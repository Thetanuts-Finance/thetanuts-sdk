#!/usr/bin/env npx tsx
/**
 * MM pricing bound tests for mmPricing multi-leg quotes (SF-1 regression).
 *
 * Asserts the invariant `0 <= netMmBidPrice <= netMmAskPrice <= widthUsd / spot`
 * for call/put spreads, vanilla call/put condors, and butterflies.
 *
 * No network / no chain: the pricing source (`getTickerPricing`) is stubbed on the
 * MMPricingModule instance, so leg bid/ask/spot are fully controlled by the test.
 * Randomized cases use a DETERMINISTIC seeded PRNG (mulberry32) — no unseeded
 * Math.random — so failures reproduce byte-for-byte.
 *
 * Iron condors (`type: 'iron'`) are intentionally skipped — their pricing branch is
 * fixed in a later scope (B5 / IRON_CONDOR_PRICING_FIX.md).
 *
 * Run: npx tsx tests/properties/mmpricing-bounds.test.ts
 * Or:  npm run test:mmpricing
 */

import {
  MMPricingModule,
  parseTicker,
  type MMVanillaPricing,
  type SpreadPricingParams,
  type CondorPricingParams,
  type ButterflyPricingParams,
} from '../../src/index.js';
import type { ThetanutsClient } from '../../src/client/ThetanutsClient.js';

// 8-decimal strike scaling — matches the SDK convention (strikes are bigint * 1e8).
const P = 10n ** 8n;
// A fixed future expiry (08:00 UTC on 25 Dec 2026) so buildTicker/parseTicker round-trip.
const EXPIRY = Math.floor(Date.UTC(2026, 11, 25, 8, 0, 0) / 1000);
// Time-to-expiry (years) used by the stubbed legs — only affects the tiny CC term.
const TTE = 0.1;
// Small absolute slack for float comparisons.
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Stub client — the MMPricingModule constructor only reads pricingApiUrl (to
// build an axios instance we never call) and logger.{debug,info,warn,error}.
// ---------------------------------------------------------------------------
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const stubClient = {
  pricingApiUrl: 'http://localhost/pricing',
  logger: noopLogger,
} as unknown as ThetanutsClient;

interface LegQuote {
  /** fee-adjusted bid, in underlying terms */
  bid: number;
  /** fee-adjusted ask, in underlying terms (>= bid) */
  ask: number;
}

/** Build a full MMVanillaPricing leg from a ticker + controlled quote/spot. */
function makeLeg(ticker: string, q: LegQuote, spot: number, tte: number): MMVanillaPricing {
  const parsed = parseTicker(ticker);
  return {
    ticker,
    rawBidPrice: q.bid,
    rawAskPrice: q.ask,
    feeAdjustedBid: q.bid,
    feeAdjustedAsk: q.ask,
    markPrice: (q.bid + q.ask) / 2,
    underlyingPrice: spot,
    strike: parsed.strike,
    expiry: parsed.expiry,
    isCall: parsed.isCall,
    underlying: parsed.underlying,
    passesToleranceCheck: true,
    timeToExpiryYears: tte,
    feeMultiplier: 1.03,
    byCollateral: {},
  };
}

/**
 * Fresh MMPricingModule whose getTickerPricing is stubbed to return the quote
 * mapped to each leg's parsed strike (all legs share the same spot).
 */
function moduleWithLegs(
  quotesByStrike: Map<number, LegQuote>,
  spot: number,
  tte: number = TTE,
): MMPricingModule {
  const mm = new MMPricingModule(stubClient);
  (mm as unknown as {
    getTickerPricing: (ticker: string) => Promise<MMVanillaPricing>;
  }).getTickerPricing = async (ticker: string) => {
    const parsed = parseTicker(ticker);
    const q = quotesByStrike.get(parsed.strike);
    if (!q) {
      throw new Error(`No stub quote for strike ${parsed.strike} (ticker ${ticker})`);
    }
    return makeLeg(ticker, q, spot, tte);
  };
  return mm;
}

const strikeBig = (k: number): bigint => BigInt(k) * P;

// ---------------------------------------------------------------------------
// Deterministic seeded PRNG (mulberry32).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Test harness (async variant of payout-multileg.test.ts's reporter).
// ---------------------------------------------------------------------------
interface TestResult {
  name: string;
  passed: boolean;
  violation?: string;
}
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, violation: msg });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Assert the SF-1 invariant on a quote given the structural bound width/spot. */
function assertBounds(
  label: string,
  bid: number,
  ask: number,
  widthUsd: number,
  spot: number,
): void {
  const bound = widthUsd / spot;
  assert(Number.isFinite(bid) && Number.isFinite(ask), `${label}: non-finite quote bid=${bid} ask=${ask}`);
  assert(bid >= -EPS, `${label}: netMmBidPrice went negative: ${bid}`);
  assert(bid <= ask + EPS, `${label}: bid > ask: ${bid} > ${ask}`);
  assert(ask <= bound + EPS, `${label}: ask exceeded width/spot bound: ${ask} > ${bound} (width=${widthUsd}, spot=${spot})`);
}

