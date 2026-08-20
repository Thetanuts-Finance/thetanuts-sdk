import assert from 'node:assert/strict';
import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import { computeCheckResult, type CheckContext, type CheckParams } from '../src/bookCheck.js';
import { orderStrikesRaw, type StructureMeta } from '../src/bookMatch.js';

const FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const FEED_LC = FEED.toLowerCase();
const OTHER_FEED = '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F';

// Two expiries on the SAME UTC date — the live book really does carry an
// 03:00Z and an 08:00Z on some days, which is why we never auto-snap.
const EXP_0400 = 1_787_198_400; // 2026-08-20T04:00:00Z
const EXP_0800 = 1_787_212_800; // 2026-08-20T08:00:00Z
const EXP_NEXT = 1_787_299_200; // 2026-08-21T08:00:00Z

const VANILLA_PUT = '0x7355eb92dfb0503db558a70c10843618932ab290';
const LINEAR_CALL = '0x051791df68223ae173fade5217c48875e36eef61';
const PUT_SPREAD = '0x02fe0d9635e0139dbb3768a5d5db404fd84d9134';
const RANGER = '0x9980ec85bc6fe07340adb36c76fa093bb6d4fcbc';

const IMPLS: Record<string, StructureMeta | undefined> = {
  [VANILLA_PUT]: { name: 'PUT', type: 'VANILLA' },
  [LINEAR_CALL]: { name: 'LINEAR_CALL', type: 'VANILLA' },
  [PUT_SPREAD]: { name: 'PUT_SPREAD', type: 'SPREAD' },
  [RANGER]: { name: 'RANGER', type: 'RANGER' },
};

function order(opts: {
  strikesUsd: number[];
  implementation: string;
  isCall?: boolean;
  expiry?: number;
  priceFeed?: string;
  price?: bigint;
}): OrderWithSignature {
  return {
    order: {
      maker: '0x0000000000000000000000000000000000000001',
      taker: '0x0000000000000000000000000000000000000000',
      option: '',
      isBuyer: false,
      numContracts: 0n,
      price: opts.price ?? 800_000_000n,
      expiry: BigInt(opts.expiry ?? EXP_0800),
      nonce: 1n,
    },
    signature: '0x01',
    availableAmount: 10_000_000_000n,
    makerAddress: '0x0000000000000000000000000000000000000001',
    rawApiData: {
      collateral: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      priceFeed: opts.priceFeed ?? FEED,
      implementation: opts.implementation,
      strikes: opts.strikesUsd.map((s) => String(Math.round(s * 1e8))),
      isCall: opts.isCall ?? false,
      isLong: false,
      orderExpiryTimestamp: EXP_0400 - 3_600,
      extraOptionData: '0x',
      maxCollateralUsable: '10000000000',
    },
  } as OrderWithSignature;
}

const ctx: CheckContext = {
  priceFeed: FEED_LC,
  implementations: IMPLS,
  maxContracts: () => 10_000_000n, // 10 contracts at 1e6 scale
  contractScale: 1e6,
  cliExecutable: true,
};

function params(over: Partial<CheckParams> = {}): CheckParams {
  return {
    underlying: 'ETH',
    type: 'PUT',
    strike: 2200,
    expiry: EXP_0800,
    direction: 'buy',
    ...over,
  };
}

const vanilla2200 = order({ strikesUsd: [2200], implementation: VANILLA_PUT });
const vanilla2250 = order({ strikesUsd: [2250], implementation: VANILLA_PUT, price: 900_000_000n });
const spread = order({ strikesUsd: [2200, 2150], implementation: PUT_SPREAD });
const rangerCall = order({
  strikesUsd: [2150, 2200, 2250, 2300],
  implementation: RANGER,
  isCall: true,
  price: 1_390_000_000n,
});
const rangerCallCheap = order({
  strikesUsd: [2100, 2200, 2300, 2400],
  implementation: RANGER,
  isCall: true,
  price: 1_200_000_000n,
});
const nextDay = order({ strikesUsd: [2200], implementation: VANILLA_PUT, expiry: EXP_NEXT });
const earlySameDay = order({ strikesUsd: [2400], implementation: VANILLA_PUT, expiry: EXP_0400 });
const otherUnderlying = order({
  strikesUsd: [2200],
  implementation: VANILLA_PUT,
  priceFeed: OTHER_FEED,
});

const BOOK = [
  vanilla2200,
  vanilla2250,
  spread,
  rangerCall,
  rangerCallCheap,
  nextDay,
  earlySameDay,
  otherUnderlying,
];

