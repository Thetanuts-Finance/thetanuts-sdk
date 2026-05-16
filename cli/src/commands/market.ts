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
    .description('Live market data: spot prices, protocol stats, indexer reads');

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
    .description('User trade history from the indexer (realized P&L source)')
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
        // Try book first; fall back to factory on any error.
        try {
          const book = await client.api.getBookOption(address);
          render(book, { output: opts.output, noColor: !opts.color });
          return;
        } catch {
          // fall through to factory
        }
        const factory = await client.api.getFactoryOption(address);
        render(factory, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
