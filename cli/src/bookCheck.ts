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
 *
 * A second invariant, added after the first live audit: *every command this
 * module emits must be one the CLI can actually run against the same order
 * set `check` just scanned.* `nextStep` used to fall back to `rfq build` for
 * sell-side matches — the exact off-book route the orderbook recommendation
 * exists to avoid — and structure matches emitted `book preview` commands even
 * for sells, which `preview` filters to asks. When there is no runnable
 * command, `nextStep` is prose and `nextStepIsCommand` is false.
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

/**
 * One price level of the exact-instrument book, best price first.
 *
 * `availableSize` sums every level, but a single `book fill` resolves exactly
 * one order — so an aggregate on its own overstates what the recommended
 * command can do. The ladder is what makes the difference inspectable.
 */
export interface PriceLevel {
  price: number;
  availableContracts: number;
  orders: number;
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
 * vanilla ask, and never comparable to another structure's premium either,
 * which is why these are reported as unranked alternatives rather than sorted
 * into a winner.
 */
export interface StructureMatch {
  index: number;
  structure: string;
  structureKind: string;
  ticker: string;
  strikes: number[];
  legIndex: number;
  legCount: number;
  structurePrice: number;
  availableContracts: number;
  /** Null when the caller passed no `--size`. */
  meetsRequestedSize: boolean | null;
  expiry: number;
  expiryDate: string;
  maker: string;
  nextStep: string;
  /** False when `nextStep` is prose (sell side — the CLI executes buys only). */
  nextStepIsCommand: boolean;
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
  priceLevels: PriceLevel[];
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
  /** False when `nextStep` is prose describing a manual action, not a command. */
  nextStepIsCommand: boolean;
  /** Contracts `nextStep` can fill in one invocation, when it is a fill command. */
  nextStepMaxSize: number | null;
  /** Referrer baked into every emitted command; null when none resolved. */
  referrer: string | null;
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
  /**
   * Resolved referrer for THIS process. A one-off `--referrer` configures only
   * the current invocation, so it has to be threaded into every generated
   * command or the copied workflow silently falls back to address zero.
   */
  referrer?: string;
}

const NEARBY_TOLERANCE = 0.05;
const DAPP_URL = 'https://app.thetanuts.finance';

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

  // A one-off `--referrer` lives for exactly this process. Bake it into every
  // emitted command so copying the workflow keeps the attribution.
  const cli = ctx.referrer ? `thetanuts --referrer ${ctx.referrer}` : 'thetanuts';
  const previewBase =
    `${cli} book preview --underlying ${params.underlying} --type ${params.type}`;
  // RFQ has its own numeric `--referral-id`; the OptionBook referrer does not
  // apply, so this command is deliberately left unprefixed.
  const rfqStep =
    `thetanuts rfq build --underlying ${params.underlying} --type ${params.type} ` +
    `--strike ${params.strike} --expiry ${params.expiry} --contracts <n> --direction ${params.direction}`;
  const dappStep =
    `Fill this ${params.direction === 'buy' ? 'ask' : 'bid'} in the dApp (${DAPP_URL}) — ` +
    'the CLI executes buys only. No RFQ command is emitted on purpose: the book ' +
    'has liquidity here, and routing off-book forfeits orderbook credit.';

  // --- 1. Exact single-strike instrument -----------------------------------
  const exact = findMatchingOrders(atExpiry, {
    priceFeed: ctx.priceFeed,
    type: params.type,
    strikesRaw: [strikeRaw],
    expiry: params.expiry,
  });

  // Best price first, matching how `resolveOrderBySelector` picks (strictly
  // lowest price for a buy, first-encountered on a tie — Array#sort is stable,
  // so `orderbookOrders[0]` IS the order the emitted command resolves to).
  const orderbookOrders: MatchingOrder[] = exact
    .map((o) => {
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
    })
    .sort((a, b) => (params.direction === 'buy' ? a.price - b.price : b.price - a.price));

  const levelMap = new Map<number, PriceLevel>();
  for (const o of orderbookOrders) {
    let level = levelMap.get(o.price);
    if (!level) {
      level = { price: o.price, availableContracts: 0, orders: 0 };
      levelMap.set(o.price, level);
    }
    level.availableContracts += o.availableContracts;
    level.orders += 1;
  }
  const priceLevels = [...levelMap.values()].sort((a, b) =>
    params.direction === 'buy' ? a.price - b.price : b.price - a.price
  );

