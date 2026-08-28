#!/usr/bin/env npx tsx
/**
 * getPositionPricing unit + width-overflow tests (C-1 / C-2 / 4c regression).
 *
 * Covers the two defects fixed in getPositionPricing plus the shared width-scale
 * defect in the multi-leg collateral calc:
 *   C-1  USD-magnitude values fed to floatToBigInt threw for every BTC option
 *        (spot/strike >= ~9007 trips the 1e12-scale safe-integer guard).
 *   C-2  premium/collateralCost multiplied by spot even for native collateral,
 *        overstating WETH/cbBTC premiums by ~spot× ("100 WETH" for 0.05 WETH).
 *   4c   floatToBigInt(widthUsd) threw for any multi-leg structure with
 *        width >= ~$9,007 (e.g. a BTC 80k/90k spread).
 *
 * No network / no chain: the pricing source (`getTickerPricing`) is stubbed on the
 * MMPricingModule instance, mirroring tests/properties/mmpricing-bounds.test.ts.
 *
 * Run: npx tsx tests/properties/position-pricing.test.ts
 * Or:  npm run test:positionpricing
 */

import {
  MMPricingModule,
  parseTicker,
  calculateCollateralCost,
  type MMVanillaPricing,
  type CondorPricingParams,
  type ButterflyPricingParams,
} from '../../src/index.js';
import { collateralCostPerUnderlying } from '../../src/modules/mmPricing.js';
import type { MMCollateralPricing } from '../../src/types/mmPricing.js';
import type { ThetanutsClient } from '../../src/client/ThetanutsClient.js';

// 8-decimal strike scaling — strikes are bigint * 1e8 in the SDK convention.
const P = 10n ** 8n;
// A fixed future expiry (08:00 UTC on 25 Dec 2026) so buildTicker/parseTicker round-trip.
const EXPIRY = Math.floor(Date.UTC(2026, 11, 25, 8, 0, 0) / 1000);
// Time-to-expiry (years) used by the stubbed legs — only affects the tiny CC term.
const TTE = 0.1;

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

/** Build one MMCollateralPricing entry (mirrors computeMMPrices' fields). */
function makeCollateralPricing(
  collateralAsset: string,
  collateralAmount: number,
  q: LegQuote,
  spot: number,
  tte: number,
): MMCollateralPricing {
  const ccRaw = calculateCollateralCost(collateralAsset, collateralAmount, tte);
  const cc = collateralCostPerUnderlying(ccRaw, collateralAsset, spot);
  const mmAsk = q.ask + cc;
  const mmBid = Math.max(0, q.bid - cc);
  return {
    collateralAsset,
    collateralAmount,
    collateralCostPerUnit: cc,
    mmBidPrice: mmBid,
    mmAskPrice: mmAsk,
    mmWlBidPrice: mmBid,
    mmWlAskPrice: mmAsk,
    mmBidPriceBuffered: Math.max(0, mmBid / 1.03),
    mmAskPriceBuffered: mmAsk * 1.03,
    mmWlBidPriceBuffered: Math.max(0, mmBid / 1.03),
    mmWlAskPriceBuffered: mmAsk * 1.03,
  };
}

/**
 * Build a full MMVanillaPricing leg with byCollateral populated for both the
 * native asset (1 unit/contract) and USD (strike/contract) — the two entries
 * getPositionPricing reads.
 */
function makePositionLeg(ticker: string, q: LegQuote, spot: number, tte: number): MMVanillaPricing {
  const parsed = parseTicker(ticker);
  const native = parsed.underlying; // 'ETH' | 'BTC'
  const byCollateral: Record<string, MMCollateralPricing> = {
    [native]: makeCollateralPricing(native, 1.0, q, spot, tte),
    USD: makeCollateralPricing('USD', parsed.strike, q, spot, tte),
  };
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
    byCollateral,
  };
}

/** Lighter leg (empty byCollateral) — enough for spread/condor/butterfly, which
 * only read fee-adjusted quotes, spot and time-to-expiry. */
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

/** Module whose getTickerPricing returns a single position leg for `ticker`. */
function moduleForPosition(ticker: string, q: LegQuote, spot: number, tte: number = TTE): MMPricingModule {
  const mm = new MMPricingModule(stubClient);
  (mm as unknown as {
    getTickerPricing: (t: string) => Promise<MMVanillaPricing>;
  }).getTickerPricing = async (t: string) => {
    if (t !== ticker) {
      throw new Error(`unexpected ticker ${t} (stub configured for ${ticker})`);
    }
    return makePositionLeg(t, q, spot, tte);
  };
  return mm;
}

