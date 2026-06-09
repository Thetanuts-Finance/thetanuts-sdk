#!/usr/bin/env npx tsx
/**
 * Multi-leg payout & collateral tests for utils.calculatePayout / calculateCollateral.
 *
 * Covers call_fly, put_fly, call_condor, put_condor, iron_condor, ranger.
 * All bigint, offline, no on-chain calls.
 *
 * Run: npx tsx tests/properties/payout-multileg.test.ts
 * Or:  npm run test:multileg
 */

import { UtilsModule, type PayoutType } from '../../src/index.js';
import type { ThetanutsClient } from '../../src/client/ThetanutsClient.js';

// UtilsModule's constructor stores but never uses the client at module-init time.
// All methods here are pure (no provider calls), so a stub is sufficient.
const utils = new UtilsModule({} as unknown as ThetanutsClient);

// 8-decimal price scaling — match the SDK default.
const P = 10n ** 8n;
// 18-decimal contract size — match the SDK default.
const C = 10n ** 18n;
// USDC has 6 decimals. payout is reported in collateral decimals (=6 by default).
const USDC = 10n ** 6n;

interface TestResult {
  name: string;
  passed: boolean;
  violation?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, violation: msg });
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => unknown, pattern?: RegExp): void {
  let threw = false;
  try { fn(); } catch (err: unknown) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    if (pattern && !pattern.test(msg)) {
      throw new Error(`Expected error matching ${pattern} but got: ${msg}`);
    }
  }
  if (!threw) throw new Error('Expected function to throw but it did not');
}

/** Helper: payout for 1 contract at price S in USDC (no scaling drift). */
function payoutAt(type: PayoutType, strikes: bigint[], S: bigint): bigint {
  return utils.calculatePayout({
    type,
    strikes,
    settlementPrice: S,
    numContracts: C, // 1 contract
  });
}

function collateralOf(type: PayoutType, strikes: bigint[]): bigint {
  return utils.calculateCollateral({
    type,
    strikes,
    numContracts: C, // 1 contract
  });
}

// ============================================================
// call_fly  [K1, K2, K3] ASCENDING, equidistant
// strikes [1900, 2000, 2100], wing width = 100
// max payout per contract = 100 USDC at S = 2000
// ============================================================

test('call_fly: payout curve [1900,2000,2100]', () => {
  const k: bigint[] = [1900n * P, 2000n * P, 2100n * P];
  // OTM left: S=1850
  assert(payoutAt('call_fly', k, 1850n * P) === 0n, 'S=1850 should be 0');
  // Left ramp midpoint: S=1950 → 50
  assert(payoutAt('call_fly', k, 1950n * P) === 50n * USDC, 'S=1950 should be 50');
  // Peak at body: S=2000 → 100
  assert(payoutAt('call_fly', k, 2000n * P) === 100n * USDC, 'S=2000 should be 100');
  // Right ramp midpoint: S=2050 → 50
  assert(payoutAt('call_fly', k, 2050n * P) === 50n * USDC, 'S=2050 should be 50');
  // OTM right: S=2100 → 0 (at wing)
  assert(payoutAt('call_fly', k, 2100n * P) === 0n, 'S=2100 should be 0');
  // Far OTM right: S=2200 → 0
  assert(payoutAt('call_fly', k, 2200n * P) === 0n, 'S=2200 should be 0');
});

test('call_fly: collateral = wing width', () => {
  const k: bigint[] = [1900n * P, 2000n * P, 2100n * P];
  assert(collateralOf('call_fly', k) === 100n * USDC, 'collateral should be 100 USDC');
});

test('call_fly: rejects non-equidistant strikes', () => {
  assertThrows(
    () => payoutAt('call_fly', [1900n * P, 2000n * P, 2150n * P], 2000n * P),
    /equidistant/i,
  );
});

test('call_fly: rejects non-ascending strikes', () => {
  assertThrows(
    () => payoutAt('call_fly', [2100n * P, 2000n * P, 1900n * P], 2000n * P),
    /ascending/i,
  );
});

// ============================================================
// put_fly  [K3, K2, K1] DESCENDING, equidistant
// strikes [2100, 2000, 1900] (descending)
// ============================================================