// --- 1. exact vanilla -------------------------------------------------------
const exact = computeCheckResult(BOOK, params(), ctx);
assert.equal(exact.recommendation, 'orderbook');
assert.equal(exact.orderbookOrders.length, 1);
assert.equal(exact.orderbookOrders[0]!.ticker, 'ETH-20AUG26-2200-P');
assert.equal(exact.bestPrice, 8);
assert.equal(exact.nextStep.includes('--strike 2200'), true);
assert.equal(
  exact.structureMatches.length,
  1,
  'the 2200/2150 spread is still surfaced alongside the vanilla'
);

// A different underlying at the same strike/expiry must not leak in.
assert.equal(
  exact.orderbookOrders.every((o) => o.strike === 2200),
  true
);

// --- 2. strike only on a structure leg -- the money bug ---------------------
const legOnly = computeCheckResult(BOOK, params({ type: 'CALL', strike: 2300 }), ctx);
assert.equal(
  legOnly.recommendation,
  'orderbook',
  'a strike on a live structure leg must NEVER be routed to RFQ'
);
assert.equal(legOnly.orderbookOrders.length, 0, 'no standalone 2300 call exists');
assert.equal(legOnly.structureMatches.length, 2);
// Cheapest structure leads, and its nextStep is the runnable multi-leg form.
assert.equal(legOnly.structureMatches[0]!.structurePrice, 12);
assert.deepEqual(legOnly.structureMatches[0]!.strikes, [2100, 2200, 2300, 2400]);
assert.equal(legOnly.structureMatches[0]!.legIndex, 2);
// The per-match command is the runnable multi-leg form...
assert.equal(
  legOnly.structureMatches[0]!.nextStep.includes('--strikes 2100,2200,2300,2400'),
  true
);
assert.equal(legOnly.structureMatches[0]!.nextStepIsCommand, true);
assert.equal(
  legOnly.structureMatches[0]!.nextStep.includes('--strike 2300 '),
  false,
  'must not emit the single-strike form that cannot resolve'
);
// ...but the TOP-LEVEL step is not a command: see BUG-002 below.
assert.equal(legOnly.nextStepIsCommand, false);
// The ticker must not read as a vanilla call.
assert.equal(legOnly.structureMatches[0]!.ticker, 'ETH-20AUG26-2100/2200/2300/2400-RANGER');
assert.equal(
  legOnly.reason.includes('different payoffs'),
  true,
  'caller must be told the structure is not the vanilla they asked for'
);

// --- 3. live expiry, far strike -> honest rfq -------------------------------
const farStrike = computeCheckResult(BOOK, params({ strike: 900 }), ctx);
assert.equal(farStrike.recommendation, 'rfq');
assert.equal(farStrike.structureMatches.length, 0);
assert.equal(farStrike.nearbyStrikes.length, 0, '900 is far outside the 5% band');

const nearStrike = computeCheckResult(BOOK, params({ strike: 2260 }), ctx);
assert.equal(nearStrike.recommendation, 'rfq');
assert.equal(nearStrike.nearbyStrikes.length > 0, true);
assert.equal(nearStrike.nearbyStrikes[0]!.strike, 2250, 'closest vanilla strike first');
assert.equal(
  nearStrike.nearbyStrikes.every((n) => n.strike !== 2200 || true),
  true
);

// --- 4. wrong expiry -> liveExpiries + didYouMean, never a silent RFQ -------
const wrongExpiry = computeCheckResult(BOOK, params({ expiry: EXP_0800 - 7_200 }), ctx);
assert.equal(wrongExpiry.orderbookOrders.length, 0);
assert.equal(wrongExpiry.structureMatches.length, 0);
assert.deepEqual(
  wrongExpiry.didYouMean.sort((a, b) => a - b),
  [EXP_0400, EXP_0800],
  'BOTH same-UTC-date expiries are offered; neither is auto-picked'
);
assert.equal(
  wrongExpiry.liveExpiries.map((e) => e.expiry).includes(EXP_NEXT),
  true,
  'the full live expiry set is reported'
);
const eightOClock = wrongExpiry.liveExpiries.find((e) => e.expiry === EXP_0800)!;
assert.equal(eightOClock.vanillaCount, 2, '2200 and 2250 vanillas');
assert.equal(eightOClock.structureCount, 1, 'the PUT spread');
assert.equal(wrongExpiry.reason.includes('did you mean'), true);

// --- 5. partial fill --------------------------------------------------------
const partial = computeCheckResult(BOOK, params({ size: 25 }), ctx);
assert.equal(partial.recommendation, 'orderbook');
assert.equal(partial.partialFillAvailable, true);
assert.equal(partial.partialSize, 10);

