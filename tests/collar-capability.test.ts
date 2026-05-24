#!/usr/bin/env npx tsx
/**
 * W2 unit tests for the CollarModule capability surface + ZendfiError migration.
 *
 * Covers (TNU-23 acceptance criteria):
 *  - `capability()` returns `{ mode: 'pricing-only', chainId, missingContracts }`
 *    on Base mainnet (placeholder zero-address coordinator).
 *  - `isPricingOnly()` true / `isWriteEnabled()` false in that state.
 *  - `isDeployed()` back-compat shim still returns the same boolean.
 *  - Every write method throws a `ZendfiError` with `code === 'PRICING_ONLY_MODE'`
 *    when called in pricing-only mode (no signer needed; the capability check
 *    fires before any signer/RPC interaction).
 *  - `expiryInPast`, `expiryTooSoon`, `invalidCap` factories fire from
 *    `requestLoan` pre-flight when the write gate is bypassed.
 *  - TypeScript type-narrowing on `isWriteEnabled()` compiles.
 *
 * No on-chain calls, no network — the provider is a JsonRpcProvider pointed
 * at a localhost sentinel that is never dialed (constructor is lazy).
 *
 * Run: npx tsx tests/collar-capability.test.ts
 */

import { JsonRpcProvider, ZeroAddress } from 'ethers';
import { ThetanutsClient } from '../src/client/ThetanutsClient.js';
import { COLLAR_CONFIG } from '../src/chains/collar.js';
import { ZendfiError, isZendfiError } from '../src/types/zendfi-errors.js';
import {
  CollarModule,
  type CollarCapability,
  type CollarLoanRequest,
  type CollarModuleWriteEnabled,
} from '../src/modules/collar.js';

// ---------------------------------------------------------------------------
// Harness — matches tests/zendfi-errors.test.ts style (no test framework).
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  violation?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      // Defer async tests through the promise queue; the runner awaits them
      // before printing the summary (see runAll() at the bottom).
      asyncQueue.push(
        r
          .then(() => {
            results.push({ name, passed: true });
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            results.push({ name, passed: false, violation: message });
          }),
      );
    } else {
      results.push({ name, passed: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, violation: message });
  }
}

const asyncQueue: Array<Promise<void>> = [];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fixture — Base mainnet client with a sentinel provider. Constructor is
// lazy (no RPC call), and every method we exercise here fails the capability
// check before touching the provider.
// ---------------------------------------------------------------------------

const BASE_CHAIN_ID = 8453;
// localhost:1 is reserved by IANA — the provider never connects until called.
const SENTINEL_PROVIDER = new JsonRpcProvider('http://127.0.0.1:1');

function makeClient(): ThetanutsClient {
  return new ThetanutsClient({ chainId: BASE_CHAIN_ID, provider: SENTINEL_PROVIDER });
}

// Sanity: the chain config under test really does ship with placeholder
// addresses. If collar-v12 ever lands and `COLLAR_CONFIG.contracts.collarCoordinator`
// becomes non-zero, these pricing-only assertions will (correctly) fail and the
// test author has to update them to match the new ground truth.
assert(
  COLLAR_CONFIG.contracts.collarCoordinator === ZeroAddress,
  'fixture precondition: collarCoordinator must still be the zero placeholder',
);

// ---------------------------------------------------------------------------
// 1. capability() + isPricingOnly() + isWriteEnabled() + isDeployed()
// ---------------------------------------------------------------------------

test('capability() returns pricing-only on current Base mainnet', () => {
  const client = makeClient();
  const cap: CollarCapability = client.collar.capability();
  assert(cap.mode === 'pricing-only', `expected pricing-only, got ${cap.mode}`);
  assert(cap.chainId === BASE_CHAIN_ID, `expected chainId ${BASE_CHAIN_ID}, got ${cap.chainId}`);
  assert(Array.isArray(cap.missingContracts), 'missingContracts must be present in pricing-only mode');
  assert(
    (cap.missingContracts ?? []).includes('collarCoordinator'),
    'missingContracts must list collarCoordinator',
  );
});

