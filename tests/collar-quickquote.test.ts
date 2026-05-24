#!/usr/bin/env npx tsx
/**
 * W4 unit tests for `client.collar.quickQuote()` — the one-call helper.
 *
 * Covers (TNU-25 acceptance criteria):
 *  - Happy path returns a populated `CollarEstimate` (never null).
 *  - Missing `underlying_price` throws `ZendfiError` with code `'PRICING_UNAVAILABLE'`.
 *  - No matching OTM put (no call leg at cap, fallback also fails) throws
 *    `ZendfiError` with code `'NO_MATCHING_STRIKE'` and a non-empty
 *    `availableStrikes` meta when puts exist for the expiry.
 *  - `quickQuote` delegates to `estimateCollar` without mutating it; calling
 *    `estimateCollar` directly with the same inputs returns an equivalent estimate.
 *
 * The Deribit fetch is stubbed by overriding `client.loan.fetchPricing` — no
 * network, no signer, no RPC. The provider is a JsonRpcProvider pointed at a
 * sentinel that is never dialed.
 *
 * Run: npx tsx tests/collar-quickquote.test.ts
 */

import { JsonRpcProvider } from 'ethers';
import { ThetanutsClient } from '../src/client/ThetanutsClient.js';
import { ZendfiError, isZendfiError } from '../src/types/zendfi-errors.js';
import type { DeribitPricingMap } from '../src/types/loan.js';

// ---------------------------------------------------------------------------
// Harness — matches tests/collar-capability.test.ts (no test framework).
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  violation?: string;
}

const results: TestResult[] = [];
const asyncQueue: Array<Promise<void>> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fixture — Base mainnet client with a sentinel provider. We stub
// `client.loan.fetchPricing` so no network call is made.
// ---------------------------------------------------------------------------

const BASE_CHAIN_ID = 8453;
const SENTINEL_PROVIDER = new JsonRpcProvider('http://127.0.0.1:1');

const EXPIRY = '26DEC25';
const SPOT_BTC = 95000;

/**
 * Build a minimal BTC pricing slot with:
 *  - one call leg at 150_000 (cap),
 *  - three OTM put strikes at 80_000 / 85_000 / 90_000.
 * Call premium > target_put_premium, so the primary path picks the highest
 * put strike whose ask ≤ target. Default mmMarginPct = 5% (see chains/collar.ts).
 */
function makePricing(opts?: {
  withUnderlyingPrice?: boolean;
  withCallLeg?: boolean;
  withPuts?: boolean;
}): DeribitPricingMap {
  const withSpot = opts?.withUnderlyingPrice ?? true;
  const withCall = opts?.withCallLeg ?? true;
  const withPuts = opts?.withPuts ?? true;
  const slot: Record<string, { underlying_price: number; ask_price: number; bid_price?: number; mark_price: number }> = {};

  if (withCall) {
    // Call leg: 0.040 BTC bid, 0.045 mark.
    slot[`BTC-${EXPIRY}-150000-C`] = {
      underlying_price: withSpot ? SPOT_BTC : 0,
      ask_price: 0.05,
      bid_price: 0.04,
      mark_price: 0.045,
    };
  }
  if (withPuts) {
    // Puts priced so that with 5% margin the *target* = 0.04 * 0.95 = 0.038.
    // 90_000 ask 0.039 → just above target (skipped on primary pass).
    // 85_000 ask 0.030 → under target, picked.
    // 80_000 ask 0.020 → cheaper but lower strike, primary pass prefers 85_000.
    slot[`BTC-${EXPIRY}-90000-P`] = {
      underlying_price: withSpot ? SPOT_BTC : 0,
      ask_price: 0.039,
      mark_price: 0.039,
    };
    slot[`BTC-${EXPIRY}-85000-P`] = {
      underlying_price: withSpot ? SPOT_BTC : 0,
      ask_price: 0.03,
      mark_price: 0.03,
    };
    slot[`BTC-${EXPIRY}-80000-P`] = {
      underlying_price: withSpot ? SPOT_BTC : 0,
      ask_price: 0.02,
      mark_price: 0.02,
    };
  }

  return { BTC: slot };
}

interface FetchPricingHost {
  fetchPricing: () => Promise<DeribitPricingMap>;
}

function makeClientWithPricing(pricing: DeribitPricingMap): ThetanutsClient {
  const client = new ThetanutsClient({ chainId: BASE_CHAIN_ID, provider: SENTINEL_PROVIDER });
  (client.loan as unknown as FetchPricingHost).fetchPricing = async () => pricing;
  return client;
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test('quickQuote happy path returns a populated CollarEstimate', async () => {
  const client = makeClientWithPricing(makePricing());
  const est = await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);

  assert(est !== null && est !== undefined, 'estimate must be non-null');
  assert(est.putStrike === 85000, `expected K_lo=85000, got ${est.putStrike}`);
  assert(est.loanUsd === 85000 * 0.5, `expected loanUsd=42500, got ${est.loanUsd}`);
  assert(est.triggerUsd === 85000, `expected triggerUsd=85000, got ${est.triggerUsd}`);
  assert(est.capPayoutUsd === (150000 - 85000) * 0.5, `expected capPayoutUsd=32500, got ${est.capPayoutUsd}`);
  assert(est.callBtc === 0.04, `expected callBtc=0.04, got ${est.callBtc}`);
  assert(est.putBtc === 0.03, `expected putBtc=0.03, got ${est.putBtc}`);
});