test('put_fly: payout curve [2100,2000,1900]', () => {
  const k: bigint[] = [2100n * P, 2000n * P, 1900n * P];
  assert(payoutAt('put_fly', k, 1800n * P) === 0n, 'S=1800 should be 0');
  assert(payoutAt('put_fly', k, 1900n * P) === 0n, 'S=1900 should be 0 (left wing)');
  assert(payoutAt('put_fly', k, 1950n * P) === 50n * USDC, 'S=1950 should be 50');
  assert(payoutAt('put_fly', k, 2000n * P) === 100n * USDC, 'S=2000 should be 100');
  assert(payoutAt('put_fly', k, 2050n * P) === 50n * USDC, 'S=2050 should be 50');
  assert(payoutAt('put_fly', k, 2100n * P) === 0n, 'S=2100 should be 0 (right wing)');
  assert(payoutAt('put_fly', k, 2200n * P) === 0n, 'S=2200 should be 0');
});

test('put_fly: collateral = wing width', () => {
  const k: bigint[] = [2100n * P, 2000n * P, 1900n * P];
  assert(collateralOf('put_fly', k) === 100n * USDC, 'collateral should be 100 USDC');
});

test('put_fly: rejects ascending strikes (must be descending)', () => {
  assertThrows(
    () => payoutAt('put_fly', [1900n * P, 2000n * P, 2100n * P], 2000n * P),
    /descending/i,
  );
});

// ============================================================
// call_condor  [K1, K2, K3, K4] ASCENDING, equal widths
// strikes [1800, 1900, 2100, 2200], wing width = 100
// plateau at 100 across [1900, 2100]
// ============================================================

test('call_condor: payout curve [1800,1900,2100,2200]', () => {
  const k: bigint[] = [1800n * P, 1900n * P, 2100n * P, 2200n * P];
  assert(payoutAt('call_condor', k, 1750n * P) === 0n, 'S=1750 should be 0');
  assert(payoutAt('call_condor', k, 1850n * P) === 50n * USDC, 'S=1850 should be 50');
  assert(payoutAt('call_condor', k, 1900n * P) === 100n * USDC, 'S=1900 should hit plateau');
  assert(payoutAt('call_condor', k, 2000n * P) === 100n * USDC, 'S=2000 should be 100 (plateau)');
  assert(payoutAt('call_condor', k, 2100n * P) === 100n * USDC, 'S=2100 should still be plateau');
  assert(payoutAt('call_condor', k, 2150n * P) === 50n * USDC, 'S=2150 should be 50');
  assert(payoutAt('call_condor', k, 2200n * P) === 0n, 'S=2200 should be 0');
  assert(payoutAt('call_condor', k, 2300n * P) === 0n, 'S=2300 should be 0');
});

test('call_condor: collateral = smaller wing width', () => {
  const k: bigint[] = [1800n * P, 1900n * P, 2100n * P, 2200n * P];
  assert(collateralOf('call_condor', k) === 100n * USDC, 'collateral should be 100 USDC');
});

test('call_condor: rejects unequal wing widths', () => {
  assertThrows(
    () => payoutAt('call_condor', [1800n * P, 1900n * P, 2100n * P, 2250n * P], 2000n * P),
    /widths must be equal/i,
  );
});

// ============================================================
// put_condor  same shape as call_condor at expiry, same strike order
// ============================================================

test('put_condor: payout curve matches call_condor at expiry', () => {
  const k: bigint[] = [1800n * P, 1900n * P, 2100n * P, 2200n * P];
  // Put-condor max payoff at expiry mirrors the call-condor envelope.
  assert(payoutAt('put_condor', k, 1750n * P) === 0n, 'S=1750 should be 0');
  assert(payoutAt('put_condor', k, 1850n * P) === 50n * USDC, 'S=1850 should be 50');
  assert(payoutAt('put_condor', k, 2000n * P) === 100n * USDC, 'S=2000 plateau');
  assert(payoutAt('put_condor', k, 2150n * P) === 50n * USDC, 'S=2150 should be 50');
  assert(payoutAt('put_condor', k, 2300n * P) === 0n, 'S=2300 should be 0');
});

test('put_condor: collateral = smaller wing width', () => {
  const k: bigint[] = [1800n * P, 1900n * P, 2100n * P, 2200n * P];
  assert(collateralOf('put_condor', k) === 100n * USDC, 'collateral should be 100 USDC');
});

