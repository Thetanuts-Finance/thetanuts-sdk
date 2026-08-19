import type { Command } from 'commander';
import type {
  PayoutType,
  Position,
  RFQRequest,
  ThetanutsClient,
  OptionImplementationInfo,
} from '@thetanuts-finance/thetanuts-client';
import { buildTicker } from '@thetanuts-finance/thetanuts-client';
import { MaxUint256 } from 'ethers';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner } from '../client.js';
import { render, renderError, buildTxReceiptPayload, fetchEthUsdSafe } from '../output.js';
import { confirm } from '../confirm.js';
import { extractQuotationIdFromReceipt } from './rfq.js';
import { refreshRfqOfferDeadline } from '../rfqImplementation.js';

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

/** True iff the user is asking for the human-friendly table view. */
function isTable(opts: Globals): boolean {
  return (opts.output ?? 'table') === 'table';
}

/**
 * Format a unix timestamp (seconds, as bigint or number) into "<raw> (<ISO>)".
 * Returns the raw string alone if the value isn't a finite second-precision ts.
 */
function fmtTimestamp(raw: bigint | number | string): string {
  let n: number;
  if (typeof raw === 'bigint') n = Number(raw);
  else if (typeof raw === 'string') n = Number(raw);
  else n = raw;
  if (!Number.isFinite(n) || n <= 0) return String(raw);
  // Heuristic: ms timestamps would land in the year >5000 if interpreted as
  // seconds. Treat sub-1e12 as seconds, >=1e12 as ms.
  const ms = n >= 1e12 ? n : n * 1000;
  try {
    const iso = new Date(ms).toISOString();
    return `${String(raw)} (${iso})`;
  } catch {
    return String(raw);
  }
}

/** ISO date-only string (YYYY-MM-DD) for at-a-glance expiry columns. */
function fmtExpiryDate(raw: bigint | number | string): string {
  let n: number;
  if (typeof raw === 'bigint') n = Number(raw);
  else if (typeof raw === 'string') n = Number(raw);
  else n = raw;
  if (!Number.isFinite(n) || n <= 0) return String(raw);
  const ms = n >= 1e12 ? n : n * 1000;
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return String(raw);
  }
}

/**
 * Resolve a token address to "<SYMBOL> (<addr>)" if it's a known chain-config
 * token, or just the raw address otherwise.
 */
function fmtTokenWithSymbol(client: ThetanutsClient, addr: string): string {
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr ?? '';
  const wanted = addr.toLowerCase();
  for (const [sym, t] of Object.entries(client.chainConfig.tokens)) {
    if (t.address.toLowerCase() === wanted) return `${sym} (${addr})`;
  }
  return addr;
}

/**
 * Reverse-lookup a Chainlink price feed address to its underlying symbol
 * ('ETH', 'BTC', etc.) using chainConfig.priceFeeds. Returns undefined if no
 * match.
 */
function priceFeedSymbol(client: ThetanutsClient, feed: string): string | undefined {
  if (!feed || !/^0x[0-9a-fA-F]{40}$/.test(feed)) return undefined;
  const wanted = feed.toLowerCase();
  for (const [sym, addr] of Object.entries(client.chainConfig.priceFeeds)) {
    if (sym.includes('/')) continue;
    if (typeof addr === 'string' && addr.toLowerCase() === wanted) return sym;
  }
  return undefined;
}

/**
 * Map an implementation `type` (VANILLA / SPREAD / BUTTERFLY / CONDOR /
 * IRON_CONDOR / RANGER / LOAN_HANDLER) to a lowercase structure label suitable
 * for the optionType column ("vanilla", "spread", "butterfly", "condor",
 * "iron condor"). Used when we derive the optionType label from the impl name
 * instead of from on-chain unpackOptionType().
 */
function structureFromImplType(type: string): string {
  switch (type) {
    case 'VANILLA': return 'vanilla';
    case 'SPREAD': return 'spread';
    case 'BUTTERFLY': return 'butterfly';
    case 'CONDOR': return 'condor';
    case 'IRON_CONDOR': return 'iron condor';
    default: return type.toLowerCase();
  }
}

/**
 * Try to attach a human label to a packed optionType uint.
 *
 * Priority chain (rebuilt for Fix B — public Base RPCs are flaky and the
 * previous decoder bottlenecked on `unpackOptionType()`, which fails
 * intermittently on freshly-minted clones):
 *   1. If we have an `impl` (OptionImplementationInfo) from the chainConfig
 *      reverse-lookup, the impl `.name` ("PUT", "CALL_SPREAD", "PUT_FLY",
 *      etc.) is already a faithful structure+side label. We render it
 *      directly without burning another RPC roundtrip.
 *   2. Otherwise, fall back to on-chain `unpackOptionType()` with one retry
 *      on transient RPC failures.
 *   3. Final fallback: render the raw uint with a stderr advisory.
 *
 * Returns { label, raw } so callers can preserve the raw number in JSON
 * output while showing a friendly label in tables.
 */
async function decodeOptionType(
  client: ThetanutsClient,
  optionAddress: string,
  raw: number | bigint,
  impl: OptionImplementationInfo | null
): Promise<{ label: string; raw: string }> {
  const rawStr = raw.toString();

  // Priority 1: derive from the implementation reverse-lookup if we have it.
  // This is the cheapest path — no extra RPC, no proxy-ABI surprises — and
  // the impl name is already a structure+side label.
  if (impl) {
    return {
      label: `${impl.name} (${structureFromImplType(impl.type)})`,
      raw: rawStr,
    };
  }

  // Priority 2: try unpackOptionType() on the option contract for the
  // full structure / style / settlement profile. Retry once on transient RPC
  // failures — public Base RPCs occasionally drop back-to-back calls, and
  // the `getOptionInfo` batch ahead of us can briefly burn the rate budget.
  const tryOnce = () => client.option.unpackOptionType(optionAddress);
  let unpacked: Awaited<ReturnType<typeof tryOnce>> | null = null;
  try {
    unpacked = await tryOnce();
  } catch (err) {
    if (isTransientRpcError(err)) {
      await sleep(750);
      try {
        unpacked = await tryOnce();
      } catch {
        unpacked = null;
      }
    }
  }
  if (unpacked) {
    const STRUCTS = ['vanilla', 'spread', 'butterfly', 'condor', 'iron_condor'];
    const STYLES = ['european', 'american'];
    const structure =
      STRUCTS[Number(unpacked.optionStructure)] ?? `structure=${unpacked.optionStructure}`;
    const style = STYLES[Number(unpacked.optionStyle)] ?? `style=${unpacked.optionStyle}`;
    const physical = unpacked.isPhysicallySettled ? 'physical' : 'cash';
    let head: string;
    if (structure === 'vanilla') {
      head = unpacked.isQuoteCollateral ? 'PUT' : 'CALL';
      if (unpacked.isPhysicallySettled) head = `PHYSICAL_${head}`;
    } else {
      head = structure.toUpperCase();
    }
    return { label: `${head} (${structure}, ${style}, ${physical})`, raw: rawStr };
  }

  // Priority 3: bare raw uint. Surface an advisory so the user knows why the
  // friendlier label is missing.
  process.stderr.write(
    `Note: could not decode optionType ${rawStr} for ${optionAddress}. ` +
      'Both on-chain implementation lookup and unpackOptionType() failed — public RPC may be down.\n'
  );
  return { label: rawStr, raw: rawStr };
}

/**
 * Look up an option's implementation address (via the SDK's typed
 * `client.option.getImplementation()` helper) and match it against the chain
 * config's `optionImplementations` reverse map. Retries once on transient RPC
 * failures (public Base RPC is flaky). Returns the registered impl info or
 * null on persistent failure.
 *
 * Map source: chainConfig.optionImplementations keyed by lowercased address.
 */
async function lookupImplementation(
  client: ThetanutsClient,
  optionAddress: string
): Promise<OptionImplementationInfo | null> {
  const tryOnce = () => client.option.getImplementation(optionAddress);
  let impl: string;
  try {
    impl = await tryOnce();
  } catch (err) {
    if (!isTransientRpcError(err)) return null;
    await sleep(750);
    try {
      impl = await tryOnce();
    } catch {
      return null;
    }
  }
  return client.chainConfig.optionImplementations[impl.toLowerCase()] ?? null;
}

/**
 * Resolve an implementation by *address* against the chain-config reverse
 * map. Used by the RFQ-side normalizer (Fix A) where the API gives us the
 * impl address directly so we never need to make an RPC call.
 */
function resolveImplByAddress(
  client: ThetanutsClient,
  implAddr: string | undefined
): OptionImplementationInfo | null {
  if (!implAddr || !/^0x[0-9a-fA-F]{40}$/.test(implAddr)) return null;
  return client.chainConfig.optionImplementations[implAddr.toLowerCase()] ?? null;
}

/**
 * Detect "RPC didn't come up" / "ABI mismatch on a freshly minted option"
 * errors from ethers v6 / the SDK. We retry these once before surfacing a
 * friendlier message.
 */
function isTransientRpcError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err);
  const code = (err as { code?: string })?.code ?? '';
  return (
    msg.includes('failed to detect network') ||
    msg.includes('does not respond to any known functions') ||
    msg.includes('could not detect network') ||
    msg.includes('missing revert data') ||
    msg.includes('SERVER_ERROR') ||
    msg.includes('NETWORK_ERROR') ||
    msg.includes('CALL_EXCEPTION') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    code === 'CALL_EXCEPTION' ||
    code === 'NETWORK_ERROR' ||
    code === 'SERVER_ERROR' ||
    code === 'TIMEOUT'
  );
}

