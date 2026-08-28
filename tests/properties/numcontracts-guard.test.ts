#!/usr/bin/env npx tsx
/**
 * calculateNumContracts degenerate-strike guard tests
 *
 * Bug: the PUT / LINEAR_CALL / PHYSICAL_PUT branch of calculateNumContracts
 * fell through to `tradeAmount` when the strike was missing or <= 0, while
 * every other product branch (and calculateCollateralRequired for the same
 * inputs) returns 0. Result: a caller asking for PUT with strikes: [] got
 * "2000 contracts" but 0 collateral — an internally inconsistent, impossible
 * quote. The fix returns 0 for the degenerate strike, matching every sibling
 * branch and the collateral function.
 *
 * Guards proven here:
 *   1. repro (post-fix): PUT/LINEAR_CALL/PHYSICAL_PUT + degenerate strikes -> 0;
 *   2. internal consistency: calculateCollateralRequired agrees (0/0);
 *   3. happy path unchanged: tradeAmount / strike still divides correctly;
 *   4. non-vacuity: the inlined OLD expression returns 2000, proving the test
 *      discriminates pre-fix from post-fix behavior WITHOUT mutating source;
 *   5. every other product branch pinned byte-identical (hand-computed);
 *   6. MCP schema (Edit 2): strikes now carries exclusiveMinimum:0 + minItems:1,
 *      proven to reject []/[0]/[-100] and accept valid strikes via a mini
 *      JSON-Schema validator that is itself proven non-vacuous against the
 *      OLD (unconstrained) schema shape;
 *   7. MCP handler pass-through: verified structurally (source-slice) + via the
 *      SDK call it forwards to. The handler CANNOT be invoked directly from a
 *      test: handleTool is not exported, importing mcp-server/src/index.ts runs
 *      main() (opens a stdio transport), and mcp-server/node_modules is absent.
 *
 * No network / no chain: pure numeric + text-file assertions.
 *
 * Run: npx tsx tests/properties/numcontracts-guard.test.ts
 * Or:  npm run test:numcontracts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { calculateNumContracts, calculateCollateralRequired } from '../../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_INDEX = join(__dirname, '../../mcp-server/src/index.ts');

// ---------------------------------------------------------------------------
// Test harness (same self-executing reporter shape as frombigint-sign.test.ts).
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

function assertEq(actual: number, expected: number, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual: number, expected: number, msg: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${msg}: expected ~${expected}, got ${actual}`);
  }
}

function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Pre-fix PUT-branch expression, verbatim — the non-vacuity oracle. */
const preFixPutBranch = (tradeAmount: number, strike: number | undefined) =>
  strike !== undefined && strike > 0 ? tradeAmount / strike : tradeAmount;

/** Minimal JSON-Schema validator: array minItems + items.exclusiveMinimum. */
function schemaAccepts(
  schema: { minItems?: number; items: { exclusiveMinimum?: number } },
  value: number[]
): boolean {
  if (schema.minItems !== undefined && value.length < schema.minItems) return false;
  if (schema.items.exclusiveMinimum !== undefined) {
    for (const v of value) {
      if (!(v > schema.items.exclusiveMinimum)) return false;
    }
  }
  return true;
}