  // --- 2. Structures carrying the strike on any leg ------------------------
  //
  // Deliberately NOT ranked. A spread, a fly and a ranger that happen to share
  // one strike are different products: their whole-structure premiums are not
  // comparable, and the requested strike can be a long, short or middle leg —
  // so "cheapest" could hand the caller exposure opposite to the vanilla they
  // asked about. Sorted by price only for a stable, inspectable listing.
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
      const availableContracts = contracts(order);
      return {
        index: indexOf.get(order) ?? -1,
        structure: info.name,
        structureKind: info.kind,
        ticker: info.ticker,
        strikes: info.strikesUsd,
        legIndex,
        legCount: info.strikesUsd.length,
        structurePrice: priceOf(order),
        availableContracts,
        meetsRequestedSize:
          params.size === undefined ? null : availableContracts >= params.size,
        expiry,
        expiryDate: isoOf(expiry),
        maker: order.makerAddress ?? order.order?.maker ?? '',
        // `book preview` filters to asks, so its command form is meaningless
        // for a sell-side match — emit the manual action instead.
        nextStep: ctx.cliExecutable
          ? `${previewBase} --strikes ${strikesCsv(info.strikesUsd)} ` +
            `--expiry ${expiry} --collateral <amount>`
          : dappStep,
        nextStepIsCommand: ctx.cliExecutable,
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
  const bestPrice = orderbookOrders.length > 0 ? orderbookOrders[0]!.price : null;
  // What ONE `book fill` against the recommended command can actually take.
  const topOrderSize =
    orderbookOrders.length > 0 ? orderbookOrders[0]!.availableContracts : null;

  const sideWord = params.direction === 'buy' ? 'ask' : 'bid';
  const cliCaveat = ctx.cliExecutable
    ? ''
    : ` The CLI cannot execute sells — fill via the dApp (${DAPP_URL}) to keep orderbook credit.`;

  let recommendation: 'orderbook' | 'rfq';
  let reason: string;
  let nextStep: string;
  let nextStepIsCommand: boolean;
  let nextStepMaxSize: number | null = null;
  let partialFillAvailable = false;
  let partialSize: number | null = null;

  if (orderbookOrders.length > 0) {
    recommendation = 'orderbook';
    const previewStep =
      `${previewBase} --strike ${params.strike} --expiry ${params.expiry} --collateral <amount>`;
    const spread =
      priceLevels.length > 1
        ? ` Liquidity spans ${priceLevels.length} price levels across ` +
          `${orderbookOrders.length} makers — one fill takes one order, so sweeping ` +
          `the rest means repeating the command against the next level.`
        : '';
    if (params.size !== undefined && topOrderSize !== null && params.size > topOrderSize) {
      partialFillAvailable = true;
      partialSize = topOrderSize;
      reason =
        params.size > totalAvailable
          ? `Found ${totalAvailable.toFixed(4)} contracts total at strike $${params.strike} ` +
            `(you requested ${params.size}); the best ${sideWord} at ` +
            `$${bestPrice?.toFixed(2)} holds ${topOrderSize.toFixed(4)}. Partial fill ` +
            `available via orderbook, or use RFQ for the full amount.${spread}${cliCaveat}`
          : `The book holds ${totalAvailable.toFixed(4)} contracts at strike $${params.strike} ` +
            `(you requested ${params.size}), but the best ${sideWord} at ` +
            `$${bestPrice?.toFixed(2)} holds only ${topOrderSize.toFixed(4)} — one fill takes ` +
            `${topOrderSize.toFixed(4)}, the remainder sits at worse prices. See ` +
            `priceLevels for the ladder.${cliCaveat}`;
    } else {
      reason =
        `Found orderbook liquidity at strike $${params.strike}. ` +
        `Best ${sideWord} price: $${bestPrice?.toFixed(2)} ` +
        `(${topOrderSize?.toFixed(4)} contracts). ` +
        `Available across all makers: ${totalAvailable.toFixed(4)} contracts.${spread}${cliCaveat}`;
    }
    // Never route a live-book match to RFQ. When the CLI cannot execute the
    // side, say so as prose — an `rfq build` here would take the trade
    // off-book, the exact cost this branch exists to prevent.
    nextStep = ctx.cliExecutable ? previewStep : dappStep;
    nextStepIsCommand = ctx.cliExecutable;
    nextStepMaxSize = ctx.cliExecutable ? topOrderSize : null;
  } else if (structureMatches.length > 0) {
    // The strike is on the book, but only inside a structure. Staying on the
    // book preserves orderbook credit; the caller has to choose WHICH
    // structure, because these payoffs cannot be ranked against each other.
    recommendation = 'orderbook';
    const listed = structureMatches
      .slice(0, 3)
      .map(
        (m) =>
          `${m.ticker} (strikes ${m.strikes.join('/')}, your strike is leg ${m.legIndex + 1} ` +
          `of ${m.legCount}) at $${m.structurePrice.toFixed(2)} per contract, ` +
          `${m.availableContracts.toFixed(4)} available`
      )
      .join('; ');
    const more =
      structureMatches.length > 3 ? ` (+${structureMatches.length - 3} more)` : '';
    const sizeNote =
      params.size === undefined
        ? ''
        : ` ${structureMatches.filter((m) => m.meetsRequestedSize).length} of ` +
          `${structureMatches.length} can cover your ${params.size}-contract size on their own ` +
          `— see meetsRequestedSize per match.`;
    reason =
      `No standalone $${params.strike} ${params.type} on the book, but $${params.strike} sits ` +
      `on a leg of ${structureMatches.length} live ` +
      `${structureMatches.length === 1 ? 'structure' : 'structures'} at this expiry: ` +
      `${listed}${more}. These are alternatives, not substitutes — a spread, fly, condor and ` +
      `ranger sharing one strike have different payoffs, and your strike may be a short or ` +
      `middle leg, so the whole-structure premiums are not comparable and none is "cheapest". ` +
      `Pick the structure whose payoff you want, then fill it in full to stay on the ` +
      `orderbook.${sizeNote}${cliCaveat}`;
    nextStep = ctx.cliExecutable
      ? 'Choose a structure from structureMatches after inspecting its payoff, then run that ' +
        "match's nextStep. No top-level command is emitted: ranking by premium is only valid " +
        'among orders for the same complete structure.'
      : dappStep;
    nextStepIsCommand = false;
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
    nextStepIsCommand = true;
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
    nextStepIsCommand = true;
  }

  return {
    recommendation,
    reason,
    params,
    orderbookOrders: orderbookOrders.slice(0, 10),
    priceLevels,
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
    nextStepIsCommand,
    nextStepMaxSize,
    referrer: ctx.referrer ?? null,
  };
}