/** Module whose getTickerPricing maps each parsed strike to a stubbed quote. */
function moduleWithLegs(
  quotesByStrike: Map<number, LegQuote>,
  spot: number,
  tte: number = TTE,
): MMPricingModule {
  const mm = new MMPricingModule(stubClient);
  (mm as unknown as {
    getTickerPricing: (t: string) => Promise<MMVanillaPricing>;
  }).getTickerPricing = async (t: string) => {
    const parsed = parseTicker(t);
    const quote = quotesByStrike.get(parsed.strike);
    if (!quote) {
      throw new Error(`No stub quote for strike ${parsed.strike} (ticker ${t})`);
    }
    return makeLeg(t, quote, spot, tte);
  };
  return mm;
}

const strikeBig = (k: number): bigint => BigInt(k) * P;

// ---------------------------------------------------------------------------
// Test harness (async reporter, matches mmpricing-bounds.test.ts).
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

/** Assert a bigint is within `rel` of a float expectation (kills unit-orientation mutants). */
function assertNear(actual: bigint, expected: number, rel: number, msg: string): void {
  const a = Number(actual);
  const ok = expected === 0 ? a === 0 : Math.abs(a - expected) <= Math.abs(expected) * rel;
  if (!ok) throw new Error(`${msg}: expected ~${expected}, got ${actual}`);
}

/** Expected collateralCost via the same helpers the stub feeds the module. */
function expectedCollateralCost(
  collateralAsset: string,
  collateralAmount: number,
  spot: number,
  numContracts: number,
  decimals: number,
): number {
  const ccRaw = calculateCollateralCost(collateralAsset, collateralAmount, TTE);
  const ccPerUnit = collateralCostPerUnderlying(ccRaw, collateralAsset, spot);
  // USD collateral converts underlying-terms → USD (×spot); native stays native.
  const conv = collateralAsset === 'USD' ? spot : 1;
  return ccPerUnit * numContracts * conv * 10 ** decimals;
}

