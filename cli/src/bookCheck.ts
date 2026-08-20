import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import { ORDER_PRICE_DECIMALS } from './bookEligibility.js';
import {
  findMatchingOrders,
  orderStrikesUsd,
  ordersWithStrikeAsLeg,
  structureInfo,
  usdToStrikeRaw,
  type StructureMeta,
} from './bookMatch.js';

/**
 * Pure decision core for `book check`.
 *
 * Kept out of the command layer so the recommendation ladder is unit-testable
 * without a network client, and so the invariant that matters can be asserted
 * directly: *`check` may only answer `rfq` when the shared matcher finds
 * nothing at the requested expiry — neither an exact instrument nor a
 * structure carrying the strike on one of its legs.*
 *
 * That invariant is the whole point. The previous implementation matched only
 * `strikes[0]`, so it recommended RFQ for strikes sitting on a live
 * structure's later legs, pushing traders off the book and forfeiting
 * orderbook credit.
 */

export interface CheckParams {
  underlying: string;
  type: 'PUT' | 'CALL';
  strike: number;
  expiry: number;
  direction: 'buy' | 'sell';
  size?: number;
}

export interface MatchingOrder {
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

export interface NearbyStrike {
  strike: number;
  priceDiff: string;
  bestPrice: number;
  availableContracts: number;
  orderIndex: number;
}

/**
 * A live multi-leg order carrying the requested strike on one of its legs.
 * `price` is the premium for the whole structure — never comparable to a
 * vanilla ask, which is why these are reported separately from
 * `orderbookOrders` rather than merged into it.
 */
export interface StructureMatch {
  index: number;
  structure: string;
  structureKind: string;
  ticker: string;
  strikes: number[];
  legIndex: number;
  structurePrice: number;
  availableContracts: number;
  expiry: number;
  expiryDate: string;
  maker: string;
  nextStep: string;
}

export interface LiveExpiry {
  expiry: number;
  iso: string;
  vanillaCount: number;
  structureCount: number;
}

export interface CheckResultCore {
  recommendation: 'orderbook' | 'rfq';
  reason: string;
  params: CheckParams;
  orderbookOrders: MatchingOrder[];
  structureMatches: StructureMatch[];
  bestPrice: number | null;
  availableSize: number | null;
  partialFillAvailable: boolean;
  partialSize: number | null;
  nearbyStrikes: NearbyStrike[];
  liveExpiries: LiveExpiry[];
  didYouMean: number[];
  /** False when the book has liquidity the CLI itself cannot execute (sells). */
  cliExecutable: boolean;
  nextStep: string;
}

export interface CheckContext {
  /** Lowercased price-feed address for `params.underlying`. */
  priceFeed: string;
  implementations: Record<string, StructureMeta | undefined>;
  /** Structure-aware contract count, from the SDK. */
  maxContracts: (order: OrderWithSignature) => bigint;
  /** 10 ** collateral decimals, for humanizing contract counts. */
  contractScale: number;
  /** The CLI can only execute buys today; sells are report-only. */
  cliExecutable: boolean;
}

const NEARBY_TOLERANCE = 0.05;

function isoOf(expiry: number): string {
  return new Date(expiry * 1000).toISOString();
}

function utcDate(expiry: number): string {
  return isoOf(expiry).slice(0, 10);
}

function priceOf(order: OrderWithSignature): number {
  return order.order?.price ? Number(order.order.price) / 10 ** ORDER_PRICE_DECIMALS : 0;
}

function strikesCsv(strikesUsd: number[]): string {
  return strikesUsd.join(',');
}

export function computeCheckResult(
  orders: readonly OrderWithSignature[],
  params: CheckParams,
  ctx: CheckContext
): CheckResultCore {
  const indexOf = new Map<OrderWithSignature, number>();
  orders.forEach((o, i) => indexOf.set(o, i));

  const strikeRaw = usdToStrikeRaw(params.strike);
  const side: 'BID' | 'ASK' = params.direction === 'buy' ? 'ASK' : 'BID';
  const contracts = (o: OrderWithSignature): number =>
    Number(ctx.maxContracts(o)) / ctx.contractScale;

  const describe = (o: OrderWithSignature) =>
    structureInfo(o, params.underlying, ctx.implementations);

  // Everything on this feed/type, regardless of expiry — used for the
  // "your expiry has no book at all" branch.
  const sameInstrument = orders.filter((o) => {
    const raw = o.rawApiData;
    if (!raw) return false;
    const orderType: 'PUT' | 'CALL' = raw.isCall ? 'CALL' : 'PUT';
    return orderType === params.type && raw.priceFeed?.toLowerCase() === ctx.priceFeed;
  });
  const atExpiry = sameInstrument.filter((o) => Number(o.order.expiry) === params.expiry);

  const liveExpiryMap = new Map<number, LiveExpiry>();
  for (const o of sameInstrument) {
    const e = Number(o.order.expiry);
    let entry = liveExpiryMap.get(e);
    if (!entry) {
      entry = { expiry: e, iso: isoOf(e), vanillaCount: 0, structureCount: 0 };
      liveExpiryMap.set(e, entry);
    }
    if (orderStrikesUsd(o).length > 1) entry.structureCount += 1;
    else entry.vanillaCount += 1;
  }
  const liveExpiries = [...liveExpiryMap.values()].sort((a, b) => a.expiry - b.expiry);
  // Same UTC date as the requested expiry. Never auto-snap: the book carries
  // both an 03:00Z and an 08:00Z expiry on some dates, so picking one for the
  // caller would be a guess with money attached.
  const didYouMean = liveExpiries
    .filter((e) => e.expiry !== params.expiry && utcDate(e.expiry) === utcDate(params.expiry))
    .map((e) => e.expiry);

  const previewBase =
    `thetanuts book preview --underlying ${params.underlying} --type ${params.type}`;
  const rfqStep =
    `thetanuts rfq build --underlying ${params.underlying} --type ${params.type} ` +
    `--strike ${params.strike} --expiry ${params.expiry} --contracts <n> --direction ${params.direction}`;

  // --- 1. Exact single-strike instrument -----------------------------------
  const exact = findMatchingOrders(atExpiry, {
    priceFeed: ctx.priceFeed,
    type: params.type,
    strikesRaw: [strikeRaw],
    expiry: params.expiry,
  });

  const orderbookOrders: MatchingOrder[] = exact.map((o) => {
    const info = describe(o);
    return {
      index: indexOf.get(o) ?? -1,
      ticker: info.ticker,
      type: params.type,
      strike: params.strike,
      expiry: Number(o.order.expiry),
      expiryDate: isoOf(Number(o.order.expiry)),
      side,
      price: priceOf(o),
      availableContracts: contracts(o),
      maker: o.makerAddress ?? o.order?.maker ?? '',
    };
  });

  // --- 2. Structures carrying the strike on any leg ------------------------
  const legMatches = ordersWithStrikeAsLeg(
    atExpiry,
    ctx.priceFeed,
    params.type,
    params.expiry,
    strikeRaw
  );
  const structureMatches: StructureMatch[] = legMatches
    .map(({ order, legIndex }) => {
      const info = describe(order);
      const expiry = Number(order.order.expiry);
      return {
        index: indexOf.get(order) ?? -1,
        structure: info.name,
        structureKind: info.kind,
        ticker: info.ticker,
        strikes: info.strikesUsd,
        legIndex,
        structurePrice: priceOf(order),
        availableContracts: contracts(order),
        expiry,
        expiryDate: isoOf(expiry),
        maker: order.makerAddress ?? order.order?.maker ?? '',
        nextStep:
          `${previewBase} --strikes ${strikesCsv(info.strikesUsd)} ` +
          `--expiry ${expiry} --collateral <amount>`,
      };
    })
    .sort((a, b) => a.structurePrice - b.structurePrice);

  // --- 3. Nearby vanilla strikes (same expiry, within tolerance) -----------
  const tolerance = params.strike * NEARBY_TOLERANCE;
  const nearbyByStrike = new Map<number, OrderWithSignature[]>();
  for (const o of atExpiry) {
    const strikes = orderStrikesUsd(o);
    if (strikes.length !== 1) continue;
    const s = strikes[0]!;
    if (s === params.strike) continue;
    if (Math.abs(s - params.strike) > tolerance) continue;
    if (!nearbyByStrike.has(s)) nearbyByStrike.set(s, []);
    nearbyByStrike.get(s)!.push(o);
  }
  const nearbyStrikes: NearbyStrike[] = [...nearbyByStrike.entries()]
    .map(([strike, group]) => {
      const best = group.reduce((acc, curr) =>
        params.direction === 'buy'
          ? priceOf(curr) < priceOf(acc)
            ? curr
            : acc
          : priceOf(curr) > priceOf(acc)
            ? curr
            : acc
      );
      const diff = (((strike - params.strike) / params.strike) * 100).toFixed(1);
      return {
        strike,
        priceDiff: `${parseFloat(diff) >= 0 ? '+' : ''}${diff}%`,
        bestPrice: priceOf(best),
        availableContracts: group.reduce((sum, o) => sum + contracts(o), 0),
        orderIndex: indexOf.get(best) ?? -1,
      };
    })
    .sort((a, b) => Math.abs(a.strike - params.strike) - Math.abs(b.strike - params.strike))
    .slice(0, 5);

  // --- Aggregate vanilla availability --------------------------------------
  const totalAvailable = orderbookOrders.reduce((sum, o) => sum + o.availableContracts, 0);
  const bestPrice =
    orderbookOrders.length > 0
      ? params.direction === 'buy'
        ? Math.min(...orderbookOrders.map((o) => o.price))
        : Math.max(...orderbookOrders.map((o) => o.price))
      : null;

  const sideWord = params.direction === 'buy' ? 'ask' : 'bid';
  const cliCaveat = ctx.cliExecutable
    ? ''
    : ' The CLI cannot execute sells — fill via the dApp to keep orderbook credit, or use RFQ.';

  let recommendation: 'orderbook' | 'rfq';
  let reason: string;
  let nextStep: string;
  let partialFillAvailable = false;
  let partialSize: number | null = null;

  if (orderbookOrders.length > 0) {
    recommendation = 'orderbook';
    const previewStep =
      `${previewBase} --strike ${params.strike} --expiry ${params.expiry} --collateral <amount>`;
    if (params.size !== undefined && params.size > totalAvailable) {
      partialFillAvailable = true;
      partialSize = totalAvailable;
      reason =
        `Found ${totalAvailable.toFixed(4)} contracts at strike $${params.strike} ` +
        `(you requested ${params.size}). Partial fill available via orderbook, ` +
        `or use RFQ for the full amount.${cliCaveat}`;
    } else {
      reason =
        `Found orderbook liquidity at strike $${params.strike}. ` +
        `Best ${sideWord} price: $${bestPrice?.toFixed(2)}. ` +
        `Available: ${totalAvailable.toFixed(4)} contracts.${cliCaveat}`;
    }
    nextStep = ctx.cliExecutable ? previewStep : rfqStep;
  } else if (structureMatches.length > 0) {
    // The strike is on the book, but only inside a structure. Staying on the
    // book preserves orderbook credit; the caller just has to know they are
    // buying a different payoff than a vanilla at this strike.
    recommendation = 'orderbook';
    const best = structureMatches[0]!;
    reason =
      `No standalone $${params.strike} ${params.type} on the book, but $${params.strike} is ` +
      `leg ${best.legIndex + 1} of ${structureMatches.length} live ` +
      `${structureMatches.length === 1 ? 'structure' : 'structures'} at this expiry — ` +
      `cheapest ${best.ticker} (strikes ${best.strikes.join('/')}) at ` +
      `$${best.structurePrice.toFixed(2)} per contract for the whole structure, ` +
      `${best.availableContracts.toFixed(4)} available. Fill the full structure to stay ` +
      `on the orderbook; its payoff differs from a vanilla at this strike.${cliCaveat}`;
    nextStep = ctx.cliExecutable ? best.nextStep : rfqStep;
  } else if (atExpiry.length > 0) {
    recommendation = 'rfq';
    reason =
      nearbyStrikes.length > 0
        ? `No orderbook liquidity at strike $${params.strike} for this expiry. ` +
          `Nearby strikes available: ${nearbyStrikes
            .slice(0, 3)
            .map((s) => `$${s.strike} (${s.priceDiff})`)
            .join(', ')}. Use RFQ for your exact strike, or trade a nearby strike.`
        : `The book has ${atExpiry.length} live ${params.type} order(s) at this expiry but ` +
          `nothing at or near $${params.strike}. Submit an RFQ — market makers respond ` +
          `within 45 seconds (default deadline).`;
    nextStep = rfqStep;
  } else {
    recommendation = 'rfq';
    const expiryHint =
      liveExpiries.length === 0
        ? `The book has no live ${params.underlying} ${params.type} orders at all right now.`
        : didYouMean.length > 0
          ? `No orders at expiry ${params.expiry}. The book has ${didYouMean
              .map((e) => `${e} (${isoOf(e).slice(0, 16)}Z)`)
              .join(' and ')} on the same UTC date — did you mean one of those?`
          : `No orders at expiry ${params.expiry}. Live expiries: ${liveExpiries
              .map((e) => `${e.expiry} (${e.iso.slice(0, 16)}Z)`)
              .join(', ')}.`;
    reason = `${expiryHint} Submit an RFQ for this exact expiry, or re-check against a listed one.`;
    nextStep = rfqStep;
  }

  return {
    recommendation,
    reason,
    params,
    orderbookOrders: orderbookOrders.slice(0, 10),
    structureMatches: structureMatches.slice(0, 10),
    bestPrice,
    availableSize: totalAvailable > 0 ? totalAvailable : null,
    partialFillAvailable,
    partialSize,
    nearbyStrikes,
    liveExpiries,
    didYouMean,
    cliExecutable: ctx.cliExecutable,
    nextStep,
  };
}