/** Sleep without pulling in node:timers/promises explicitly. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// RFQ-side position fetch + normalization (Fix A)
// ---------------------------------------------------------------------------
//
// The SDK exposes two user-position endpoints with different return shapes:
//
//   client.api.getUserPositionsFromIndexer(addr)  → Position[]    (book)
//   client.api.getUserOptionsFromRfq(addr)         → StateOption[] (rfq)
//
// `getUserPositionsFromIndexer` flows through `normalizePosition` which
// preserves richer fields like `entryPrice`, `pnlUsd`, `implementationName`,
// `optionStatus`, etc.
//
// `getUserOptionsFromRfq` returns a sparser typed shape (StateOption), but
// the actual indexer response is much richer — it includes `implementation`,
// `underlyingAsset`, `priceFeed`, `collateralSymbol`, `collateralDecimals`,
// `numContracts`, `collateralAmount`, etc. (verified live against
// indexer.thetanuts.finance/api/v1/factory/user/<addr>/positions). The dApp
// at /Users/shawnchee/Desktop/projects/thetanuts-1840/app/pages/option-rfq/
// utils/positionDataHelpers.ts:93 casts the response as a richer
// `ApiPosition` to access those fields.
//
// We mirror the same approach here: cast to a `RfqOptionResponse` superset
// and normalize into the same `Position` shape so the rest of the renderer
// (computeLivePnL, table builder, JSON emitter) treats RFQ and Book entries
// uniformly.

/**
 * Shape of a single entry from /api/v1/factory/user/<addr>/positions.
 * Wider than `StateOption` to match the actual indexer response — the SDK's
 * StateOption type is a subset for backward-compat reasons, but the live API
 * carries all of these fields. Mirrors the dApp's `ApiPosition` interface
 * (positionDataHelpers.ts:93).
 */
interface RfqOptionResponse {
  address: string;
  buyer?: string;
  seller?: string;
  requester?: string;
  winner?: string;
  creator?: string;
  quotationId?: string;
  implementation?: string;
  numContracts?: string;
  collateralAmount?: string;
  feeAmount?: string;
  currentBestPrice?: string;
  collateralDecimals?: number;
  collateralSymbol?: string;
  underlyingAsset?: string;
  strikes?: string[];
  expiryTimestamp?: number;
  expiry?: number;
  collateral?: string;
  collateralToken?: string;
  priceFeed?: string;
  optionType?: number | string;
  optionStatus?: string;
  pnl?: Array<{ side?: string; pnlUsd?: string; pnlPct?: string; [k: string]: unknown }>;
  createdAt?: number;
  status?: string;
  [k: string]: unknown;
}

/**
 * Normalize a single RFQ-side option response into the SDK's `Position`
 * shape. Side resolution follows the dApp logic: prefer the pnl[0].side
 * sentinel, else compare addresses.
 *
 * Returns a Position augmented with the same `implementationName` /
 * `implementationType` fields that the Book normalizer would have produced —
 * derived from the chain-config reverse lookup on the impl address.
 */
function normalizeRfqPosition(
  client: ThetanutsClient,
  raw: RfqOptionResponse,
  accountAddress: string
): Position {
  const optionAddress = String(raw.address ?? '');
  const collateral = String(raw.collateral ?? raw.collateralToken ?? '');
  const collateralSymbol = String(raw.collateralSymbol ?? '');
  const collateralDecimals = Number(raw.collateralDecimals ?? 6);
  const buyer = String(raw.buyer ?? '');
  const seller = String(raw.seller ?? '');

  // Side: dApp prefers pnl[0].side, otherwise compares buyer to wallet.
  let side: 'buyer' | 'seller';
  const firstPnl = raw.pnl?.[0];
  if (firstPnl?.side === 'buyer' || firstPnl?.side === 'seller') {
    side = firstPnl.side;
  } else {
    side = buyer.toLowerCase() === accountAddress.toLowerCase() ? 'buyer' : 'seller';
  }

  // optionType is sometimes hex-string ("0xc"), sometimes a number. Coerce.
  const rawOpt = raw.optionType ?? 0;
  const optionType =
    typeof rawOpt === 'string'
      ? rawOpt.startsWith('0x')
        ? parseInt(rawOpt, 16)
        : parseInt(rawOpt, 10) || 0
      : Number(rawOpt);

  const strikes = (raw.strikes ?? []).map((s) => BigInt(String(s)));
  const expiry = Number(raw.expiryTimestamp ?? raw.expiry ?? 0);

  // Reverse-lookup impl name/type from chain config — no extra RPC.
  const impl = resolveImplByAddress(client, raw.implementation);

  // Pick a representative pnl entry for the user's side (if any).
  const userPnl =
    raw.pnl?.find((p) => p.side === side) ?? raw.pnl?.[0] ?? null;

  const pos: Position = {
    // The RFQ endpoint doesn't carry a stable position id; reuse the option
    // address + side as a synthetic id so dedup and table sort stays stable.
    id: `${optionAddress}-${side}`,
    optionAddress,
    side,
    amount: BigInt(String(raw.numContracts ?? '0')),
    // The RFQ endpoint exposes `currentBestPrice` (the latest fill price),
    // not the user's entryPrice. The dApp tracks entry via the linked RFQ
    // (rfqs[0].currentBestPrice). Use currentBestPrice as a best-effort
    // entryPrice surrogate — for fresh positions it IS the entry premium.
    entryPrice: BigInt(String(raw.currentBestPrice ?? '0')),
    currentValue: 0n,
    pnl: 0n,
    option: {
      underlying: String(raw.underlyingAsset ?? ''),
      collateral,
      strikes,
      expiry,
      optionType,
    },
    status: String(raw.status ?? raw.optionStatus ?? ''),
    buyer,
    seller,
    referrer: '',
    createdBy: String(raw.creator ?? ''),
    entryTimestamp: BigInt(String(raw.createdAt ?? '0')),
    entryTxHash: '',
    entryBlock: 0n,
    entryFeePaid: BigInt(String(raw.feeAmount ?? '0')),
    collateralAmount: BigInt(String(raw.collateralAmount ?? '0')),
    collateralSymbol,
    collateralDecimals,
    priceFeed: String(raw.priceFeed ?? ''),
    closeTimestamp: 0n,
    closeTxHash: '',
    closeBlock: 0n,
    optionTypeRaw: optionType,
    explicitClose: false,
    ...(raw.optionStatus
      ? { optionStatus: raw.optionStatus as Position['optionStatus'] }
      : {}),
    ...(userPnl?.pnlUsd != null ? { pnlUsd: String(userPnl.pnlUsd) } : {}),
    ...(userPnl?.pnlPct != null ? { pnlPct: String(userPnl.pnlPct) } : {}),
    ...(impl ? { implementationName: impl.name, implementationType: impl.type } : {}),
  };
  return pos;
}

/** Tag denoting which API a position came from. */
type PositionSource = 'book' | 'rfq';

/** Position decorated with the API source(s) it came from. */
interface SourcedPosition extends Position {
  sources: PositionSource[];
}

/**
 * Merge book and rfq position lists, deduping by lowercase optionAddress.
 * When the same option appears in both lists, the Book entry wins (it tends
 * to have richer fields like pnlUsd from the indexer's settlement worker)
 * but we record both sources for transparency.
 */
function mergePositions(
  bookList: Position[],
  rfqList: Position[]
): SourcedPosition[] {
  const merged = new Map<string, SourcedPosition>();
  for (const p of bookList) {
    const key = p.optionAddress.toLowerCase();
    merged.set(key, { ...p, sources: ['book'] });
  }
  for (const p of rfqList) {
    const key = p.optionAddress.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      // Book wins on field-level (already in `existing`), but record both
      // sources so consumers can see the option was matched on both sides.
      existing.sources = ['book', 'rfq'];
      continue;
    }
    merged.set(key, { ...p, sources: ['rfq'] });
  }
  return Array.from(merged.values());
}


// ---------------------------------------------------------------------------
// MTM PnL — dApp options-dashboard parity (Tier 3 fallback)
// ---------------------------------------------------------------------------
//
// Tier strategy (matches the dApp's adaptOptionBookPosition.ts:74-89 +
// mapApiPositionToEnriched.ts:317-338):
//
//   Tier 1 [indexer]      — pnlEntries[side].pnlUsd (pre-computed by indexer)
//   Tier 2 [indexer]      — top-level pos.pnlUsd / pos.pnlPct
//   Tier 3 [mtm]          — fetch MM pricing per position, run buyer/seller
//                            formulas ported verbatim from the dApp's
//                            pnlCalculations.ts:75-141.
//   Tier 4 [unavailable]  — render "— [pricing unavailable]".
//
// We use native JS Number rather than the dApp's decimal.js — the CLI doesn't
// pull decimal.js as a dep and adding one for ~$X.XX-precision rendering is
// overkill. Divergence: ~1e-7 precision loss on extreme positions. Acceptable
// for a 2-dp display.

/**
 * BASE vs QUOTE collateral classification, matching the dApp's
 * inferAssetMeta() in pages/options/config.ts:31-38. USDC-family symbols are
 * QUOTE (USD-pegged); WETH / cbBTC / cbDOGE / cbXRP / aBasWETH / aBascbBTC
 * are BASE.
 *
 * Returns { isBaseCollateral, decimals, asset } where `asset` is the SDK's
 * MM-pricing collateral asset key (e.g. 'ETH', 'BTC', 'USD').
 */