async function main(): Promise<void> {
  // ============================================================
  // Acceptance 1 — BTC 100000 C + USDC returns finite values (C-1).
  // Pre-fix: floatToBigInt(100000) throws the safe-integer error.
  // ask 0.02 BTC-terms @ spot 100000 → premium = 2000 USDC; collateral = 100000 USDC.
  // ============================================================
  await test('acceptance: BTC-100000-C + USDC → finite; premium 2000 USDC, collateral 100000 USDC', async () => {
    const r = await moduleForPosition('BTC-25DEC26-100000-C', { bid: 0.018, ask: 0.02 }, 100_000).getPositionPricing({
      ticker: 'BTC-25DEC26-100000-C',
      isLong: true,
      numContracts: 1,
      collateralToken: 'USDC',
    });
    assert(r.collateralRequired === 100_000n * 10n ** 6n, `collateralRequired should be 100000 USDC, got ${r.collateralRequired}`);
    assert(r.basePremium === 2000n * 10n ** 6n, `basePremium should be 2000 USDC, got ${r.basePremium}`);
    assert(r.basePremium > 0n && r.collateralCost >= 0n && r.totalPrice > 0n, `values must be positive/finite: ${r.basePremium}/${r.collateralCost}/${r.totalPrice}`);
    // Exact-magnitude check: USD collateral cost must be spot-converted (C-2 mutant killer).
    assertNear(r.collateralCost, expectedCollateralCost('USD', 100_000, 100_000, 1, 6), 1e-6,
      'collateralCost (USDC) wrong magnitude');
  });

  // ============================================================
  // Acceptance 2 — ETH put ask 0.05 @ spot 2000 + WETH → basePremium = 5e16
  // (0.05 WETH in 18dp), NOT 1e20 (100 WETH). Native collateral stays native (C-2).
  // ============================================================
  await test('acceptance: ETH put ask 0.05 @ spot 2000 + WETH → basePremium 5e16 (0.05 WETH), not 1e20', async () => {
    const r = await moduleForPosition('ETH-25DEC26-2000-P', { bid: 0.04, ask: 0.05 }, 2000).getPositionPricing({
      ticker: 'ETH-25DEC26-2000-P',
      isLong: true,
      numContracts: 1,
      collateralToken: 'WETH',
    });
    assert(r.basePremium === 50_000_000_000_000_000n, `basePremium should be 5e16 (0.05 WETH), got ${r.basePremium}`);
    // Native collateral: 1 unit per contract = 1 WETH (18dp).
    assert(r.collateralRequired === 1_000_000_000_000_000_000n, `collateralRequired should be 1 WETH, got ${r.collateralRequired}`);
    // Exact-magnitude check: native collateral cost must NOT be spot-converted (C-2 mutant killer).
    assertNear(r.collateralCost, expectedCollateralCost('ETH', 1.0, 2000, 1, 18), 1e-6,
      'collateralCost (WETH) wrong magnitude');
  });

  // ============================================================
  // Acceptance 3 — BTC 80000/90000 call spread ($10k width) does not throw (4c).
  // Pre-fix: floatToBigInt(10000) throws in the collateral calc.
  // ============================================================
  await test('acceptance: BTC 80000/90000 call spread ($10k width) prices without throwing', async () => {
    const quotes = new Map<number, LegQuote>([
      [80_000, { bid: 0.205, ask: 0.215 }],
      [90_000, { bid: 0.125, ask: 0.135 }],
    ]);
    const r = await moduleWithLegs(quotes, 100_000).getSpreadPricing({
      underlying: 'BTC',
      strikes: [strikeBig(80_000), strikeBig(90_000)],
      expiry: EXPIRY,
      isCall: true,
    });
    assert(r.widthUsd === 10_000, `widthUsd should be 10000, got ${r.widthUsd}`);
    assert(Number.isFinite(r.netMmAskPrice) && Number.isFinite(r.netMmBidPrice), `quotes must be finite: ask=${r.netMmAskPrice} bid=${r.netMmBidPrice}`);
    assert(r.collateral > 0n, `collateral must be positive, got ${r.collateral}`);
  });

  // ============================================================
  // Control — ETH put @ spot 2000 + USDC (magnitudes below the guard). Must stay
  // correct pre- and post-fix: collateral = strike (2000 USDC), premium = 0.05*2000 = 100 USDC.
  // ============================================================
  await test('control: ETH put ask 0.05 @ spot 2000 + USDC → collateral 2000 USDC, premium 100 USDC', async () => {
    const r = await moduleForPosition('ETH-25DEC26-2000-P', { bid: 0.04, ask: 0.05 }, 2000).getPositionPricing({
      ticker: 'ETH-25DEC26-2000-P',
      isLong: true,
      numContracts: 1,
      collateralToken: 'USDC',
    });
    assert(r.collateralRequired === 2000n * 10n ** 6n, `collateralRequired should be 2000 USDC, got ${r.collateralRequired}`);
    assert(r.basePremium === 100n * 10n ** 6n, `basePremium should be 100 USDC, got ${r.basePremium}`);
  });

  // ============================================================
  // Wide-width multi-leg — BTC condor & butterfly ($10k widths) must not throw (4c).
  // ============================================================
  await test('acceptance: BTC condor 80k/90k/110k/120k ($10k width) prices without throwing', async () => {
    const quotes = new Map<number, LegQuote>([
      [80_000, { bid: 0.205, ask: 0.215 }],
      [90_000, { bid: 0.150, ask: 0.160 }],
      [110_000, { bid: 0.090, ask: 0.100 }],
      [120_000, { bid: 0.050, ask: 0.060 }],
    ]);
    const params: CondorPricingParams = {
      underlying: 'BTC',
      strikes: [strikeBig(80_000), strikeBig(90_000), strikeBig(110_000), strikeBig(120_000)],
      expiry: EXPIRY,
      type: 'call',
    };
    const r = await moduleWithLegs(quotes, 100_000).getCondorPricing(params);
    assert(r.spreadWidth === 10_000, `spreadWidth should be 10000, got ${r.spreadWidth}`);
    assert(r.collateral > 0n, `collateral must be positive, got ${r.collateral}`);
  });

  await test('acceptance: BTC butterfly 80k/90k/100k ($10k width) prices without throwing', async () => {
    const quotes = new Map<number, LegQuote>([
      [80_000, { bid: 0.205, ask: 0.215 }],
      [90_000, { bid: 0.150, ask: 0.160 }],
      [100_000, { bid: 0.100, ask: 0.110 }],
    ]);
    const params: ButterflyPricingParams = {
      underlying: 'BTC',
      strikes: [strikeBig(80_000), strikeBig(90_000), strikeBig(100_000)],
      expiry: EXPIRY,
      isCall: true,
    };
    const r = await moduleWithLegs(quotes, 100_000).getButterflyPricing(params);
    assert(r.width === 10_000, `width should be 10000, got ${r.width}`);
    assert(r.collateral > 0n, `collateral must be positive, got ${r.collateral}`);
  });

  // -------------------------------------------------------------------------
  // Reporter
  // -------------------------------------------------------------------------
  console.log('\n# getPositionPricing tests (C-1 / C-2 / 4c)\n');

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