// ============================================================
// iron_condor  [putLower, putUpper, callLower, callUpper]
// strikes [1800, 1900, 2100, 2200] — wings pay, body pays zero
// max payoff per contract = max(put-spread, call-spread) = 100
// ============================================================

test('iron_condor: payout curve [1800,1900,2100,2200]', () => {
  const k: bigint[] = [1800n * P, 1900n * P, 2100n * P, 2200n * P];
  // Body S=2000 → 0 (between putUpper and callLower)
  assert(payoutAt('iron_condor', k, 2000n * P) === 0n, 'S=2000 should be 0 (body)');
  // Left cap: S=1750 → 100 (put-spread fully ITM)
  assert(payoutAt('iron_condor', k, 1750n * P) === 100n * USDC, 'S=1750 should be 100');
  // Left ramp: S=1850 → 50
  assert(payoutAt('iron_condor', k, 1850n * P) === 50n * USDC, 'S=1850 should be 50');
  // putUpper boundary: S=1900 → 0
  assert(payoutAt('iron_condor', k, 1900n * P) === 0n, 'S=1900 should be 0 (putUpper boundary)');
  // callLower boundary: S=2100 → 0
  assert(payoutAt('iron_condor', k, 2100n * P) === 0n, 'S=2100 should be 0 (callLower boundary)');
  // Right ramp: S=2150 → 50
  assert(payoutAt('iron_condor', k, 2150n * P) === 50n * USDC, 'S=2150 should be 50');
  // Right cap: S=2250 → 100 (call-spread fully ITM)
  assert(payoutAt('iron_condor', k, 2250n * P) === 100n * USDC, 'S=2250 should be 100');
});

test('iron_condor: collateral = max(put-spread, call-spread)', () => {
  // Symmetric case
  assert(
    collateralOf('iron_condor', [1800n * P, 1900n * P, 2100n * P, 2200n * P]) === 100n * USDC,
    'symmetric IC collateral should be 100 USDC',
  );
  // Asymmetric: put-spread=200, call-spread=100 → collateral=200
  assert(
    collateralOf('iron_condor', [1700n * P, 1900n * P, 2100n * P, 2200n * P]) === 200n * USDC,
    'asymmetric IC collateral should be max(200,100) = 200 USDC',
  );
});

test('iron_condor: rejects overlapping spreads (putUpper > callLower)', () => {
  assertThrows(
    () => payoutAt('iron_condor', [1800n * P, 2100n * P, 2050n * P, 2200n * P], 2000n * P),
    /not overlap/i,
  );
});

// ============================================================
// ranger  [callLower, callUpper, putLower, putUpper]
// strikes [1900, 2000, 2100, 2200] — k = 100, zone = [2000, 2100]
// max payoff to buyer per contract = k = 100; seller posts 2k = 200
// ============================================================

test('ranger: payout curve [1900,2000,2100,2200]', () => {
  const k: bigint[] = [1900n * P, 2000n * P, 2100n * P, 2200n * P];
  // Below callLower
  assert(payoutAt('ranger', k, 1800n * P) === 0n, 'S=1800 should be 0');
  // At callLower boundary
  assert(payoutAt('ranger', k, 1900n * P) === 0n, 'S=1900 should be 0 (callLower boundary)');
  // Left ramp midpoint
  assert(payoutAt('ranger', k, 1950n * P) === 50n * USDC, 'S=1950 should be 50');
  // Zone (plateau) — at lower zone bound
  assert(payoutAt('ranger', k, 2000n * P) === 100n * USDC, 'S=2000 should be 100 (zone bound)');
  assert(payoutAt('ranger', k, 2050n * P) === 100n * USDC, 'S=2050 should be 100 (zone mid)');
  assert(payoutAt('ranger', k, 2100n * P) === 100n * USDC, 'S=2100 should be 100 (zone upper bound)');
  // Right ramp midpoint
  assert(payoutAt('ranger', k, 2150n * P) === 50n * USDC, 'S=2150 should be 50');
  // At putUpper boundary
  assert(payoutAt('ranger', k, 2200n * P) === 0n, 'S=2200 should be 0 (putUpper boundary)');
  // Above putUpper
  assert(payoutAt('ranger', k, 2300n * P) === 0n, 'S=2300 should be 0');
});

