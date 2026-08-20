import type { Command } from 'commander';
import { Interface, MaxUint256, ZeroAddress } from 'ethers';
import {
  OPTION_BOOK_ABI,
  type OrderWithSignature,
} from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { render, renderError, buildTxReceiptPayload, fetchEthUsdSafe } from '../output.js';
import { confirm } from '../confirm.js';
import {
  computePayoutSummary,
  computeScenarios,
  type StructureType,
  type CollateralToken,
} from '../payout.js';
import {
  formatTicker,
  formatStrikeUsd,
  formatUsd,
  formatExpiry,
  tokenSymbolByAddress,
  underlyingSymbolByPriceFeed,
} from '../format.js';
import {
  ORDER_PRICE_DECIMALS,
  bookOrderIneligibility,
  cashSettledImplementationSet,
  isEligibleBookOrder,
  type BookEligibilityPolicy,
} from '../bookEligibility.js';
import { bookPremiumCeiling, withActualBookPremium } from '../bookPreview.js';
import { findSignedOrder } from '../bookOrderIdentity.js';
import { findMatchingOrders, resolvePriceFeed } from '../bookMatch.js';
import {
  computeCheckResult,
  type CheckParams,
  type CheckResultCore,
} from '../bookCheck.js';

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

function eligibilityPolicy(
  client: GetClientResult['client'],
  direction: 'buy' | 'sell' = 'buy'
): BookEligibilityPolicy {
  const usdc = client.chainConfig.tokens.USDC;
  if (!usdc) throw new Error('USDC is missing from the active chain configuration.');
  return {
    usdcAddress: usdc.address,
    cashSettledImplementations: cashSettledImplementationSet(
      client.chainConfig.implementations
    ),
    now: Math.floor(Date.now() / 1000),
    direction,
  };
}

function eligibleOrders(
  orders: OrderWithSignature[],
  client: GetClientResult['client'],
  direction: 'buy' | 'sell' = 'buy'
): OrderWithSignature[] {
  const policy = eligibilityPolicy(client, direction);
  return orders.filter((order) => isEligibleBookOrder(order, policy));
}

function assertEligibleOrder(
  order: OrderWithSignature,
  client: GetClientResult['client'],
  direction: 'buy' | 'sell' = 'buy'
): void {
  const reason = bookOrderIneligibility(order, eligibilityPolicy(client, direction));
  if (reason) {
    throw new Error(
      `Order is not eligible for a cash-settled USDC ${direction}: ${reason}. ` +
        'Run `thetanuts book orders` and select one of the displayed orders.'
    );
  }
}

function previewBookFill(
  client: GetClientResult['client'],
  order: OrderWithSignature,
  collateralAmount?: bigint
) {
  return withActualBookPremium(
    client.optionBook.previewFillOrder(order, collateralAmount)
  );
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

/**
 * Force-refetch live orders, bypassing the cache. Used by `book fill` right
 * before broadcast to close the staleness window between confirm prompt and
 * tx submission — mirrors the dApp's 30s React Query refetch behaviour
 * (see thetanuts-1840 audit, `useOrders.ts`).
 */
async function fetchOrdersFresh(
  client: GetClientResult['client']
): Promise<OrderWithSignature[]> {
  const fresh = await client.api.fetchOrders();
  _ordersCache = fresh;
  return fresh;
}

interface ReceiptLogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

/** Extract the option created by OptionBook.fillOrder from the mined receipt. */
function extractOrderFilledEvent(
  receipt: { logs: readonly ReceiptLogLike[] },
  optionBookAddress: string
): Record<string, unknown> | null {
  const iface = new Interface(OPTION_BOOK_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== optionBookAddress.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.name !== 'OrderFilled') continue;
      return {
        optionAddress: String(parsed.args['optionAddress']),
        buyer: String(parsed.args['buyer']),
        seller: String(parsed.args['seller']),
        premiumAmountRaw: BigInt(parsed.args['premiumAmount']).toString(),
        feeCollectedRaw: BigInt(parsed.args['feeCollected']).toString(),
        // Surfaced so a fill can be audited for referral attribution without
        // decoding the receipt on a block explorer.
        referrer: String(parsed.args['referrer']),
        referralFeePaidRaw: BigInt(parsed.args['referralFeePaid']).toString(),
        sellerWasMaker: Boolean(parsed.args['sellerWasMaker']),
      };
    } catch {
      // Ignore unrelated/malformed logs; receipt success must still render.
    }
  }
  return null;
}

function tickerForOrder(
  order: OrderWithSignature,
  client: GetClientResult['client']
): string | undefined {
  const raw = order.rawApiData;
  if (!raw || raw.strikes.length === 0) return undefined;
  const underlying = underlyingSymbolByPriceFeed(
    raw.priceFeed,
    client.chainConfig.priceFeeds
  );
  if (!underlying) return undefined;
  return formatTicker(
    underlying,
    Number(order.order.expiry),
    raw.strikes.map((strike) => Number(strike) / 1e8),
    raw.isCall ? 'CALL' : 'PUT'
  );
}

