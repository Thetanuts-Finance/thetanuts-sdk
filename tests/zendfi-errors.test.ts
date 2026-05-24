#!/usr/bin/env npx tsx
/**
 * W1 unit tests for the ZendfiError discriminated union + factories.
 *
 * No on-chain calls, no network — pure type & factory exercise.
 *
 * Run: npx tsx tests/zendfi-errors.test.ts
 */

import { ThetanutsError } from '../src/types/errors.js';
import {
  ZendfiError,
  isZendfiError,
  zendfiErr,
  type ZendfiErrorCode,
} from '../src/types/zendfi-errors.js';

// ---------------------------------------------------------------------------
// Test harness (matches tests/properties/invariants.test.ts style — no
// test-framework dependency, runnable via tsx).
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, violation: message });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// 1. instanceof + base-class compatibility
// ---------------------------------------------------------------------------

test('ZendfiError extends ThetanutsError (instanceof works)', () => {
  const err = new ZendfiError('PRICING_ONLY_MODE', 'msg', 'do this');
  assert(err instanceof ZendfiError, 'should be instanceof ZendfiError');
  assert(err instanceof ThetanutsError, 'should be instanceof ThetanutsError');
  assert(err instanceof Error, 'should be instanceof Error');
});

test('ZendfiError sets name to ZendfiError', () => {
  const err = new ZendfiError('INVALID_CAP', 'msg', 'do this');
  assert(err.name === 'ZendfiError', `expected name 'ZendfiError', got '${err.name}'`);
});

test('ZendfiError writes code through to ThetanutsError.code', () => {
  const err = new ZendfiError('CONTRACT_REVERT', 'msg', 'do this');
  // string equality is what base-class consumers test for
  assert(
    (err as ThetanutsError).code === 'CONTRACT_REVERT',
    'base-class consumers must still see code === CONTRACT_REVERT',
  );
});

test('ZendfiError exposes namespace, humanMessage, actionable', () => {
  const err = new ZendfiError('PRICING_ONLY_MODE', 'human msg', 'do that');
  assert(err.namespace === 'zendfi', 'namespace must be zendfi');
  assert(err.humanMessage === 'human msg', 'humanMessage round-trips');
  assert(err.actionable === 'do that', 'actionable round-trips');
});

test('ZendfiError exposes meta and cause when provided', () => {
  const cause = new Error('underlying');
  const err = new ZendfiError('CONTRACT_REVERT', 'msg', 'fix it', {
    cause,
    meta: { txHash: '0xabc' },
  });
  assert(err.cause === cause, 'cause must round-trip');
  assert(
    err.meta !== undefined && err.meta.txHash === '0xabc',
    'meta must round-trip',
  );
});

test('ZendfiError leaves docsUrl undefined when not provided', () => {
  const err = new ZendfiError('INVALID_CAP', 'msg', 'fix it');
  // Contract: consumers test `err.docsUrl !== undefined`, not key presence.
  // (TypeScript class field declarations emit an `undefined` assignment for
  // optional fields, so checking `in` would conflate "explicitly set to
  // undefined" with "absent".)
  assert(err.docsUrl === undefined, `expected docsUrl undefined, got ${String(err.docsUrl)}`);
});

test('ZendfiError carries docsUrl when provided', () => {
  const err = new ZendfiError('INVALID_CAP', 'msg', 'fix it', {
    docsUrl: '/zendfi/errors#invalid_cap',
  });
  assert(err.docsUrl === '/zendfi/errors#invalid_cap', 'docsUrl round-trips');
});

// ---------------------------------------------------------------------------
// 2. isZendfiError type guard
// ---------------------------------------------------------------------------

test('isZendfiError returns true for ZendfiError instances', () => {
  const err = new ZendfiError('PRICING_ONLY_MODE', 'msg', 'do this');
  assert(isZendfiError(err), 'must recognise ZendfiError');
});

test('isZendfiError returns false for plain ThetanutsError', () => {
  const err = new ThetanutsError('CONTRACT_REVERT', 'msg');
  assert(!isZendfiError(err), 'must not match plain ThetanutsError');
});

test('isZendfiError returns false for non-errors', () => {
  assert(!isZendfiError(null), 'null is not a ZendfiError');
  assert(!isZendfiError(undefined), 'undefined is not a ZendfiError');
  assert(!isZendfiError('PRICING_ONLY_MODE'), 'string is not a ZendfiError');
  assert(!isZendfiError({ code: 'PRICING_ONLY_MODE' }), 'duck-typed object is not a ZendfiError');
  assert(!isZendfiError(new Error('plain')), 'plain Error is not a ZendfiError');
});

// ---------------------------------------------------------------------------
// 3. Factory coverage: every code has a factory; every factory writes
//    a non-empty humanMessage + actionable.
// ---------------------------------------------------------------------------

const ALL_CODES: readonly ZendfiErrorCode[] = [
  'PRICING_ONLY_MODE',
  'PRICING_UNAVAILABLE',
  'NO_MATCHING_STRIKE',
  'CAP_ABOVE_MAX',
  'EXPIRY_IN_PAST',
  'EXPIRY_TOO_SOON',
  'INVALID_CAP',
  'INSUFFICIENT_COLLATERAL',
  'INSUFFICIENT_LOAN_BUDGET',
  'OFFER_DECRYPTION_FAILED',
  'QUOTATION_NOT_FOUND',
  'QUOTATION_ALREADY_SETTLED',
  'INDEXER_UNAVAILABLE',
  'CONTRACT_REVERT',
  'SIGNER_REQUIRED',
  'INSUFFICIENT_ALLOWANCE',
  'INSUFFICIENT_BALANCE',
];