function getCollateralMeta(
  client: ThetanutsClient,
  collateralAddr: string,
  fallbackDecimals = 6
): { isBaseCollateral: boolean; decimals: number; asset: string; symbol: string } {
  if (!collateralAddr || !/^0x[0-9a-fA-F]{40}$/.test(collateralAddr)) {
    return { isBaseCollateral: false, decimals: fallbackDecimals, asset: 'USD', symbol: 'USDC' };
  }
  const wanted = collateralAddr.toLowerCase();
  for (const [sym, t] of Object.entries(client.chainConfig.tokens)) {
    if (t.address.toLowerCase() !== wanted) continue;
    if (/USD/i.test(sym)) {
      return { isBaseCollateral: false, decimals: t.decimals, asset: 'USD', symbol: sym };
    }
    // Strip prefixes used in chain config: aBas / cb / W.
    const stripped = sym.replace(/^aBas/i, '').replace(/^cb/i, '').replace(/^W/i, '');
    const asset = stripped || sym;
    return { isBaseCollateral: true, decimals: t.decimals, asset, symbol: sym };
  }
  return { isBaseCollateral: false, decimals: fallbackDecimals, asset: 'USD', symbol: 'USDC' };
}

/**
 * Resolve a price-feed address back to its underlying symbol ('ETH', 'BTC',
 * 'SOL', 'DOGE', 'XRP', 'BNB', 'PAXG', 'AVAX'). Used when the position's
 * underlying field is empty but priceFeed is populated.
 */
function deriveUnderlying(
  client: ThetanutsClient,
  underlying: string,
  priceFeed: string,
  collateralAddr: string
): string {
  if (underlying) return underlying.toUpperCase();
  const feedSym = priceFeedSymbol(client, priceFeed);
  if (feedSym) return feedSym;
  // BASE collateral implies its asset is the underlying (e.g. WETH options
  // on WETH collateral are ETH).
  const meta = getCollateralMeta(client, collateralAddr);
  if (meta.isBaseCollateral) return meta.asset;
  return '';
}

/**
 * Derive isCall from the position's implementation metadata or option type.
 * Mirrors the dApp's `implName.includes("CALL")` heuristic
 * (positionDataHelpers.ts:145) plus a fallback on the unpackOptionType bit.
 */
function deriveIsCall(pos: Position): boolean {
  const implName = pos.implementationName ?? '';
  if (implName) return implName.toUpperCase().includes('CALL');
  // Fallback: optionType bit 0 — vanilla 0 = CALL, 1 = PUT. Spreads and other
  // structures encode call/put in bit 0 as well in r12.
  const ot = Number(pos.option?.optionType ?? 0);
  return (ot & 1) === 0;
}

/** Human-readable position structure for list output. */
function positionStructureLabel(pos: Position): string {
  const implementationName = pos.implementationName?.trim();
  if (implementationName) return implementationName;

  const strikeCount = pos.option.strikes.length;
  const side = deriveIsCall(pos) ? 'CALL' : 'PUT';
  switch (strikeCount) {
    case 1: return side;
    case 2: return `${side}_SPREAD`;
    case 3: return `${side}_FLY`;
    case 4: return '4_LEG'; // Cannot distinguish condor vs iron condor without implementation metadata.
    default: return `${strikeCount}_LEG`;
  }
}

/** Pricing return shape used by the buyer/seller PnL calculators. */
interface PricingForPnL {
  sellPrice: number;
  buyPrice: number;
  spotPrice: number;
}

/**
 * Native-Number port of the dApp's fetchPositionPricing
 * (positionDataHelpers.ts:140-247). Dispatches by strike count + impl type:
 *
 *   1 strike     → mmPricing.getTickerPricing(buildTicker(...))
 *   2 strikes    → mmPricing.getSpreadPricing       (isCall from impl name)
 *   3 strikes    → mmPricing.getButterflyPricing
 *   4 strikes    → mmPricing.getCondorPricing       (iron / call / put)
 *
 * For USD-denominated collateral we multiply by spot since the SDK returns
 * pricing in underlying terms — same conversion the dApp does at
 * positionDataHelpers.ts:173-178 / 230-234. This keeps the toUSD() step in
 * the PnL calc consistent across collateral types.
 *
 * Returns null when pricing is unavailable / the option's underlying isn't
 * priced by the MM (e.g. exotic asset, expired ticker).
 */
async function fetchPricingForPosition(
  client: ThetanutsClient,
  pos: Position
): Promise<PricingForPnL | null> {
  const collateralMeta = getCollateralMeta(client, pos.option.collateral);
  const underlying = deriveUnderlying(
    client,
    pos.option.underlying,
    pos.priceFeed,
    pos.option.collateral
  );
  if (!underlying) return null;

  const isCall = deriveIsCall(pos);
  const strikes = pos.option.strikes ?? [];
  if (strikes.length === 0) return null;

  // Multi-leg classification mirrors positionDataHelpers.ts:140-214. We trust
  // the impl `type` when present and otherwise fall back on strike count.
  const implType =
    (pos.implementationType ?? '').toUpperCase() ||
    (strikes.length === 1
      ? 'VANILLA'
      : strikes.length === 2
      ? 'SPREAD'
      : strikes.length === 3
      ? 'BUTTERFLY'
      : 'CONDOR');

  const extractSpot = (result: Record<string, unknown>): number => {
    const top = Number(result.underlyingPrice ?? 0);
    if (top > 0) return top;
    const legs = (result.legs ??
      [result.nearLeg, result.farLeg].filter(Boolean)) as Array<{
      underlyingPrice?: number;
    }>;
    for (const leg of legs ?? []) {
      if (leg?.underlyingPrice) return Number(leg.underlyingPrice);
    }
    return 0;
  };

  const isUSDAsset =
    collateralMeta.asset === 'USD' ||
    ['USDC', 'USDT', 'aUSDC'].includes(collateralMeta.asset);

  const extractMultiLeg = (result: Record<string, unknown>): PricingForPnL => {
    const spot = extractSpot(result);
    let sellPrice = Number(result.netMmBidPrice ?? 0);
    let buyPrice = Number(result.netMmAskPrice ?? 0);
    if (isUSDAsset && spot > 0) {
      sellPrice = sellPrice * spot;
      buyPrice = buyPrice * spot;
    }
    return { sellPrice, buyPrice, spotPrice: spot };
  };

  try {
    if (implType === 'SPREAD' && strikes.length >= 2) {
      const result = await client.mmPricing.getSpreadPricing({
        underlying,
        strikes: [strikes[0], strikes[1]],
        expiry: pos.option.expiry,
        isCall,
      });
      return extractMultiLeg(result as unknown as Record<string, unknown>);
    }
    if (implType === 'BUTTERFLY' && strikes.length >= 3) {
      const result = await client.mmPricing.getButterflyPricing({
        underlying,
        strikes: [strikes[0], strikes[1], strikes[2]],
        expiry: pos.option.expiry,
        isCall,
      });
      return extractMultiLeg(result as unknown as Record<string, unknown>);
    }
    if (
      (implType === 'CONDOR' || implType === 'IRON_CONDOR') &&
      strikes.length >= 4
    ) {
      const condorType: 'call' | 'put' | 'iron' =
        implType === 'IRON_CONDOR' ? 'iron' : isCall ? 'call' : 'put';
      const result = await client.mmPricing.getCondorPricing({
        underlying,
        strikes: [strikes[0], strikes[1], strikes[2], strikes[3]],
        expiry: pos.option.expiry,
        type: condorType,
      });
      return extractMultiLeg(result as unknown as Record<string, unknown>);
    }

    // Vanilla single-strike path.
    const strikeHuman = Number(strikes[0]) / 1e8;
    const ticker = buildTicker(underlying, pos.option.expiry, strikeHuman, isCall);
    const result = await client.mmPricing.getTickerPricing(ticker);
    const spot = Number(result.underlyingPrice ?? 0);
    const cp =
      result.byCollateral?.[collateralMeta.asset] ?? result.byCollateral?.USD;
    if (cp) {
      let sellPrice = Number(cp.mmBidPriceBuffered ?? cp.mmBidPrice ?? 0);
      let buyPrice = Number(cp.mmAskPriceBuffered ?? cp.mmAskPrice ?? 0);
      if (isUSDAsset && spot > 0) {
        sellPrice = sellPrice * spot;
        buyPrice = buyPrice * spot;
      }
      return { sellPrice, buyPrice, spotPrice: spot };
    }
    return {
      sellPrice: Number(result.feeAdjustedBid ?? result.rawBidPrice ?? 0),
      buyPrice: Number(result.feeAdjustedAsk ?? result.rawAskPrice ?? 0),
      spotPrice: spot,
    };
  } catch (err) {
    // Surface diagnostic when THETANUTS_DEBUG_PNL=1;
    if (process.env.THETANUTS_DEBUG_PNL) {
      process.stderr.write(
        `[pnl] mtm fetch failed for ${pos.optionAddress}: ${(err as Error)?.message ?? String(err)}\n`
      );
    }
    return null;
  }
}

/** Numeric PnL result for the CLI's table renderer. */
interface MtmResult {
  pnlUsd: number;
  pnlPct: number;
  entryUsd: number;
  currentUsd: number;
}

/**
 * Buyer PnL — native-Number port of calculateBuyerPnL
 * (thetanuts-1840/.../pnlCalculations.ts:75-97):
 *
 *   contracts  = numContracts / 10^d
 *   entryVal   = currentBestPrice / 10^d         (total premium, NOT per-contract)
 *   entryUSD   = entryVal × spot                 (if base collateral)
 *   currentVal = sellPrice × contracts           (sellPrice = MM bid)
 *   currentUSD = currentVal × spot               (if base collateral)
 *   pnl        = currentUSD − entryUSD
 */
