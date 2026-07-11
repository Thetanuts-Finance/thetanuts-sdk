#!/usr/bin/env npx tsx
/**
 * UtilsModule.fromBigInt sign-handling tests
 *
 * The formatter slices the bigint's decimal string into whole/fraction parts;
 * pre-fix it treated the "-" as a digit, so any negative value with |value| <
 * one whole unit rendered garbage ("0.-5" for -0.05). The fix extracts the
 * sign first, formats the absolute value, and re-prefixes "-".
 *
 * Guards proven here:
 *   1. hand-computed negative acceptance cases render correctly;
 *   2. decimals === 0 keeps its integer-string behavior (the canonical
 *      utils/decimals.ts copy gets this wrong — the module must NOT regress);
 *   3. non-negative output is byte-identical to the pre-fix algorithm;
 *   4. fromBigInt(-v, d) === "-" + fromBigInt(v, d) for every positive v;
 *   5. everything agrees with an independent bigint-division reference;
 *   6. formatAmount / formatPrice (which funnel through fromBigInt) render
 *      negative sub-unit values correctly.
 *
 * No network / no chain: UtilsModule ignores its client argument.
 *
 * Run: npx tsx tests/properties/frombigint-sign.test.ts
 * Or:  npm run test:frombigint
 */

import { UtilsModule } from '../../src/index.js';
import type { ThetanutsClient } from '../../src/client/ThetanutsClient.js';

const utils = new UtilsModule(null as unknown as ThetanutsClient);

// ---------------------------------------------------------------------------
// Reference implementations.
// ---------------------------------------------------------------------------

/** Pre-fix algorithm, verbatim — the byte-identity oracle for non-negatives. */
function preFixFromBigInt(value: bigint, decimals: number): string {
  if (decimals === 0) {
    return value.toString();
  }
  const str = value.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, -decimals) || '0';
  const fraction = str.slice(-decimals);
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

/** Independent construction via bigint division/modulo — never slices signs. */
function refFromBigInt(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const result = frac ? `${whole}.${frac}` : whole;
  return negative && abs !== 0n ? `-${result}` : result;
}

/** Deterministic LCG so property sweeps are reproducible (no Math.random). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Random bigint with 1..maxDigits digits (uniform digit count, no leading zero). */
function randomBigint(rng: () => number, maxDigits: number): bigint {
  const digits = 1 + Math.floor(rng() * maxDigits);
  let s = String(1 + Math.floor(rng() * 9));
  for (let i = 1; i < digits; i++) s += String(Math.floor(rng() * 10));
  return BigInt(s);
}

// ---------------------------------------------------------------------------
// Test harness (same self-executing reporter shape as maxcontracts.test.ts).
// ---------------------------------------------------------------------------
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