async function main(): Promise<void> {
  const rng = mulberry32(0xc0ffee);
  const ITER = 300;

  // Random leg quote in underlying terms with ask >= bid (realistic book).
  const randQuote = (): LegQuote => {
    const bid = rng() * 0.5;
    const ask = bid + rng() * 0.5;
    return { bid, ask };
  };
  // Integer spot in [1000, 5000).
  const randSpot = (): number => 1000 + Math.floor(rng() * 4000);
  // Integer width in [10, 200].
  const randWidth = (): number => 10 + Math.floor(rng() * 191);

  // ---- CALL spread (ascending strikes k1 < k2) ----
  await test(`property: 0 <= bid <= ask <= width/spot — CALL spread (${ITER} cases)`, async () => {
    for (let i = 0; i < ITER; i++) {
      const spot = randSpot();
      const w = randWidth();
      const k1 = 800 + Math.floor(rng() * 4000);
      const k2 = k1 + w;
      const quotes = new Map<number, LegQuote>([[k1, randQuote()], [k2, randQuote()]]);
      const params: SpreadPricingParams = {
        underlying: 'ETH',
        strikes: [strikeBig(k1), strikeBig(k2)],
        expiry: EXPIRY,
        isCall: true,
      };
      const r = await moduleWithLegs(quotes, spot).getSpreadPricing(params);
      assertBounds(`call_spread[${i}]`, r.netMmBidPrice, r.netMmAskPrice, r.widthUsd, spot);
      assert(r.widthUsd === w, `call_spread[${i}]: widthUsd ${r.widthUsd} !== ${w}`);
    }
  });

  // ---- PUT spread (descending strikes k1 > k2) ----
  await test(`property: 0 <= bid <= ask <= width/spot — PUT spread (${ITER} cases)`, async () => {
    for (let i = 0; i < ITER; i++) {
      const spot = randSpot();
      const w = randWidth();
      const k1 = 800 + w + Math.floor(rng() * 4000); // higher strike (near)
      const k2 = k1 - w; // lower strike (far)
      const quotes = new Map<number, LegQuote>([[k1, randQuote()], [k2, randQuote()]]);
      const params: SpreadPricingParams = {
        underlying: 'ETH',
        strikes: [strikeBig(k1), strikeBig(k2)],
        expiry: EXPIRY,
        isCall: false,
      };
      const r = await moduleWithLegs(quotes, spot).getSpreadPricing(params);
      assertBounds(`put_spread[${i}]`, r.netMmBidPrice, r.netMmAskPrice, r.widthUsd, spot);
      assert(r.widthUsd === w, `put_spread[${i}]: widthUsd ${r.widthUsd} !== ${w}`);
    }
  });

  // ---- vanilla CALL / PUT condors (ascending 4 strikes, equal outer widths) ----
  for (const type of ['call', 'put'] as const) {
    await test(`property: 0 <= bid <= ask <= width/spot — ${type} condor (${ITER} cases)`, async () => {
      for (let i = 0; i < ITER; i++) {
        const spot = randSpot();
        const w = randWidth();
        const body = w + Math.floor(rng() * w); // body gap >= w keeps strict ascending
        const k1 = 800 + Math.floor(rng() * 3000);
        const k2 = k1 + w;
        const k3 = k2 + body;
        const k4 = k3 + w;
        const quotes = new Map<number, LegQuote>([
          [k1, randQuote()],
          [k2, randQuote()],
          [k3, randQuote()],
          [k4, randQuote()],
        ]);
        const params: CondorPricingParams = {
          underlying: 'ETH',
          strikes: [strikeBig(k1), strikeBig(k2), strikeBig(k3), strikeBig(k4)],
          expiry: EXPIRY,
          type,
        };
        const r = await moduleWithLegs(quotes, spot).getCondorPricing(params);
        assertBounds(`${type}_condor[${i}]`, r.netMmBidPrice, r.netMmAskPrice, r.spreadWidth, spot);
        assert(r.spreadWidth === w, `${type}_condor[${i}]: spreadWidth ${r.spreadWidth} !== ${w}`);
      }
    });
  }

  // ---- CALL / PUT butterflies (equidistant 3 strikes) ----
  for (const isCall of [true, false]) {
    const label = isCall ? 'call' : 'put';
    await test(`property: 0 <= bid <= ask <= width/spot — ${label} butterfly (${ITER} cases)`, async () => {
      for (let i = 0; i < ITER; i++) {
        const spot = randSpot();
        const w = randWidth();
        const k1 = 800 + Math.floor(rng() * 3500);
        const k2 = k1 + w;
        const k3 = k2 + w;
        const quotes = new Map<number, LegQuote>([
          [k1, randQuote()],
          [k2, randQuote()],
          [k3, randQuote()],
        ]);
        const params: ButterflyPricingParams = {
          underlying: 'ETH',
          strikes: [strikeBig(k1), strikeBig(k2), strikeBig(k3)],
          expiry: EXPIRY,
          isCall,
        };
        const r = await moduleWithLegs(quotes, spot).getButterflyPricing(params);
        assertBounds(`${label}_butterfly[${i}]`, r.netMmBidPrice, r.netMmAskPrice, r.width, spot);
        assert(r.width === w, `${label}_butterfly[${i}]: width ${r.width} !== ${w}`);
      }
    });
  }

  // ============================================================
  // Acceptance repro 1 — deep-ITM 1450/1475 CALL spread, spot ~1692.
  // Wide leg quotes overshoot the $25 max payout pre-fix; post-fix the
  // ask must be clamped to 25/1692 (~0.01477541).
  // ============================================================
  await test('acceptance: deep-ITM 1450/1475 call spread @ spot 1692 → ask <= 25/spot', async () => {
    const spot = 1692;
    const quotes = new Map<number, LegQuote>([
      [1450, { bid: 0.140, ask: 0.160 }], // near (deep ITM)
      [1475, { bid: 0.125, ask: 0.145 }], // far
    ]);
    const r = await moduleWithLegs(quotes, spot).getSpreadPricing({
      underlying: 'ETH',
      strikes: [strikeBig(1450), strikeBig(1475)],
      expiry: EXPIRY,
      isCall: true,
    });
    const bound = 25 / spot; // ~0.01477541
    assert(r.widthUsd === 25, `widthUsd should be 25, got ${r.widthUsd}`);
    assert(r.netMmAskPrice > 0, `ask should be positive, got ${r.netMmAskPrice}`);
    assert(r.netMmAskPrice <= bound + EPS, `ask ${r.netMmAskPrice} exceeded 25/spot bound ${bound}`);
    // Wide quotes force the raw ask well above the bound, so it must clamp exactly to it.
    assert(Math.abs(r.netMmAskPrice - bound) < 1e-6, `ask should clamp to bound ${bound}, got ${r.netMmAskPrice}`);
    assertBounds('acceptance-callspread', r.netMmBidPrice, r.netMmAskPrice, r.widthUsd, spot);
  });

  // ============================================================
  // Acceptance repro 2 — 1950/1925 PUT spread (was quoted ~$57.53 vs $25 max
  // payout pre-fix). Post-fix ask must be <= 25/spot.
  // ============================================================
  await test('acceptance: 1950/1925 put spread → ask <= 25/spot (was $57.53 vs $25 max)', async () => {
    const spot = 1850;
    const quotes = new Map<number, LegQuote>([
      [1950, { bid: 0.050, ask: 0.070 }], // near (higher strike, deep ITM put)
      [1925, { bid: 0.035, ask: 0.055 }], // far (lower strike)
    ]);
    const r = await moduleWithLegs(quotes, spot).getSpreadPricing({
      underlying: 'ETH',
      strikes: [strikeBig(1950), strikeBig(1925)], // descending = put convention
      expiry: EXPIRY,
      isCall: false,
    });
    const bound = 25 / spot;
    assert(r.widthUsd === 25, `widthUsd should be 25, got ${r.widthUsd}`);
    assert(r.netMmAskPrice > 0, `ask should be positive, got ${r.netMmAskPrice}`);
    assert(r.netMmAskPrice <= bound + EPS, `ask ${r.netMmAskPrice} exceeded 25/spot bound ${bound}`);
    // Pre-fix this quoted ~$57.53 (> $25 = widthUsd); post-fix ask*spot must be <= $25.
    assert(r.netMmAskPrice * spot <= 25 + 1e-6, `ask*spot ${r.netMmAskPrice * spot} exceeded $25 max payout`);
    assertBounds('acceptance-putspread', r.netMmBidPrice, r.netMmAskPrice, r.widthUsd, spot);
  });

  // ============================================================
  // Acceptance repro 3 — wrong-order strikes must never yield a negative ask.
  // A CALL spread fed descending strikes with crossed leg quotes drives the raw
  // ask negative; the clamp's lower bound (Math.max(0, ...)) must floor it to 0.
  // ============================================================
  await test('acceptance: wrong-order strikes → ask floored to 0 (never negative)', async () => {
    const spot = 1692;
    const quotes = new Map<number, LegQuote>([
      [1475, { bid: 0.010, ask: 0.020 }], // near = higher strike (wrong order for a call)
      [1450, { bid: 0.300, ask: 0.350 }], // far = lower strike, rich bid → negative raw net
    ]);
    const r = await moduleWithLegs(quotes, spot).getSpreadPricing({
      underlying: 'ETH',
      strikes: [strikeBig(1475), strikeBig(1450)], // descending: wrong order for a call spread
      expiry: EXPIRY,
      isCall: true,
    });
    assert(r.netMmAskPrice >= 0, `ask must never be negative, got ${r.netMmAskPrice}`);
    assert(r.netMmAskPrice === 0, `ask should floor to exactly 0 for this crossed case, got ${r.netMmAskPrice}`);
    assert(r.netMmBidPrice >= 0, `bid must never be negative, got ${r.netMmBidPrice}`);
    assertBounds('acceptance-wrongorder', r.netMmBidPrice, r.netMmAskPrice, r.widthUsd, spot);
  });

  // -------------------------------------------------------------------------
  // Reporter
  // -------------------------------------------------------------------------
  console.log('\n# MM pricing bound tests (SF-1)\n');

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    const status = r.passed ? 'PASS' : 'FAIL';
    console.log(`  ${icon} ${status}  ${r.name}`);
    if (!r.passed) {
      console.log(`         → ${r.violation}`);
      failed++;
    } else {
      passed++;
    }
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

void main();