test('missingContracts is sorted and contains every zero-address slot', () => {
  const cap = makeClient().collar.capability();
  const slots = cap.missingContracts ?? [];
  const expected = Object.entries(COLLAR_CONFIG.contracts)
    .filter(([, addr]) => addr === ZeroAddress)
    .map(([slot]) => slot)
    .sort();
  assert(
    JSON.stringify([...slots]) === JSON.stringify(expected),
    `missingContracts (${[...slots].join(',')}) must equal expected (${expected.join(',')})`,
  );
});

test('isPricingOnly() returns true on current Base mainnet', () => {
  assert(makeClient().collar.isPricingOnly() === true, 'expected isPricingOnly() === true');
});

test('isWriteEnabled() returns false in pricing-only mode', () => {
  assert(makeClient().collar.isWriteEnabled() === false, 'expected isWriteEnabled() === false');
});

test('isDeployed() back-compat shim mirrors isWriteEnabled', () => {
  const collar = makeClient().collar;
  assert(
    collar.isDeployed() === collar.isWriteEnabled(),
    'isDeployed() must equal isWriteEnabled() (back-compat shim)',
  );
  assert(collar.isDeployed() === false, 'isDeployed() must be false in pricing-only mode');
});

// ---------------------------------------------------------------------------
// 2. Write methods throw PRICING_ONLY_MODE before touching signer/RPC
// ---------------------------------------------------------------------------

