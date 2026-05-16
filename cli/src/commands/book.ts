import type { Command } from 'commander';
import { MaxUint256 } from 'ethers';
import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { render, renderError } from '../output.js';
import { confirm } from '../confirm.js';

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
  return orders[idx]!;
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
  const hasCollateral = flags.collateral !== undefined && flags.collateral !== '';
  const hasNumContracts = flags.numContracts !== undefined && flags.numContracts !== '';
  if (hasCollateral && hasNumContracts) {
    throw new Error(
      '--collateral and --num-contracts are mutually exclusive. Pass exactly one'
    );
  }
  if (hasCollateral) {
    const decimals = collateralDecimalsFromOrder(order, client);
    return client.utils.toBigInt(flags.collateral!, decimals);
  }
  if (hasNumContracts) {
    // numContracts is denominated in collateral decimals,
    // pricePerContract is 8-decimal. premium = numContracts * price / 1e8
    const decimals = collateralDecimalsFromOrder(order, client);
    const numContractsRaw = client.utils.toBigInt(flags.numContracts!, decimals);
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

/**
 * Currently only USDC-collateralized fills are supported
 * TODO: WETH and cbBTC fill support will roll out in a future release
 * 
 */
function assertUsdcCollateral(
  order: OrderWithSignature,
  client: GetClientResult['client']
): void {
  const orderCollateral = order.rawApiData?.collateral?.toLowerCase();
  const usdc = client.chainConfig.tokens.USDC!;
  if (orderCollateral !== usdc.address.toLowerCase()) {
    throw new Error(
      `Only USDC-collateralized fills are supported in this version ` +
        `This order uses ${order.rawApiData?.collateral ?? '<unknown>'} as collateral. ` +
        `WETH and cbBTC fill support will roll out in a future release.`
    );
  }
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
    .description('OptionBook orderflow: list orders, preview, fill');

  registerReads(grp);
  registerCheck(grp);
  registerWrites(grp);
}

// ---------------------------------------------------------------------------
// Pre-trade liquidity check
// ---------------------------------------------------------------------------

interface CheckParams {
  underlying: 'ETH' | 'BTC';
  type: 'PUT' | 'CALL';
  strike: number;
  expiry: number;
  direction: 'buy' | 'sell';
  size?: number;
}

interface MatchingOrder {
  index: number;
  ticker: string;
  type: 'PUT' | 'CALL';
  strike: number;
  expiry: number;
  expiryDate: string;
  side: 'BID' | 'ASK';
  price: number;
  availableContracts: number;
  maker: string;
}

interface NearbyStrike {
  strike: number;
  priceDiff: string;
  bestPrice: number;
  availableContracts: number;
  orderIndex: number;
}

interface CheckResult {
  recommendation: 'orderbook' | 'rfq';
  reason: string;
  params: CheckParams;
  orderbookOrders: MatchingOrder[];
  bestPrice: number | null;
  availableSize: number | null;
  partialFillAvailable: boolean;
  partialSize: number | null;
  nearbyStrikes: NearbyStrike[];
  nextStep: string;
}

function formatCheckTicker(underlying: string, expiry: number, strike: number, type: string): string {
  const expiryDate = new Date(expiry * 1000);
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const day = expiryDate.getUTCDate();
  const month = months[expiryDate.getUTCMonth()];
  const year = expiryDate.getUTCFullYear().toString().slice(-2);
  return `${underlying}-${day}${month}${year}-${strike}-${type === 'PUT' ? 'P' : 'C'}`;
}

function registerCheck(grp: Command): void {
  grp
    .command('check')
    .description('Pre-trade liquidity check: scan orderbook for matching strike/expiry/type and recommend orderbook vs RFQ')
    .requiredOption('--underlying <asset>', 'underlying asset (ETH|BTC)')
    .requiredOption('--type <type>', 'option type (PUT|CALL)')
    .requiredOption('--strike <price>', 'target strike price in USD')
    .requiredOption('--expiry <ts>', 'expiry unix timestamp')
    .requiredOption('--direction <dir>', 'buy = you buy the option, sell = you sell the option')
    .option('--size <contracts>', 'desired contract size (if omitted, shows all available)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        underlying: string;
        type: string;
        strike: string;
        expiry: string;
        direction: string;
        size?: string;
      }>();

      // Validate params upfront
      // CLI surfaces the same errors as the script it ports
      const underlying = local.underlying.toUpperCase();
      const type = local.type.toUpperCase();
      const direction = local.direction.toLowerCase();
      const strike = parseFloat(local.strike);
      const expiry = parseInt(local.expiry, 10);
      const size = local.size !== undefined ? parseFloat(local.size) : undefined;

      const missing: string[] = [];
      if (!['ETH', 'BTC'].includes(underlying)) missing.push('--underlying (ETH|BTC)');
      if (!['PUT', 'CALL'].includes(type)) missing.push('--type (PUT|CALL)');
      if (!strike || Number.isNaN(strike)) missing.push('--strike (price)');
      if (!expiry || Number.isNaN(expiry)) missing.push('--expiry (unix timestamp)');
      if (!['buy', 'sell'].includes(direction)) missing.push('--direction (buy|sell)');
      if (size !== undefined && Number.isNaN(size)) missing.push('--size (number)');

      const params: CheckParams = {
        underlying: underlying as 'ETH' | 'BTC',
        type: type as 'PUT' | 'CALL',
        strike,
        expiry,
        direction: direction as 'buy' | 'sell',
        ...(size !== undefined ? { size } : {}),
      };

      if (missing.length > 0) {
        renderError(
          new Error(`Missing or invalid required parameters: ${missing.join(', ')}`),
          renderOpts(opts)
        );
        process.exit(1);
      }

      try {
        const { client } = getClient(opts);
        const now = Math.floor(Date.now() / 1000);

        // Fetch all orders
        const orders = await client.api.fetchOrders();

        // Extract order data helper
        // numeric scaling (1e8 for strike/price/availableAmount) matches
        const extractOrderData = (o: OrderWithSignature, index: number): MatchingOrder | null => {
          const raw = o.rawApiData as Record<string, unknown> | undefined;
          const isCall = (raw?.isCall as boolean | undefined) ?? true;
          // Use strikes[0] (SDK deprecated `strikePrice` for multi-leg correctness)
          const rawStrikes = (raw?.strikes as unknown[] | undefined) ?? [];
          const firstStrike = rawStrikes[0];
          const strike = firstStrike ? Number(firstStrike) / 1e8 : 0;
          const expiry = o.order?.expiry ? Number(o.order.expiry) : 0;
          const price = o.order?.price ? Number(o.order.price) / 1e8 : 0;
          const availableAmount = o.availableAmount ? Number(o.availableAmount) / 1e8 : 0;
          const isBuyer = o.order?.isBuyer ?? false;
          const orderExpiry = (raw?.orderExpiryTimestamp as number | undefined) ?? 0;

          // Skip expired orders
          if (orderExpiry > 0 && orderExpiry < now) {
            return null;
          }

          const optionType: 'PUT' | 'CALL' = isCall ? 'CALL' : 'PUT';

          return {
            index,
            // Preserve OpenClaw quirk: ticker formatter hardcodes 'ETH'. Don't
            // "fix" this — number alignment requires byte-for-byte parity.
            ticker: formatCheckTicker('ETH', expiry, strike, optionType),
            type: optionType,
            strike,
            expiry,
            expiryDate: new Date(expiry * 1000).toISOString(),
            side: isBuyer ? 'BID' : 'ASK',
            price,
            availableContracts: availableAmount,
            maker: o.makerAddress ?? '',
          };
        };

        // Filter orders by type and expiry
        const filteredOrders: MatchingOrder[] = [];

        orders.forEach((o, index) => {
          const orderData = extractOrderData(o, index);
          if (!orderData) return;

          if (orderData.type !== params.type) return;
          if (orderData.expiry !== params.expiry) return;

          // Direction match: buy -> need ASK (sellers); sell -> need BID (buyers)
          const matchesSide =
            params.direction === 'buy'
              ? orderData.side === 'ASK'
              : orderData.side === 'BID';
          if (!matchesSide) return;

          filteredOrders.push(orderData);
        });

        // Exact strike matches
        const exactMatches = filteredOrders.filter((o) => o.strike === params.strike);

        // Nearby strikes (within 5%)
        const strikeTolerance = params.strike * 0.05;
        const nearbyMatches = filteredOrders.filter(
          (o) =>
            o.strike !== params.strike &&
            Math.abs(o.strike - params.strike) <= strikeTolerance
        );

        // Aggregate nearby strikes
        const nearbyStrikes: NearbyStrike[] = [];
        const strikeMap = new Map<number, MatchingOrder[]>();
        nearbyMatches.forEach((o) => {
          if (!strikeMap.has(o.strike)) strikeMap.set(o.strike, []);
          strikeMap.get(o.strike)!.push(o);
        });
        strikeMap.forEach((ordersAtStrike, strikeKey) => {
          const bestOrder = ordersAtStrike.reduce(
            (best, curr) =>
              params.direction === 'buy'
                ? curr.price < best.price
                  ? curr
                  : best
                : curr.price > best.price
                  ? curr
                  : best,
            ordersAtStrike[0]
          );
          const totalContracts = ordersAtStrike.reduce(
            (sum, o) => sum + o.availableContracts,
            0
          );
          const priceDiff = (((strikeKey - params.strike) / params.strike) * 100).toFixed(1);
          nearbyStrikes.push({
            strike: strikeKey,
            priceDiff: `${parseFloat(priceDiff) >= 0 ? '+' : ''}${priceDiff}%`,
            bestPrice: bestOrder.price,
            availableContracts: totalContracts,
            orderIndex: bestOrder.index,
          });
        });
        nearbyStrikes.sort(
          (a, b) =>
            Math.abs(a.strike - params.strike) - Math.abs(b.strike - params.strike)
        );

        // Totals + best price for exact matches
        const totalAvailable = exactMatches.reduce(
          (sum, o) => sum + o.availableContracts,
          0
        );
        const bestPrice =
          exactMatches.length > 0
            ? params.direction === 'buy'
              ? Math.min(...exactMatches.map((o) => o.price))
              : Math.max(...exactMatches.map((o) => o.price))
            : null;

        // Recommendation logic — lifted from OpenClaw
        let recommendation: 'orderbook' | 'rfq';
        let reason: string;
        let nextStep: string;
        let partialFillAvailable = false;
        let partialSize: number | null = null;

        if (exactMatches.length > 0) {
          if (params.size && params.size > totalAvailable) {
            partialFillAvailable = true;
            partialSize = totalAvailable;
            recommendation = 'orderbook';
            reason = `Found ${totalAvailable.toFixed(4)} contracts at strike $${params.strike} (you requested ${params.size}). Partial fill available via orderbook, or use RFQ for full amount.`;
            nextStep = `Preview fill: thetanuts book preview --order-index ${exactMatches[0].index} --collateral <amount>`;
          } else {
            recommendation = 'orderbook';
            reason = `Found orderbook liquidity at strike $${params.strike}. Best ${params.direction === 'buy' ? 'ask' : 'bid'} price: $${bestPrice?.toFixed(2)}. Available: ${totalAvailable.toFixed(4)} contracts. This will execute instantly.`;
            nextStep = `Preview fill: thetanuts book preview --order-index ${exactMatches[0].index} --collateral <amount>`;
          }
        } else if (nearbyStrikes.length > 0) {
          recommendation = 'rfq';
          reason = `No orderbook liquidity at exact strike $${params.strike}. Nearby strikes available: ${nearbyStrikes
            .slice(0, 3)
            .map((s) => `$${s.strike} (${s.priceDiff})`)
            .join(', ')}. Use RFQ for your exact strike, or consider nearby strikes.`;
          nextStep = `thetanuts rfq build --underlying ${params.underlying} --type ${params.type} --strike ${params.strike} --expiry ${params.expiry} --contracts <n> --direction ${params.direction}`;
        } else {
          recommendation = 'rfq';
          reason = `No orderbook liquidity at strike $${params.strike} or nearby. Submit an RFQ — market makers respond within 45 seconds (default deadline).`;
          nextStep = `thetanuts rfq build --underlying ${params.underlying} --type ${params.type} --strike ${params.strike} --expiry ${params.expiry} --contracts <n> --direction ${params.direction}`;
        }

        const result: CheckResult = {
          recommendation,
          reason,
          params,
          orderbookOrders: exactMatches.slice(0, 10),
          bestPrice,
          availableSize: totalAvailable > 0 ? totalAvailable : null,
          partialFillAvailable,
          partialSize,
          nearbyStrikes: nearbyStrikes.slice(0, 5),
          nextStep,
        };

        render(result, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function registerReads(grp: Command): void {
  grp
    .command('orders')
    .description('List open maker orders')
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
        assertUsdcCollateral(order, client);
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
            process.stderr.write('WARNING: approving MaxUint256. The spender will be able to move any amount.\n');
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
}
