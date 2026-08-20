import assert from 'node:assert/strict';
import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import {
  findMatchingOrders,
  orderMatchesSelector,
  ordersWithStrikeAsLeg,
  resolvePriceFeed,
  sameStrikeMultiset,
  structureInfo,
  usdToStrikeRaw,
  type StructureMeta,
} from '../src/bookMatch.js';

const FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const FEED_LC = FEED.toLowerCase();
const EXPIRY = 1_787_904_000;
const VANILLA_PUT = '0x7355eb92dfb0503db558a70c10843618932ab290';
const PUT_SPREAD = '0x02fe0d9635e0139dbb3768a5d5db404fd84d9134';
const PUT_FLY = '0x4fd2c6d271cc6ff3ebd2027da9815a0608d03aa3';
const RANGER = '0x9980ec85bc6fe07340adb36c76fa093bb6d4fcbc';
const CALL_CONDOR = '0x14476cf2ea9f7c448100f061670e390f17c78817';

const IMPLS: Record<string, StructureMeta | undefined> = {
  [VANILLA_PUT]: { name: 'PUT', type: 'VANILLA' },
  [PUT_SPREAD]: { name: 'PUT_SPREAD', type: 'SPREAD' },
  [PUT_FLY]: { name: 'PUT_FLY', type: 'BUTTERFLY' },
  [RANGER]: { name: 'RANGER', type: 'RANGER' },
  [CALL_CONDOR]: { name: 'CALL_CONDOR', type: 'CONDOR' },
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
      expiry: BigInt(opts.expiry ?? EXPIRY),
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
      orderExpiryTimestamp: EXPIRY - 3_600,
      extraOptionData: '0x',
      maxCollateralUsable: '10000000000',
    },
  } as OrderWithSignature;
}

// --- multiset comparison ----------------------------------------------------
assert.equal(sameStrikeMultiset([1n, 2n], [2n, 1n]), true);
assert.equal(sameStrikeMultiset([1n, 2n], [1n, 2n]), true);
assert.equal(sameStrikeMultiset([1n, 2n], [1n, 3n]), false);
assert.equal(sameStrikeMultiset([1n], [1n, 1n]), false, 'length must still differ');
assert.equal(sameStrikeMultiset([1n, 1n, 2n], [1n, 2n, 2n]), false, 'true multiset, not a set');

// --- exact instrument matching ---------------------------------------------
const vanilla = order({ strikesUsd: [2200], implementation: VANILLA_PUT });
const sel = {
  priceFeed: FEED_LC,
  type: 'PUT' as const,
  strikesRaw: [usdToStrikeRaw(2200)],
  expiry: EXPIRY,
};
assert.equal(orderMatchesSelector(vanilla, sel), true);
assert.equal(
  orderMatchesSelector(vanilla, { ...sel, expiry: EXPIRY + 1 }),
  false,
  'expiry must match exactly'
);
assert.equal(orderMatchesSelector(vanilla, { ...sel, type: 'CALL' }), false);
assert.equal(
  orderMatchesSelector(vanilla, { ...sel, priceFeed: '0xdead' }),
  false,
  'wrong price feed must not match'
);

// A single-strike selector must never match a multi-leg order — this is the
// bug that made `book check` report 4-strike RANGERs as fillable vanillas.
const ranger = order({ strikesUsd: [2150, 2200, 2250, 2300], implementation: RANGER, isCall: true });
assert.equal(
  orderMatchesSelector(ranger, {
    ...sel,
    type: 'CALL',
    strikesRaw: [usdToStrikeRaw(2150)],
  }),
  false,
  'leg strike alone must not match the whole structure'
);

// --- descending stored strike vectors --------------------------------------
// 19 of 310 live orders store strikes descending. The ascending form a human
// types must still resolve, or `preview`/`fill` report a phantom "no match".
const descendingSpread = order({ strikesUsd: [2200, 2150], implementation: PUT_SPREAD });
assert.equal(
  orderMatchesSelector(descendingSpread, {
    ...sel,
    strikesRaw: [usdToStrikeRaw(2150), usdToStrikeRaw(2200)],
  }),
  true,
  'ascending user input must match a descending stored vector'
);
assert.equal(
  orderMatchesSelector(descendingSpread, {
    ...sel,
    strikesRaw: [usdToStrikeRaw(2200), usdToStrikeRaw(2150)],
  }),
  true,
  'stored order must of course still match'
);

