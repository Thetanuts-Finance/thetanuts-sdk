import type { Command } from 'commander';
import type { PayoutType } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner } from '../client.js';
import { render, renderError } from '../output.js';
import { confirm } from '../confirm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Globals = ReturnType<typeof getGlobalOpts>;

interface RenderOpts {
  output?: 'table' | 'json' | 'csv' | 'yaml';
  noColor?: boolean;
  jsonErrors?: boolean;
}

function renderOpts(opts: Globals): RenderOpts {
  return {
    output: opts.output,
    noColor: !opts.color,
    jsonErrors: Boolean(opts.jsonErrors),
  };
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const grp = program
    .command('position')
    .description('Owned options: list positions, inspect, claim payout');

  registerReads(grp);
  registerWrites(grp);
  registerLocal(grp);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function registerReads(grp: Command): void {
  grp
    .command('list')
    .description('List positions for a wallet via the indexer (defaults to signer)')
    .option('--address <addr>', 'wallet address (defaults to signer)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address?: string }>();
      try {
        const res = getClient(opts);
        const { client } = res;
        let addr = local.address;
        if (!addr) {
          if (!res.hasSigner) {
            process.stderr.write(
              'No --address given and no signer configured. Provide --address or set a signer.\n'
            );
            process.exit(4);
          }
          addr = await client.signer!.getAddress();
        }
        const positions = await client.api.getUserPositionsFromIndexer(addr);
        const rows = positions.map((p) => ({
          id: p.id,
          optionAddress: p.optionAddress,
          side: p.side,
          amount: p.amount.toString(),
          entryPrice: p.entryPrice.toString(),
          currentValue: p.currentValue.toString(),
          pnl: p.pnl.toString(),
        }));
        render(rows, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('info')
    .description('Get option info (type, strikes, expiry, collateral token)')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const info = await client.option.getOptionInfo(local.address);
        render(
          {
            address: info.address,
            optionType: info.optionType,
            strikes: info.strikes.map((s) => s.toString()),
            expiry: info.expiry.toString(),
            collateralToken: info.collateralToken,
            underlyingToken: info.underlyingToken,
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('full')
    .description('Get full option info (batched RPC; tolerates partial-ABI proxies)')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const full = await client.option.getFullOptionInfo(local.address);
        if (full.info === null) {
          process.stderr.write(
            `Note: getOptionInfo returned null for ${local.address} — the option contract may use an incompatible proxy ABI. Individual sub-calls below may still be populated.\n`
          );
        }
        render(
          {
            info: full.info
              ? {
                  address: full.info.address,
                  optionType: full.info.optionType,
                  strikes: full.info.strikes.map((s) => s.toString()),
                  expiry: full.info.expiry.toString(),
                  collateralToken: full.info.collateralToken,
                }
              : null,
            buyer: full.buyer,
            seller: full.seller,
            isExpired: full.isExpired,
            isSettled: full.isSettled,
            numContracts: full.numContracts?.toString() ?? null,
            collateralAmount: full.collateralAmount?.toString() ?? null,
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function registerWrites(grp: Command): void {
  grp
    .command('payout')
    .description('Claim post-expiry payout for an option')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        // Preview the simulated payout at TWAP so the user sees what they'll claim.
        const [twap, strikes, numContracts] = await Promise.all([
          client.option.getTWAP(local.address),
          client.option.getStrikes(local.address),
          client.option.getNumContracts(local.address),
        ]);
        const simulated = await client.option.simulatePayout(
          local.address,
          twap,
          strikes,
          numContracts
        );
        render(
          {
            optionAddress: local.address,
            settlementPriceTwap: twap.toString(),
            simulatedPayout: simulated.toString(),
            numContracts: numContracts.toString(),
            strikes: strikes.map((s) => s.toString()),
          },
          renderOpts(opts)
        );

        if (opts.dryRun) {
          render({ dryRun: true, action: 'payout', optionAddress: local.address }, renderOpts(opts));
          process.exit(0);
        }

        const ok = await confirm('Proceed with payout?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const result = await client.option.payout(local.address);
        const receipt = await result.wait();
        render(
          {
            txHash: receipt.hash,
            status: receipt.status,
            gasUsed: receipt.gasUsed.toString(),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Local-only math (no RPC, no signer)
// ---------------------------------------------------------------------------

function registerLocal(grp: Command): void {
  grp
    .command('calc-payout')
    .description('Calculate payout locally (no RPC) for a given product')
    .requiredOption('--type <type>', 'option type: call | put | call_spread | put_spread')
    .requiredOption('--strikes <list>', 'comma-separated strikes (human-readable, e.g. 2000 or 1800,2000)')
    .requiredOption('--price <n>', 'human-readable settlement price')
    .requiredOption('--contracts <n>', 'human-readable number of contracts')
    .option(
      '--size-decimals <n>',
      'contract-size scale (default 18 = SDK default; use 6 for USDC-scaled positions on-chain)',
      '18'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        type: string;
        strikes: string;
        price: string;
        contracts: string;
        sizeDecimals: string;
      }>();
      try {
        const { client } = getClient(opts);
        const allowed: PayoutType[] = ['call', 'put', 'call_spread', 'put_spread'];
        const t = local.type.toLowerCase() as PayoutType;
        if (!allowed.includes(t)) {
          throw new Error(
            `Invalid --type "${local.type}". Allowed: ${allowed.join(', ')}.`
          );
        }
        const sizeDecimals = Number.parseInt(local.sizeDecimals, 10);
        if (!Number.isFinite(sizeDecimals) || sizeDecimals < 0) {
          throw new Error(`--size-decimals must be a non-negative integer (got "${local.sizeDecimals}")`);
        }
        // SDK's calculatePayout treats strikes[0] as lower and strikes[1] as
        // upper for *_spread. Sort ascending so user input order doesn't
        // silently zero out the payout for descending PUT-style ordering.
        const strikes = local.strikes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => client.utils.toPriceDecimals(s))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const settlementPrice = client.utils.toPriceDecimals(local.price);
        const numContracts = client.utils.toBigInt(local.contracts, sizeDecimals);
        const payoutBn = client.utils.calculatePayout({
          type: t,
          strikes,
          settlementPrice,
          numContracts,
          sizeDecimals,
        });
        render(
          {
            type: t,
            strikes: strikes.map((s) => s.toString()),
            settlementPrice: settlementPrice.toString(),
            numContracts: numContracts.toString(),
            payout: client.utils.fromBigInt(payoutBn, 6),
            payoutRaw: payoutBn.toString(),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}