function assertEq(actual: string, expected: string, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function main(): void {
  // ============================================================
  // 1. Hand-computed acceptance cases (the reported garbage outputs).
  // ============================================================
  test('negatives render correctly (was "0.00-5" / "0.-5" / "-.5")', () => {
    assertEq(utils.fromBigInt(-500n, 6), '-0.0005', '-500n @ 6');
    assertEq(utils.fromBigInt(-50000n, 6), '-0.05', '-50000n @ 6');
    assertEq(utils.fromBigInt(-500000n, 6), '-0.5', '-500000n @ 6');
    assertEq(utils.fromBigInt(-1500000n, 6), '-1.5', '-1500000n @ 6 (was right by accident)');
    assertEq(utils.fromBigInt(-1000000n, 6), '-1', 'trailing-zero trim keeps sign');
    assertEq(utils.fromBigInt(-1n, 77), `-0.${'0'.repeat(76)}1`, 'sign survives at max decimals');
  });

  // ============================================================
  // 2. decimals === 0 behavior must survive (canonical decimals.ts
  //    copy is broken here — "0.123" — the module copy must not be).
  // ============================================================
  test('decimals === 0 returns plain integer string, both signs', () => {
    assertEq(utils.fromBigInt(123n, 0), '123', '123n @ 0');
    assertEq(utils.fromBigInt(-123n, 0), '-123', '-123n @ 0');
    assertEq(utils.fromBigInt(0n, 0), '0', '0n @ 0');
  });

  // ============================================================
  // 3. Non-negative outputs byte-identical to the pre-fix algorithm
  //    (positives cannot regress). 10k random (value, decimals) pairs
  //    across magnitudes plus structured edges.
  // ============================================================
  test('non-negative sweep: 10k cases byte-identical to pre-fix code', () => {
    const rng = makeRng(0xc4c4c4);
    for (let i = 0; i < 10_000; i++) {
      const v = randomBigint(rng, 30);
      const d = Math.floor(rng() * 78); // 0..77, full guard range
      assertEq(utils.fromBigInt(v, d), preFixFromBigInt(v, d), `v=${v} d=${d}`);
    }
    for (const d of [0, 1, 6, 8, 18, 77]) {
      for (const v of [0n, 1n, 9n, 10n, 10n ** 18n, 10n ** 18n - 1n]) {
        assertEq(utils.fromBigInt(v, d), preFixFromBigInt(v, d), `edge v=${v} d=${d}`);
      }
    }
  });

  // ============================================================
  // 4. Negation symmetry: fromBigInt(-v, d) === "-" + fromBigInt(v, d)
  //    for every positive v (this is the property the bug violated).
  // ============================================================
  test('negation symmetry: 10k cases of fromBigInt(-v) === "-" + fromBigInt(v)', () => {
    const rng = makeRng(0x5157);
    for (let i = 0; i < 10_000; i++) {
      const v = randomBigint(rng, 30);
      const d = Math.floor(rng() * 78);
      assertEq(utils.fromBigInt(-v, d), `-${utils.fromBigInt(v, d)}`, `v=${v} d=${d}`);
    }
  });

  // ============================================================
  // 5. Signed sweep against the independent division/modulo reference.
  // ============================================================
  test('signed sweep: 10k cases match bigint-division reference', () => {
    const rng = makeRng(0xd1f5);
    for (let i = 0; i < 10_000; i++) {
      const sign = rng() < 0.5 ? -1n : 1n;
      const v = sign * randomBigint(rng, 30);
      const d = Math.floor(rng() * 78);
      assertEq(utils.fromBigInt(v, d), refFromBigInt(v, d), `v=${v} d=${d}`);
    }
  });

  // ============================================================
  // 6. Decimals range guard unchanged (throws for both signs).
  // ============================================================
  test('decimals guard still throws outside [0, 77], both signs', () => {
    for (const d of [-1, 78]) {
      for (const v of [500n, -500n]) {
        let threw = false;
        try {
          utils.fromBigInt(v, d);
        } catch {
          threw = true;
        }
        if (!threw) throw new Error(`fromBigInt(${v}, ${d}) did not throw`);
      }
    }
  });

  // ============================================================
  // 7. Downstream formatters inherit the fix.
  //    formatPrice default decimals = DECIMALS.PRICE = 8.
  // ============================================================
  test('formatAmount / formatPrice render negative sub-unit values', () => {
    assertEq(utils.formatAmount(-50000n, 6), '-0.05', 'formatAmount(-50000n, 6)');
    assertEq(utils.formatAmount(-50000n, 6, 2), '-0.05', 'formatAmount(-50000n, 6, 2)');
    assertEq(utils.formatAmount(-1500000n, 6, 1), '-1.5', 'formatAmount(-1500000n, 6, 1)');
    assertEq(utils.formatPrice(-5000000n), '$-0.05', 'formatPrice(-5000000n) @ 8dp');
    assertEq(utils.formatPrice(-150000000n), '$-1.5', 'formatPrice(-150000000n) @ 8dp');
  });

  // Report.
  const passed = results.filter((r) => r.passed).length;
  console.log('\nfromBigInt sign-handling test results');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(`${r.passed ? '✅' : '❌'} ${r.name}`);
    if (r.violation) console.log(`   ${r.violation}`);
  }
  console.log('='.repeat(60));
  console.log(`${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main();
