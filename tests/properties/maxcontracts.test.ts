#!/usr/bin/env npx tsx
/**
 * OptionBook.calculateMaxContracts collateral-discrimination tests.
 *
 * Single-strike calls size by collateral type: USDC (quote) divides by strike;
 * every other token (base: WETH, cbBTC) backs exactly 1 contract per whole
 * token, rescaled from native decimals to 6-dec numContracts.
 *
 * All expectations are hand-computed. No network / no chain: the module only reads
 * `client.chainConfig` (token table) and `client.logger`, both stubbed here.
 *
 * Run: npx tsx tests/properties/maxcontracts.test.ts
 * Or:  npm run test:maxcontracts
 */

import { OptionBookModule } from '../../src/index.js';
import type { OrderWithSignature } from '../../src/types/api.js';
import type { ThetanutsClient } from '../../src/client/ThetanutsClient.js';

// Base-mainnet token addresses (src/chains/index.ts is the source of truth).
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const cbBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';

// Strikes are 8-decimal fixed point (USD * 1e8).
const P = 100000000n; // 1e8
const strikeBig = (usd: bigint): bigint => usd * P;

// ---------------------------------------------------------------------------
// Stub client — calculateMaxContracts only touches client.chainConfig (token
// table, for USDC address + collateral decimals) and client.logger.
// ---------------------------------------------------------------------------
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const tokenTable = {
  USDC: { address: USDC, symbol: 'USDC', decimals: 6 },
  WETH: { address: WETH, symbol: 'WETH', decimals: 18 },
  cbBTC: { address: cbBTC, symbol: 'cbBTC', decimals: 8 },
};
const stubClient = {
  logger: noopLogger,
  chainConfig: { tokens: tokenTable, collateralTokens: tokenTable },
} as unknown as ThetanutsClient;

const ob = new OptionBookModule(stubClient);

/** Build a minimal OrderWithSignature carrying the rawApiData the sizing math reads. */
function order(
  collateral: string,
  strikes: bigint[],
  isCall: boolean,
  availableAmount: bigint,
): OrderWithSignature {
  return {
    order: { price: 1n } as unknown as OrderWithSignature['order'],
    signature: '0x',
    availableAmount,
    makerAddress: '0x',
    rawApiData: {
      collateral,
      priceFeed: '0x',
      implementation: '0x',
      strikes: strikes.map((s) => s.toString()),
      isCall,
      isLong: false,
      orderExpiryTimestamp: 0,
      extraOptionData: '0x',
      maxCollateralUsable: availableAmount.toString(),
    },
  } as OrderWithSignature;
}

// ---------------------------------------------------------------------------
// Test harness (same self-executing reporter shape as mmpricing-bounds.test.ts).
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

function assertEq(actual: bigint, expected: bigint, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected.toString()}, got ${actual.toString()}`);
  }
}

function main(): void {
  // ============================================================
  // 1. WETH-collateral CALL (18-dp base):
  //    1 WETH (1e18) backs exactly 1 contract regardless of strike.
  //    hand: (1e18 * 1e6) / 1e18 = 1e6.
  // ============================================================
  test('WETH call (18dp base) 1e18 @ $100k → 1000000 (1.0 contract)', () => {
    const r = ob.calculateMaxContracts(
      order(WETH, [strikeBig(100000n)], true, 10n ** 18n),
    );
    assertEq(r, 1000000n, 'WETH call');
  });

  // ============================================================
  // 2. cbBTC-collateral CALL (8-dp base):
  //    1 cbBTC (1e8) backs exactly 1 contract → 1000000 (6dp).
  //    hand: (1e8 * 1e6) / 1e8 = 1e6.
  // ============================================================
  test('cbBTC call (8dp base) 1e8 @ $100k → 1000000 (1.0 contract)', () => {
    const r = ob.calculateMaxContracts(
      order(cbBTC, [strikeBig(100000n)], true, P), // 1 cbBTC = 1e8
    );
    assertEq(r, 1000000n, 'cbBTC call');
  });

  // ============================================================
  // 3. USDC-collateral PUT (6-dp quote): sized by strike.
  //    hand: (maxCollateral * 1e8) / strike = (2000e6 * 1e8) / (2000 * 1e8) = 1e6.
  // ============================================================
  test('USDC put (6dp quote) 2000e6 @ $2000 → 1000000 ((coll*1e8)/strike)', () => {
    const maxCollateral = 2000n * 10n ** 6n; // 2000 USDC
    const r = ob.calculateMaxContracts(
      order(USDC, [strikeBig(2000n)], false, maxCollateral),
    );
    const expected = (maxCollateral * P) / strikeBig(2000n);
    assertEq(expected, 1000000n, 'hand-computed USDC put'); // sanity on the formula
    assertEq(r, 1000000n, 'USDC put');
  });

  // ============================================================
  // 3b. USDC-collateral CALL (6-dp quote, LINEAR_CALL): sized by strike.
  //     hand: (1e8 * 1e8) / (100000 * 1e8) = 1e16 / 1e13 = 1000.
  // ============================================================
  test('USDC call (6dp quote, LINEAR) 1e8 @ $100k → 1000', () => {
    const r = ob.calculateMaxContracts(
      order(USDC, [strikeBig(100000n)], true, P),
    );
    assertEq(r, 1000n, 'USDC linear call');
  });

  // ============================================================
  // 4. Edge — sub-$100 strike with cbBTC. Base collateral sizes
  //    1 contract per token regardless of strike:
  //    (1e8 * 1e6) / 1e8 = 1e6.
  // ============================================================
  test('EDGE cbBTC call (8dp base) 1e8 @ $50 → 1000000', () => {
    const r = ob.calculateMaxContracts(
      order(cbBTC, [strikeBig(50n)], true, P),
    );
    assertEq(r, 1000000n, 'cbBTC sub-$100 call');
  });

  // Strike-independence of the base branch: cbBTC 1 token → 1 contract for any strike.
  test('EDGE cbBTC base branch is strike-independent ($1 vs $100k → same)', () => {
    const cheap = ob.calculateMaxContracts(order(cbBTC, [strikeBig(1n)], true, P));
    const rich = ob.calculateMaxContracts(order(cbBTC, [strikeBig(100000n)], true, P));
    assertEq(cheap, rich, 'cbBTC strike-independence');
    assertEq(cheap, 1000000n, 'cbBTC $1 strike');
  });

  // -------------------------------------------------------------------------
  // Reporter
  // -------------------------------------------------------------------------
  console.log('\n# calculateMaxContracts collateral tests\n');

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

main();