test('ranger: collateral = 2k (seller posts double)', () => {
  const k: bigint[] = [1900n * P, 2000n * P, 2100n * P, 2200n * P];
  assert(collateralOf('ranger', k) === 200n * USDC, 'ranger collateral should be 200 USDC');
});

test('ranger: rejects unequal spread widths', () => {
  assertThrows(
    () => payoutAt('ranger', [1900n * P, 2000n * P, 2100n * P, 2250n * P], 2050n * P),
    /widths must be equal/i,
  );
});

test('ranger: rejects missing zone gap (callUpper >= putLower)', () => {
  assertThrows(
    () => payoutAt('ranger', [1900n * P, 2100n * P, 2100n * P, 2300n * P], 2050n * P),
    /zone gap/i,
  );
});

// ============================================================
// Sweep invariant: payout(S) <= maxPayoutPerContract for all S
// across [Kmin*0.9, Kmax*1.1] in 100 steps.
// ============================================================

interface SweepCase {
  type: PayoutType;
  strikes: bigint[];
  // True if the type expects strikes to be descending; affects min/max selection.
  descending?: boolean;
}

const sweepCases: SweepCase[] = [
  { type: 'call_fly', strikes: [1900n * P, 2000n * P, 2100n * P] },
  { type: 'put_fly',  strikes: [2100n * P, 2000n * P, 1900n * P], descending: true },
  { type: 'call_condor', strikes: [1800n * P, 1900n * P, 2100n * P, 2200n * P] },
  { type: 'put_condor',  strikes: [1800n * P, 1900n * P, 2100n * P, 2200n * P] },
  { type: 'iron_condor', strikes: [1800n * P, 1900n * P, 2100n * P, 2200n * P] },
  { type: 'ranger',      strikes: [1900n * P, 2000n * P, 2100n * P, 2200n * P] },
];

for (const sc of sweepCases) {
  test(`sweep invariant: payout <= collateral for ${sc.type}`, () => {
    const sorted = [...sc.strikes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const kMin = sorted[0]!;
    const kMax = sorted[sorted.length - 1]!;
    const lo = (kMin * 9n) / 10n;
    const hi = (kMax * 11n) / 10n;
    const steps = 100;
    const stride = (hi - lo) / BigInt(steps);
    const maxPayout = collateralOf(sc.type, sc.strikes);

    // Ranger collateral is 2k but buyer's max payout is k. For all other types
    // collateral equals max payout. Compare against the actual buyer cap.
    const buyerCap = sc.type === 'ranger' ? maxPayout / 2n : maxPayout;

    for (let i = 0; i <= steps; i++) {
      const S = lo + stride * BigInt(i);
      const p = payoutAt(sc.type, sc.strikes, S);
      assert(p >= 0n, `${sc.type} payout at S=${S} went negative: ${p}`);
      assert(
        p <= buyerCap,
        `${sc.type} payout at S=${S} exceeded buyer cap: ${p} > ${buyerCap}`,
      );
    }
  });
}

// ============================================================
// Backwards compatibility: existing 4 types still work
// ============================================================

test('backcompat: call/put/call_spread/put_spread still work', () => {
  // Call
  assert(
    utils.calculatePayout({
      type: 'call',
      strikes: [2000n * P],
      settlementPrice: 2500n * P,
      numContracts: 10n * C,
    }) === 5000n * USDC,
    'call ITM payout',
  );
  // Put
  assert(
    utils.calculatePayout({
      type: 'put',
      strikes: [2000n * P],
      settlementPrice: 1500n * P,
      numContracts: 10n * C,
    }) === 5000n * USDC,
    'put ITM payout',
  );
  // Call spread (capped)
  assert(
    utils.calculatePayout({
      type: 'call_spread',
      strikes: [2000n * P, 2200n * P],
      settlementPrice: 2500n * P,
      numContracts: 10n * C,
    }) === 2000n * USDC,
    'call spread capped at width',
  );
});

// ============================================================
// Unknown type still throws
// ============================================================

test('unknown type still throws INVALID_PARAMS', () => {
  assertThrows(
    () => utils.calculatePayout({
      type: 'nonsense' as unknown as PayoutType,
      strikes: [2000n * P],
      settlementPrice: 2000n * P,
      numContracts: C,
    }),
    /Unknown option type/i,
  );
});

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

console.log('\n# Multi-leg payout & collateral tests\n');

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
