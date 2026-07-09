#!/usr/bin/env npx tsx
/**
 * Iron-condor pricing tests for `MMPricingModule.getCondorPricing` (B5 regression).
 *
 * Iron condors are CREDIT structures — short the inner pair (K2 put, K3 call),
 * long the outer wings (K1 put, K4 call). Before B5, `getCondorPricing` applied the
 * VANILLA leg weights (+1 K1, -1 K2, -1 K3, +1 K4) unconditionally, so the credit
 * computed strongly negative and `Math.max(0, …)` floored the bid to $0 (and, after
 * the SF-1 clamp, the ask to $0 too). The fix adds a `type: 'iron'` branch:
 *   sellNet = bid(K2) + bid(K3) − ask(K1) − ask(K4)   (credit collected)
 *   buyNet  = ask(K2) + ask(K3) − bid(K1) − bid(K4)   (cost of the long body)
 *
 * These tests cover the 3 cases from IRON_CONDOR_PRICING_FIX.md:
 *   1. Iron credit is positive on the worked example (≈ $20.94 bid / ≈ $27.22 ask).
 *   2. Genuine floor still works (collateral cost > credit ⇒ bid floored to 0).
 *   3. Vanilla call/put condor outputs are byte-identical to the pre-fix formula.
 *
 * No network / no chain: `getTickerPricing` is stubbed on the MMPricingModule
 * instance, so leg bid/ask/spot are fully controlled by the test. Leg prices are
 * expressed in UNDERLYING terms (fractions of ETH); the "$" figures in the worked
 * example are recovered as `price * spot`.
 *
 * Run: npx tsx tests/properties/iron-condor-pricing.test.ts
 * Or:  npm run test:ironcondor
 */

import {
  MMPricingModule,
  parseTicker,
  type MMVanillaPricing,
  type CondorPricingParams,
} from '../../src/index.js';
import { FEE_MULTIPLIER, COLLATERAL_APR } from '../../src/types/mmPricing.js';
import { calculateSpreadCollateralCost } from '../../src/modules/mmPricing.js';
import type { ThetanutsClient } from '../../src/client/ThetanutsClient.js';

// 8-decimal strike scaling — matches the SDK convention (strikes are bigint * 1e8).
const P = 10n ** 8n;
const strikeBig = (k: number): bigint => BigInt(k) * P;
// A fixed future expiry (08:00 UTC on 25 Dec 2026) so buildTicker/parseTicker round-trip.
const EXPIRY = Math.floor(Date.UTC(2026, 11, 25, 8, 0, 0) / 1000);
// Absolute slack for exact-formula comparisons (identical float ops ⇒ ~bit-identical).
const EPS = 1e-12;

// ---------------------------------------------------------------------------
// Stub client — the MMPricingModule constructor only reads pricingApiUrl (to
// build an axios instance we never call) and logger.{debug,info,warn,error}.
// ---------------------------------------------------------------------------
type Logger = { debug(...a: unknown[]): void; info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const makeClient = (logger: Logger): ThetanutsClient =>
  ({ pricingApiUrl: 'http://localhost/pricing', logger } as unknown as ThetanutsClient);

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
    feeMultiplier: FEE_MULTIPLIER,
    byCollateral: {},
  };
}

/**
 * Fresh MMPricingModule whose getTickerPricing is stubbed to return the quote
 * mapped to each leg's parsed strike (all legs share the same spot). Iron-condor
 * legs have distinct strikes per leg, so mapping on strike alone is unambiguous.
 */
function moduleWithLegs(
  quotesByStrike: Map<number, LegQuote>,
  spot: number,
  tte: number,
  logger: Logger = noopLogger,
): MMPricingModule {
  const mm = new MMPricingModule(makeClient(logger));
  (mm as unknown as {
    getTickerPricing: (ticker: string) => Promise<MMVanillaPricing>;
  }).getTickerPricing = async (ticker: string) => {
    const parsed = parseTicker(ticker);
    const q = quotesByStrike.get(parsed.strike);
    if (!q) throw new Error(`No stub quote for strike ${parsed.strike} (ticker ${ticker})`);
    return makeLeg(ticker, q, spot, tte);
  };
  return mm;
}

// ---------------------------------------------------------------------------
// Reference math — replicates getCondorPricing's exact arithmetic (post-SF-1)
// so tests can assert against hand-computed values, not just "doesn't throw".
// ---------------------------------------------------------------------------
type Quad = [LegQuote, LegQuote, LegQuote, LegQuote]; // ordered K1..K4

