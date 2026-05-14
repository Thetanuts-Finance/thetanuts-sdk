import type { Command } from 'commander';
import { getGlobalOpts } from '../options.js';
import { getClient } from '../client.js';
import { render, renderError } from '../output.js';

/**
 * `thetanuts market` — wraps the read-only `client.api` surface
 *
 * All subcommands here are read-only — no signer required
 */
export function register(program: Command): void {
  const grp = program
    .command('market')
    .description('Live market data: spot prices, orders, protocol stats, indexer reads');

  // -------------------------------------------------------------- data
  grp
    .command('data')
    .description('Spot prices + lastUpdated/currentTime metadata')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client } = getClient(opts);
        const data = await client.api.getMarketData();
        // Render prices as a 2-column table when in table mode; other formats
        // get the full structured object.
        if ((opts.output ?? 'table') === 'table') {
          const priceRows = Object.entries(data.prices).map(([asset, price]) => ({
            asset,
            price,
          }));
          render(priceRows, { output: 'table', noColor: !opts.color });
          render(data.metadata, { output: 'table', noColor: !opts.color });
        } else {
          render(data, { output: opts.output, noColor: !opts.color });
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ------------------------------------------------------------ prices
  grp
    .command('prices')
    .description('Raw price feed data (getMarketPrices)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client } = getClient(opts);
        const prices = await client.api.getMarketPrices();
        render(prices, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ------------------------------------------------------------ orders
  grp
    .command('orders')
    .description('List available maker orders. Supports underlying/type/min-expiry filters.')
    .option('--underlying <sym>', 'filter by underlying (ETH, BTC, ...). Applied client-side.')
    .option('--type <type>', 'filter by option type (PUT|CALL)')
    .option('--min-expiry <ts>', 'minimum expiry Unix timestamp (server-side)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        underlying?: string;
        type?: string;
        minExpiry?: string;
      }>();
      try {
        const { client } = getClient(opts);

        const typeFilter = local.type?.toLowerCase();
        const isCallFilter =
          typeFilter === 'call' ? true : typeFilter === 'put' ? false : undefined;
        const minExpiry = local.minExpiry ? Number(local.minExpiry) : undefined;

        // The Odette feed (`/`) is the reliable source. The server-side
        // `filterOrders` endpoint frequently returns an empty/undefined
        // payload, so do all filtering client-side from the full fetch.
        let orders = await client.api.fetchOrders();
        if (isCallFilter !== undefined) {
          orders = orders.filter((o) => o.rawApiData?.isCall === isCallFilter);
        }
        if (minExpiry !== undefined) {
          orders = orders.filter((o) => Number(o.order.expiry) >= minExpiry);
        }

        // Client-side underlying filter (Odette uses priceFeed; we match the
        // BTC/ETH feeds to user-visible symbols).
        const sym = local.underlying?.toUpperCase();
        const filtered = sym
          ? orders.filter((o) => {
              const feed = o.rawApiData?.priceFeed?.toLowerCase() ?? '';
              if (sym === 'BTC') return feed.endsWith('64c911996d3c6ac71f9b455b1e8e7266bcbd848f');
              if (sym === 'ETH') return feed.endsWith('71041dddad3595f9ced3dccfbe3d1f4b0a16bb70');
              // Fallback: try matching against underlying token addr if SDK populates it
              return false;
            })
          : orders;

        const rows = filtered.map((o, index) => {
          const strikes = (o.rawApiData?.strikes ?? []).join(',');
          const structure = o.rawApiData?.implementation ?? '';
          const isCall = o.rawApiData?.isCall ?? false;
          const priceFeed = o.rawApiData?.priceFeed ?? '';
          let underlying = '';
          const feedLower = priceFeed.toLowerCase();
          if (feedLower.endsWith('64c911996d3c6ac71f9b455b1e8e7266bcbd848f')) underlying = 'BTC';
          else if (feedLower.endsWith('71041dddad3595f9ced3dccfbe3d1f4b0a16bb70')) underlying = 'ETH';
          return {
            index,
            underlying,
            type: isCall ? 'CALL' : 'PUT',
            strikes,
            expiry: o.order.expiry.toString(),
            premium: o.order.price.toString(),
            available: o.availableAmount.toString(),
            structure,
          };
        });

        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ------------------------------------------------------------- stats
  grp
    .command('stats')
    .description('Combined protocol stats (book + factory)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client } = getClient(opts);
        const stats = await client.api.getProtocolStats();
        render(stats, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------- daily-stats
  grp
    .command('daily-stats')
    .description('Daily protocol time series (book + factory combined)')
    .option('--from <ts>', 'start timestamp (Unix seconds, client-side filter)')
    .option('--to <ts>', 'end timestamp (Unix seconds, client-side filter)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ from?: string; to?: string }>();
      try {
        const { client } = getClient(opts);
        // SDK's getDailyStats() takes no params; we apply --from/--to as
        // a client-side filter on the returned `daily` array.
        const stats = await client.api.getDailyStats();
        const from = local.from ? Number(local.from) : undefined;
        const to = local.to ? Number(local.to) : undefined;
        if (from === undefined && to === undefined) {
          render(stats, { output: opts.output, noColor: !opts.color });
          return;
        }
        const daily = (stats.daily ?? []).filter((entry) => {
          // DailyStatsEntry has either a `date` (YYYY-MM-DD) or a timestamp;
          // attempt to normalize to seconds.
          const e = entry as unknown as { timestamp?: number; date?: string };
          const ts =
            typeof e.timestamp === 'number'
              ? e.timestamp
              : e.date
                ? Math.floor(Date.parse(e.date) / 1000)
                : 0;
          if (from !== undefined && ts < from) return false;
          if (to !== undefined && ts > to) return false;
          return true;
        });
        render({ ...stats, daily }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // -------------------------------------------------------- positions
  grp
    .command('positions')
    .description('User positions from the indexer (open + closed)')
    .requiredOption('--address <addr>', 'user address')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { address } = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const positions = await client.api.getUserPositionsFromIndexer(address);
        render(positions, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ---------------------------------------------------------- history
  grp
    .command('history')
    .description('User trade history from the indexer')
    .requiredOption('--address <addr>', 'user address')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { address } = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const history = await client.api.getUserHistoryFromIndexer(address);
        render(history, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------- option
  grp
    .command('option')
    .description('Indexer detail for a single option contract (tries book, falls back to factory)')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { address } = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        // Try book first; on 404 fall back to factory.
        try {
          const book = await client.api.getBookOption(address);
          render(book, { output: opts.output, noColor: !opts.color });
          return;
        } catch (bookErr) {
          const code = (bookErr as { code?: string } | null)?.code;
          const status = (bookErr as { status?: number } | null)?.status;
          const is404 = code === 'NOT_FOUND' || status === 404;
          if (!is404) {
            // Non-404 from the book lookup — try factory anyway as the PRD
            // implies the option may live on either side, but surface the
            // book error if factory also fails.
          }
        }
        const factory = await client.api.getFactoryOption(address);
        render(factory, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ------------------------------------------------- referrer-stats
  grp
    .command('referrer-stats')
    .description('Referrer aggregate stats from the book indexer')
    .requiredOption('--address <addr>', 'referrer address')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { address } = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const stats = await client.api.getReferrerStatsFromIndexer(address);
        render(stats, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
