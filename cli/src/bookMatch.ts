import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import { formatStructureTicker } from './format.js';

/**
 * The single order-matching predicate shared by `book check`, `book preview`
 * and `book fill`.
 *
 * Before this module the two paths matched differently: `check` compared only
 * `strikes[0]` while `preview`/`fill` compared the whole vector element-wise.
 * `check` therefore reported "No orderbook liquidity" for strikes that sat on
 * a live structure's second/third/fourth leg — routing traders off the book
 * (and off orderbook credit) onto RFQ — while simultaneously reporting 4-leg
 * rangers as fillable vanillas whose recommended `preview` command then failed.
 *
 * One predicate here means `check` cannot disagree with `fill` about what the
 * book holds.
 */

/** Strikes are stored 1e8-scaled. */
export const STRIKE_DECIMALS = 8;
const STRIKE_SCALE = 10 ** STRIKE_DECIMALS;

export interface OrderSelector {
  /** Lowercased price-feed address, already resolved from chain config. */
  priceFeed: string;
  type: 'PUT' | 'CALL';
  /** 1e8-scaled strikes. Order is irrelevant — matching is multiset-based. */
  strikesRaw: bigint[];
  /** Exact unix seconds. */
  expiry: number;
}

/** Minimal shape of a chain-config implementation entry. */
export interface StructureMeta {
  name: string;
  type?: string;
}

export interface StructureDescriptor {
  /** Implementation name, e.g. `RANGER`, `PUT_SPREAD`, `LINEAR_CALL`. */
  name: string;
  /** Chain-config structure kind, e.g. `RANGER`, `SPREAD`, `VANILLA`. */
  kind: string;
  strikesUsd: number[];
  /** Honest ticker — never a bare `-C`/`-P` suffix on a multi-leg order. */
  ticker: string;
  isMultiLeg: boolean;
}

export function orderStrikesRaw(order: OrderWithSignature): bigint[] {
  const strikes = order.rawApiData?.strikes ?? [];
  return strikes.map((s) => BigInt(s as string | number | bigint));
}

export function orderStrikesUsd(order: OrderWithSignature): number[] {
  return orderStrikesRaw(order).map((s) => Number(s) / STRIKE_SCALE);
}

export function usdToStrikeRaw(strikeUsd: number): bigint {
  return BigInt(Math.round(strikeUsd * STRIKE_SCALE));
}

/**
 * Compare two strike vectors as multisets rather than sequences.
 *
 * Makers do not store strikes in a canonical order: 19 of 310 live orders keep
 * them descending (`PUT_SPREAD [68000, 67000]`, `PUT_FLY [69000, 66000,
 * 63000]`). Element-wise comparison meant `--strikes 67000,68000` — the
 * natural ascending form a human types — missed a live order that
 * `--strikes 68000,67000` filled. Matching on the multiset is safe because the
 * fill encodes the *signed order's own* strike vector; the caller's argument
 * order never reaches the contract.
 */
export function sameStrikeMultiset(a: readonly bigint[], b: readonly bigint[]): boolean {
  if (a.length !== b.length) return false;
  const sortAsc = (xs: readonly bigint[]): bigint[] =>
    [...xs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const sa = sortAsc(a);
  const sb = sortAsc(b);
  return sa.every((v, i) => v === sb[i]);
}

/** True when `order` is exactly the instrument `sel` describes. */
export function orderMatchesSelector(
  order: OrderWithSignature,
  sel: OrderSelector
): boolean {
  const raw = order.rawApiData;
  if (!raw) return false;
  const orderType: 'PUT' | 'CALL' = raw.isCall ? 'CALL' : 'PUT';
  if (orderType !== sel.type) return false;
  if (raw.priceFeed?.toLowerCase() !== sel.priceFeed) return false;
  if (Number(order.order.expiry) !== sel.expiry) return false;
  return sameStrikeMultiset(orderStrikesRaw(order), sel.strikesRaw);
}

export function findMatchingOrders(
  orders: readonly OrderWithSignature[],
  sel: OrderSelector
): OrderWithSignature[] {
  return orders.filter((o) => orderMatchesSelector(o, sel));
}

export interface LegMatch {
  order: OrderWithSignature;
  /** Index of the requested strike within the order's stored strike vector. */
  legIndex: number;
}

/**
 * Live multi-leg orders that carry `strikeRaw` on any leg.
 *
 * This is the liquidity `book check` used to be blind to. A caller asking
 * about a single strike that only exists inside a spread/fly/ranger can still
 * trade on the book — they just have to fill the whole structure, so the
 * caller must be told which structure it is before acting.
 */
export function ordersWithStrikeAsLeg(
  orders: readonly OrderWithSignature[],
  priceFeed: string,
  type: 'PUT' | 'CALL',
  expiry: number,
  strikeRaw: bigint
): LegMatch[] {
  const matches: LegMatch[] = [];
  for (const order of orders) {
    const raw = order.rawApiData;
    if (!raw) continue;
    const orderType: 'PUT' | 'CALL' = raw.isCall ? 'CALL' : 'PUT';
    if (orderType !== type) continue;
    if (raw.priceFeed?.toLowerCase() !== priceFeed) continue;
    if (Number(order.order.expiry) !== expiry) continue;
    const strikes = orderStrikesRaw(order);
    if (strikes.length < 2) continue;
    const legIndex = strikes.findIndex((s) => s === strikeRaw);
    if (legIndex >= 0) matches.push({ order, legIndex });
  }
  return matches;
}

/**
 * Describe an order's structure for display.
 *
 * `numStrikes` from chain config is deliberately ignored: it disagrees across
 * deployments (RANGER is 2 on one implementation address and 4 on another).
 * The order's own strike vector is the only reliable leg count.
 */
export function structureInfo(
  order: OrderWithSignature,
  underlying: string,
  implementations: Record<string, StructureMeta | undefined>
): StructureDescriptor {
  const implAddress = order.rawApiData?.implementation?.toLowerCase();
  const meta = implAddress ? implementations[implAddress] : undefined;
  const strikesUsd = orderStrikesUsd(order);
  const type: 'PUT' | 'CALL' = order.rawApiData?.isCall ? 'CALL' : 'PUT';
  const expiry = Number(order.order.expiry);
  return {
    name: meta?.name ?? implAddress ?? 'UNKNOWN',
    kind: meta?.type ?? 'UNKNOWN',
    strikesUsd,
    ticker: formatStructureTicker(underlying, expiry, strikesUsd, type, meta?.name),
    isMultiLeg: strikesUsd.length > 1,
  };
}

/**
 * Resolve an underlying symbol to a price-feed address.
 *
 * Chain config carries legacy alias keys (`ETH/USD` alongside `ETH`) that
 * resolve to the same feed. They stay accepted as input but are filtered out
 * of the "Known:" hint so the error message reads cleanly.
 */
export function resolvePriceFeed(
  underlying: string,
  priceFeeds: Record<string, string>
): { feed: string } | { error: string } {
  const feed = priceFeeds[underlying.toUpperCase()];
  if (feed) return { feed: feed.toLowerCase() };
  const known = Object.keys(priceFeeds)
    .filter((k) => !k.includes('/'))
    .join(', ');
  return { error: `Unknown underlying "${underlying}". Known: ${known}.` };
}
