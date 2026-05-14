import type { Command } from 'commander';
import { Contract } from 'ethers';
import type { PayoutType } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
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

/**
 * Look up collateral-token decimals from the option contract, falling back to
 * 6 if the chain config does not list the token (e.g. an unusual deployment).
 */
async function getCollateralDecimals(
  client: GetClientResult['client'],
  optionAddress: string
): Promise<number> {
  const tokenAddr = await client.option.getCollateralToken(optionAddress);
  const lower = tokenAddr.toLowerCase();
  for (const cfg of Object.values(client.chainConfig.tokens)) {
    if (cfg.address.toLowerCase() === lower) return cfg.decimals;
  }
  return 6;
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const grp = program
    .command('position')
    .description('Owned options: list positions, inspect, close, split, transfer, payout');

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

  grp
    .command('strikes')
    .description('Get the strike prices of an option')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const strikes = await client.option.getStrikes(local.address);
        render(
          { strikes: strikes.map((s) => s.toString()) },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('expiry')
    .description('Get the option expiry (Unix ts + ISO)')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const expiry = await client.option.getExpiry(local.address);
        const expiryNum = Number(expiry);
        const iso = Number.isFinite(expiryNum)
          ? new Date(expiryNum * 1000).toISOString()
          : null;
        render({ expiry: expiry.toString(), iso }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('type')
    .description('Get the unpacked option type struct')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        // PRD: position type --address ... -> unpackOptionType(await getOptionType(addr)).
        // The SDK's unpackOptionType pulls directly from the contract (no input arg),
        // which is equivalent — and avoids a redundant RPC round-trip.
        const unpacked = await client.option.unpackOptionType(local.address);
        render(
          {
            isQuoteCollateral: unpacked.isQuoteCollateral,
            isPhysicallySettled: unpacked.isPhysicallySettled,
            optionStyle: unpacked.optionStyle,
            optionStructure: unpacked.optionStructure,
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('buyer')
    .description('Get the buyer address')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const buyer = await client.option.getBuyer(local.address);
        render({ buyer }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('seller')
    .description('Get the seller address')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const seller = await client.option.getSeller(local.address);
        render({ seller }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('collateral-token')
    .description('Get the collateral token address')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const token = await client.option.getCollateralToken(local.address);
        render({ collateralToken: token }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('collateral-amount')
    .description('Get the collateral amount held in the option')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const amount = await client.option.getCollateralAmount(local.address);
        render({ collateralAmount: amount.toString() }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('num-contracts')
    .description('Get the number of contracts in the option')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const n = await client.option.getNumContracts(local.address);
        render({ numContracts: n.toString() }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('payout-at')
    .description('Calculate payout at a given settlement price (on-chain calculatePayout)')
    .requiredOption('--address <addr>', 'option contract address')
    .requiredOption('--price <n>', 'human-readable settlement price (8-decimal scaling applied)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string; price: string }>();
      try {
        const { client } = getClient(opts);
        const price = client.utils.toPriceDecimals(local.price);
        const result = await client.option.calculatePayout(local.address, price);
        render(
          {
            payout: result.payout.toString(),
            settlementPrice: result.settlementPrice.toString(),
            optionAddress: result.optionAddress,
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('simulate-payout')
    .description('Simulate payout on-chain (uses TWAP when --price is omitted)')
    .requiredOption('--address <addr>', 'option contract address')
    .option('--price <n>', 'human-readable settlement price (defaults to TWAP)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string; price?: string }>();
      try {
        const { client } = getClient(opts);
        const price =
          local.price !== undefined
            ? client.utils.toPriceDecimals(local.price)
            : await client.option.getTWAP(local.address);
        const strikes = await client.option.getStrikes(local.address);
        const numContracts = await client.option.getNumContracts(local.address);
        const payout = await client.option.simulatePayout(
          local.address,
          price,
          strikes,
          numContracts
        );
        render(
          {
            payout: payout.toString(),
            settlementPrice: price.toString(),
            strikes: strikes.map((s) => s.toString()),
            numContracts: numContracts.toString(),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('required-collateral')
    .description('Calculate required collateral for the option')
    .requiredOption('--address <addr>', 'option contract address')
    .option('--strike <n>', 'human-readable single strike to override (otherwise uses on-chain strikes)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string; strike?: string }>();
      try {
        const { client } = getClient(opts);
        const strikes = local.strike
          ? [client.utils.toPriceDecimals(local.strike)]
          : await client.option.getStrikes(local.address);
        const numContracts = await client.option.getNumContracts(local.address);
        const required = await client.option.calculateRequiredCollateral(
          local.address,
          strikes,
          numContracts
        );
        render(
          {
            requiredCollateral: required.toString(),
            strikes: strikes.map((s) => s.toString()),
            numContracts: numContracts.toString(),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('twap')
    .description('Get the current TWAP (8-decimal price)')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const twap = await client.option.getTWAP(local.address);
        render({ twap: twap.toString() }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('chainlink-feed')
    .description('Get the Chainlink price feed address for the option')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const feed = await client.option.getChainlinkPriceFeed(local.address);
        render({ chainlinkFeed: feed }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('is-expired')
    .description('Check whether an option has expired')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const expired = await client.option.isExpired(local.address);
        render({ expired }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('is-settled')
    .description('Check whether an option has been settled')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);
        const settled = await client.option.isSettled(local.address);
        render({ settled }, renderOpts(opts));
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
    .command('close')
    .description('Bilaterally close an option position (both parties)')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        // Preview
        const [buyer, seller, strikes, expiry] = await Promise.all([
          client.option.getBuyer(local.address),
          client.option.getSeller(local.address),
          client.option.getStrikes(local.address),
          client.option.getExpiry(local.address),
        ]);
        render(
          {
            optionAddress: local.address,
            buyer,
            seller,
            strikes: strikes.map((s) => s.toString()),
            expiry: expiry.toString(),
          },
          renderOpts(opts)
        );

        if (opts.dryRun) {
          render({ dryRun: true, action: 'close', optionAddress: local.address }, renderOpts(opts));
          process.exit(0);
        }

        const ok = await confirm('Proceed with close?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const result = await client.option.close(local.address);
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

  grp
    .command('split')
    .description('Split an option position by collateral amount (payable in r12 — fee forwarded by SDK)')
    .requiredOption('--address <addr>', 'option contract address')
    .requiredOption('--collateral <n>', 'human-readable collateral amount to split off')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string; collateral: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        const decimals = await getCollateralDecimals(client, local.address);
        const splitAmount = client.utils.toBigInt(local.collateral, decimals);

        // r12: split is payable; surface the split fee in the preview so the
        // user sees what's being forwarded as msg.value.
        const optionContract = new Contract(
          local.address,
          ['function getSplitFee() view returns (uint256)'],
          client.provider
        );
        let splitFee: bigint | null = null;
        try {
          splitFee = (await optionContract['getSplitFee']!()) as bigint;
        } catch {
          // older deployments may not have getSplitFee(); leave null
        }

        render(
          {
            optionAddress: local.address,
            splitCollateralAmount: splitAmount.toString(),
            collateralDecimals: decimals,
            splitFeeWei: splitFee?.toString() ?? 'unknown (pre-r12?)',
          },
          renderOpts(opts)
        );

        if (opts.dryRun) {
          render(
            {
              dryRun: true,
              action: 'split',
              optionAddress: local.address,
              splitCollateralAmount: splitAmount.toString(),
            },
            renderOpts(opts)
          );
          process.exit(0);
        }

        const ok = await confirm('Proceed with split?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const result = await client.option.split(local.address, splitAmount);
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

  grp
    .command('transfer')
    .description('Transfer a position to another address (or approve via --approved)')
    .requiredOption('--address <addr>', 'option contract address')
    .requiredOption('--to <addr>', 'recipient address')
    .option('--approved', 'set transfer approval instead of executing the transfer', false)
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string; to: string; approved?: boolean }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        const signerAddr = await client.signer!.getAddress();
        const [buyer, seller] = await Promise.all([
          client.option.getBuyer(local.address),
          client.option.getSeller(local.address),
        ]);
        const isBuyer = signerAddr.toLowerCase() === buyer.toLowerCase();
        const isSeller = signerAddr.toLowerCase() === seller.toLowerCase();
        if (!isBuyer && !isSeller) {
          throw new Error(
            `Signer ${signerAddr} is neither buyer nor seller on option ${local.address}.`
          );
        }

        render(
          {
            optionAddress: local.address,
            from: signerAddr,
            to: local.to,
            role: isBuyer ? 'buyer' : 'seller',
            mode: local.approved ? 'approveTransfer' : 'transfer',
          },
          renderOpts(opts)
        );

        if (opts.dryRun) {
          render({ dryRun: true, action: local.approved ? 'approveTransfer' : 'transfer' }, renderOpts(opts));
          process.exit(0);
        }

        const ok = await confirm(
          `Proceed with ${local.approved ? 'approveTransfer' : 'transfer'}?`,
          { yes: opts.yes, dryRun: opts.dryRun }
        );
        if (!ok) process.exit(3);

        const result = local.approved
          ? await client.option.approveTransfer(local.address, isBuyer, local.to, true)
          : await client.option.transfer(local.address, isBuyer, local.to);
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
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        type: string;
        strikes: string;
        price: string;
        contracts: string;
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
        const strikes = local.strikes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => client.utils.toPriceDecimals(s));
        const settlementPrice = client.utils.toPriceDecimals(local.price);
        // Match util.ts convention: numContracts is denominated in 18 decimals
        // (size decimals), matching the SDK defaults in utils.calculatePayout.
        const numContracts = client.utils.toBigInt(local.contracts, 18);
        const payout = client.utils.calculatePayout({
          type: t,
          strikes,
          settlementPrice,
          numContracts,
        });
        render(
          {
            type: t,
            strikes: strikes.map((s) => s.toString()),
            settlementPrice: settlementPrice.toString(),
            numContracts: numContracts.toString(),
            payout: payout.toString(),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}
