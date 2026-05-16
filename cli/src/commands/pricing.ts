import type { Command } from 'commander';
import { getGlobalOpts } from '../options.js';
import { getClient } from '../client.js';
import { render, renderError } from '../output.js';
import {
  validateButterfly,
  validateCondor,
} from '@thetanuts-finance/thetanuts-client';

/**
 * `thetanuts pricing` — wraps `client.mmPricing`. All reads, no signer.
 */
export function register(program: Command): void {
  const grp = program
    .command('pricing')
    .description('Market-maker pricing: quote vanilla and multi-leg options');

  // -------------------------------------------------------------- all
  // Sorted flat list of every non-expired quote for the underlying, projected
  // to the columns a trader actually reads (ticker, strike, expiry, bid, ask,
  // mark). Use `-o json` to get the full pricing object per row.
  grp
    .command('all')
    .description('All non-expired MM quotes for an underlying, sorted by expiry then strike')
    .requiredOption('--underlying <sym>', 'underlying asset (ETH or BTC)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { underlying } = cmd.opts<{ underlying: string }>();
      try {
        const { client } = getClient(opts);
        const u = underlying.toUpperCase() as 'ETH' | 'BTC';
        const pricing = await client.mmPricing.getPricingArray(u);
        if ((opts.output ?? 'table') === 'table') {
          const rows = pricing.map((p) => ({
            ticker: p.ticker,
            strike: p.strike,
            expiry: p.expiry,
            isCall: p.isCall,
            bid: p.feeAdjustedBid,
            ask: p.feeAdjustedAsk,
            mark: p.markPrice,
          }));
          render(rows, { output: 'table', noColor: !opts.color });
        } else {
          render(pricing, { output: opts.output, noColor: !opts.color });
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------- ticker
  grp
    .command('ticker')
    .description('Fetch MM pricing for a single ticker, e.g. ETH-16FEB26-1800-P')
    .requiredOption('--ticker <ticker>', 'option ticker (e.g. ETH-16FEB26-1800-P)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const { ticker } = cmd.opts<{ ticker: string }>();
      try {
        const { client } = getClient(opts);
        const pricing = await client.mmPricing.getTickerPricing(ticker);
        render(pricing, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // --------------------------------------------------------- position
  grp
    .command('position')
    .description('Position-aware MM pricing (premium + collateral cost)')
    .requiredOption('--ticker <ticker>', 'option ticker')
    .option('--long', 'long position (default)', false)
    .option('--short', 'short position', false)
    .requiredOption('--contracts <n>', 'number of contracts (raw count, e.g. 6)')
    .requiredOption('--collateral-token <sym>', 'collateral token symbol (USDC|WETH|cbBTC)')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        ticker: string;
        long?: boolean;
        short?: boolean;
        contracts: string;
        collateralToken: string;
      }>();
      try {
        const { client } = getClient(opts);
        // Default to --long when neither flag is given.
        const isLong = local.short ? false : true;
        const collateralToken = local.collateralToken as 'USDC' | 'WETH' | 'cbBTC';
        const pricing = await client.mmPricing.getPositionPricing({
          ticker: local.ticker,
          isLong,
          numContracts: Number(local.contracts),
          collateralToken,
        });
        render(pricing, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------- spread
  grp
    .command('spread')
    .description('MM pricing for a 2-leg spread')
    .requiredOption('--underlying <sym>', 'underlying asset (ETH or BTC)')
    .requiredOption('--strikes <a,b>', 'two strikes, comma-separated (e.g. 1800,2000)')
    .requiredOption('--expiry <ts>', 'expiry Unix timestamp')
    .requiredOption('--type <type>', 'call|put')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        underlying: string;
        strikes: string;
        expiry: string;
        type: string;
      }>();
      try {
        const { client } = getClient(opts);
        const strikes = local.strikes.split(',').map((s) => s.trim());
        if (strikes.length !== 2) {
          renderError(new Error('Spread requires exactly 2 strikes (a,b)'), {
            jsonErrors: Boolean(opts.jsonErrors),
            noColor: !opts.color,
          });
          process.exit(2);
        }
        const strikeBigInts = strikes.map((s) =>
          client.utils.toStrikeDecimals(s)
        ) as [bigint, bigint];
        const isCall = local.type.toLowerCase() === 'call';
        const pricing = await client.mmPricing.getSpreadPricing({
          underlying: local.underlying.toUpperCase(),
          strikes: strikeBigInts,
          expiry: Number(local.expiry),
          isCall,
        });
        render(pricing, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // -------------------------------------------------------- butterfly
  grp
    .command('butterfly')
    .description('MM pricing for a 3-leg butterfly (equidistant strikes)')
    .requiredOption('--underlying <sym>', 'underlying asset (ETH or BTC)')
    .requiredOption('--strikes <a,b,c>', 'three strikes, comma-separated')
    .requiredOption('--expiry <ts>', 'expiry Unix timestamp')
    .requiredOption('--type <type>', 'call|put')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        underlying: string;
        strikes: string;
        expiry: string;
        type: string;
      }>();
      try {
        const { client } = getClient(opts);
        const strikeNums = local.strikes.split(',').map((s) => Number(s.trim()));
        if (strikeNums.length !== 3) {
          renderError(new Error('Butterfly requires exactly 3 strikes (a,b,c)'), {
            jsonErrors: Boolean(opts.jsonErrors),
            noColor: !opts.color,
          });
          process.exit(2);
        }
        const validation = validateButterfly(strikeNums);
        if (!validation.valid) {
          renderError(new Error(validation.error ?? 'Invalid butterfly strikes'), {
            jsonErrors: Boolean(opts.jsonErrors),
            noColor: !opts.color,
          });
          process.exit(2);
        }
        const strikeBigInts = strikeNums.map((s) =>
          client.utils.toStrikeDecimals(s)
        ) as [bigint, bigint, bigint];
        const isCall = local.type.toLowerCase() === 'call';
        const pricing = await client.mmPricing.getButterflyPricing({
          underlying: local.underlying.toUpperCase(),
          strikes: strikeBigInts,
          expiry: Number(local.expiry),
          isCall,
        });
        render(pricing, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------- condor
  grp
    .command('condor')
    .description('MM pricing for a 4-leg condor')
    .requiredOption('--underlying <sym>', 'underlying asset (ETH or BTC)')
    .requiredOption('--strikes <a,b,c,d>', 'four strikes, comma-separated')
    .requiredOption('--expiry <ts>', 'expiry Unix timestamp')
    .requiredOption('--type <type>', 'call|put|iron')
    .action(async (_opts, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        underlying: string;
        strikes: string;
        expiry: string;
        type: string;
      }>();
      try {
        const { client } = getClient(opts);
        const strikeNums = local.strikes.split(',').map((s) => Number(s.trim()));
        if (strikeNums.length !== 4) {
          renderError(new Error('Condor requires exactly 4 strikes (a,b,c,d)'), {
            jsonErrors: Boolean(opts.jsonErrors),
            noColor: !opts.color,
          });
          process.exit(2);
        }
        const validation = validateCondor(strikeNums);
        if (!validation.valid) {
          renderError(new Error(validation.error ?? 'Invalid condor strikes'), {
            jsonErrors: Boolean(opts.jsonErrors),
            noColor: !opts.color,
          });
          process.exit(2);
        }
        const strikeBigInts = strikeNums.map((s) =>
          client.utils.toStrikeDecimals(s)
        ) as [bigint, bigint, bigint, bigint];
        const type = local.type.toLowerCase() as 'call' | 'put' | 'iron';
        const pricing = await client.mmPricing.getCondorPricing({
          underlying: local.underlying.toUpperCase(),
          strikes: strikeBigInts,
          expiry: Number(local.expiry),
          type,
        });
        render(pricing, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