test('quickQuote agrees with estimateCollar on identical inputs', async () => {
  const pricing = makePricing();
  const client = makeClientWithPricing(pricing);
  const quick = await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);
  const direct = client.collar.estimateCollar({
    underlying: 'BTC',
    collateralAmount: 0.5,
    capUsd: 150000,
    expiryLabel: EXPIRY,
    pricingData: pricing,
    underlyingPrice: SPOT_BTC,
  });
  assert(direct !== null, 'direct estimateCollar must not be null for this fixture');
  assert(
    JSON.stringify(quick) === JSON.stringify(direct),
    `quickQuote and estimateCollar must produce the same estimate (quick=${JSON.stringify(quick)}, direct=${JSON.stringify(direct)})`,
  );
});

test('quickQuote honors options.mmMarginPct override', async () => {
  // With 50% margin: target = 0.04 * 0.5 = 0.020. Only the 80_000 put fits.
  const client = makeClientWithPricing(makePricing());
  const est = await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY, { mmMarginPct: 50 });
  assert(est.putStrike === 80000, `expected K_lo=80000 with 50% margin, got ${est.putStrike}`);
});

// ---------------------------------------------------------------------------
// 2. PRICING_UNAVAILABLE
// ---------------------------------------------------------------------------

test('quickQuote throws PRICING_UNAVAILABLE when underlying_price is missing', async () => {
  const client = makeClientWithPricing(makePricing({ withUnderlyingPrice: false }));
  try {
    await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);
    throw new Error('expected quickQuote to throw, but it resolved');
  } catch (err) {
    assert(isZendfiError(err), `expected ZendfiError, got ${String(err)}`);
    const zerr = err as ZendfiError;
    assert(zerr.code === 'PRICING_UNAVAILABLE', `expected code PRICING_UNAVAILABLE, got ${zerr.code}`);
    assert(
      (zerr.meta as { asset?: string } | undefined)?.asset === 'BTC',
      `expected meta.asset === 'BTC', got ${String((zerr.meta as { asset?: string } | undefined)?.asset)}`,
    );
  }
});

test('quickQuote throws PRICING_UNAVAILABLE when the BTC slot is entirely empty', async () => {
  const client = makeClientWithPricing({ BTC: {} });
  try {
    await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);
    throw new Error('expected quickQuote to throw, but it resolved');
  } catch (err) {
    assert(isZendfiError(err), `expected ZendfiError, got ${String(err)}`);
    assert(
      (err as ZendfiError).code === 'PRICING_UNAVAILABLE',
      `expected code PRICING_UNAVAILABLE, got ${(err as ZendfiError).code}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. NO_MATCHING_STRIKE
// ---------------------------------------------------------------------------

test('quickQuote throws NO_MATCHING_STRIKE when the call leg at cap is missing', async () => {
  // No 150000-C, so estimateCollar returns null at the call lookup. But
  // there's still spot pricing on the put legs, so extractUnderlyingPrice
  // succeeds via the put rows.
  const client = makeClientWithPricing(makePricing({ withCallLeg: false }));
  try {
    await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);
    throw new Error('expected quickQuote to throw, but it resolved');
  } catch (err) {
    assert(isZendfiError(err), `expected ZendfiError, got ${String(err)}`);
    const zerr = err as ZendfiError;
    assert(zerr.code === 'NO_MATCHING_STRIKE', `expected code NO_MATCHING_STRIKE, got ${zerr.code}`);
    const meta = zerr.meta as
      | { capUsd?: number; availableStrikes?: readonly number[]; underlying?: string; expiryLabel?: string }
      | undefined;
    assert(meta?.capUsd === 150000, `expected meta.capUsd=150000, got ${String(meta?.capUsd)}`);
    assert(meta?.underlying === 'BTC', `expected meta.underlying='BTC', got ${String(meta?.underlying)}`);
    assert(meta?.expiryLabel === EXPIRY, `expected meta.expiryLabel='${EXPIRY}', got ${String(meta?.expiryLabel)}`);
    const strikes = meta?.availableStrikes ?? [];
    assert(strikes.length === 3, `expected 3 OTM put strikes, got ${strikes.length}`);
    // Sorted descending (closest to spot first).
    assert(
      strikes[0] === 90000 && strikes[1] === 85000 && strikes[2] === 80000,
      `expected [90000,85000,80000], got [${strikes.join(',')}]`,
    );
  }
});

test('quickQuote throws NO_MATCHING_STRIKE with empty availableStrikes when no puts exist', async () => {
  // No put legs at all — even the cheapest-put fallback fails. The call leg
  // is still present, so extractUnderlyingPrice can read spot from it.
  const client = makeClientWithPricing(makePricing({ withPuts: false }));
  try {
    await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);
    throw new Error('expected quickQuote to throw, but it resolved');
  } catch (err) {
    assert(isZendfiError(err), `expected ZendfiError, got ${String(err)}`);
    const zerr = err as ZendfiError;
    assert(zerr.code === 'NO_MATCHING_STRIKE', `expected code NO_MATCHING_STRIKE, got ${zerr.code}`);
    const strikes = (zerr.meta as { availableStrikes?: readonly number[] } | undefined)?.availableStrikes ?? [];
    assert(strikes.length === 0, `expected empty availableStrikes, got [${strikes.join(',')}]`);
  }
});

// ---------------------------------------------------------------------------
// 4. Never returns null — the type contract is `Promise<CollarEstimate>`.
// ---------------------------------------------------------------------------

test('quickQuote return type is non-null (compile-time)', async () => {
  const client = makeClientWithPricing(makePricing());
  const est = await client.collar.quickQuote('BTC', 0.5, 150000, EXPIRY);
  // If quickQuote ever returns null at runtime, the cast below survives but
  // the field reads will throw NPE — we assert directly to catch that path.
  assert(typeof est.loanUsd === 'number', 'estimate.loanUsd must be present and numeric');
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