/** IRON credit-direction nets (the B5 branch). */
function ironNets(q: Quad): { buyNet: number; sellNet: number } {
  const sellNet = q[1].bid + q[2].bid - q[0].ask - q[3].ask;
  const buyNet = q[1].ask + q[2].ask - q[0].bid - q[3].bid;
  return { buyNet, sellNet };
}

/** VANILLA condor nets (+1 K1, -1 K2, -1 K3, +1 K4) — the UNMODIFIED pre-fix formula. */
function vanillaNets(q: Quad): { buyNet: number; sellNet: number } {
  const buyNet = q[0].ask - q[1].bid - q[2].bid + q[3].ask;
  const sellNet = q[0].bid - q[1].ask - q[2].ask + q[3].bid;
  return { buyNet, sellNet };
}

/** Apply CC + FEE_MULTIPLIER + SF-1 clamp exactly as the module does. */
function finalPrices(
  nets: { buyNet: number; sellNet: number },
  widthUsd: number,
  spot: number,
  tte: number,
): { rawAskPrice: number; rawBidPrice: number; netMmAskPrice: number; netMmBidPrice: number } {
  const spreadCollateralCostUsd = calculateSpreadCollateralCost(widthUsd, tte);
  const spreadCCPerUnderlying = spot > 0 ? spreadCollateralCostUsd / spot : 0;
  const widthPerUnderlying = spot > 0 ? widthUsd / spot : Number.POSITIVE_INFINITY;
  const rawAskPrice = (nets.buyNet + spreadCCPerUnderlying) * FEE_MULTIPLIER;
  const netMmAskPrice = Math.min(Math.max(0, rawAskPrice), widthPerUnderlying);
  const rawBidPrice = (nets.sellNet - spreadCCPerUnderlying) / FEE_MULTIPLIER;
  const netMmBidPrice = Math.min(Math.max(0, rawBidPrice), widthPerUnderlying);
  return { rawAskPrice, rawBidPrice, netMmAskPrice, netMmBidPrice };
}

