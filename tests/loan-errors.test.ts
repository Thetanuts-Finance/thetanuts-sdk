#!/usr/bin/env npx tsx
/**
 * W3 unit tests for the loan-module typed-error migration ([TNU-24](/TNU/issues/TNU-24)).
 *
 * Verifies:
 * 1. Synchronous validation paths in `LoanModule` throw `ZendfiError`
 *    with the expected `code`, `humanMessage`, `actionable`, and `meta`.
 * 2. Legacy `error.code === 'CONTRACT_REVERT'` consumers still match
 *    `zendfiErr.contractRevert(...)` output (acceptance criteria).
 * 3. The `encodeRequestLoan` actionable hint is on the standard
 *    `actionable` field (not embedded in `humanMessage`).
 *
 * No on-chain calls, no network — synchronous-throw paths only.
 *
 * Run: npx tsx tests/loan-errors.test.ts
 */

import type { ThetanutsClient } from '../src/client/ThetanutsClient.js';
import { LoanModule } from '../src/modules/loan.js';
import { ThetanutsError } from '../src/types/errors.js';
import { ZendfiError, isZendfiError, zendfiErr } from '../src/types/zendfi-errors.js';

// ---------------------------------------------------------------------------
// Test harness (matches tests/zendfi-errors.test.ts style — no framework dep).
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  violation?: string;
}

const results: TestResult[] = [];
const pending: Promise<void>[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  const run = async (): Promise<void> => {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name, passed: false, violation: message });
    }
  };
  pending.push(run());
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// A LoanModule built with `{} as ThetanutsClient`. The synchronous validation
// paths under test (`splitOption` rejecting non-positive amounts;
// `encodeRequestLoan` rejecting empty `requesterPublicKey`) throw before any
// client field is read, so the stub is enough.
//
// Note: `validateAddress` is called first inside `splitOption` and verifies
// the option address is a valid 0x address. We pass a syntactically-valid
// throwaway address so we hit the amount check.
const stubClient = {} as unknown as ThetanutsClient;
const VALID_ADDRESS = '0x' + 'aa'.repeat(20);

// ---------------------------------------------------------------------------
// 1. splitOption: non-positive collateral amount throws zendfiErr.invalidParam
// ---------------------------------------------------------------------------

test('splitOption(0n) throws ZendfiError INVALID_PARAM with field=splitCollateralAmount', async () => {
  const loan = new LoanModule(stubClient);
  let caught: unknown;
  try {
    await loan.splitOption(VALID_ADDRESS, 0n);
    assert(false, 'splitOption(0n) should have rejected');
  } catch (err) {
    caught = err;
  }
  assert(isZendfiError(caught), 'thrown error must satisfy isZendfiError');
  const z = caught as ZendfiError;
  assert(z.code === 'INVALID_PARAM', `expected code INVALID_PARAM, got ${String(z.code)}`);
  assert(
    z.humanMessage.includes('splitCollateralAmount') && z.humanMessage.includes('must be positive'),
    `humanMessage missing field+reason: ${z.humanMessage}`,
  );
  assert(z.actionable.length > 0, 'actionable must be non-empty');
  assert(
    z.meta?.fieldName === 'splitCollateralAmount',
    `meta.fieldName expected splitCollateralAmount, got ${String(z.meta?.fieldName)}`,
  );
  assert(
    z.meta?.reason === 'must be positive',
    `meta.reason expected "must be positive", got ${String(z.meta?.reason)}`,
  );
});