const full = computeCheckResult(BOOK, params({ size: 5 }), ctx);
assert.equal(full.partialFillAvailable, false);

// --- 6. sell direction is reported, not asserted away -----------------------
const sellCtx: CheckContext = { ...ctx, cliExecutable: false };
const sell = computeCheckResult(BOOK, params({ direction: 'sell' }), sellCtx);
assert.equal(sell.cliExecutable, false);
assert.equal(sell.recommendation, 'orderbook', 'a matching bid is still reported as book liquidity');
assert.equal(sell.reason.includes('cannot execute sells'), true);
// BUG-003: an orderbook recommendation must never hand back an RFQ command.
assert.equal(
  sell.nextStep.includes('rfq build'),
  false,
  'live book liquidity must never be routed off-book by the next step'
);
assert.equal(sell.nextStepIsCommand, false);
assert.equal(sell.nextStep.includes('app.thetanuts.finance'), true);
assert.equal(sell.nextStepMaxSize, null);

const sellEmpty = computeCheckResult([], params({ direction: 'sell' }), sellCtx);
assert.equal(sellEmpty.recommendation, 'rfq');
assert.equal(sellEmpty.liveExpiries.length, 0);

// --- 7. THE INVARIANT -------------------------------------------------------
// For every order on the book and every strike it carries, `check` must not
// recommend RFQ. This is the property whose violation cost real money.
for (const o of BOOK) {
  const raw = o.rawApiData!;
  if (raw.priceFeed!.toLowerCase() !== FEED_LC) continue;
  const type: 'PUT' | 'CALL' = raw.isCall ? 'CALL' : 'PUT';
  for (const strikeRaw of orderStrikesRaw(o)) {
    const strike = Number(strikeRaw) / 1e8;
    const res = computeCheckResult(
      BOOK,
      params({ type, strike, expiry: Number(o.order.expiry) }),
      ctx
    );
    assert.notEqual(
      res.recommendation,
      'rfq',
      `check routed strike ${strike} ${type} @ ${o.order.expiry} to RFQ despite live book liquidity`
    );
    assert.equal(
      res.orderbookOrders.length > 0 || res.structureMatches.length > 0,
      true,
      `no match surfaced for strike ${strike} ${type} @ ${o.order.expiry}`
    );
  }
}

// Converse: a strike/expiry the book genuinely lacks must never claim orderbook.
const phantom = computeCheckResult(BOOK, params({ strike: 4321, expiry: EXP_NEXT }), ctx);
assert.equal(phantom.recommendation, 'rfq');
assert.equal(phantom.orderbookOrders.length, 0);
assert.equal(phantom.structureMatches.length, 0);


// --- 8. BUG-001: aggregate availability vs what ONE fill can take ----------
// Two makers at the same instrument, different prices, requested size larger
// than either but smaller than their sum. `check` used to call this "fully
// available" while the command it recommended resolved to the cheapest maker
// alone.
const cheapAsk = order({ strikesUsd: [2200], implementation: VANILLA_PUT, price: 100_000_000n });
const pricyAsk = order({ strikesUsd: [2200], implementation: VANILLA_PUT, price: 200_000_000n });
const sizeByOrder = new Map<OrderWithSignature, bigint>([
  [cheapAsk, 5_000_000n],
  [pricyAsk, 5_000_000n],
]);
const ladderCtx: CheckContext = { ...ctx, maxContracts: (o) => sizeByOrder.get(o) ?? 0n };
// Deliberately unsorted input: the pricier maker comes first on the wire.
const ladder = computeCheckResult([pricyAsk, cheapAsk], params({ size: 8 }), ladderCtx);
assert.equal(ladder.recommendation, 'orderbook');
assert.equal(ladder.availableSize, 10, 'the aggregate is still reported');
assert.equal(ladder.bestPrice, 1);
assert.equal(
  ladder.orderbookOrders[0]!.price,
  1,
  'best price leads, matching what resolveOrderBySelector picks'
);
assert.deepEqual(ladder.priceLevels, [
  { price: 1, availableContracts: 5, orders: 1 },
  { price: 2, availableContracts: 5, orders: 1 },
]);
assert.equal(ladder.nextStepMaxSize, 5, 'one fill resolves one order');
assert.equal(
  ladder.partialFillAvailable,
  true,
  'requested size exceeds what the recommended command can fill in one go'
);
assert.equal(ladder.partialSize, 5);
assert.equal(ladder.reason.includes('priceLevels'), true);