// ---------------------------------------------------------------------------
// Test harness (async reporter, mirrors mmpricing-bounds.test.ts).
// ---------------------------------------------------------------------------
interface TestResult { name: string; passed: boolean; violation?: string }
const results: TestResult[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (err: unknown) {
    results.push({ name, passed: false, violation: err instanceof Error ? err.message : String(err) });
  }
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function close(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

async function main(): Promise<void> {
  // Common structure: iron condor 1450/1525/1625/1700 (equal outer widths = 75).
  const K = [1450, 1525, 1625, 1700] as const;
  const WIDTH = 75; // K2 - K1 == K4 - K3
  const ironParams = (): CondorPricingParams => ({
    underlying: 'ETH',
    strikes: [strikeBig(K[0]), strikeBig(K[1]), strikeBig(K[2]), strikeBig(K[3])],
    expiry: EXPIRY,
    type: 'iron',
  });

  // ============================================================
  // Test 1 — Iron credit is POSITIVE on the worked example.
  // Worked example (IRON_CONDOR_PRICING_FIX.md): spot ~1585, USD leg prices
  //   Put K1 4/5, Put K2 15/16, Call K3 18/19, Call K4 5/6.
  //   True short-IC credit = bid(K2)+bid(K3)-ask(K1)-ask(K4) = 15+18-5-6 = +$22.
  //   Expected: netMmBidPrice ≈ $20.94 (credit − CC), netMmAskPrice ≈ $27.22.
  // Leg prices are fed in UNDERLYING terms (USD / spot).
  // ============================================================
  await test('iron: worked example → positive credit, bid ≈ $20.94 / ask ≈ $27.22 (was $0)', async () => {
    const spot = 1585;
    const tte = 0.0822; // ~1 month; sets CC = 75 * 0.07 * 0.0822 ≈ $0.4316
    const usd: Quad = [
      { bid: 4, ask: 5 },   // Put K1 (OTM wing)
      { bid: 15, ask: 16 }, // Put K2 (inner, sold)
      { bid: 18, ask: 19 }, // Call K3 (inner, sold)
      { bid: 5, ask: 6 },   // Call K4 (OTM wing)
    ];
    // Convert to underlying terms for the stub.
    const legs = usd.map((q) => ({ bid: q.bid / spot, ask: q.ask / spot })) as Quad;
    const quotes = new Map<number, LegQuote>([
      [K[0], legs[0]], [K[1], legs[1]], [K[2], legs[2]], [K[3], legs[3]],
    ]);

    const r = await moduleWithLegs(quotes, spot, tte).getCondorPricing(ironParams());
    assert(r.type === 'iron_condor', `type should be iron_condor, got ${r.type}`);

    // Hand-computed expectation via the credit-direction (B5) formula.
    const expected = finalPrices(ironNets(legs), WIDTH, spot, tte);

    // 1a. Credit is genuinely positive — the regression.
    assert(r.netMmBidPrice > 0, `iron bid must be positive, got ${r.netMmBidPrice}`);
    assert(r.netMmAskPrice > 0, `iron ask must be positive, got ${r.netMmAskPrice}`);

    // 1b. Exact match to the hand-computed credit-direction values.
    assert(close(r.netMmBidPrice, expected.netMmBidPrice, EPS),
      `iron bid ${r.netMmBidPrice} !== expected ${expected.netMmBidPrice}`);
    assert(close(r.netMmAskPrice, expected.netMmAskPrice, EPS),
      `iron ask ${r.netMmAskPrice} !== expected ${expected.netMmAskPrice}`);

    // 1c. USD figures land on the acceptance targets (fable_5_fix.md item 2).
    const bidUsd = r.netMmBidPrice * spot;
    const askUsd = r.netMmAskPrice * spot;
    assert(close(bidUsd, 20.94, 0.05), `bid ≈ $20.94 expected, got $${bidUsd.toFixed(4)}`);
    assert(close(askUsd, 27.22, 0.05), `ask ≈ $27.22 expected, got $${askUsd.toFixed(4)}`);

    // 1d. Clamp must NOT engage — both quotes sit well inside [0, width].
    const bound = WIDTH / spot;
    assert(r.netMmAskPrice < bound - EPS, `ask ${r.netMmAskPrice} unexpectedly hit width bound ${bound}`);
    assert(r.netMmBidPrice < bound - EPS, `bid ${r.netMmBidPrice} unexpectedly hit width bound ${bound}`);

    // 1e. NON-VACUITY: the OLD vanilla weights on these iron legs floor both sides.
    const preFix = finalPrices(vanillaNets(legs), WIDTH, spot, tte);
    assert(preFix.rawBidPrice < 0 && preFix.netMmBidPrice === 0,
      `sanity: pre-fix vanilla formula should floor the iron bid to 0 (raw ${preFix.rawBidPrice})`);
    assert(preFix.rawAskPrice < 0 && preFix.netMmAskPrice === 0,
      `sanity: pre-fix vanilla formula should floor the iron ask to 0 (raw ${preFix.rawAskPrice})`);
  });

  // ============================================================
  // Test 2 — Genuine floor still works.
  // Small real credit ($6) but a large collateral cost ($10.5 via a long tenor)
  // ⇒ rawBid = (6 − 10.5)/1.03 < 0 ⇒ netMmBidPrice floored to 0, and the
  // "Condor bid price floored to 0" debug fires. The ask stays positive.
  // ============================================================
  await test('iron: genuine floor → bid clamped to 0 when collateral cost > credit', async () => {
    const spot = 1585;
    const tte = 2.0; // CC = 75 * 0.07 * 2.0 = $10.5
    const usd: Quad = [
      { bid: 4, ask: 5 }, // Put K1 wing
      { bid: 8, ask: 9 }, // Put K2 inner
      { bid: 8, ask: 9 }, // Call K3 inner
      { bid: 4, ask: 5 }, // Call K4 wing
    ];
    // sellNet(USD) = 8 + 8 − 5 − 5 = +6 (a real, positive credit) ; CC = 10.5 > 6.
    const legs = usd.map((q) => ({ bid: q.bid / spot, ask: q.ask / spot })) as Quad;
    const quotes = new Map<number, LegQuote>([
      [K[0], legs[0]], [K[1], legs[1]], [K[2], legs[2]], [K[3], legs[3]],
    ]);

    const debugMsgs: string[] = [];
    const recording: Logger = { ...noopLogger, debug: (msg: unknown) => { debugMsgs.push(String(msg)); } };

    const r = await moduleWithLegs(quotes, spot, tte, recording).getCondorPricing(ironParams());

    // Pre-cc credit is genuinely positive, so this is the collateral cost flooring it
    // (not a broken/negative structure).
    const ccUsd = calculateSpreadCollateralCost(WIDTH, tte);
    const creditUsd = 8 + 8 - 5 - 5;
    assert(creditUsd > 0, 'sanity: raw iron credit should be positive');
    assert(ccUsd > creditUsd, `sanity: collateral cost $${ccUsd} should exceed credit $${creditUsd}`);

    assert(r.netMmBidPrice === 0, `bid should floor to exactly 0, got ${r.netMmBidPrice}`);
    assert(r.netMmAskPrice > 0, `ask should remain positive, got ${r.netMmAskPrice}`);
    assert(debugMsgs.some((m) => m.includes('Condor bid price floored to 0')),
      `expected the floor debug log to fire, saw: ${JSON.stringify(debugMsgs)}`);
  });

  // ============================================================
  // Test 3 — Vanilla call/put condor outputs are BYTE-IDENTICAL to the
  // unmodified vanilla formula (the else branch is the original code verbatim).
  // Values chosen so neither the zero floor nor the width clamp engages, so the
  // assertion pins the exact vanilla arithmetic (netCondorPrice = buyNet exposed).
  // ============================================================
  const vanillaK = [1800, 1900, 2100, 2200] as const; // outer widths 100 == 100
  const VWIDTH = 100;
  const vanillaCases: Array<{ type: 'call' | 'put'; expectType: string; quad: Quad }> = [
    {
      type: 'call', expectType: 'call_condor',
      quad: [
        { bid: 0.12, ask: 0.13 },   // K1
        { bid: 0.08, ask: 0.09 },   // K2
        { bid: 0.03, ask: 0.04 },   // K3
        { bid: 0.015, ask: 0.02 },  // K4
      ],
    },
    {
      type: 'put', expectType: 'put_condor',
      quad: [
        { bid: 0.015, ask: 0.02 },   // K1
        { bid: 0.02, ask: 0.025 },   // K2
        { bid: 0.05, ask: 0.055 },   // K3
        { bid: 0.075, ask: 0.08 },   // K4
      ],
    },
  ];

  for (const c of vanillaCases) {
    await test(`vanilla: ${c.type} condor byte-identical to pre-fix formula`, async () => {
      const spot = 2000;
      const tte = 0.25;
      const quotes = new Map<number, LegQuote>([
        [vanillaK[0], c.quad[0]], [vanillaK[1], c.quad[1]],
        [vanillaK[2], c.quad[2]], [vanillaK[3], c.quad[3]],
      ]);
      const params: CondorPricingParams = {
        underlying: 'ETH',
        strikes: [strikeBig(vanillaK[0]), strikeBig(vanillaK[1]), strikeBig(vanillaK[2]), strikeBig(vanillaK[3])],
        expiry: EXPIRY,
        type: c.type,
      };
      const r = await moduleWithLegs(quotes, spot, tte).getCondorPricing(params);

      const nets = vanillaNets(c.quad);
      const expected = finalPrices(nets, VWIDTH, spot, tte);

      assert(r.type === c.expectType, `type should be ${c.expectType}, got ${r.type}`);
      // netCondorPrice is the exposed buy-side net.
      assert(close(r.netCondorPrice, nets.buyNet, EPS),
        `${c.type}: netCondorPrice ${r.netCondorPrice} !== buyNet ${nets.buyNet}`);
      assert(close(r.netMmAskPrice, expected.netMmAskPrice, EPS),
        `${c.type}: netMmAskPrice ${r.netMmAskPrice} !== expected ${expected.netMmAskPrice}`);
      assert(close(r.netMmBidPrice, expected.netMmBidPrice, EPS),
        `${c.type}: netMmBidPrice ${r.netMmBidPrice} !== expected ${expected.netMmBidPrice}`);
      assert(r.spreadWidth === VWIDTH, `${c.type}: spreadWidth ${r.spreadWidth} !== ${VWIDTH}`);
      // Confirm the chosen quotes exercised the un-floored, un-clamped path.
      assert(r.netMmBidPrice > 0 && r.netMmAskPrice > 0 && r.netMmAskPrice < VWIDTH / spot,
        `${c.type}: expected an interior (non-floored, non-clamped) quote`);
    });
  }

  // -------------------------------------------------------------------------
  // Reporter
  // -------------------------------------------------------------------------
  console.log('\n# Iron-condor pricing tests (B5)\n');
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
  if (failed > 0) process.exit(1);
}

void main();