function resolveOrderByIndex(
  orders: OrderWithSignature[],
  rawIndex: string | number | undefined
): OrderWithSignature {
  if (rawIndex === undefined || rawIndex === null || rawIndex === '') {
    throw new Error('--order-index is required');
  }
  if (typeof rawIndex === 'string' && rawIndex.startsWith('--')) {
    throw new Error(
      `Invalid --order-index: "${rawIndex}" looks like a flag, not a number. ` +
        'Did the value resolve to empty (e.g. an unset shell variable like $INDEX)?'
    );
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
 * on a fill.
 *   --collateral <human>           e.g. 10 USDC -> 10 * 10^decimals
 *
 * Returns `undefined` when the flag wasn't passed; the SDK then fills max.
 * Number-of-contracts is computed automatically by the SDK from this amount
 * and the order's price-per-contract.
 */
function computeCollateralAmount(
  order: OrderWithSignature,
  client: GetClientResult['client'],
  flags: { collateral?: string }
): bigint | undefined {
  const hasCollateral = flags.collateral !== undefined && flags.collateral !== '';
  if (hasCollateral) {
    const decimals = collateralDecimalsFromOrder(order, client);
    return client.utils.toBigInt(flags.collateral!, decimals);
  }
  return undefined;
}

function collateralDecimalsFromOrder(
  order: OrderWithSignature,
  client: GetClientResult['client']
): number {
  const addr = order.rawApiData?.collateral?.toLowerCase();
  if (!addr) {
    throw new Error(
      'book preview: order is missing rawApiData.collateral. Cannot determine ' +
        'decimal scale — refusing to fall back to 6-decimal default (TNU-AUDIT-0080).',
    );
  }
  for (const cfg of Object.values(client.chainConfig.tokens)) {
    if (cfg.address.toLowerCase() === addr) return cfg.decimals;
  }
  // Fail loudly instead of silently rendering at 6-decimal — a future order with
  // an unknown collateral token would otherwise mislead the trader.
  throw new Error(
    `book preview: unknown collateral token ${addr}. ` +
      'Add it to client.chainConfig.tokens before previewing (TNU-AUDIT-0080).',
  );
}

/**
 * Map (strikeCount, isCall) to a CLI structure label.
 *
 * Mirrors `getStructureType` in commands/rfq.ts but for the book side — books
 * never mark a 4-strike order as iron-condor (the indexer doesn't expose that
 * distinction on the order), so 4-strike CALL/PUT here falls back to the
 * matching CONDOR variant. If a maker actually signed an iron-condor order
 * we'll mis-label as CALL_CONDOR / PUT_CONDOR; payout math is identical at
 * the SDK `calculateCollateralRequired` level for the dApp-supported cases,
 * so payout fields stay sound — only the structureType label drifts.
 *
 * IRON_CONDOR detection: dApp-side orders for iron-condor would surface as
 * `isCall=true` with 4 strikes (the SDK treats it as a CALL family for
 * implementation lookup); we still default to CALL_CONDOR labelling. If the
 * indexer ever adds a `structureKind` field this is the place to plumb it.
 */
function deriveStructureType(strikeCount: number, isCall: boolean): StructureType {
  switch (strikeCount) {
    case 1:
      return isCall ? 'CALL' : 'PUT';
    case 2:
      return isCall ? 'CALL_SPREAD' : 'PUT_SPREAD';
    case 3:
      return isCall ? 'CALL_FLY' : 'PUT_FLY';
    case 4:
      return isCall ? 'CALL_CONDOR' : 'PUT_CONDOR';
    default:
      throw new Error(`Unsupported strike count from preview: ${strikeCount}`);
  }
}

/**
 * Map collateral token address → CollateralToken symbol the payout helper
 * understands. Anything that isn't WETH falls back to 'USDC'; eligible book
 * orders are cash-settled and USDC-only before this helper is reached.
 */
function collateralTokenSymbol(
  collateralAddress: string,
  client: GetClientResult['client']
): CollateralToken {
  const addr = collateralAddress.toLowerCase();
  const weth = client.chainConfig.tokens.WETH?.address.toLowerCase();
  if (weth && addr === weth) return 'WETH';
  return 'USDC';
}

/**
 * Build the payout-helper arg bag from a fill preview + order. Book fills are
 * always BUYS from the taker's perspective (taker pays premium, gains long
 * intrinsic). `reservePrice` is the order's fixed `pricePerContract` — book
 * orders are firm quotes, not ceilings, so we always pass it through.
 *
 * Returns null when the preview lacks the data we need (defensive — never
 * crash a render path over payout enrichment).
 */
function buildPayoutArgsFromPreview(
  preview: {
    numContracts: bigint;
    pricePerContract: bigint;
    collateralToken: string;
    strikes: bigint[];
    isCall: boolean;
  },
  order: OrderWithSignature,
  client: GetClientResult['client']
): {
  structureType: StructureType;
  collateralToken: CollateralToken;
  strikes: number[];
  direction: 'buy';
  contracts: number;
  reservePrice: number;
} | null {
  if (preview.strikes.length === 0 || preview.numContracts === 0n) return null;
  const collTokenSym = collateralTokenSymbol(preview.collateralToken, client);
  const contractDecimals = collateralDecimalsFromOrder(order, client);

  // Strikes from the OptionBook ABI are 8-decimal scaled bigints.
  const strikesHuman = preview.strikes.map((s) => Number(s) / 1e8);
  // OptionBook contract quantities use collateral decimals (6 for the CLI's
  // supported USDC orders), not PRICE_DECIMALS.
  const contractsHuman =
    Number(preview.numContracts) / 10 ** contractDecimals;
  // OptionBook prices always use PRICE_DECIMALS (8), independently of the
  // collateral token's ERC-20 decimals.
  const reservePriceHuman =
    Number(preview.pricePerContract) / 10 ** ORDER_PRICE_DECIMALS;

  return {
    structureType: deriveStructureType(preview.strikes.length, preview.isCall),
    collateralToken: collTokenSym,
    strikes: strikesHuman,
    direction: 'buy',
    contracts: contractsHuman,
    reservePrice: reservePriceHuman,
  };
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
    implementation: order.rawApiData?.implementation,
    settlement: 'cash',
    orderExpiryTimestamp: order.rawApiData?.orderExpiryTimestamp,
  };
}

/**
 * Table-mode rendering of an order: replaces raw on-chain decimals with
 * humanized columns. JSON output continues to call `summarizeOrder` so
 * scripted consumers see the same byte-stable raw values as before.
 *
 * Columns: index | maker | ticker | strike | premium | expiry | available
 * Plus a derived collateralSymbol when we can resolve it.
 */
function summarizeOrderHuman(
  order: OrderWithSignature,
  client: GetClientResult['client'],
  index?: number
): Record<string, unknown> {
  const rawStrikes = order.rawApiData?.strikes ?? [];
  const strikesUsd = rawStrikes.map((s) => Number(s) / 1e8);
  const isCall = order.rawApiData?.isCall ?? true;
  const type: 'PUT' | 'CALL' = isCall ? 'CALL' : 'PUT';
  const expiry = Number(order.order.expiry);
  const underlyingSym =
    underlyingSymbolByPriceFeed(order.rawApiData?.priceFeed, client.chainConfig.priceFeeds) ??
    'UNKNOWN';
  // TNU-AUDIT-0054: previously hardcoded /1e6, which mis-rendered premiums
  // by 100x against the SDK's 8-decimal pricing convention. Derive scale from
  // the order's collateral token so the table matches what `book check` and
  // `humanizePreview` show pre-broadcast.
  const collDec = collateralDecimalsFromOrder(order, client);
  const priceScale = 10 ** ORDER_PRICE_DECIMALS;
  const collScale = 10 ** collDec;
  const premiumHuman = Number(order.order.price) / priceScale;
  const availableHuman = Number(order.availableAmount) / collScale;
  const collSym =
    tokenSymbolByAddress(order.rawApiData?.collateral, client.chainConfig.tokens) ?? 'UNKNOWN';
  const implAddress = order.rawApiData?.implementation?.toLowerCase();
  const implementation = implAddress
    ? client.chainConfig.optionImplementations[implAddress]?.name ?? implAddress
    : 'UNKNOWN';

  return {
    ...(index !== undefined ? { index } : {}),
    maker: order.order.maker,
    ticker: formatTicker(underlyingSym, expiry, strikesUsd, type),
    strike: formatStrikeUsd(strikesUsd),
    premium: formatUsd(premiumHuman),
    expiry: formatExpiry(expiry),
    available: formatUsd(availableHuman),
    collateralSymbol: collSym,
    implementation,
    settlement: 'cash',
  };
}

/**
 * Humanized header for `book preview`: rebuilds the SDK preview shape with
 * dollar-formatted strings and a derived ticker. Used only in table mode;
 * JSON output preserves the raw SDK preview object.
 */
function humanizePreview(
  preview: {
    numContracts: bigint;
    maxContracts: bigint;
    collateralToken: string;
    pricePerContract: bigint;
    totalCollateral: bigint;
    referrer: string;
    maker: string;
    expiry: bigint;
    isCall: boolean;
    strikes: bigint[];
  },
  order: OrderWithSignature,
  client: GetClientResult['client']
): Record<string, unknown> {
  const strikesUsd = preview.strikes.map((s) => Number(s) / 1e8);
  const type: 'PUT' | 'CALL' = preview.isCall ? 'CALL' : 'PUT';
  const expiry = Number(preview.expiry);
  const underlyingSym =
    underlyingSymbolByPriceFeed(order.rawApiData?.priceFeed, client.chainConfig.priceFeeds) ??
    'UNKNOWN';
  const collDec = collateralDecimalsFromOrder(order, client);
  const collSym =
    tokenSymbolByAddress(preview.collateralToken, client.chainConfig.tokens) ?? 'UNKNOWN';
  // Contract quantities use collateral decimals (USDC = 6); only strikes and
  // prices use the protocol's fixed 8-decimal scale.
  const numContractsHuman = Number(preview.numContracts) / 10 ** collDec;
  const maxContractsHuman = Number(preview.maxContracts) / 10 ** collDec;
  const pricePerContractHuman =
    Number(preview.pricePerContract) / 10 ** ORDER_PRICE_DECIMALS;
  const totalCollateralHuman = Number(preview.totalCollateral) / 10 ** collDec;

  return {
    ticker: formatTicker(underlyingSym, expiry, strikesUsd, type),
    maker: preview.maker,
    referrer: preview.referrer,
    collateralToken: preview.collateralToken,
    collateralSymbol: collSym,
    numContracts: numContractsHuman.toString(),
    maxContracts: maxContractsHuman.toString(),
    strikes: formatStrikeUsd(strikesUsd),
    pricePerContract: formatUsd(pricePerContractHuman, 4),
    totalCollateral: formatUsd(totalCollateralHuman),
    expiry: formatExpiry(expiry),
  };
}

// ---------------------------------------------------------------------------
// Selector helper — Fix 3: pick an order by (underlying, type, strike(s),
// expiry) instead of a volatile index. The legacy --order-index path still
// works as an escape hatch (with a stderr deprecation hint).
// ---------------------------------------------------------------------------

interface SelectorFlags {
  orderIndex?: string;
  underlying?: string;
  type?: string;
  strike?: string;
  strikes?: string;
  expiry?: string;
  strict?: boolean;
}

/**
 * Resolve an order from either --order-index OR the
 * (--underlying/--type/--strike(s)/--expiry) selector group. Exactly one path
 * must be specified.
 *
 * Exit codes:
 *   - 2 when no selector args at all (or both paths supplied)
 *   - 4 when zero live orders match the selector
 *
 * For multi-match, picks the cheapest pricePerContract (book fills always
 * BUY per CLAUDE.md). `--strict` turns multi-match into a hard error instead.
 */
function resolveOrderBySelector(
  orders: OrderWithSignature[],
  client: GetClientResult['client'],
  flags: SelectorFlags
): OrderWithSignature {
  const hasIndex = flags.orderIndex !== undefined && flags.orderIndex !== '';
  const hasSelectorBits =
    (flags.underlying !== undefined && flags.underlying !== '') ||
    (flags.type !== undefined && flags.type !== '') ||
    (flags.strike !== undefined && flags.strike !== '') ||
    (flags.strikes !== undefined && flags.strikes !== '') ||
    (flags.expiry !== undefined && flags.expiry !== '');

  if (!hasIndex && !hasSelectorBits) {
    const err = new Error(
      'Pick an order: pass either --order-index <n>, or the selector group ' +
        '(--underlying <ETH|BTC> --type <PUT|CALL> --strike <usd> --expiry <unix-seconds>). ' +
        'The selector group is preferred — --order-index is volatile across calls.'
    );
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }
  if (hasIndex && hasSelectorBits) {
    const err = new Error(
      '--order-index is mutually exclusive with --underlying/--type/--strike(s)/--expiry. Pick one path.'
    );
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }

  if (hasIndex) {
    process.stderr.write(
      'Note: --order-index is volatile across calls. Prefer --underlying/--type/--strike/--expiry for stable selection.\n'
    );
    return resolveOrderByIndex(orders, flags.orderIndex);
  }

  // Selector path — validate.
  const missing: string[] = [];
  if (!flags.underlying) missing.push('--underlying');
  if (!flags.type) missing.push('--type');
  if (!flags.strike && !flags.strikes) missing.push('--strike (or --strikes)');
  if (!flags.expiry) missing.push('--expiry');
  if (missing.length > 0) {
    const err = new Error(
      `Selector path is incomplete — missing: ${missing.join(', ')}. ` +
        'Pass all of --underlying, --type, --strike (or --strikes), --expiry.'
    );
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }

  const underlying = flags.underlying!.toUpperCase();
  const type = flags.type!.toUpperCase();
  if (type !== 'PUT' && type !== 'CALL') {
    const err = new Error(`Invalid --type "${flags.type}". Expected PUT or CALL.`);
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }
  const wantStrikesUsd: number[] = flags.strikes
    ? flags.strikes.split(',').map((s) => Number.parseFloat(s.trim()))
    : [Number.parseFloat(flags.strike!)];
  if (wantStrikesUsd.some((n) => Number.isNaN(n) || n <= 0)) {
    const err = new Error(
      `Invalid strikes: ${flags.strikes ?? flags.strike}. Expected positive USD numbers.`
    );
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }
  const wantStrikesRaw = wantStrikesUsd.map((s) => BigInt(Math.round(s * 1e8)));
  const wantExpiry = Number.parseInt(flags.expiry!, 10);
  if (Number.isNaN(wantExpiry) || wantExpiry <= 0) {
    const err = new Error(`Invalid --expiry "${flags.expiry}". Expected unix seconds.`);
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }

  // Resolve underlying -> price feed for matching.
  const feedResult = resolvePriceFeed(underlying, client.chainConfig.priceFeeds);
  if ('error' in feedResult) {
    const err = new Error(feedResult.error.replace('underlying', '--underlying'));
    (err as { exitCode?: number }).exitCode = 2;
    throw err;
  }
  const wantPriceFeed = feedResult.feed;

  // Shared predicate — `book check` uses the same one, so the two commands
  // cannot disagree about what the book holds.
  const matches = findMatchingOrders(orders, {
    priceFeed: wantPriceFeed,
    type,
    strikesRaw: wantStrikesRaw,
    expiry: wantExpiry,
  });

  if (matches.length === 0) {
    const strikeLabel = wantStrikesUsd.join('/');
    const err = new Error(
      `No live order matches underlying=${underlying} type=${type} strike=${strikeLabel} expiry=${wantExpiry}. ` +
        `Run 'thetanuts book orders --underlying ${underlying} --type ${type}' to see what's listed.`
    );
    (err as { exitCode?: number }).exitCode = 4;
    throw err;
  }

  if (matches.length === 1) {
    return matches[0]!;
  }

  // Two implementations can share a strike count, type and expiry (e.g.
  // CALL_CONDOR vs IRON_CONDOR, both 4 strikes). Their payoffs differ, so
  // silently picking the cheaper one would hand the caller a different product
  // than they priced. Make them disambiguate.
  const matchedStructures = new Set(
    matches.map(
      (o) =>
        client.chainConfig.optionImplementations[
          o.rawApiData?.implementation?.toLowerCase() ?? ''
        ]?.name ?? 'UNKNOWN'
    )
  );
  if (matchedStructures.size > 1) {
    const err = new Error(
      `Selector matches more than one structure: ${[...matchedStructures].sort().join(', ')}. ` +
        'These have different payoffs — pass --order-index to pick one explicitly.'
    );
    (err as { exitCode?: number }).exitCode = 4;
    throw err;
  }

  // Multi-match. --strict: hard error. Default: cheapest BUY (lowest price).
  if (flags.strict) {
    const err = new Error(
      `${matches.length} live orders match the selector. Pass --order-index to disambiguate, or drop --strict.`
    );
    (err as { exitCode?: number }).exitCode = 4;
    throw err;
  }
  const chosen = matches.reduce((best, curr) =>
    curr.order.price < best.order.price ? curr : best
  );
  process.stderr.write(
    `Selected order from maker ${chosen.order.maker} (cheapest of ${matches.length} matching).\n`
  );
  return chosen;
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

function registerCheck(grp: Command): void {
  grp
    .command('check')
    .description(
      'Pre-trade liquidity check: scan the orderbook for a matching strike/expiry/type ' +
        '(including strikes that sit on a structure leg) and recommend orderbook vs RFQ'
    )
    .requiredOption('--underlying <asset>', 'underlying asset (e.g. ETH, BTC, SOL)')
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

      const underlying = local.underlying.toUpperCase();
      const type = local.type.toUpperCase();
      const direction = local.direction.toLowerCase();
      const strike = parseFloat(local.strike);
      const expiry = parseInt(local.expiry, 10);
      const size = local.size !== undefined ? parseFloat(local.size) : undefined;

      // Underlying is validated against chain config after the client exists —
      // the old hardcoded ETH|BTC gate made every SOL/DOGE/XRP/BNB/AVAX order
      // on the book unreachable from this command.
      const missing: string[] = [];
      if (!['PUT', 'CALL'].includes(type)) missing.push('--type (PUT|CALL)');
      if (!strike || Number.isNaN(strike)) missing.push('--strike (price)');
      if (!expiry || Number.isNaN(expiry)) missing.push('--expiry (unix timestamp)');
      if (!['buy', 'sell'].includes(direction)) missing.push('--direction (buy|sell)');
      if (size !== undefined && Number.isNaN(size)) missing.push('--size (number)');

      if (missing.length > 0) {
        renderError(
          new Error(`Missing or invalid required parameters: ${missing.join(', ')}`),
          renderOpts(opts)
        );
        process.exit(1);
      }

      const params: CheckParams = {
        underlying,
        type: type as 'PUT' | 'CALL',
        strike,
        expiry,
        direction: direction as 'buy' | 'sell',
        ...(size !== undefined ? { size } : {}),
      };

      try {
        // `referrer` comes along so every command `check` emits carries the
        // one resolved for THIS process. A one-off `--referrer` configures the
        // current invocation only — without this the copied workflow silently
        // falls back to the zero address and the fill earns no credit.
        const { client, referrer } = getClient(opts);

        const feedResult = resolvePriceFeed(underlying, client.chainConfig.priceFeeds);
        if ('error' in feedResult) {
          renderError(new Error(feedResult.error), renderOpts(opts));
          process.exit(1);
          return;
        }

        // Scan the side the caller actually wants. Sells are reported but not
        // executable from the CLI, so `cliExecutable` tells a bot not to try.
        const orders = eligibleOrders(
          await fetchOrdersOnce(client),
          client,
          params.direction
        );

        const core = computeCheckResult(orders, params, {
          priceFeed: feedResult.feed,
          implementations: client.chainConfig.optionImplementations,
          maxContracts: (o) => client.optionBook.calculateMaxContracts(o),
          contractScale: 10 ** (client.chainConfig.tokens.USDC?.decimals ?? 6),
          cliExecutable: params.direction === 'buy',
          ...(referrer !== undefined ? { referrer } : {}),
        });

        render(core, renderOpts(opts));
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
    .description('List executable cash-settled USDC maker asks')
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
        // Canonical CLI book: cash-settled USDC asks only. Assign indices
        // before applying display filters so `--underlying` / `--type` never
        // renumber a row relative to `book preview/fill --order-index`.
        const indexedEligible = eligibleOrders(allOrders, client, 'buy').map(
          (order, index) => ({ order, index })
        );

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

        const filtered = indexedEligible.filter(({ order: o }) => {
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

        // Table mode gets humanized columns (ticker, $-formatted strike/
        // premium/available, ISO expiry). JSON/CSV/YAML stay byte-stable with
        // the raw on-chain decimals scripts depend on.
        const ro = renderOpts(opts);
        const isTable = (ro.output ?? 'table') === 'table';
        const rows = isTable
          ? filtered.map(({ order, index }) => summarizeOrderHuman(order, client, index))
          : filtered.map(({ order, index }) => summarizeOrder(order, index));
        render(rows, ro);
      } catch (err) {
        renderError(err, renderOpts(opts));
        process.exit(1);
      }
    });

  grp
    .command('preview')
    .description('Preview a fill against an order without sending a transaction')
    .option('--order-index <n>', 'index into the live orders array (legacy — prefer the selector flags below)')
    .option('--underlying <asset>', 'ETH or BTC (use with --type/--strike/--expiry instead of --order-index)')
    .option('--type <type>', 'PUT or CALL (use with --underlying/--strike/--expiry)')
    .option('--strike <usd>', 'single strike in USD (vanilla)')
    .option('--strikes <csv>', 'comma-separated strikes in USD (multi-leg)')
    .option('--expiry <ts>', 'unix expiry seconds')
    .option('--strict', 'when multiple orders match the selector, error instead of picking the cheapest')
    .option('--collateral <n>', 'USDC amount to spend on premium (e.g. 1 for $1). Number of contracts is auto-derived from the order price. Omit to preview a max fill.')
    .option(
      '--scenarios',
      'print a 5-row table of (spot at expiry, payout, net P&L) after the preview'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        orderIndex?: string;
        underlying?: string;
        type?: string;
        strike?: string;
        strikes?: string;
        expiry?: string;
        strict?: boolean;
        collateral?: string;
        scenarios?: boolean;
      }>();
      try {
        const { client } = getClient(opts);
        const orders = eligibleOrders(await fetchOrdersOnce(client), client, 'buy');
        const order = resolveOrderBySelector(orders, client, local);
        const collateralAmount = computeCollateralAmount(order, client, local);
        const preview = previewBookFill(client, order, collateralAmount);

        // Enrich with the same payout block `rfq build` emits. Book fills are
        // always BUY from the taker's perspective; the order's pricePerContract
        // is a fixed firm quote so we always have a concrete totalPremium.
        const payoutArgs = buildPayoutArgsFromPreview(preview, order, client);
        const ro = renderOpts(opts);
        const isTable = (ro.output ?? 'table') === 'table';
        const headerPayload: Record<string, unknown> = isTable
          ? humanizePreview(preview, order, client)
          : { ...preview };
        const payload: Record<string, unknown> =
          payoutArgs !== null
            ? { ...headerPayload, payout: computePayoutSummary(payoutArgs) }
            : headerPayload;
        render(payload, ro);

        if (local.scenarios && payoutArgs !== null) {
          const rows = computeScenarios(payoutArgs);
          process.stdout.write('\nScenarios at expiry:\n');
          render(rows, { output: 'table', noColor: !opts.color });
        }
      } catch (err) {
        renderError(err, renderOpts(opts));
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit);
      }
    });

  grp
    .command('max-contracts')
    .description('Compute the maximum fillable contracts for an order')
    .option('--order-index <n>', 'index into the live orders array (legacy)')
    .option('--underlying <asset>', 'ETH or BTC')
    .option('--type <type>', 'PUT or CALL')
    .option('--strike <usd>', 'single strike in USD')
    .option('--strikes <csv>', 'comma-separated strikes in USD')
    .option('--expiry <ts>', 'unix expiry seconds')
    .option('--strict', 'when multiple orders match, error instead of picking the cheapest')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        orderIndex?: string;
        underlying?: string;
        type?: string;
        strike?: string;
        strikes?: string;
        expiry?: string;
        strict?: boolean;
      }>();
      try {
        const { client } = getClient(opts);
        const orders = eligibleOrders(await fetchOrdersOnce(client), client, 'buy');
        const order = resolveOrderBySelector(orders, client, local);
        const maxContracts = client.optionBook.calculateMaxContracts(order);
        render({ maxContracts: maxContracts.toString() }, renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit);
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
    .option('--order-index <n>', 'index into the live orders array (legacy — prefer the selector flags below)')
    .option('--underlying <asset>', 'ETH or BTC (use with --type/--strike/--expiry instead of --order-index)')
    .option('--type <type>', 'PUT or CALL')
    .option('--strike <usd>', 'single strike in USD (vanilla)')
    .option('--strikes <csv>', 'comma-separated strikes in USD (multi-leg)')
    .option('--expiry <ts>', 'unix expiry seconds')
    .option('--strict', 'when multiple orders match the selector, error instead of picking the cheapest')
    .option('--collateral <n>', 'USDC amount to spend on premium (e.g. 1 for $1). Number of contracts is auto-derived from the order price. Omit to fill the maximum available.')
    .option(
      '--approve-amount <max|n>',
      'approval amount when allowance is insufficient: "max" for unlimited (MaxUint256), or a decimal token amount. Defaults to exactly preview.totalCollateral.'
    )
    .option(
      '--scenarios',
      'on --dry-run, also print a 5-row (spot, payout, net P&L) table after the preview'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        orderIndex?: string;
        underlying?: string;
        type?: string;
        strike?: string;
        strikes?: string;
        expiry?: string;
        strict?: boolean;
        collateral?: string;
        approveAmount?: string;
        scenarios?: boolean;
      }>();
      try {
        if (!opts.dryRun && local.orderIndex !== undefined && local.orderIndex !== '') {
          const err = new Error(
            'Live book fills require the stable selector flags ' +
              '(--underlying, --type, --strike/--strikes, --expiry). ' +
              '--order-index is volatile and is allowed only with --dry-run.'
          );
          (err as Error & { exitCode?: number }).exitCode = 2;
          throw err;
        }

        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;

        // No referrer resolved (the SDK then falls back to the zero address),
        // or one explicitly resolved to the zero address — either way the fill
        // earns no referral credit. Warn on stderr so `--output json` stays
        // machine-parseable.
        if (res.referrer === undefined || res.referrer === ZeroAddress) {
          process.stderr.write(
            'Warning: no referrer configured — this fill accrues no referral credit. ' +
              'Set one with `thetanuts config set referrer 0x...` or --referrer.\n'
          );
        }

        const orders = eligibleOrders(await fetchOrdersOnce(client), client, 'buy');
        const order = resolveOrderBySelector(orders, client, local);
        assertEligibleOrder(order, client, 'buy');
        const collateralAmount = computeCollateralAmount(order, client, local);

        // 1+2+3: build preview, render it. Enrich with the same payout block
        // emitted by `book preview` (and `rfq build`) so dry-runs surface
        // max-loss / max-gain alongside the calldata.
        const preview = previewBookFill(client, order, collateralAmount);
        const payoutArgs = buildPayoutArgsFromPreview(preview, order, client);
        const ro = renderOpts(opts);
        const isTable = (ro.output ?? 'table') === 'table';
        const previewHeader: Record<string, unknown> = isTable
          ? humanizePreview(preview, order, client)
          : { ...preview };
        const previewWithPayout: Record<string, unknown> =
          payoutArgs !== null
            ? { ...previewHeader, payout: computePayoutSummary(payoutArgs) }
            : previewHeader;
        // In table mode the preview is its own block. For machine output we
        // hold it back and fold it into the single dry-run object below —
        // emitting two top-level JSON documents on stdout made `book fill
        // --dry-run -o json` unparseable by `jq`/`JSON.parse`.
        const deferPreview = !isTable && opts.dryRun;
        if (!deferPreview) render(previewWithPayout, ro);

        const collateralAddr = preview.collateralToken;
        const spender = client.optionBook.contractAddress;
        // Approve the ceiling, not the floored display premium: one unit of
        // slack costs 1e-6 USDC and survives either contract rounding rule.
        const required = bookPremiumCeiling(preview);

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
          // In table mode the raw fill calldata (often 4 KB+) crushes the
          // terminal; flag the renderer to truncate hex blobs. JSON/CSV/YAML
          // output is untouched so machine consumers still receive the full
          // payload. For the table path we substitute an explicit marker on
          // null-approve so the user doesn't see a confusing empty cell;
          // JSON consumers still get `approve: null` via the json branch.
          const ro = renderOpts(opts);
          const isTable = (ro.output ?? 'table') === 'table';
          const approveCell = isTable && approveEncoded === null
            ? '(none — allowance sufficient)'
            : approveEncoded;
          render(
            {
              dryRun: true,
              ...(deferPreview ? { preview: previewWithPayout } : {}),
              approve: approveCell,
              fill: fillEncoded,
            },
            { ...ro, truncate: true }
          );

          // Optional follow-up: per-spot scenarios table. Opt-in via
          // --scenarios; same shape as `rfq build --scenarios`. Renders only
          // when we successfully derived payout args (otherwise silent).
          if (local.scenarios && payoutArgs !== null) {
            const rows = computeScenarios(payoutArgs);
            process.stdout.write('\nScenarios at expiry:\n');
            render(rows, { output: 'table', noColor: !opts.color });
          }
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

        // Refetch the live book RIGHT before broadcast to close the staleness
        // window: the user may have paused on the confirm prompt, during which
        // someone else could have filled/cancelled the order. Match by the
        // exact EIP-712 signature — indices shift and Odette reuses nonces
        // across batches, so neither index nor (maker, nonce) is unique. This
        // safety check runs even under --yes; only --dry-run skips it above.
        const freshOrders = await fetchOrdersFresh(client);
        const freshOrder = findSignedOrder(freshOrders, order);
        if (!freshOrder) {
          process.stderr.write(
            'Order no longer in the live book — fully filled or cancelled. Aborting.\n'
          );
          process.exit(1);
        }
        assertEligibleOrder(freshOrder, client, 'buy');
        // Recompute the preview against the fresh order. The signed order is
        // immutable, so numContracts/totalCollateral should match exactly when
        // `availableAmount` is still sufficient; any drift is a defensive
        // signal (e.g. partial fill) and we abort rather than risk a revert.
        const freshPreview = previewBookFill(client, freshOrder, collateralAmount);
        if (freshOrder.availableAmount < freshPreview.numContracts) {
          process.stderr.write(
            `Order has been partially filled since preview. ` +
              `Available: ${freshOrder.availableAmount.toString()}, ` +
              `requested: ${freshPreview.numContracts.toString()}. ` +
              `Aborting — re-run \`book fill\` to pick a fresh order.\n`
          );
          process.exit(1);
        }
        if (
          freshPreview.numContracts !== preview.numContracts ||
          freshPreview.totalCollateral !== preview.totalCollateral
        ) {
          process.stderr.write(
            `Fresh preview drifted from original: ` +
              `numContracts ${preview.numContracts.toString()} -> ${freshPreview.numContracts.toString()}, ` +
              `totalCollateral ${preview.totalCollateral.toString()} -> ${freshPreview.totalCollateral.toString()}. ` +
              `Aborting — re-run \`book fill\` to confirm the new terms.\n`
          );
          process.exit(1);
        }

        // 7+8: send + render receipt — broadcast against the FRESH order.
        const receipt = await client.optionBook.fillOrder(freshOrder, collateralAmount);
        // Best-effort spot fetch for USD-equivalent gas cost. Never blocks
        // success rendering — `fetchEthUsdSafe` swallows API failures.
        const ethUsd = await fetchEthUsdSafe(client.api);
        const fillEvent = extractOrderFilledEvent(
          receipt,
          client.optionBook.contractAddress
        );
        const optionAddress = fillEvent?.['optionAddress'];
        const usdcDecimals = client.chainConfig.tokens.USDC?.decimals ?? 6;
        const premiumAmountRaw = fillEvent?.['premiumAmountRaw'];
        const feeCollectedRaw = fillEvent?.['feeCollectedRaw'];
        const extra: Record<string, unknown> = {
          ticker: tickerForOrder(freshOrder, client),
          ...(fillEvent ?? {}),
          ...(typeof premiumAmountRaw === 'string'
            ? {
                premiumPaid: `${formatUsd(
                  Number(premiumAmountRaw) / 10 ** usdcDecimals,
                  6
                )} USDC`,
              }
            : {}),
          ...(typeof feeCollectedRaw === 'string'
            ? {
                protocolFee: `${formatUsd(
                  Number(feeCollectedRaw) / 10 ** usdcDecimals,
                  6
                )} USDC`,
              }
            : {}),
          ...(typeof optionAddress === 'string'
            ? {
                inspectPosition: `thetanuts position info --address ${optionAddress}`,
              }
            : {}),
          indexingNote:
            'The position indexer is eventually consistent; if `position list` is briefly missing this fill, inspect the option address above or retry in a few seconds.',
        };
        render(buildTxReceiptPayload(receipt, ethUsd, extra), renderOpts(opts));
      } catch (err) {
        renderError(err, renderOpts(opts));
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit);
      }
    });
}