const descendingFly = order({ strikesUsd: [2300, 2200, 2100], implementation: PUT_FLY });
assert.equal(
  orderMatchesSelector(descendingFly, {
    ...sel,
    strikesRaw: [2100, 2200, 2300].map(usdToStrikeRaw),
  }),
  true,
  'three-leg descending fly matches ascending input'
);

// --- findMatchingOrders -----------------------------------------------------
const book = [vanilla, descendingSpread, descendingFly, ranger];
assert.equal(findMatchingOrders(book, sel).length, 1);
assert.equal(
  findMatchingOrders(book, {
    ...sel,
    strikesRaw: [usdToStrikeRaw(2150), usdToStrikeRaw(2200)],
  }).length,
  1
);

// --- leg lookup -------------------------------------------------------------
const legs = ordersWithStrikeAsLeg(book, FEED_LC, 'CALL', EXPIRY, usdToStrikeRaw(2300));
assert.equal(legs.length, 1);
assert.equal(legs[0]!.legIndex, 3, '2300 is the 4th leg of the ranger');

const putLegs = ordersWithStrikeAsLeg(book, FEED_LC, 'PUT', EXPIRY, usdToStrikeRaw(2200));
assert.equal(putLegs.length, 2, 'spread and fly both carry a 2200 leg');
assert.equal(
  putLegs.every((l) => l.order.rawApiData!.strikes.length >= 2),
  true,
  'vanillas are never reported as leg matches'
);
assert.equal(
  ordersWithStrikeAsLeg(book, FEED_LC, 'PUT', EXPIRY + 1, usdToStrikeRaw(2200)).length,
  0,
  'leg lookup respects expiry'
);

// --- structure descriptions -------------------------------------------------
const rangerInfo = structureInfo(ranger, 'ETH', IMPLS);
assert.equal(rangerInfo.name, 'RANGER');
assert.equal(rangerInfo.isMultiLeg, true);
assert.equal(rangerInfo.ticker, 'ETH-28AUG26-2150/2200/2250/2300-RANGER');
assert.equal(
  rangerInfo.ticker.endsWith('-C'),
  false,
  'a multi-leg order must never render with a bare vanilla suffix'
);

const vanillaInfo = structureInfo(vanilla, 'ETH', IMPLS);
assert.equal(vanillaInfo.isMultiLeg, false);
assert.equal(vanillaInfo.ticker, 'ETH-28AUG26-2200-P');

// Strikes render in stored order so the ticker round-trips into `--strikes`.
assert.equal(
  structureInfo(descendingSpread, 'ETH', IMPLS).ticker,
  'ETH-28AUG26-2200/2150-PUT_SPREAD'
);

// Unknown implementation must degrade, not throw.
const unknown = structureInfo(
  order({ strikesUsd: [2200, 2300], implementation: '0xabc' }),
  'ETH',
  IMPLS
);
assert.equal(unknown.name, '0xabc');
assert.equal(unknown.ticker, 'ETH-28AUG26-2200/2300-P', 'falls back to the vanilla formatter');

// --- price-feed resolution --------------------------------------------------
const feeds = {
  ETH: FEED,
  BTC: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
  SOL: '0x0000000000000000000000000000000000000003',
  'ETH/USD': FEED,
};
assert.deepEqual(resolvePriceFeed('eth', feeds), { feed: FEED_LC });
assert.deepEqual(resolvePriceFeed('SOL', feeds), {
  feed: '0x0000000000000000000000000000000000000003',
});
assert.deepEqual(
  resolvePriceFeed('ETH/USD', feeds),
  { feed: FEED_LC },
  'legacy alias keys still resolve'
);
const unknownFeed = resolvePriceFeed('DOGECOIN', feeds);
assert.ok('error' in unknownFeed);
assert.equal(
  unknownFeed.error.includes('ETH/USD'),
  false,
  'alias keys are hidden from the user-facing hint'
);
assert.equal(unknownFeed.error.includes('SOL'), true);

console.log('book matcher regression tests passed');