function expectPricingOnly(operation: string, fn: () => Promise<unknown>): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected ${operation} to throw PRICING_ONLY_MODE, but it resolved`);
    },
    (err: unknown) => {
      assert(isZendfiError(err), `${operation}: expected ZendfiError, got ${String(err)}`);
      const zerr = err as ZendfiError;
      assert(
        zerr.code === 'PRICING_ONLY_MODE',
        `${operation}: expected code PRICING_ONLY_MODE, got ${zerr.code}`,
      );
      assert(
        typeof zerr.humanMessage === 'string' && zerr.humanMessage.length > 0,
        `${operation}: humanMessage must be non-empty`,
      );
      assert(
        typeof zerr.actionable === 'string' && zerr.actionable.length > 0,
        `${operation}: actionable must be non-empty`,
      );
      assert(
        (zerr.meta as { operation?: string } | undefined)?.operation === operation,
        `${operation}: meta.operation should pin the failing method name`,
      );
    },
  );
}

test('requestLoan throws PRICING_ONLY_MODE in pricing-only mode', () =>
  expectPricingOnly('requestLoan', () =>
    makeClient().collar.requestLoan({
      underlying: 'BTC',
      collateralAmount: '0.5',
      capUsd: 150000,
      minLoanUsd: 1,
      expiryTimestamp: Math.floor(Date.now() / 1000) + 7 * 86400,
    }),
  ));

test('cancelLoan throws PRICING_ONLY_MODE in pricing-only mode', () =>
  expectPricingOnly('cancelLoan', () => makeClient().collar.cancelLoan(1n)));

test('acceptOffer throws PRICING_ONLY_MODE in pricing-only mode', () =>
  expectPricingOnly('acceptOffer', () =>
    makeClient().collar.acceptOffer(1n, 1n, 1n, '0x000000000000000000000000000000000000dead'),
  ));

test('exerciseCollar throws PRICING_ONLY_MODE in pricing-only mode', () =>
  expectPricingOnly('exerciseCollar', () =>
    makeClient().collar.exerciseCollar('0x000000000000000000000000000000000000dead'),
  ));

test('walkAwayCollar throws PRICING_ONLY_MODE in pricing-only mode', () =>
  expectPricingOnly('walkAwayCollar', () =>
    makeClient().collar.walkAwayCollar('0x000000000000000000000000000000000000dead'),
  ));

test('getLoanRequest throws PRICING_ONLY_MODE in pricing-only mode', () =>
  expectPricingOnly('getLoanRequest', () => makeClient().collar.getLoanRequest(1n)));

// ---------------------------------------------------------------------------
// 3. Validation factories fire (when write gate is bypassed via a stubbed
//    capability() that returns 'full'). We confirm the *post*-capability
//    pre-flight throws still surface as typed ZendfiError, not raw createError.
// ---------------------------------------------------------------------------

function makeFullModeCollar(): CollarModule {
  const collar = makeClient().collar;
  // Override capability() to simulate a deployed-collar chain. Pre-flight
  // validation should still throw typed ZendfiError for bad inputs.
  (collar as unknown as { capability: () => CollarCapability }).capability = () => ({
    mode: 'full',
    chainId: BASE_CHAIN_ID,
  });
  return collar;
}

function expectZendfiCode(
  operation: string,
  expectedCode: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  return fn().then(
    () => {
      throw new Error(`expected ${operation} to throw ${expectedCode}, but it resolved`);
    },
    (err: unknown) => {
      assert(isZendfiError(err), `${operation}: expected ZendfiError, got ${String(err)}`);
      assert(
        (err as ZendfiError).code === expectedCode,
        `${operation}: expected code ${expectedCode}, got ${(err as ZendfiError).code}`,
      );
    },
  );
}

test('requestLoan throws EXPIRY_IN_PAST for past expiry (full-mode stub)', () => {
  const req: CollarLoanRequest = {
    underlying: 'BTC',
    collateralAmount: '0.5',
    capUsd: 150000,
    minLoanUsd: 1,
    expiryTimestamp: 1, // unix epoch + 1s, definitely in the past
  };
  return expectZendfiCode('requestLoan', 'EXPIRY_IN_PAST', () => makeFullModeCollar().requestLoan(req));
});

test('requestLoan throws EXPIRY_TOO_SOON when expiry is within the default offer window', () => {
  const now = Math.floor(Date.now() / 1000);
  const req: CollarLoanRequest = {
    underlying: 'BTC',
    collateralAmount: '0.5',
    capUsd: 150000,
    minLoanUsd: 1,
    expiryTimestamp: now + 60, // <1 hour, no offerEnd override
  };
  return expectZendfiCode('requestLoan', 'EXPIRY_TOO_SOON', () => makeFullModeCollar().requestLoan(req));
});

test('requestLoan throws INVALID_CAP for non-positive capUsd', () => {
  const now = Math.floor(Date.now() / 1000);
  const req: CollarLoanRequest = {
    underlying: 'BTC',
    collateralAmount: '0.5',
    capUsd: 0,
    minLoanUsd: 1,
    expiryTimestamp: now + 7 * 86400,
  };
  return expectZendfiCode('requestLoan', 'INVALID_CAP', () => makeFullModeCollar().requestLoan(req));
});

test('requireNonZeroAddress (via exerciseCollar) throws INVALID_PARAM for zero address', () => {
  return expectZendfiCode('exerciseCollar', 'INVALID_PARAM', () =>
    makeFullModeCollar().exerciseCollar(ZeroAddress),
  );
});

// ---------------------------------------------------------------------------
// 4. Type narrowing — compile-time only. If this stops typechecking, the
//    `isWriteEnabled()` guard has regressed.
// ---------------------------------------------------------------------------

test('isWriteEnabled() narrows to CollarModuleWriteEnabled (compile-time)', () => {
  const client = makeClient();
  if (client.collar.isWriteEnabled()) {
    // Inside the guard, `client.collar` is typed as `CollarModuleWriteEnabled`.
    // We assign to the narrowed interface explicitly to assert the narrowing,
    // then never call into the network — pricing-only mode short-circuits
    // before this branch is reachable at runtime.
    const writeEnabled: CollarModuleWriteEnabled = client.collar;
    void writeEnabled.requestLoan;
    void writeEnabled.cancelLoan;
    void writeEnabled.acceptOffer;
    void writeEnabled.exerciseCollar;
    void writeEnabled.walkAwayCollar;
  }
  // Runtime side: nothing to assert — the branch is unreachable on Base
  // mainnet, and that *is* the test (pricing-only stays pricing-only).
  assert(client.collar.isWriteEnabled() === false, 'sanity: still pricing-only at runtime');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runAll(): Promise<void> {
  await Promise.all(asyncQueue);

  const failed = results.filter((r) => !r.passed);
  for (const r of results) {
    if (r.passed) console.log(`  [PASS] ${r.name}`);
    else console.log(`  [FAIL] ${r.name}: ${r.violation ?? '(no message)'}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

void runAll();
