import type { Command } from 'commander';
import { MaxUint256 } from 'ethers';
import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { render, renderError } from '../output.js';
import { confirm } from '../confirm.js';
import { warnMaxApproval } from '../warn.js';

// ---------------------------------------------------------------------------
// Helpers — kept module-local; do not export
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
 * Per-invocation order cache so the same CLI run doesn't refetch when a command
 * needs the orders list more than once (e.g. fill: preview, then encode/send)
 */
let _ordersCache: OrderWithSignature[] | null = null;
async function fetchOrdersOnce(
  client: GetClientResult['client']
): Promise<OrderWithSignature[]> {
  if (_ordersCache) return _ordersCache;
  _ordersCache = await client.api.fetchOrders();
  return _ordersCache;
}

function resolveOrderByIndex(
  orders: OrderWithSignature[],
  rawIndex: string | number | undefined
): OrderWithSignature {
  if (rawIndex === undefined || rawIndex === null || rawIndex === '') {
    throw new Error('--order-index is required');
  }
  const idx = typeof rawIndex === 'number' ? rawIndex : Number.parseInt(String(rawIndex), 10);
  if (Number.isNaN(idx) || idx < 0) {
    throw new Error(`Invalid --order-index: ${rawIndex}`);
  }
  if (idx >= orders.length) {
    throw new Error(
      `Order index ${idx} out of range. Live orderbook has ${orders.length} order(s) (valid range: 0..${orders.length - 1}).`
    );
  }
  const order = orders[idx];
  if (!order) {
    throw new Error(`Order at index ${idx} is undefined`);
  }
  return order;
}

/**
 * Resolve a token argument that may be a chain-config symbol (e.g. 'USDC') or
 * a raw 0x address. Throws if it's neither.
 */
function resolveTokenAddress(
  client: GetClientResult['client'],
  tokenArg: string
): { address: string; symbol: string; decimals: number } {
  if (!tokenArg) {
    throw new Error('--token is required');
  }
  // Address path
  if (tokenArg.startsWith('0x') && tokenArg.length === 42) {
    const lower = tokenArg.toLowerCase();
    for (const [symbol, cfg] of Object.entries(client.chainConfig.tokens)) {
      if (cfg.address.toLowerCase() === lower) {
        return { address: cfg.address, symbol, decimals: cfg.decimals };
      }
    }
    return { address: tokenArg, symbol: tokenArg, decimals: 18 };
  }
  // Symbol path
  const cfg = client.chainConfig.tokens[tokenArg];
  if (!cfg) {
    const known = Object.keys(client.chainConfig.tokens).join(', ');
    throw new Error(`Unknown token symbol "${tokenArg}". Known: ${known}`);
  }
  return { address: cfg.address, symbol: tokenArg, decimals: cfg.decimals };
}

/**
 * Compute the collateral amount (in raw token units) the user wants to spend
 * on a fill. Two flag paths:
 *   --collateral <human>           e.g. 10 USDC -> 10 * 10^decimals
 *   --num-contracts <human> +      derive from order's pricePerContract
 *
 * Returns `undefined` when neither flag was passed; the SDK then fills max.
 */
function computeCollateralAmount(
  order: OrderWithSignature,
  client: GetClientResult['client'],
  flags: { collateral?: string; numContracts?: string }
): bigint | undefined {
  if (flags.collateral !== undefined && flags.collateral !== '') {
    const decimals = collateralDecimalsFromOrder(order, client);
    return client.utils.toBigInt(flags.collateral, decimals);
  }
  if (flags.numContracts !== undefined && flags.numContracts !== '') {
    // numContracts is denominated in collateral decimals (per SDK convention),
    // pricePerContract is 8-decimal. premium = numContracts * price / 1e8.
    const decimals = collateralDecimalsFromOrder(order, client);
    const numContractsRaw = client.utils.toBigInt(flags.numContracts, decimals);
    return (numContractsRaw * order.order.price) / 100000000n;
  }
  return undefined;
}

function collateralDecimalsFromOrder(
  order: OrderWithSignature,
  client: GetClientResult['client']
): number {
  const addr = order.rawApiData?.collateral?.toLowerCase();
  if (!addr) return 6; // safe default (USDC)
  for (const cfg of Object.values(client.chainConfig.tokens)) {
    if (cfg.address.toLowerCase() === addr) return cfg.decimals;
  }
  return 6;
}