test('splitOption(-1n) also throws INVALID_PARAM (negative amounts rejected)', async () => {
  const loan = new LoanModule(stubClient);
  let caught: unknown;
  try {
    await loan.splitOption(VALID_ADDRESS, -1n);
    assert(false, 'splitOption(-1n) should have rejected');
  } catch (err) {
    caught = err;
  }
  assert(isZendfiError(caught), 'thrown error must satisfy isZendfiError');
  assert((caught as ZendfiError).code === 'INVALID_PARAM', 'code must be INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// 2. encodeRequestLoan: empty requesterPublicKey throws with bespoke actionable
// ---------------------------------------------------------------------------

test('encodeRequestLoan empty key throws INVALID_PARAM with bespoke actionable on the actionable field', () => {
  const loan = new LoanModule(stubClient);
  let caught: unknown;
  try {
    loan.encodeRequestLoan({
      underlying: 'ETH',
      collateralAmount: '1.0',
      strike: 1600,
      expiryTimestamp: 1780041600,
      minSettlementAmount: 0n,
      requesterPublicKey: '',
    });
    assert(false, 'encodeRequestLoan with empty key should throw');
  } catch (err) {
    caught = err;
  }
  assert(isZendfiError(caught), 'thrown error must satisfy isZendfiError');
  const z = caught as ZendfiError;
  assert(z.code === 'INVALID_PARAM', `expected code INVALID_PARAM, got ${String(z.code)}`);
  assert(
    z.humanMessage.includes('requesterPublicKey'),
    `humanMessage must reference field: ${z.humanMessage}`,
  );
  // The hint MUST live on `actionable`, not on `humanMessage` (TNU-24 acceptance).
  assert(
    z.actionable.includes('rfqKeys.getOrCreateKeyPair'),
    `actionable must contain the rfqKeys hint: ${z.actionable}`,
  );
  assert(
    !z.humanMessage.includes('rfqKeys.getOrCreateKeyPair'),
    `humanMessage must NOT carry the actionable hint anymore: ${z.humanMessage}`,
  );
});

test('encodeRequestLoan whitespace-only key is also rejected', () => {
  const loan = new LoanModule(stubClient);
  let caught: unknown;
  try {
    loan.encodeRequestLoan({
      underlying: 'ETH',
      collateralAmount: '1.0',
      strike: 1600,
      expiryTimestamp: 1780041600,
      minSettlementAmount: 0n,
      requesterPublicKey: '   ',
    });
    assert(false, 'whitespace-only key should throw');
  } catch (err) {
    caught = err;
  }
  assert(isZendfiError(caught), 'whitespace key must throw a ZendfiError');
  assert((caught as ZendfiError).code === 'INVALID_PARAM', 'code must be INVALID_PARAM');
});

// ---------------------------------------------------------------------------
// 3. Legacy `error.code === 'CONTRACT_REVERT'` regression
// ---------------------------------------------------------------------------

test('zendfiErr.contractRevert writes legacy code CONTRACT_REVERT (string equality)', () => {
  // Mirror what every loan.ts CONTRACT_REVERT site now throws.
  const err = zendfiErr.contractRevert('loan.requestLoan: no receipt');
  // Existing consumers do `error.code === 'CONTRACT_REVERT'` — that must keep working.
  assert(err.code === 'CONTRACT_REVERT', `legacy code preserved, got ${String(err.code)}`);
  assert(err instanceof ThetanutsError, 'must still be a ThetanutsError for base-class consumers');
  assert(isZendfiError(err), 'must also satisfy isZendfiError for new consumers');
  assert(err.humanMessage.length > 0, 'humanMessage non-empty');
  assert(err.actionable.length > 0, 'actionable non-empty');
  assert(
    err.meta?.operation === 'loan.requestLoan: no receipt',
    `meta.operation expected to carry the operation string, got ${String(err.meta?.operation)}`,
  );
});

test('all eight loan.ts CONTRACT_REVERT sites produce code=CONTRACT_REVERT', () => {
  // Each entry mirrors a real call site so a refactor that flips the code is caught here.
  const sites = [
    'loan.requestLoan: no receipt',
    'loan.acceptOffer: no receipt',
    'loan.cancelLoan: no receipt',
    'loan.exerciseOption: no receipt',
    'loan.doNotExercise: no receipt',
    'loan.swapAndExercise: no receipt',
    'loan.splitOption: no receipt',
    'loan.reclaimCollateral: no receipt',
  ];
  for (const op of sites) {
    const err = zendfiErr.contractRevert(op);
    assert(err.code === 'CONTRACT_REVERT', `${op} expected CONTRACT_REVERT, got ${String(err.code)}`);
    assert(err.humanMessage.includes(op), `humanMessage should reference operation "${op}"`);
  }
});

// ---------------------------------------------------------------------------
// 4. Indexer-unavailable + pricing-unavailable shape sanity
// ---------------------------------------------------------------------------

test('zendfiErr.indexerUnavailable with status meta surfaces the HTTP status', () => {
  const err = zendfiErr.indexerUnavailable('https://example.com/api/state', { meta: { status: 502 } });
  assert(err.code === 'INDEXER_UNAVAILABLE', `code expected INDEXER_UNAVAILABLE, got ${String(err.code)}`);
  assert(
    err.meta?.endpoint === 'https://example.com/api/state',
    'meta.endpoint must be the URL',
  );
  assert(err.meta?.status === 502, `meta.status expected 502, got ${String(err.meta?.status)}`);
});

test('zendfiErr.pricingUnavailable preserves cause for the outer-fetch fallback', () => {
  const cause = new Error('network down');
  const err = zendfiErr.pricingUnavailable('fetch failed', { cause });
  assert(err.code === 'PRICING_UNAVAILABLE', 'code expected PRICING_UNAVAILABLE');
  assert(err.cause === cause, 'cause must forward through to ThetanutsError.cause');
});

// ---------------------------------------------------------------------------
// 5. invalidParam actionable override mechanic (factory-level)
// ---------------------------------------------------------------------------

test('zendfiErr.invalidParam without actionable opt gets the canned default', () => {
  const err = zendfiErr.invalidParam('foo', 'bad');
  assert(err.code === 'INVALID_PARAM', 'code expected INVALID_PARAM');
  assert(
    err.actionable.includes('Fix the foo argument'),
    `default actionable expected, got: ${err.actionable}`,
  );
});

test('zendfiErr.invalidParam with actionable opt overrides the canned default', () => {
  const err = zendfiErr.invalidParam('foo', 'bad', { actionable: 'do the thing' });
  assert(err.actionable === 'do the thing', `override expected, got: ${err.actionable}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await Promise.all(pending);

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);

  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${r.name}${r.violation ? ` — ${r.violation}` : ''}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} passed`);

  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`${failed.length} test(s) failed`);
    process.exit(1);
  }
}

void main();