function main(): void {
  // ============================================================
  // 1. The repro (post-fix behavior): degenerate strikes -> 0.
  // ============================================================
  test('repro: PUT/LINEAR_CALL/PHYSICAL_PUT + degenerate strikes -> 0', () => {
    for (const product of ['PUT', 'LINEAR_CALL', 'PHYSICAL_PUT'] as const) {
      for (const strikes of [[], [0], [-100]]) {
        assertEq(
          calculateNumContracts({ tradeAmount: 2000, product, strikes, isBuy: false }),
          0,
          `${product} strikes=${JSON.stringify(strikes)}`
        );
      }
    }
  });

  // ============================================================
  // 2. Internal consistency restored: 0 contracts, 0 collateral.
  // ============================================================
  test('consistency: calculateCollateralRequired agrees (0 contracts, 0 collateral)', () => {
    for (const product of ['PUT', 'LINEAR_CALL', 'PHYSICAL_PUT'] as const) {
      for (const strikes of [[], [0], [-100]]) {
        const n = calculateNumContracts({ tradeAmount: 2000, product, strikes, isBuy: false });
        assertEq(n, 0, `numContracts ${product}`);
        assertEq(calculateCollateralRequired(n, product, strikes), 0, `collateral ${product}`);
        // and collateral for the raw degenerate input is independently 0
        assertEq(calculateCollateralRequired(2000, product, strikes), 0, `raw collateral ${product}`);
      }
    }
  });

  // ============================================================
  // 3. Happy path unchanged: tradeAmount / strike divides correctly.
  // ============================================================
  test('happy path: PUT tradeAmount / strike unchanged', () => {
    assertEq(
      calculateNumContracts({ tradeAmount: 2000, product: 'PUT', strikes: [2000], isBuy: false }),
      1,
      '2000 / 2000'
    );
    assertEq(
      calculateNumContracts({ tradeAmount: 3000, product: 'PUT', strikes: [1500], isBuy: false }),
      2,
      '3000 / 1500'
    );
  });

  // ============================================================
  // 4. Non-vacuity WITHOUT mutating source: the OLD expression yields 2000
  //    and differs from the live function's 0 for the same inputs.
  // ============================================================
  test('non-vacuity: inlined pre-fix expression returns 2000, live returns 0', () => {
    assertEq(preFixPutBranch(2000, undefined), 2000, 'pre-fix PUT-branch fallback');
    const live = calculateNumContracts({ tradeAmount: 2000, product: 'PUT', strikes: [], isBuy: false });
    assertEq(live, 0, 'live PUT empty strikes');
    assertTrue(
      preFixPutBranch(2000, undefined) !== live,
      'test must discriminate pre-fix (2000) from post-fix (0)'
    );
  });

  // ============================================================
  // 5. Every other product branch pinned byte-identical (hand-computed).
  // ============================================================
  test('other branches unchanged (hand-computed pins)', () => {
    // INVERSE_CALL, sell, 1:1
    assertEq(
      calculateNumContracts({ tradeAmount: 5, product: 'INVERSE_CALL', strikes: [], isBuy: false }),
      5,
      'INVERSE_CALL 1:1'
    );
    // INVERSE_CALL_SPREAD: 1 / (1 - 2000/2500) = 1 / 0.2 = 5 (float, tolerant compare)
    assertApprox(
      calculateNumContracts({
        tradeAmount: 1,
        product: 'INVERSE_CALL_SPREAD',
        strikes: [2000, 2500],
        isBuy: false,
      }),
      5,
      'INVERSE_CALL_SPREAD'
    );
    // CALL_SPREAD (default): 500 / (2100 - 2000) = 5
    assertEq(
      calculateNumContracts({
        tradeAmount: 500,
        product: 'CALL_SPREAD',
        strikes: [2000, 2100],
        isBuy: false,
      }),
      5,
      'CALL_SPREAD width'
    );
    // CALL_FLY (default, 3 strikes): width = two smallest = 2100 - 2000 = 100; 100/100 = 1
    assertEq(
      calculateNumContracts({
        tradeAmount: 100,
        product: 'CALL_FLY',
        strikes: [2000, 2100, 2200],
        isBuy: false,
      }),
      1,
      'CALL_FLY two-smallest width'
    );
    // RANGER: 400 / (2 * (2000 - 1900)) = 400 / 200 = 2
    assertEq(
      calculateNumContracts({
        tradeAmount: 400,
        product: 'RANGER',
        strikes: [1900, 2000, 2100, 2200],
        isBuy: false,
      }),
      2,
      'RANGER'
    );
    // IRON_CONDOR: 300 / max(1800-1700, 2050-1900) = 300 / 150 = 2
    assertEq(
      calculateNumContracts({
        tradeAmount: 300,
        product: 'IRON_CONDOR',
        strikes: [1700, 1800, 1900, 2050],
        isBuy: false,
      }),
      2,
      'IRON_CONDOR max spread'
    );
    // Degenerate guards elsewhere unchanged.
    assertEq(
      calculateNumContracts({ tradeAmount: 300, product: 'IRON_CONDOR', strikes: [], isBuy: false }),
      0,
      'IRON_CONDOR empty -> 0'
    );
    assertEq(
      calculateNumContracts({ tradeAmount: 500, product: 'CALL_SPREAD', strikes: [2000], isBuy: false }),
      0,
      'CALL_SPREAD single strike -> 0'
    );
    // Buy path untouched: quote-collateral PUT premium = mmPrice*spot = 0.01*2000 = 20; 100/20 = 5.
    assertEq(
      calculateNumContracts({
        tradeAmount: 100,
        product: 'PUT',
        strikes: [],
        isBuy: true,
        mmPrice: 0.01,
        spot: 2000,
      }),
      5,
      'buy path ignores strikes'
    );
    // tradeAmount <= 0 -> 0 for any product.
    assertEq(
      calculateNumContracts({ tradeAmount: 0, product: 'PUT', strikes: [2000], isBuy: false }),
      0,
      'tradeAmount 0 -> 0'
    );
    assertEq(
      calculateNumContracts({ tradeAmount: -5, product: 'CALL_SPREAD', strikes: [2000, 2100], isBuy: false }),
      0,
      'tradeAmount <0 -> 0'
    );
  });

  // ============================================================
  // 6. MCP schema (Edit 2): text assertion + mini-validator semantics.
  // ============================================================
  test('MCP calculate_num_contracts strikes schema carries the new constraints', () => {
    const src = readFileSync(MCP_INDEX, 'utf8');
    const toolStart = src.indexOf("name: 'calculate_num_contracts'");
    assertTrue(toolStart >= 0, "could not locate calculate_num_contracts tool");
    const nextTool = src.indexOf("name: '", toolStart + 1);
    const toolWindow = src.slice(toolStart, nextTool >= 0 ? nextTool : undefined);
    const strikesStart = toolWindow.indexOf('strikes: {');
    const strikesEnd = toolWindow.indexOf('isBuy: {');
    assertTrue(strikesStart >= 0 && strikesEnd > strikesStart, 'could not slice strikes property');
    const strikesWindow = toolWindow.slice(strikesStart, strikesEnd);
    assertTrue(strikesWindow.includes('exclusiveMinimum: 0'), 'strikes missing exclusiveMinimum: 0');
    assertTrue(strikesWindow.includes('minItems: 1'), 'strikes missing minItems: 1');
  });

  test('MCP schema mini-validator rejects degenerate, accepts valid; non-vacuous vs OLD schema', () => {
    const newSchema = { minItems: 1, items: { type: 'number', exclusiveMinimum: 0 } };
    // Rejections.
    assertTrue(!schemaAccepts(newSchema, []), 'new schema must reject []');
    assertTrue(!schemaAccepts(newSchema, [0]), 'new schema must reject [0]');
    assertTrue(!schemaAccepts(newSchema, [-100]), 'new schema must reject [-100]');
    // Acceptances.
    assertTrue(schemaAccepts(newSchema, [2000]), 'new schema must accept [2000]');
    assertTrue(schemaAccepts(newSchema, [1700, 1800, 1900, 2000]), 'new schema must accept 4 valid strikes');
    // Non-vacuity: the OLD (unconstrained) schema shape accepts [] — the added
    // constraints are what do the rejecting.
    const oldSchema = { items: { type: 'number' } };
    assertTrue(schemaAccepts(oldSchema, []), 'OLD schema accepts [] (mini-validator non-vacuous)');
    assertTrue(schemaAccepts(oldSchema, [0]), 'OLD schema accepts [0]');
  });

  // ============================================================
  // 7. MCP handler pass-through (structural + functional; not invoked directly,
  //    see header for why).
  // ============================================================
  test('MCP calculate_num_contracts handler forwards all four args unchanged', () => {
    const src = readFileSync(MCP_INDEX, 'utf8');
    const handlerStart = src.indexOf("case 'calculate_num_contracts': {");
    assertTrue(handlerStart >= 0, 'could not locate handler case');
    const handlerEnd = src.indexOf("case 'calculate_collateral_required'", handlerStart);
    assertTrue(handlerEnd > handlerStart, 'could not slice handler window');
    const handlerWindow = src.slice(handlerStart, handlerEnd);
    assertTrue(handlerWindow.includes('calculateNumContracts('), 'handler must call calculateNumContracts');
    for (const field of ['args.tradeAmount', 'args.product', 'args.strikes', 'args.isBuy']) {
      assertTrue(handlerWindow.includes(field), `handler must forward ${field}`);
    }
    // Functional: the schema-valid example returns exactly what the handler emits as numContracts.
    assertEq(
      calculateNumContracts({ tradeAmount: 2000, product: 'PUT', strikes: [2000], isBuy: false }),
      1,
      'handler example numContracts'
    );
  });

  // Report.
  const passed = results.filter((r) => r.passed).length;
  console.log('\ncalculateNumContracts guard test results');
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