function summarizeOrder(
  order: OrderWithSignature,
  index?: number
): Record<string, unknown> {
  const strikes = order.rawApiData?.strikes ?? [];
  return {
    ...(index !== undefined ? { index } : {}),
    maker: order.order.maker,
    isCall: order.rawApiData?.isCall,
    isLong: order.rawApiData?.isLong,
    strikes: strikes.length ? strikes.join(',') : undefined,
    pricePerContract: order.order.price.toString(),
    expiry: order.order.expiry.toString(),
    availableAmount: order.availableAmount.toString(),
    collateral: order.rawApiData?.collateral,
    orderExpiryTimestamp: order.rawApiData?.orderExpiryTimestamp,
  };
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const grp = program
    .command('book')
    .description('OptionBook orderflow: list orders, preview, fill, cancel, claim referrer fees');

  registerReads(grp);
  registerWrites(grp);
  registerFees(grp);
  registerStatic(grp);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function registerReads(grp: Command): void {
  grp
    .command('orders')
    .description('List open maker orders (alias of `market orders`)')
    .option('--underlying <asset>', 'filter by underlying (e.g. ETH, BTC)')
    .option('--type <type>', 'filter by option type (CALL|PUT)')
    .option('--min-expiry <ts>', 'filter by minimum expiry timestamp (unix seconds)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ underlying?: string; type?: string; minExpiry?: string }>();
      try {
        const { client } = getClient(opts);

        // Fetch the full book and filter client-side. The SDK's filterOrders()
        // currently throws on certain API response shapes (`response.orders`
        // undefined); fetching once and filtering here keeps the CLI working
        // and preserves the per-invocation cache for downstream commands.
        const allOrders = await fetchOrdersOnce(client);

        let wantType: 'CALL' | 'PUT' | null = null;
        if (local.type) {
          const upper = local.type.toUpperCase();
          if (upper !== 'CALL' && upper !== 'PUT') {
            throw new Error(`Invalid --type "${local.type}". Expected CALL or PUT.`);
          }
          wantType = upper;
        }
        const minExpiry = local.minExpiry
          ? Number.parseInt(local.minExpiry, 10)
          : null;

        // Resolve underlying symbol -> price-feed address via chain config so
        // we can match the order's priceFeed instead of relying on the API
        // server-side filter.
        let wantPriceFeed: string | null = null;
        if (local.underlying) {
          const feed = client.chainConfig.priceFeeds[local.underlying.toUpperCase()];
          if (!feed) {
            const known = Object.keys(client.chainConfig.priceFeeds).join(', ');
            throw new Error(
              `Unknown --underlying "${local.underlying}". Known: ${known}.`
            );
          }
          wantPriceFeed = feed.toLowerCase();
        }

        const filtered = allOrders.filter((o) => {
          if (wantType !== null) {
            const isCall = o.rawApiData?.isCall;
            if (isCall === undefined) return false;
            if (wantType === 'CALL' && !isCall) return false;
            if (wantType === 'PUT' && isCall) return false;
          }
          if (wantPriceFeed !== null) {
            const pf = o.rawApiData?.priceFeed?.toLowerCase();
            if (pf !== wantPriceFeed) return false;
          }
          if (minExpiry !== null) {
            if (Number(o.order.expiry) < minExpiry) return false;
          }
          return true;
        });

        const rows = filtered.map((o, i) => summarizeOrder(o, i));
        render(rows, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('preview')
    .description('Preview a fill against an order without sending a transaction')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .option('--collateral <n>', 'human-readable collateral amount to spend (e.g. 10 for 10 USDC)')
    .option('--num-contracts <n>', 'human-readable number of contracts to fill')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string; collateral?: string; numContracts?: string }>();
      try {
        const { client } = getClient(opts);
        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const collateralAmount = computeCollateralAmount(order, client, local);
        const preview = client.optionBook.previewFillOrder(order, collateralAmount);
        render(preview, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('max-contracts')
    .description('Compute the maximum fillable contracts for an order')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string }>();
      try {
        const { client } = getClient(opts);
        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const maxContracts = client.optionBook.calculateMaxContracts(order);
        render({ maxContracts: maxContracts.toString() }, renderOpts(opts));
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
    .command('fill')
    .description('Fill an order (preview → allowance check → confirm → send)')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .option('--collateral <n>', 'human-readable collateral amount to spend')
    .option('--num-contracts <n>', 'human-readable number of contracts to fill')
    .option(
      '--approve-amount <max|n>',
      'approval amount when allowance is insufficient: "max" for unlimited (MaxUint256), or a decimal token amount. Defaults to exactly preview.totalCollateral.'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        orderIndex: string;
        collateral?: string;
        numContracts?: string;
        approveAmount?: string;
      }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const collateralAmount = computeCollateralAmount(order, client, local);

        // 1+2+3: build preview, render it
        const preview = client.optionBook.previewFillOrder(order, collateralAmount);
        render(preview, renderOpts(opts));

        const collateralAddr = preview.collateralToken;
        const spender = client.optionBook.contractAddress;
        const required = preview.totalCollateral;

        // Resolve how much to approve, IF approval ends up being needed.
        //   undefined → exact (required collateral)
        //   "max"     → MaxUint256
        //   numeric   → toBigInt(value, decimals)
        const collateralDecimals = collateralDecimalsFromOrder(order, client);
        let approveAmount: bigint;
        let approveIsMax = false;
        if (local.approveAmount === undefined) {
          approveAmount = required;
        } else if (local.approveAmount === 'max') {
          approveAmount = MaxUint256;
          approveIsMax = true;
        } else {
          approveAmount = client.utils.toBigInt(local.approveAmount, collateralDecimals);
        }

        // Dry-run: always emit the fill calldata regardless of allowance, plus
        // the would-be approve calldata if approval is needed. The user can
        // then submit both via a separate signer. We never prompt or broadcast.
        if (opts.dryRun) {
          const signerAddrDryRun = await client.signer!.getAddress();
          const currentAllowanceDryRun = await client.erc20.getAllowance(
            collateralAddr,
            signerAddrDryRun,
            spender
          );
          const fillEncoded = client.optionBook.encodeFillOrder(order, collateralAmount);
          let approveEncoded: ReturnType<typeof client.erc20.encodeApprove> | null = null;
          if (currentAllowanceDryRun < required) {
            approveEncoded = client.erc20.encodeApprove(
              collateralAddr,
              spender,
              approveAmount
            );
          }
          render(
            {
              dryRun: true,
              approve: approveEncoded,
              fill: fillEncoded,
            },
            renderOpts(opts)
          );
          process.exit(0);
        }

        // Live path: allowance check on the collateral token.
        const signerAddr = await client.signer!.getAddress();
        const currentAllowance = await client.erc20.getAllowance(
          collateralAddr,
          signerAddr,
          spender
        );
        if (currentAllowance < required) {
          process.stderr.write(
            `Allowance is ${currentAllowance.toString()}, need ${required.toString()}. ` +
              `Approving the OptionBook contract is required to proceed.\n`
          );
          if (approveIsMax) {
            warnMaxApproval(collateralAddr, spender, {});
          }
          const approvePromptAmount = approveIsMax
            ? 'unlimited (MaxUint256)'
            : approveAmount.toString();
          const approveOk = await confirm(
            `Approve ${approvePromptAmount} ${collateralAddr} to ${spender}?`,
            { yes: opts.yes, dryRun: opts.dryRun }
          );
          if (!approveOk) {
            process.stderr.write('Approval declined; aborting fill.\n');
            process.exit(3);
          }
          await client.erc20.ensureAllowance(collateralAddr, spender, approveAmount);
        }

        // Final confirm for the fill itself (separate prompt — never bundled).
        const ok = await confirm('Proceed with fill?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        // 7+8: send + render receipt
        const receipt = await client.optionBook.fillOrder(order, collateralAmount);
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
    .command('swap-and-fill')
    .description('Swap a source token into the order collateral and fill in one tx — swap path: requires aggregator support')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .requiredOption('--src-token <addr-or-sym>', 'source token (symbol or address)')
    .requiredOption('--src-amount <n>', 'human-readable amount of source token to swap')
    .option('--num-contracts <n>', 'human-readable number of contracts to fill (informational)')
    .option('--swap-router <addr>', 'swap router contract address (required)')
    .option('--swap-data <hex>', 'encoded aggregator calldata (required)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        orderIndex: string;
        srcToken: string;
        srcAmount: string;
        numContracts?: string;
        swapRouter?: string;
        swapData?: string;
      }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        // SDK requires swapRouter + swapData (encoded aggregator calldata).
        // Neither can be safely derived from --src-token/--src-amount alone.
        const missing: string[] = [];
        if (!local.swapRouter) missing.push('--swap-router');
        if (!local.swapData) missing.push('--swap-data');
        if (missing.length) {
          throw new Error(
            `swap-and-fill requires aggregator-provided fields the CLI cannot derive: ${missing.join(', ')}. ` +
              `Obtain these from your aggregator (0x, 1inch, etc.) and re-run.`
          );
        }

        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const srcInfo = resolveTokenAddress(client, local.srcToken);
        const srcAmount = client.utils.toBigInt(local.srcAmount, srcInfo.decimals);

        // Preview so the user sees the expected destination-side fill before signing
        const preview = client.optionBook.previewFillOrder(order);
        const summary = {
          srcToken: srcInfo.address,
          srcSymbol: srcInfo.symbol,
          srcAmount: srcAmount.toString(),
          swapRouter: local.swapRouter,
          ...preview,
        };
        render(summary, renderOpts(opts));

        if (opts.dryRun) {
          const encoded = client.optionBook.encodeSwapAndFillOrder(
            order,
            local.swapRouter!,
            srcInfo.address,
            srcAmount,
            local.swapData!
          );
          render({ dryRun: true, ...encoded }, renderOpts(opts));
          process.exit(0);
        }

        const ok = await confirm('Proceed with swap-and-fill?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const receipt = await client.optionBook.swapAndFillOrder(
          order,
          local.swapRouter!,
          srcInfo.address,
          srcAmount,
          local.swapData!
        );
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
    .command('cancel')
    .description('Cancel an order (maker-side)')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);

        render(summarizeOrder(order, Number(local.orderIndex)), renderOpts(opts));

        if (opts.dryRun) {
          const sim = await client.optionBook.callStaticCancelOrder(order);
          render(
            {
              dryRun: true,
              success: sim.success,
              gasEstimate: sim.gasEstimate.toString(),
              gasLimitWithBuffer: sim.gasLimitWithBuffer.toString(),
              error: sim.error?.message,
            },
            renderOpts(opts)
          );
          process.exit(0);
        }

        const ok = await confirm('Proceed with cancel?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const receipt = await client.optionBook.cancelOrder(order);
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
// Fees / referrer
// ---------------------------------------------------------------------------

function registerFees(grp: Command): void {
  grp
    .command('fees')
    .description('Get the accrued fee balance for (token, referrer)')
    .requiredOption('--token <symbol-or-addr>', 'token symbol or address')
    .option('--referrer <addr>', 'referrer address (defaults to signer)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string; referrer?: string }>();
      try {
        const res = getClient(opts);
        const { client } = res;
        const tokenInfo = resolveTokenAddress(client, local.token);
        let referrer = local.referrer ?? (opts.referrer as string | undefined);
        if (!referrer) {
          requireSigner(res);
          referrer = await client.signer!.getAddress();
        }
        const amount = await client.optionBook.getFees(tokenInfo.address, referrer);
        render(
          {
            token: tokenInfo.address,
            symbol: tokenInfo.symbol,
            referrer,
            amount: amount.toString(),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('claimable-fees')
    .description('List all claimable referrer fees across configured tokens')
    .option('--address <addr>', 'referrer address (defaults to signer)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address?: string }>();
      try {
        const res = getClient(opts);
        const { client } = res;
        let addr = local.address;
        if (!addr) {
          requireSigner(res);
          addr = await client.signer!.getAddress();
        }
        const fees = await client.optionBook.getAllClaimableFees(addr);
        const rows = fees.map((f) => ({
          token: f.token,
          symbol: f.symbol,
          decimals: f.decimals,
          amount: f.amount.toString(),
        }));
        render(rows, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('claim')
    .description('Claim accrued referrer fees for one token')
    .requiredOption('--token <symbol-or-addr>', 'token symbol or address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;
        const tokenInfo = resolveTokenAddress(client, local.token);
        const signerAddr = await client.signer!.getAddress();
        const accrued = await client.optionBook.getFees(tokenInfo.address, signerAddr);
        render(
          {
            token: tokenInfo.address,
            symbol: tokenInfo.symbol,
            referrer: signerAddr,
            amountToClaim: accrued.toString(),
          },
          renderOpts(opts)
        );

        if (opts.dryRun) {
          render({ dryRun: true, action: 'claimFees', token: tokenInfo.address }, renderOpts(opts));
          process.exit(0);
        }

        const ok = await confirm('Proceed with claim?', {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const receipt = await client.optionBook.claimFees(tokenInfo.address);
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
    .command('claim-all')
    .description('Claim accrued referrer fees for every token with a non-zero balance')
    .option('--address <addr>', 'referrer address (defaults to signer)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address?: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;
        const addr = local.address ?? (await client.signer!.getAddress());
        const fees = await client.optionBook.getAllClaimableFees(addr);
        if (fees.length === 0) {
          render({ message: 'No claimable fees', referrer: addr }, renderOpts(opts));
          return;
        }
        render(
          fees.map((f) => ({
            token: f.token,
            symbol: f.symbol,
            amount: f.amount.toString(),
          })),
          renderOpts(opts)
        );

        if (opts.dryRun) {
          render({ dryRun: true, action: 'claimAllFees', tokens: fees.map((f) => f.symbol) }, renderOpts(opts));
          process.exit(0);
        }

        const ok = await confirm(`Proceed claiming ${fees.length} token(s)?`, {
          yes: opts.yes,
          dryRun: opts.dryRun,
        });
        if (!ok) process.exit(3);

        const results = await client.optionBook.claimAllFees(addr);
        const rows = results.map((r) => ({
          symbol: r.symbol,
          amount: r.amount.toString(),
          txHash: r.receipt?.hash,
          status: r.receipt?.status,
          error: r.error?.message,
        }));
        render(rows, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('referrer-fee-split')
    .description('Get the referrer fee split in basis points (read-only)')
    .requiredOption('--referrer <addr>', 'referrer address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ referrer: string }>();
      try {
        const { client } = getClient(opts);
        const bps = await client.optionBook.getReferrerFeeSplit(local.referrer);
        render({ referrer: local.referrer, feeSplitBps: bps.toString() }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Static reflection (read-only)
// ---------------------------------------------------------------------------

function registerStatic(grp: Command): void {
  grp
    .command('static-fill')
    .description('Simulate filling an order (callStatic, no broadcast)')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .option('--num-contracts <n>', 'human-readable number of contracts (passes through to preview)')
    .option('--collateral <n>', 'human-readable collateral amount to spend')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string; numContracts?: string; collateral?: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;
        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const collateralAmount = computeCollateralAmount(order, client, local);
        const result = await client.optionBook.callStaticFillOrder(order, collateralAmount);
        render(
          {
            success: result.success,
            gasEstimate: result.gasEstimate.toString(),
            gasLimitWithBuffer: result.gasLimitWithBuffer.toString(),
            error: result.error?.message,
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('static-cancel')
    .description('Simulate cancelling an order (callStatic, no broadcast)')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string }>();
      try {
        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;
        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const result = await client.optionBook.callStaticCancelOrder(order);
        render(
          {
            success: result.success,
            gasEstimate: result.gasEstimate.toString(),
            gasLimitWithBuffer: result.gasLimitWithBuffer.toString(),
            error: result.error?.message,
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('hash-order')
    .description('Get the EIP-712 hash of an order')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string }>();
      try {
        const { client } = getClient(opts);
        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const hash = await client.optionBook.hashOrder(order);
        render({ hash }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('compute-nonce')
    .description('Compute the on-chain nonce for an order')
    .requiredOption('--order-index <n>', 'index into the live orders array')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ orderIndex: string }>();
      try {
        const { client } = getClient(opts);
        const orders = await fetchOrdersOnce(client);
        const order = resolveOrderByIndex(orders, local.orderIndex);
        const nonce = await client.optionBook.computeNonce(order);
        render({ nonce: nonce.toString() }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('eip712-domain')
    .description('Get the OptionBook EIP-712 domain')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const { client } = getClient(opts);
        const domain = await client.optionBook.getEip712Domain();
        render(
          {
            fields: domain.fields,
            name: domain.name,
            version: domain.version,
            chainId: domain.chainId.toString(),
            verifyingContract: domain.verifyingContract,
            salt: domain.salt,
            extensions: domain.extensions.map((e) => e.toString()),
          },
          renderOpts(opts)
        );
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}