// Call every factory with representative arguments, mapped by code.
const samples: { [K in ZendfiErrorCode]: () => ZendfiError } = {
  PRICING_ONLY_MODE: () => zendfiErr.pricingOnlyMode('requestLoan'),
  PRICING_UNAVAILABLE: () => zendfiErr.pricingUnavailable('ETH'),
  NO_MATCHING_STRIKE: () => zendfiErr.noMatchingStrike(2500, [2200, 2300, 2400]),
  CAP_ABOVE_MAX: () => zendfiErr.capAboveMax(5000, 4000),
  EXPIRY_IN_PAST: () => zendfiErr.expiryInPast(1000, 2000),
  EXPIRY_TOO_SOON: () => zendfiErr.expiryTooSoon(1000, 2000),
  INVALID_CAP: () => zendfiErr.invalidCap(0),
  INSUFFICIENT_COLLATERAL: () => zendfiErr.insufficientCollateral(10n, 20n, 'USDC'),
  INSUFFICIENT_LOAN_BUDGET: () => zendfiErr.insufficientLoanBudget(1000, 500),
  OFFER_DECRYPTION_FAILED: () => zendfiErr.offerDecryptionFailed('quot-1'),
  QUOTATION_NOT_FOUND: () => zendfiErr.quotationNotFound('quot-1'),
  QUOTATION_ALREADY_SETTLED: () => zendfiErr.quotationAlreadySettled('quot-1'),
  INDEXER_UNAVAILABLE: () => zendfiErr.indexerUnavailable('https://indexer.example/api/state'),
  CONTRACT_REVERT: () => zendfiErr.contractRevert('requestLoan', 'PRICE_STALE'),
  SIGNER_REQUIRED: () => zendfiErr.signerRequired('requestLoan'),
  INSUFFICIENT_ALLOWANCE: () =>
    zendfiErr.insufficientAllowance('0xUSDC', '0xLOAN', 1_000_000n),
  INSUFFICIENT_BALANCE: () => zendfiErr.insufficientBalance('USDC', 10n, 100n),
};

for (const code of ALL_CODES) {
  test(`zendfiErr factory exists and produces ZendfiError<'${code}'>`, () => {
    const make = samples[code];
    assert(typeof make === 'function', `samples missing for ${code}`);
    const err = make();
    assert(err instanceof ZendfiError, `factory for ${code} returned non-ZendfiError`);
    assert(err.code === code, `factory for ${code} produced wrong code: ${err.code}`);
    assert(err.humanMessage.length > 0, `factory for ${code} produced empty humanMessage`);
    assert(err.actionable.length > 0, `factory for ${code} produced empty actionable`);
    assert(err.namespace === 'zendfi', `factory for ${code} produced wrong namespace`);
  });
}

test('every ZendfiErrorCode is covered by a factory (no orphans)', () => {
  const producedCodes = new Set(ALL_CODES.map((c) => samples[c]().code));
  for (const code of ALL_CODES) {
    assert(producedCodes.has(code), `no factory produces code ${code}`);
  }
});

test('factories carry meta + default docsUrl', () => {
  const err = zendfiErr.pricingOnlyMode('requestLoan');
  assert(
    err.docsUrl === '/zendfi/errors#pricing_only_mode',
    `expected default docsUrl, got ${String(err.docsUrl)}`,
  );
  assert(
    err.meta !== undefined && err.meta.operation === 'requestLoan',
    'meta.operation should be set by factory',
  );
});

test('factory docsUrl override wins over the default', () => {
  const err = zendfiErr.invalidCap(0, { docsUrl: '/custom/docs#here' });
  assert(err.docsUrl === '/custom/docs#here', 'override docsUrl not applied');
});

test('factory cause forwards through to ThetanutsError.cause', () => {
  const cause = new Error('underlying');
  const err = zendfiErr.indexerUnavailable('https://x', { cause });
  assert(err.cause === cause, 'cause must forward to ThetanutsError.cause');
});

// ---------------------------------------------------------------------------
// 4. Exhaustive switch — type-level check that consumers can switch.
//    This block is reachable at runtime to also catch logical regressions.
// ---------------------------------------------------------------------------

test('consumers can exhaustively switch on ZendfiError.code', () => {
  function classify(err: ZendfiError): string {
    switch (err.code) {
      case 'PRICING_ONLY_MODE':
      case 'PRICING_UNAVAILABLE':
        return 'pricing';
      case 'NO_MATCHING_STRIKE':
      case 'CAP_ABOVE_MAX':
      case 'INVALID_CAP':
      case 'INSUFFICIENT_LOAN_BUDGET':
        return 'config';
      case 'EXPIRY_IN_PAST':
      case 'EXPIRY_TOO_SOON':
        return 'expiry';
      case 'INSUFFICIENT_COLLATERAL':
      case 'INSUFFICIENT_ALLOWANCE':
      case 'INSUFFICIENT_BALANCE':
        return 'funds';
      case 'OFFER_DECRYPTION_FAILED':
      case 'QUOTATION_NOT_FOUND':
      case 'QUOTATION_ALREADY_SETTLED':
        return 'quotation';
      case 'INDEXER_UNAVAILABLE':
        return 'indexer';
      case 'CONTRACT_REVERT':
        return 'revert';
      case 'SIGNER_REQUIRED':
        return 'signer';
      default: {
        const _exhaustive: never = err.code;
        return _exhaustive;
      }
    }
  }
  // Just run it across one sample so we exercise the function (the type
  // check is the load-bearing part — if a new code is added without a
  // matching case, `_exhaustive: never` will fail to type-check).
  assert(classify(zendfiErr.pricingOnlyMode('test')) === 'pricing', 'switch returned wrong bucket');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

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
