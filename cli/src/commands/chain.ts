import type { Command } from 'commander';
import {
  buildPriceFeedSymbolMap,
  getOptionImplementationInfo,
} from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient } from '../client.js';
import { render, renderError } from '../output.js';

export function register(program: Command): void {
  const grp = program
    .command('chain')
    .description('Chain metadata: list supported chains, tokens, price feeds, implementations');

  grp
    .command('info')
    .description('Chain id, name, RPC URL, and contract addresses')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client, chainId, rpcUrl } = getClient(opts);
        const cfg = client.chainConfig;
        const info = {
          chainId,
          name: cfg.name,
          nativeCurrency: cfg.nativeCurrency,
          rpcUrl,
          explorerUrl: cfg.explorerUrl,
          optionBook: cfg.contracts.optionBook ?? '<not deployed>',
          optionFactory: cfg.contracts.optionFactory ?? '<not deployed>',
          twapConsumer: cfg.twapConsumer ?? '<not deployed>',
          apiBaseUrl: cfg.apiBaseUrl || '<n/a>',
          indexerApiUrl: cfg.indexerApiUrl || '<n/a>',
          wsBaseUrl: cfg.wsBaseUrl || '<n/a>',
          pricingApiUrl: cfg.pricingApiUrl || '<n/a>',
          stateApiUrl: cfg.stateApiUrl || '<n/a>',
          deploymentBlock: cfg.deploymentBlock,
        };
        render(info, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('tokens')
    .description('List supported tokens with symbol, address, and decimals')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client } = getClient(opts);
        const rows = Object.entries(client.chainConfig.tokens).map(([symbol, t]) => ({
          symbol,
          address: t.address,
          decimals: t.decimals,
        }));
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('contracts')
    .description('List all named contract addresses')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client } = getClient(opts);
        const cfg = client.chainConfig;
        const rows = Object.entries(cfg.contracts).map(([name, address]) => ({
          name,
          address: address ?? '<not deployed>',
        }));
        // Append twapConsumer for completeness (lives outside `contracts` in the SDK).
        rows.push({
          name: 'twapConsumer',
          address: cfg.twapConsumer ?? '<not deployed>',
        });
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('implementations')
    .description('Option implementation map (CALL, PUT, SPREAD, BUTTERFLY, …)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client, chainId } = getClient(opts);
        const impls = client.chainConfig.implementations;
        const rows = Object.entries(impls).map(([name, address]) => {
          const info = address
            ? getOptionImplementationInfo(chainId as 1 | 8453, address)
            : null;
          return {
            name,
            address: address ?? '<not deployed>',
            type: info?.type ?? '',
            numStrikes: info?.numStrikes ?? '',
          };
        });
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('feeds')
    .description('Price-feed map (symbol → Chainlink address)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client, chainId } = getClient(opts);
        const reverseMap = buildPriceFeedSymbolMap(chainId as 1 | 8453);
        // Forward mapping: prefer the canonical (non-legacy) entries from chainConfig.priceFeeds that appear in the reverse map.
        const reverseKeys = new Set(Object.keys(reverseMap));
        const rows = Object.entries(client.chainConfig.priceFeeds)
          .filter(([symbol, addr]) => !symbol.includes('/') && reverseKeys.has(addr.toLowerCase()))
          .map(([symbol, address]) => ({ symbol, address }));
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