function calculateBuyerPnL(
  numContractsRaw: bigint,
  entryPremiumRaw: bigint,
  decimals: number,
  isBaseCollateral: boolean,
  pricing: PricingForPnL
): MtmResult | null {
  const contracts = Number(numContractsRaw) / 10 ** decimals;
  if (contracts === 0) return null;
  const entryUnderlying = Number(entryPremiumRaw) / 10 ** decimals;
  const spotForUSD = pricing.spotPrice;
  const entryUSD = isBaseCollateral ? entryUnderlying * spotForUSD : entryUnderlying;
  if (!pricing.sellPrice) return null;
  const currentUnderlying = pricing.sellPrice * contracts;
  const currentUSD = isBaseCollateral
    ? currentUnderlying * spotForUSD
    : currentUnderlying;
  const pnlUsd = currentUSD - entryUSD;
  const pnlPct = entryUSD === 0 ? 0 : (pnlUsd / Math.abs(entryUSD)) * 100;
  return { pnlUsd, pnlPct, entryUsd: entryUSD, currentUsd: currentUSD };
}

/**
 * Seller PnL — native-Number port of calculateSellerPnL
 * (thetanuts-1840/.../pnlCalculations.ts:112-141):
 *
 *   collateral = collateralAmount / 10^d
 *   premium    = currentBestPrice / 10^d
 *   fee        = feeAmount / 10^d
 *   entryUSD   = collateral × spot               (if base collateral)
 *   closeCost  = buyPrice × contracts            (buyPrice = MM ask)
 *   currentVal = collateral − closeCost + premium − fee
 *   currentUSD = currentVal × spot               (if base collateral)
 *   pnl        = currentUSD − entryUSD = premium − fee − closeCost
 */
function calculateSellerPnL(
  numContractsRaw: bigint,
  collateralAmountRaw: bigint,
  entryPremiumRaw: bigint,
  feeRaw: bigint,
  decimals: number,
  isBaseCollateral: boolean,
  pricing: PricingForPnL
): MtmResult | null {
  const contracts = Number(numContractsRaw) / 10 ** decimals;
  if (contracts === 0) return null;
  const collateral = Number(collateralAmountRaw) / 10 ** decimals;
  const premium = Number(entryPremiumRaw) / 10 ** decimals;
  const fee = Number(feeRaw) / 10 ** decimals;
  const spotForUSD = pricing.spotPrice;
  const entryUSD = isBaseCollateral ? collateral * spotForUSD : collateral;
  if (!pricing.buyPrice) return null;
  const closeCost = pricing.buyPrice * contracts;
  const currentUnderlying = collateral - closeCost + premium - fee;
  const currentUSD = isBaseCollateral
    ? currentUnderlying * spotForUSD
    : currentUnderlying;
  const pnlUsd = currentUSD - entryUSD;
  const pnlPct = entryUSD === 0 ? 0 : (pnlUsd / Math.abs(entryUSD)) * 100;
  return { pnlUsd, pnlPct, entryUsd: entryUSD, currentUsd: currentUSD };
}

/**
 * Position is "dead" (settled / closed / expired) and therefore not worth
 * a Tier 3 MM-pricing fetch — there's no live MM quote for a dead option.
 * Tier 1/2 indexer paths may still surface a final pnlUsd.
 */
function isDeadPosition(pos: Position): boolean {
  const now = Math.floor(Date.now() / 1000);
  const status = (pos.optionStatus ?? pos.status ?? '').toLowerCase();
  if (
    status === 'settled' ||
    status === 'settled-itm' ||
    status === 'settled-otm' ||
    status === 'closed' ||
    status === 'expired-awaiting-settlement'
  ) {
    return true;
  }
  if (pos.option?.expiry && pos.option.expiry > 0 && pos.option.expiry <= now) {
    return true;
  }
  return false;
}

type PnLSource = 'indexer' | 'mtm' | 'unavailable';

interface ResolvedPnL {
  source: PnLSource;
  pnlUsd: number | null;
  pnlPct: number | null;
}

/**
 * Tier-1/2 indexer extractor. Returns null when neither pnlEntries nor the
 * top-level pnlUsd/pnlPct fields are present.
 *
 * Tier 1: pnlEntries[side].pnlUsd — mirrors adaptOptionBookPosition.ts:74-89.
 * Tier 2: top-level pos.pnlUsd / pos.pnlPct — some indexer payloads only
 *         populate the top-level fields (RFQ normalizer at line 427/428).
 */
function resolveIndexerPnL(pos: Position): ResolvedPnL | null {
  // Tier 1: per-side entry.
  const entry =
    pos.pnlEntries?.find((e) => e.side === pos.side) ?? pos.pnlEntries?.[0];
  if (entry && entry.pnlUsd != null && entry.pnlUsd !== '') {
    const pnlUsd = Number(entry.pnlUsd) / 1e8;
    const pnlPct =
      entry.pnlPct != null && entry.pnlPct !== '' ? Number(entry.pnlPct) : null;
    if (Number.isFinite(pnlUsd)) {
      return { source: 'indexer', pnlUsd, pnlPct };
    }
  }
  // Tier 2: top-level fields.
  if (pos.pnlUsd != null && pos.pnlUsd !== '') {
    const pnlUsd = Number(pos.pnlUsd) / 1e8;
    const pnlPct =
      pos.pnlPct != null && pos.pnlPct !== '' ? Number(pos.pnlPct) : null;
    if (Number.isFinite(pnlUsd)) {
      return { source: 'indexer', pnlUsd, pnlPct };
    }
  }
  return null;
}

/**
 * Tier 3: MM-based MTM PnL. Returns null when pricing is unavailable.
 * Skips dead positions — MMs don't quote settled / expired options.
 *
 * Uses currentBestPrice when available (RFQ-path positions), otherwise falls
 * back to pos.entryPrice (Book-path positions). The dApp uses
 * apiPos.currentBestPrice exclusively because its mapApiPositionToEnriched
 * runs against the RFQ endpoint; on the Book side it sets currentBestPrice
 * to "0" (adaptOptionBookPosition.ts:150) which means the dApp's MTM tier
 * doesn't fire for Book positions. We do better: we accept either field so
 * Tier 3 actually fires for both sources.
 */
async function resolveMtmPnL(
  client: ThetanutsClient,
  pos: Position
): Promise<ResolvedPnL | null> {
  if (isDeadPosition(pos)) return null;
  const pricing = await fetchPricingForPosition(client, pos);
  if (!pricing) return null;
  const collateralMeta = getCollateralMeta(client, pos.option.collateral);
  // Premium source preference: explicit RFQ currentBestPrice if normalizer
  // recorded it on entryPrice (we already do this in normalizeRfqPosition),
  // otherwise fall back to the Book's entryPrice.
  const entryPremium = pos.entryPrice ?? 0n;
  const fee = pos.entryFeePaid ?? 0n;
  const numContracts = pos.amount ?? 0n;
  const collateralAmount = pos.collateralAmount ?? 0n;
  const mtm =
    pos.side === 'buyer'
      ? calculateBuyerPnL(
          numContracts,
          entryPremium,
          collateralMeta.decimals,
          collateralMeta.isBaseCollateral,
          pricing
        )
      : calculateSellerPnL(
          numContracts,
          collateralAmount,
          entryPremium,
          fee,
          collateralMeta.decimals,
          collateralMeta.isBaseCollateral,
          pricing
        );
  if (!mtm || !Number.isFinite(mtm.pnlUsd)) return null;
  return { source: 'mtm', pnlUsd: mtm.pnlUsd, pnlPct: mtm.pnlPct };
}

/**
 * Fan-out resolver: Tier 1/2 first (synchronous), then Tier 3 in parallel for
 * the residual set. Surfaces a stderr advisory if Tier 3 fetches exceed 2s.
 *
 * Per-position alternative (`indexer → MTM → unavailable`) is inlined inside
 * `resolveAllPnL` so we don't ship a single-call variant that nothing uses.
 */