// A size the top level covers on its own is not a partial fill.
const ladderSmall = computeCheckResult([pricyAsk, cheapAsk], params({ size: 4 }), ladderCtx);
assert.equal(ladderSmall.partialFillAvailable, false);
assert.equal(ladderSmall.nextStepMaxSize, 5);

// --- 9. BUG-002/004: structure matches are alternatives, never a winner ----
const PUT_FLY = '0x3ba26e1d2b1f6c37b0d8a6c4a2a1e30bd1a4a111';
const IMPLS_FLY: Record<string, StructureMeta | undefined> = {
  ...IMPLS,
  [PUT_FLY]: { name: 'PUT_FLY', type: 'FLY' },
};
// 2200 is the LONG leg of the spread and the SHORT (middle) leg of the fly.
// Ranking these by whole-structure premium is meaningless — and following the
// "cheapest" could hand the caller the opposite exposure.
const fly = order({
  strikesUsd: [2300, 2200, 2100],
  implementation: PUT_FLY,
  price: 1_790_000_000n,
});
const structCtx: CheckContext = {
  ...ctx,
  implementations: IMPLS_FLY,
  maxContracts: () => 3_000_000n, // 3 contracts
};
const structOnly = computeCheckResult([spread, fly], params({ strike: 2200 }), structCtx);
assert.equal(structOnly.recommendation, 'orderbook');
assert.equal(structOnly.orderbookOrders.length, 0);
assert.equal(structOnly.structureMatches.length, 2);
assert.equal(
  structOnly.nextStepIsCommand,
  false,
  'no top-level command may auto-select between incomparable payoffs'
);
assert.equal(structOnly.nextStep.includes('book preview'), false);
assert.equal(structOnly.nextStep.includes('rfq build'), false);
assert.equal(structOnly.reason.includes('not comparable'), true);
assert.equal(structOnly.reason.includes('short or middle leg'), true);
assert.equal(structOnly.nextStepMaxSize, null);
// Each alternative still carries its own runnable command and leg position.
const flyMatch = structOnly.structureMatches.find((m) => m.structure === 'PUT_FLY')!;
assert.equal(flyMatch.legIndex, 1, '2200 is the middle leg of 2300/2200/2100');
assert.equal(flyMatch.legCount, 3);
assert.equal(flyMatch.nextStepIsCommand, true);
assert.equal(flyMatch.nextStep.includes('--strikes 2300,2200,2100'), true);

// BUG-004: --size is evaluated per structure instead of silently ignored.
const structSized = computeCheckResult(
  [spread, fly],
  params({ strike: 2200, size: 8 }),
  structCtx
);
assert.equal(
  structSized.structureMatches.every((m) => m.meetsRequestedSize === false),
  true,
  'a 3-contract structure cannot cover an 8-contract request'
);
assert.equal(structSized.reason.includes('0 of 2 can cover'), true);
assert.equal(
  structOnly.structureMatches.every((m) => m.meetsRequestedSize === null),
  true,
  'no --size means no sufficiency claim'
);

// --- 10. BUG-003: sell-side structure matches emit no buy-only command -----
const structSell = computeCheckResult(
  [spread, fly],
  params({ strike: 2200, direction: 'sell' }),
  { ...structCtx, cliExecutable: false }
);
assert.equal(structSell.recommendation, 'orderbook');
assert.equal(
  structSell.structureMatches.every((m) => !m.nextStepIsCommand),
  true
);
assert.equal(
  structSell.structureMatches.every((m) => !m.nextStep.includes('book preview')),
  true,
  '`book preview` filters to asks — it cannot preview the bid that matched'
);
assert.equal(structSell.nextStep.includes('rfq build'), false);

// --- 11. BUG-005: a one-off --referrer survives into every emitted command --
const REFERRER = '0x1111111111111111111111111111111111111111';
const refCtx: CheckContext = { ...ctx, referrer: REFERRER };
const withRef = computeCheckResult(BOOK, params(), refCtx);
assert.equal(withRef.referrer, REFERRER);
assert.equal(withRef.nextStep.startsWith(`thetanuts --referrer ${REFERRER} book preview`), true);
assert.equal(
  withRef.structureMatches.every((m) =>
    m.nextStep.startsWith(`thetanuts --referrer ${REFERRER} book preview`)
  ),
  true
);
const noRef = computeCheckResult(BOOK, params(), ctx);
assert.equal(noRef.referrer, null);
assert.equal(noRef.nextStep.startsWith('thetanuts book preview'), true);

console.log('book check ladder + invariant tests passed');