async function resolveAllPnL(
  client: ThetanutsClient,
  positions: SourcedPosition[]
): Promise<ResolvedPnL[]> {
  // Pre-resolve indexer tier synchronously.
  const resolved: (ResolvedPnL | null)[] = positions.map((p) =>
    resolveIndexerPnL(p)
  );
  // Tier 3 indices: positions that need MM-pricing.
  const mtmIdx: number[] = [];
  for (let i = 0; i < positions.length; i++) {
    if (resolved[i] == null && !isDeadPosition(positions[i])) {
      mtmIdx.push(i);
    }
  }
  if (mtmIdx.length === 0) {
    return resolved.map((r) => r ?? { source: 'unavailable', pnlUsd: null, pnlPct: null });
  }
  const t0 = Date.now();
  const settled = await Promise.allSettled(
    mtmIdx.map((i) => resolveMtmPnL(client, positions[i]))
  );
  const elapsed = (Date.now() - t0) / 1000;
  if (elapsed > 2) {
    process.stderr.write(
      `Note: PnL refresh took ${elapsed.toFixed(1)} seconds. Indexer-only mode coming when this is too slow.\n`
    );
  }
  for (let k = 0; k < mtmIdx.length; k++) {
    const s = settled[k];
    const i = mtmIdx[k];
    if (s.status === 'fulfilled' && s.value) {
      resolved[i] = s.value;
    }
  }
  return resolved.map((r) => r ?? { source: 'unavailable', pnlUsd: null, pnlPct: null });
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
    .description('List positions for a wallet (book + rfq sources, merged by default)')
    .option('--address <addr>', 'wallet address (defaults to signer)')
    .option(
      '--source <src>',
      'position source: book | rfq | all (default: all)',
      'all'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address?: string; source?: string }>();
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

        // ── Source dispatch (Fix A) ────────────────────────────────────────
        // book → /api/v1/user/<addr>/positions (OptionBook)
        // rfq  → /api/v1/factory/user/<addr>/positions (RFQ/OptionFactory)
        // all  → both, merged + deduped by lowercased optionAddress
        const source = (local.source ?? 'all').toLowerCase();
        if (source !== 'book' && source !== 'rfq' && source !== 'all') {
          throw new Error(
            `Invalid --source "${local.source}". Allowed: book | rfq | all.`
          );
        }

        const fetches: Promise<unknown>[] = [];
        const wantBook = source === 'book' || source === 'all';
        const wantRfq = source === 'rfq' || source === 'all';
        if (wantBook) {
          fetches.push(client.api.getUserPositionsFromIndexer(addr));
        }
        if (wantRfq) {
          fetches.push(client.api.getUserOptionsFromRfq(addr));
        }
        // Run book + rfq in parallel; tolerate one failing (e.g. rfq indexer
        // hiccups) by surfacing a stderr advisory instead of failing the
        // whole command. The book API is the historical default so we keep
        // a hard failure if THAT fails.
        const results = await Promise.allSettled(fetches);
        let bookPositions: Position[] = [];
        let rfqPositions: Position[] = [];
        let cursor = 0;
        if (wantBook) {
          const r = results[cursor++];
          if (r.status === 'fulfilled') {
            bookPositions = r.value as Position[];
          } else {
            throw r.reason;
          }
        }
        if (wantRfq) {
          const r = results[cursor++];
          if (r.status === 'fulfilled') {
            const raws = r.value as unknown as RfqOptionResponse[];
            rfqPositions = raws.map((p) => normalizeRfqPosition(client, p, addr!));
          } else {
            // RFQ side is best-effort — degrade gracefully rather than
            // failing the whole list view.
            process.stderr.write(
              `Warning: RFQ position fetch failed: ${(r.reason as Error)?.message ?? r.reason}\n`
            );
          }
        }

        const positions: SourcedPosition[] =
          source === 'book'
            ? bookPositions.map((p) => ({ ...p, sources: ['book'] as PositionSource[] }))
            : source === 'rfq'
            ? rfqPositions.map((p) => ({ ...p, sources: ['rfq'] as PositionSource[] }))
            : mergePositions(bookPositions, rfqPositions);

        // ── 4-tier PnL resolution ──────────────────────────────────────────
        // Mirrors the dApp's options-dashboard route
        // (adaptOptionBookPosition.ts + mapApiPositionToEnriched.ts):
        //
        //   Tier 1 [indexer]      pnlEntries[side].pnlUsd
        //   Tier 2 [indexer]      top-level pnlUsd / pnlPct
        //   Tier 3 [mtm]          MM-pricing × buyer/seller calc (ported from
        //                          pnlCalculations.ts:75-141)
        //   Tier 4 [unavailable]  render "— [pricing unavailable]"
        //
        // Tier 3 fan-out runs in Promise.allSettled — one slow MM fetch can't
        // block the whole table. resolveAllPnL emits a stderr advisory when
        // fan-out exceeds 2s.
        const pnlResolutions = await resolveAllPnL(client, positions);

        if (isTable(opts)) {
          // Humanized table view, mirrored against the dApp's option-book
          // PositionsTable (app/pages/option-book/components/PositionsTable.tsx).
          //
          // Field semantics confirmed against the indexer payload and the
          // SDK normalizer (src/modules/api.ts normalizePosition, line ~945):
          //
          //   amount       — alias for numContracts; scaled by
          //                  collateralDecimals on USDC-collateralized
          //                  options (live: 1505 raw → 0.001505 contracts).
          //                  dApp also divides by 10**collateralDecimals.
          //   entryPrice   — alias for entryPremium; TOTAL premium paid in
          //                  collateral-token decimals (live: 9995 raw =
          //                  $0.009995). dApp renders this as "Premium" with
          //                  a $ prefix. NOT per-contract.
          //   currentValue — indexer does NOT return this field; the SDK
          //                  normalizer defaults it to 0n. dApp ignores it.
          //                  Dropping from the table view.
          //   pnl (bigint) — same story: indexer omits, normalizer zeroes.
          //                  Use pnlUsd (8-dec USD) + pnlPct (string %) as
          //                  the dApp does. Show "—" when both are null.
          //
          // The `pending` fallback used previously was incorrect: the
          // indexer never populates these bigint fields, so "pending"
          // implies a transient state that doesn't exist.
          const rows = positions.map((p, i) => {
            const dec = Number(p.collateralDecimals ?? 6);
            const sym = p.collateralSymbol ?? 'USDC';
            const r = pnlResolutions[i];
            // Display format:
            //   Tier 1/2/3: "+$1.23 (+4.5%)"  — bracket source tag stripped
            //               from the table render; users don't need to know
            //               which tier produced the number. JSON output below
            //               still carries `pnlSource` for script consumers
            //               that want to filter on it.
            //   Tier 4:    "—"
            let pnlDisplay: string;
            if (
              r.pnlUsd !== null &&
              Number.isFinite(r.pnlUsd) &&
              (r.source === 'indexer' || r.source === 'mtm')
            ) {
              const usdStr = `${r.pnlUsd >= 0 ? '+' : ''}$${r.pnlUsd.toFixed(2)}`;
              const pctStr =
                r.pnlPct !== null && Number.isFinite(r.pnlPct)
                  ? ` (${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(1)}%)`
                  : '';
              pnlDisplay = `${usdStr}${pctStr}`;
            } else {
              pnlDisplay = '—';
            }
            // entryTimestamp is when the position was minted on-chain (Book
            // path) or when the underlying RFQ was created (RFQ path, via
            // normalizeRfqPosition). 0n means the SDK didn't populate it —
            // render "—" rather than 1970-01-01.
            const createdTs =
              p.entryTimestamp && p.entryTimestamp > 0n
                ? new Date(Number(p.entryTimestamp) * 1000).toISOString().slice(0, 19) + 'Z'
                : '—';
            return {
              id: p.id,
              optionAddress: p.optionAddress,
              source: p.sources.join('+'),
              side: p.side,
              structure: positionStructureLabel(p),
              createdAt: createdTs,
              expiry: fmtExpiryDate(p.option.expiry),
              contracts: client.utils.fromBigInt(p.amount, dec),
              premium: `$${client.utils.fromBigInt(p.entryPrice, dec)} ${sym}`,
              pnl: pnlDisplay,
            };
          });
          render(rows, renderOpts(opts));
          // If any LIVE row resolved to "—", surface the standard hint so users
          // don't read the dash as "0" or "broken" — most often it just means
          // the MM has rotated off this strike near expiry, and the live
          // quote will return after the next grid refresh
          let anyUnavailable = false;
          for (let i = 0; i < pnlResolutions.length; i++) {
            const r = pnlResolutions[i]!;
            const p = positions[i]!;
            if (r.source === 'unavailable' && !isDeadPosition(p)) {
              anyUnavailable = true;
              break;
            }
          }
          if (anyUnavailable) {
            process.stderr.write(
              `Note: '—' in the pnl column means the market maker had no live quote for that strike at fetch time. ` +
                `It usually clears in a minute or two; re-run \`thetanuts position list\` to retry.\n`
            );
          }
        } else {
          // Machine-readable path: preserve the existing field shape exactly
          // so scripts that rely on `amount` / `entryPrice` / etc. as
          // decimal-string raw values keep working. New fields are additive:
          //   pnlSource — "indexer" | "mtm" | "unavailable"
          //   pnlUsd    — present whenever Tier 1/2/3 resolved (indexer values
          //               kept as 8-dec strings; mtm values as 2-dp USD numbers)
          //   pnlPct    — present whenever the tier produced a percent
          const rows = positions.map((p, i) => {
            const r = pnlResolutions[i];
            const base: Record<string, unknown> = {
              id: p.id,
              optionAddress: p.optionAddress,
              side: p.side,
              amount: p.amount.toString(),
              entryPrice: p.entryPrice.toString(),
              currentValue: p.currentValue.toString(),
              pnl: p.pnl.toString(),
              // New (Fix A) — additive, byte-stable for existing fields above.
              sources: p.sources,
              // New (Tier strategy) — always present, even when unavailable.
              pnlSource: r.source,
            };
            // Pass through the impl labels when the API or normalizer
            // populated them. Both Book (via normalizePosition) and RFQ
            // (via normalizeRfqPosition) emit these.
            if (p.implementationName) base.implementationName = p.implementationName;
            if (p.implementationType) base.implementationType = p.implementationType;
            // entryTimestamp surfaced for scripts (raw unix seconds string).
            if (p.entryTimestamp && p.entryTimestamp > 0n) {
              base.entryTimestamp = p.entryTimestamp.toString();
            }
            // PnL passthrough. For tier=indexer keep the original 8-dec
            // strings if the SDK normalizer populated them (byte-stable for
            // existing scripts). For tier=mtm emit the computed USD numbers.
            if (r.source === 'indexer') {
              if (p.pnlUsd != null && p.pnlUsd !== '') base.pnlUsd = p.pnlUsd;
              else if (r.pnlUsd !== null) base.pnlUsd = r.pnlUsd.toFixed(2);
              if (p.pnlPct != null && p.pnlPct !== '') base.pnlPct = p.pnlPct;
              else if (r.pnlPct !== null) base.pnlPct = r.pnlPct.toFixed(2);
            } else if (r.source === 'mtm' && r.pnlUsd !== null) {
              base.pnlUsd = r.pnlUsd.toFixed(2);
              if (r.pnlPct !== null) base.pnlPct = r.pnlPct.toFixed(2);
            }
            return base;
          });
          render(rows, renderOpts(opts));
        }
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

        // Best-effort underlying derivation. The SDK leaves underlyingToken=""
        // because BaseOption has no underlyingToken() getter — fetch the
        // Chainlink price feed off the option and reverse-look in chain
        // config. Not fatal if either step fails.
        let underlyingSymbol: string | undefined;
        let priceFeedAddr: string | undefined;
        try {
          priceFeedAddr = await client.option.getChainlinkPriceFeed(local.address);
          underlyingSymbol = priceFeedSymbol(client, priceFeedAddr);
        } catch {
          // ignore — table will show empty / N/A
        }

        if (isTable(opts)) {
          // Fix B — priority chain for implementation + optionType resolution:
          //
          //   1. Try the RFQ-side API endpoint first. It returns an entry per
          //      option for this user and includes both `implementation`
          //      (address) and the rich metadata the indexer scraped once
          //      already. This is the fastest, most-reliable path — no RPC.
          //   2. Fall back to on-chain `getImplementation()` (via
          //      `lookupImplementation`) which reverse-looks the address
          //      against `chainConfig.optionImplementations`.
          //   3. Fall back to on-chain `unpackOptionType()` for the raw uint
          //      structure decode. (Handled inside `decodeOptionType`.)
          //   4. Final fallback: render raw uint with a stderr advisory.
          //
          // We don't know the user wallet for `position info` — it takes a
          // bare option address — so the API path uses `getFactoryOption()`
          // which is keyed by option address. That endpoint doesn't carry
          // `implementation` directly, so we fall back to the chain config
          // lookup. If we DO have a signer, we additionally try the user's
          // RFQ positions list (which IS keyed by user and contains impl).
          let impl: OptionImplementationInfo | null = null;
          // Best-effort: scan the signer's positions (BOTH book + rfq) for
          // this option. The Book API populates `implementationName` /
          // `implementationType` directly (verified live: indexer
          // `/api/v1/book/user/<addr>/positions` returns `"implementationName":
          // "PUT"` etc.), so we can resolve impl without an RPC roundtrip.
          // The RFQ API exposes the impl *address* which we reverse-look in
          // chainConfig. Either one beats the flaky on-chain path.
          try {
            const signerAddr = (await client.signer?.getAddress?.()) ?? undefined;
            if (signerAddr) {
              const wanted = local.address.toLowerCase();
              // Run book + rfq lookups in parallel; either may fail
              // independently without blocking the other.
              const [bookSettled, rfqSettled] = await Promise.allSettled([
                client.api.getUserPositionsFromIndexer(signerAddr),
                client.api.getUserOptionsFromRfq(signerAddr),
              ]);
              if (bookSettled.status === 'fulfilled') {
                const hit = bookSettled.value.find(
                  (p) => p.optionAddress.toLowerCase() === wanted
                );
                if (hit?.implementationName) {
                  // Synthesize an OptionImplementationInfo when we have the
                  // name/type but not the address (Book API doesn't return
                  // the impl address — only its name).
                  impl = {
                    name: hit.implementationName,
                    type:
                      (hit.implementationType as OptionImplementationInfo['type']) ??
                      'VANILLA',
                    numStrikes: info.strikes.length,
                  };
                }
              }
              if (!impl && rfqSettled.status === 'fulfilled') {
                const raws = rfqSettled.value as unknown as RfqOptionResponse[];
                const hit = raws.find((p) => p.address?.toLowerCase() === wanted);
                if (hit?.implementation) {
                  const resolved = resolveImplByAddress(client, hit.implementation);
                  if (resolved) {
                    impl = resolved;
                  }
                }
              }
            }
          } catch {
            // ignore — fall through to on-chain
          }
          if (!impl) {
            impl = await lookupImplementation(client, local.address);
          }
          const decoded = await decodeOptionType(client, local.address, info.optionType, impl);
          // Strikes are 8-decimal Chainlink-scaled. Format each as a plain
          // dollar figure for the human view.
          const strikesHuman = info.strikes
            .map((s) => client.utils.fromBigInt(s, 8))
            .join(', ');
          // Note: `implementation`, `implementationName`, `implementationType`
          // are redundant with `optionType` (which decodes to a readable label
          // like "PUT (vanilla)"). The previous version showed them as a
          // separate row, but when the on-chain decoder failed they rendered
          // empty — confusing for a row that adds zero info. Dropped from the
          // table view. JSON output below keeps the raw uint for scripts.
          const out: Record<string, unknown> = {
            address: info.address,
            optionType: decoded.label,
            optionTypeRaw: decoded.raw,
            strikes: `${strikesHuman} USD`,
            strikesRaw: info.strikes.map((s) => s.toString()),
            expiry: fmtTimestamp(info.expiry),
            collateralToken: fmtTokenWithSymbol(client, info.collateralToken),
            // Show whatever the SDK reported, but enrich with the price-feed
            // derived underlying when available. BaseOption itself has no
            // underlyingToken() getter, so info.underlyingToken is "" today.
            underlyingToken:
              info.underlyingToken && /^0x[0-9a-fA-F]{40}$/.test(info.underlyingToken)
                ? fmtTokenWithSymbol(client, info.underlyingToken)
                : underlyingSymbol
                ? `${underlyingSymbol} (derived from priceFeed)`
                : '— (BaseOption has no underlyingToken() getter)',
            priceFeed: priceFeedAddr ?? '—',
          };
          render(out, renderOpts(opts));
        } else {
          // JSON / CSV / YAML: keep the previous shape stable for scripts.
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
        }
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

        // Retry once on transient RPC failures. Public Base RPCs occasionally
        // need a warmup call before they report a chainId; freshly minted
        // options can also briefly fail probe calls before the chain catches
        // up. One retry with a 1.5s backoff covers both.
        const fetchFull = async () => client.option.getFullOptionInfo(local.address);
        let full: Awaited<ReturnType<typeof fetchFull>>;
        try {
          full = await fetchFull();
        } catch (err) {
          if (!isTransientRpcError(err)) throw err;
          process.stderr.write(
            'Initial RPC probe failed (network detection / ABI mismatch). Retrying once in 1.5s…\n'
          );
          await sleep(1500);
          try {
            full = await fetchFull();
          } catch (err2) {
            // Second failure — surface an actionable message.
            const orig = (err2 as { message?: string })?.message ?? String(err2);
            throw new Error(
              `Could not load option ${local.address}: ${orig}\n\n` +
                'Hint: this typically means either (a) the option is freshly minted ' +
                'and the public RPC hasn\'t indexed it yet — wait ~30s and retry — or ' +
                '(b) the public RPC is failing network detection. Set THETANUTS_RPC_URL ' +
                'to a tier-1 provider (Alchemy / Infura / QuickNode) and try again.'
            );
          }
        }

        if (full.info === null) {
          process.stderr.write(
            `Note: getOptionInfo returned null for ${local.address} — the option contract may use an incompatible proxy ABI. Individual sub-calls below may still be populated.\n`
          );
        }

        if (isTable(opts) && full.info) {
          const impl = await lookupImplementation(client, local.address);
          const decoded = await decodeOptionType(client, local.address, full.info.optionType, impl);
          let priceFeedAddr: string | undefined;
          let underlyingSymbol: string | undefined;
          try {
            priceFeedAddr = await client.option.getChainlinkPriceFeed(local.address);
            underlyingSymbol = priceFeedSymbol(client, priceFeedAddr);
          } catch {
            // ignore
          }
          const strikesHuman = full.info.strikes
            .map((s) => client.utils.fromBigInt(s, 8))
            .join(', ');
          // Heuristic: most r12 cash-settled options on Base are
          // USDC-collateralized (6 dec). If we know the collateral token, use
          // its decimals from chainConfig; otherwise default to 6.
          let collateralDecimals = 6;
          let collateralSymbol = 'USDC';
          const collat = full.info.collateralToken.toLowerCase();
          for (const [sym, t] of Object.entries(client.chainConfig.tokens)) {
            if (t.address.toLowerCase() === collat) {
              collateralDecimals = Number(t.decimals);
              collateralSymbol = sym;
              break;
            }
          }
          render(
            {
              address: full.info.address,
              optionType: decoded.label,
              optionTypeRaw: decoded.raw,
              implementation: impl ? `${impl.name} (${impl.type}, ${impl.numStrikes} strikes)` : '—',
              strikes: `${strikesHuman} USD`,
              expiry: fmtTimestamp(full.info.expiry),
              collateralToken: fmtTokenWithSymbol(client, full.info.collateralToken),
              underlyingToken: underlyingSymbol
                ? `${underlyingSymbol} (derived from priceFeed)`
                : '— (BaseOption has no underlyingToken() getter)',
              priceFeed: priceFeedAddr ?? '—',
              buyer: full.buyer ?? '—',
              seller: full.seller ?? '—',
              isExpired: full.isExpired ?? '—',
              isSettled: full.isSettled ?? '—',
              numContracts:
                full.numContracts !== null
                  ? `${client.utils.fromBigInt(full.numContracts, collateralDecimals)} (raw ${full.numContracts.toString()})`
                  : '—',
              collateralAmount:
                full.collateralAmount !== null
                  ? `${client.utils.fromBigInt(full.collateralAmount, collateralDecimals)} ${collateralSymbol} (raw ${full.collateralAmount.toString()})`
                  : '—',
            },
            renderOpts(opts)
          );
        } else {
          // Machine-readable path: keep prior shape.
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
        }
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
    .description('Inspect the automatic post-expiry payout for an option')
    .requiredOption('--address <addr>', 'option contract address')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ address: string }>();
      try {
        const { client } = getClient(opts);

        // Pre-check expiry before reading TWAP — pre-expiry the contract reverts
        // with "TWAP calculation failed", which surfaces as a wall of ethers
        // calldata in the error output. Catch the common case up front with a
        // clean message that tells the user when payout becomes available.
        const expiry = await client.option.getExpiry(local.address);
        const nowSec = BigInt(Math.floor(Date.now() / 1000));
        if (expiry > nowSec) {
          const expiryIso = new Date(Number(expiry) * 1000).toISOString();
          const err = new Error(
            `Option ${local.address} has not expired yet. Payout is settled from the post-expiry TWAP, ` +
              `which becomes available after ${expiry} (${expiryIso}). Settlement is automatic; ` +
              're-run after expiry to inspect it.'
          );
          (err as Error & { exitCode?: number }).exitCode = 4;
          throw err;
        }

        // Preview the simulated payout at TWAP so the user can verify what the
        // automatic factory settlement should deliver.
        // `getStrikes()` and `getNumContracts()` return ethers v6 Result proxies —
        // these are frozen array-likes that throw "Cannot assign to read only
        // property '0'" when ethers tries to re-encode them as ABI input on
        // the next call. Spread/coerce into plain arrays / values before
        // passing into simulatePayout (which encodes uint256[]).
        const [twap, rawStrikes, rawNumContracts] = await Promise.all([
          client.option.getTWAP(local.address),
          client.option.getStrikes(local.address),
          client.option.getNumContracts(local.address),
        ]);
        const strikes: bigint[] = Array.from(rawStrikes ?? []).map((s) => BigInt(String(s)));
        const numContracts: bigint = BigInt(String(rawNumContracts ?? 0n));
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

        // Guard zero-payout: an expired-OTM position has nothing for the
        // automatic settlement callback to transfer to the buyer.
        if (simulated === 0n) {
          const err = new Error(
            `Option ${local.address} expired with zero payout. ` +
              `The strike was not breached at settlement so there is no buyer payout. ` +
              `Premium paid at entry is the realized loss; no on-chain transaction is needed.`
          );
          (err as Error & { exitCode?: number }).exitCode = 0;
          // Render as info, not error — exit code 0 since this isn't a failure.
          process.stderr.write(`${err.message}\n`);
          process.exit(0);
        }

        if (opts.dryRun) {
          render(
            {
              dryRun: true,
              action: 'inspect-automatic-payout',
              optionAddress: local.address,
            },
            renderOpts(opts)
          );
          process.exit(0);
        }

        // TNU-AUDIT-0046: client.option.payout() has been removed because the
        // r12 BaseOption contract has no user-callable payout() entrypoint;
        // settlement is automatic via factory callbacks. Surface this clearly
        // to the user instead of broadcasting a guaranteed-revert tx.
        process.stderr.write(
          'position payout: settlement is automatic on r12 — no on-chain payout() call is needed.\n' +
            '  Buyer payout (if any) is delivered to your address by the factory once ' +
            'the option settles. To verify status, run:\n' +
            `    thetanuts position info --address ${local.address}\n` +
            '  (see TNU-AUDIT-0046 in SECURITY_AUDIT_BETA.md)\n'
        );
        process.exit(0);
      } catch (err) {
        renderError(err, renderOpts(opts));
        const exit = (err as Error & { exitCode?: number }).exitCode ?? 1;
        process.exit(exit);
      }
    });

  // -------------------------------------------------------------------------
  // close — open a flipped-direction RFQ on the same option to unwind
  // -------------------------------------------------------------------------
  grp
    .command('close')
    .description(
      'Close an RFQ position by opening an opposite-direction RFQ on the same option ' +
        '(mirrors the dApp\'s close-position flow).'
    )
    .requiredOption('--address <addr>', 'option contract address to close (copy from `position list`)')
    .option(
      '--reserve-price <n>',
      'override the MM-derived closing price per contract, denominated in the position\'s own collateral (USDC for cash structures, WETH for inverse calls). Required when the MM has no live quote.'
    )
    .option('--deadline-minutes <n>', 'offer-window length in minutes (default 1 = 60 s)', '1')
    .option('--fill-or-kill', 'reject partial fills — only accept a full-size match')
    .option('--ensure-allowance', 'approve collateral on OptionFactory before submission if short')
    .option('--approve-amount <max|n>', 'allowance amount when --ensure-allowance fires (default: exact reservePrice)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        address: string;
        reservePrice?: string;
        deadlineMinutes?: string;
        fillOrKill?: boolean;
        ensureAllowance?: boolean;
        approveAmount?: string;
      }>();
      try {
        if (!/^0x[a-fA-F0-9]{40}$/.test(local.address)) {
          throw new Error('--address must be a 0x-prefixed 40-char hex address');
        }

        const res = getClient(opts);
        requireSigner(res);
        const { client } = res;
        const signerAddress = await client.getSignerAddress();

        // Fetch all RFQ-source positions for the signer, find the target.
        // The SDK's return type is loose; narrow to unknown[] then guard before
        // touching individual records. Defensive in case the indexer ever ships
        // a non-array payload (rare 5xx shape mismatch).
        const raws = (await client.api.getUserOptionsFromRfq(signerAddress)) as unknown;
        const rawList: unknown[] = Array.isArray(raws) ? raws : [];
        const targetRaw = rawList.find(
          (r): r is RfqOptionResponse =>
            typeof r === 'object' &&
            r !== null &&
            'address' in r &&
            String((r as { address?: unknown }).address ?? '').toLowerCase() ===
              local.address.toLowerCase()
        );
        if (!targetRaw) {
          const err = new Error(
            `No RFQ-source position found for option ${local.address} on signer ${signerAddress}. ` +
              `Run \`thetanuts position list --source rfq\` to see closeable positions.`
          );
          (err as Error & { exitCode?: number }).exitCode = 4;
          throw err;
        }

        const pos = normalizeRfqPosition(client, targetRaw as RfqOptionResponse, signerAddress);
        const side = pos.side; // 'buyer' | 'seller'
        const isClosingLong = side === 'seller'; // seller buys back, buyer sells back

        const implementationAddress = String(targetRaw.implementation ?? '');
        if (
          !implementationAddress ||
          implementationAddress === '0x0000000000000000000000000000000000000000'
        ) {
          throw new Error(
            `Position ${local.address} has no resolved implementation address. ` +
              `The indexer payload may be incomplete; retry in a moment.`
          );
        }
        const collateralPriceFeed = String(
          targetRaw.priceFeed ?? targetRaw.collateralPriceFeed ?? pos.priceFeed ?? ''
        );
        if (!collateralPriceFeed) {
          throw new Error(`Position ${local.address} is missing collateralPriceFeed on the indexer payload.`);
        }

        const collateralMeta = getCollateralMeta(client, pos.option.collateral);

        // Both USDC (6-dec) and WETH (18-dec) closes are supported. The reserve
        // math below is exact bigint arithmetic, so 18-decimal raw amounts —
        // which exceed Number.MAX_SAFE_INTEGER — never round-trip through a
        // float. MM quotes come back in collateral terms via
        // `byCollateral[collateralMeta.asset]`, so an INVERSE_CALL is priced in
        // ETH, not USD.

        // Derive closingPricePerContract: MM-driven by default, override via --reserve-price.
        let closingPricePerContract: number;
        let priceSource: 'mm-bid' | 'mm-ask' | 'user';
        if (local.reservePrice !== undefined && local.reservePrice !== '') {
          closingPricePerContract = Number.parseFloat(local.reservePrice);
          if (!Number.isFinite(closingPricePerContract) || closingPricePerContract < 0) {
            throw new Error('--reserve-price must be a non-negative number');
          }
          priceSource = 'user';
        } else {
          const pricing = await fetchPricingForPosition(client, pos);
          if (!pricing) {
            const err = new Error(
              `MM has no live quote for ${pos.optionAddress} right now (typical 1–3 h pre-expiry). ` +
                `Pass --reserve-price <${collateralMeta.symbol}-per-contract> explicitly. ` +
                `Tip: closing buyer side wants the MM bid (floor), seller side wants the ask (ceiling).`
            );
            (err as Error & { exitCode?: number }).exitCode = 4;
            throw err;
          }
          // buyer closes by selling → uses MM bid (sellPrice in our PricingForPnL)
          // seller closes by buying → uses MM ask (buyPrice in our PricingForPnL)
          closingPricePerContract = side === 'buyer' ? pricing.sellPrice : pricing.buyPrice;
          priceSource = side === 'buyer' ? 'mm-bid' : 'mm-ask';
          if (!Number.isFinite(closingPricePerContract) || closingPricePerContract <= 0) {
            const err = new Error(
              `MM closing quote was non-positive (${closingPricePerContract}). ` +
                `The option may be too deep ITM/OTM or near expiry. ` +
                `Pass --reserve-price <${collateralMeta.symbol}-per-contract> to force a closing RFQ at your own price.`
            );
            (err as Error & { exitCode?: number }).exitCode = 4;
            throw err;
          }
        }

        // Reserve price formula matches dApp useRfqActions.ts:733-738:
        //   rawReserve = numContracts (raw) × closingPricePerContract (human)
        //   reservePriceBn = ceil(rawReserve) on BUY side, floor(rawReserve) on SELL side
        const numContractsRaw = pos.amount ?? 0n;
        if (numContractsRaw <= 0n) {
          throw new Error(`Position ${local.address} has numContracts=0 — nothing to close.`);
        }
        // Scale the human price to 18 decimals and multiply in bigint space.
        // `Number(numContractsRaw) * price` loses low digits once the raw
        // amount passes 2^53, which every 18-decimal WETH position does.
        const RESERVE_PRICE_PRECISION = 18;
        const reserveDenom = 10n ** BigInt(RESERVE_PRICE_PRECISION);
        const priceScaled = client.utils.toBigInt(
          closingPricePerContract,
          RESERVE_PRICE_PRECISION
        );
        const reserveProduct = numContractsRaw * priceScaled;
        const reservePriceBn =
          closingPricePerContract > 0
            ? isClosingLong
              ? (reserveProduct + reserveDenom - 1n) / reserveDenom // ceil on BUY
              : reserveProduct / reserveDenom // floor on SELL
            : 0n;

        // Build the request (matches dApp shape exactly).
        const keyPair = await client.rfqKeys.getOrCreateKeyPair();
        const deadlineMinutes = Number.parseFloat(local.deadlineMinutes ?? '1');
        if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) {
          throw new Error(`--deadline-minutes must be > 0 (got "${local.deadlineMinutes}")`);
        }
        // Guard here, not at the broadcast restamp: a sub-second window rounds
        // to 0 and would otherwise throw only after an approval tx was mined.
        if (Math.round(deadlineMinutes * 60) < 1) {
          const err = new Error(
            `--deadline-minutes must be at least one whole second (got "${local.deadlineMinutes}")`
          );
          (err as Error & { exitCode?: number }).exitCode = 4;
          throw err;
        }
        const offerEndSec = Math.floor(Date.now() / 1000) + Math.round(deadlineMinutes * 60);
        // Catch the common doomed-close case before the approval tx below.
        // This narrows but does NOT close the window: the restamp at broadcast
        // uses a later `submittedAt`, so an option expiring within
        // (window + approval/confirm time) still fails there — with exit 4 and
        // a clear message, but after an approval has been mined. `rfq request`
        // carries the same residual gap by construction.
        if (BigInt(pos.option.expiry) <= BigInt(offerEndSec)) {
          const err = new Error(
            `Option ${pos.optionAddress} expires at ${pos.option.expiry}, which is at or before the ` +
              `${Math.round(deadlineMinutes * 60)}s offer deadline. Lower --deadline-minutes or let it settle.`
          );
          (err as Error & { exitCode?: number }).exitCode = 4;
          throw err;
        }
        const request: RFQRequest = {
          params: {
            requester: signerAddress,
            existingOptionAddress: pos.optionAddress,
            collateral: pos.option.collateral,
            collateralPriceFeed,
            implementation: implementationAddress,
            strikes: pos.option.strikes,
            numContracts: numContractsRaw,
            requesterDeposit: 0n,
            collateralAmount: 0n,
            expiryTimestamp: BigInt(pos.option.expiry),
            offerEndTimestamp: BigInt(offerEndSec),
            isRequestingLongPosition: isClosingLong,
            convertToLimitOrder: !local.fillOrKill,
            extraOptionData: '0x',
          },
          tracking: { referralId: 0n, eventCode: 0n },
          reservePrice: reservePriceBn,
          requesterPublicKey: keyPair.compressedPublicKey,
        };

        const contractsHuman = client.utils.fromBigInt(numContractsRaw, collateralMeta.decimals);
        const reserveHuman = client.utils.fromBigInt(reservePriceBn, collateralMeta.decimals);
        const closeDirection = isClosingLong ? 'buy' : 'sell';

        // Compute a display ticker if we can; falls back to the option address.
        // SDK's buildTicker takes (underlying, expiry, strikes, isCall) — same
        // helper book preview uses for display.
        const underlyingForTicker = deriveUnderlying(
          client,
          pos.option.underlying,
          pos.priceFeed,
          pos.option.collateral
        );
        const strikesHumanForTicker = pos.option.strikes.map((s) => Number(s) / 1e8);
        const isCallForTicker = deriveIsCall(pos);
        // buildTicker only accepts a single strike; for multi-leg, render
        // a slash-joined ticker manually (matches the dApp's display style).
        let displayTicker: string;
        if (underlyingForTicker && strikesHumanForTicker.length === 1) {
          displayTicker = buildTicker(
            underlyingForTicker,
            pos.option.expiry,
            strikesHumanForTicker[0]!,
            isCallForTicker
          );
        } else if (underlyingForTicker && strikesHumanForTicker.length > 1) {
          const base = buildTicker(
            underlyingForTicker,
            pos.option.expiry,
            strikesHumanForTicker[0]!,
            isCallForTicker
          );
          // e.g. "ETH-19MAY26-2125-P" → "ETH-19MAY26-2125/2100-P"
          const suffix = strikesHumanForTicker
            .slice(1)
            .map((s) => s.toString())
            .join('/');
          const m = base.match(/^(.*-)(\d+(?:\.\d+)?)(-[CP])$/);
          displayTicker = m ? `${m[1]}${m[2]}/${suffix}${m[3]}` : base;
        } else {
          displayTicker = pos.optionAddress;
        }

        const summary = {
          action: 'close',
          optionAddress: pos.optionAddress,
          ticker: displayTicker,
          side,
          closingDirection: closeDirection,
          contracts: contractsHuman,
          closingPricePerContract,
          priceSource,
          reservePrice: reservePriceBn.toString(),
          reservePriceHuman: `${reserveHuman} ${collateralMeta.symbol}`,
          deadlineSeconds: Math.round(deadlineMinutes * 60),
          fillOrKill: Boolean(local.fillOrKill),
        };
        render(summary, renderOpts(opts));

        // Dry-run: emit calldata + skip allowance + skip broadcast.
        if (opts.dryRun) {
          const { to, data } = client.optionFactory.encodeRequestForQuotation(request);
          render(
            {
              dryRun: true,
              transaction: {
                to,
                data:
                  data.length > 80
                    ? `${data.slice(0, 40)}…${data.slice(-8)} (${data.length} chars)`
                    : data,
              },
            },
            renderOpts(opts)
          );
          process.exit(0);
        }

        // Ensure allowance — only when the requester actually escrows collateral.
        // BUY-side close (seller closing) requires the reservePrice to be escrowed
        // up-front on the OptionFactory. SELL-side close doesn't escrow USDC
        // (the option itself transfers), so the allowance step is skipped.
        if (isClosingLong && reservePriceBn > 0n && local.ensureAllowance) {
          const factoryAddr = client.chainConfig.contracts.optionFactory;
          if (!factoryAddr) {
            throw new Error('OptionFactory is not deployed on this chain — close-position requires Base mainnet.');
          }
          const desired =
            local.approveAmount === 'max'
              ? MaxUint256
              : local.approveAmount !== undefined
                ? client.utils.toBigInt(local.approveAmount, collateralMeta.decimals)
                : reservePriceBn;
          if (local.approveAmount === 'max') {
            process.stderr.write(
              `WARNING: approving MaxUint256 on ${collateralMeta.asset} for optionFactory. Revoke after closing if you do not trust the contract.\n`
            );
          }
          if (!pos.option.collateral) {
            throw new Error('Position is missing collateral address; cannot approve.');
          }
          const approveReceipt = await client.erc20.ensureAllowance(pos.option.collateral, factoryAddr, desired);
          if (approveReceipt) {
            render(
              {
                action: 'approve',
                txHash: approveReceipt.hash,
                status: approveReceipt.status,
                gasUsed: approveReceipt.gasUsed.toString(),
              },
              renderOpts(opts)
            );
          }
        }

        const ok = await confirm(
          `Submit closing RFQ (${closeDirection.toUpperCase()} ${contractsHuman} contracts of ${displayTicker}, reserve ${reserveHuman} ${collateralMeta.symbol}, ${Math.round(deadlineMinutes * 60)}s deadline)?`,
          { yes: opts.yes, dryRun: opts.dryRun }
        );
        if (!ok) process.exit(3);

        // The ERC-20 approval above and the confirm prompt can consume most or
        // all of the offer window (default 60s), which would mine an RFQ that is
        // already expired. Restamp the deadline at the final broadcast boundary
        // so makers receive the full requested window — same fix as `rfq request`.
        const submittedAt = Math.floor(Date.now() / 1000);
        const requestToSubmit = refreshRfqOfferDeadline(
          request,
          submittedAt,
          Math.round(deadlineMinutes * 60)
        );
        const receipt = await client.optionFactory.requestForQuotation(requestToSubmit);
        const quotationId = extractQuotationIdFromReceipt(
          receipt.logs,
          client.optionFactory.contractAddress
        );
        const ethUsd = await fetchEthUsdSafe(client.api);
        render(
          buildTxReceiptPayload(
            receipt,
            ethUsd,
            quotationId !== undefined ? { quotationId } : undefined
          ),
          renderOpts(opts)
        );

        // Post-broadcast guidance — match `rfq request`'s tip pattern. Auto-settle
        // is best-effort on close RFQs (no maker is incentivized to call settle
        // when no offer wins)
        if (opts.output !== 'json') {
          const idHint = quotationId !== undefined ? quotationId : '<quotationId>';
          process.stderr.write(
            `\nClose RFQ ${idHint} submitted on ${pos.optionAddress}. The protocol settles after the offer deadline (${Math.round(deadlineMinutes * 60)} s).\n` +
              `  thetanuts rfq status --ticker ${displayTicker} --since ${submittedAt}\n` +
              `  thetanuts position list --source rfq\n` +
              `Note: close RFQs may not auto-settle when no maker matches. If status still shows the RFQ active after the deadline, run:\n` +
              `  thetanuts rfq settle --id ${idHint}\n` +
              `to refund the escrow.\n`
          );
        }
      } catch (err) {
        renderError(err, renderOpts(opts));
        const exit = (err as Error & { exitCode?: number }).exitCode ?? 1;
        process.exit(exit);
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
    .requiredOption(
      '--type <type>',
      'option type: call | put | call_spread | put_spread | call_fly | put_fly | ' +
        'call_condor | put_condor | iron_condor | ranger'
    )
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
        const allowed: PayoutType[] = [
          'call',
          'put',
          'call_spread',
          'put_spread',
          'call_fly',
          'put_fly',
          'call_condor',
          'put_condor',
          'iron_condor',
          'ranger',
        ];
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
        // put_fly takes strikes DESCENDING; all other multi-leg structures
        // (call_fly, call_condor, put_condor, iron_condor, ranger) and the
        // spread types take strikes ASCENDING. See PayoutType JSDoc in
        // src/modules/utils.ts for the per-type strike-order contract.
        const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
        const descending = (a: bigint, b: bigint): number => (a < b ? 1 : a > b ? -1 : 0);
        const strikes = local.strikes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => client.utils.toPriceDecimals(s))
          .sort(t === 'put_fly' ? descending : ascending);
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
