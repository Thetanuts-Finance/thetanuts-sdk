# Migration Guide

Upgrade guide for existing users moving to the latest SDK patterns and APIs.

## Table of Contents

- [Migrating to v0.3.0](#migrating-to-v030)
- [Migrating to v0.2.1 (Base_r12 deployment)](#migrating-to-v021-base_r12-deployment)
- [Breaking Changes](#breaking-changes)
- [New Helper Methods](#new-helper-methods)
- [Code Migration Examples](#code-migration-examples)
- [Deprecation Notices](#deprecation-notices)
- [Indexer Migration Notes](#indexer-migration-notes)

---

## Migrating to v0.3.0

**No breaking changes** — 0.3.0 is additive over 0.2.x. Upgrade with a plain `npm install @thetanuts-finance/thetanuts-client@^0.3.0`. One heads-up between the 0.2.x patches: v0.2.3 renamed two `strategyVault` symbols (see [Changelog](changelog.md)) — if you're jumping from ≤0.2.2, apply that find-and-replace.

What you gain:

- **RFQ sealed-bid agent helpers** — `optionFactory.buildOfferTypedData()`, `api.getRequesterPublicKey()`, `api.getOffer()`. Required by [`@thetanuts-finance/agentkit`](../guides/agentkit.md) (its peer range is `>=0.3.0`).
- **Off-chain multi-leg payout/collateral math** — `client.utils.calculatePayout()` / `calculateCollateral()` for flies, condors, iron condors, and rangers (previously `INVALID_PARAMS`).
- **Hardened write paths** — pre-write network assertions and stricter swap-parameter validation. Code that previously passed malformed swap params to `swapAndFillOrder` / `marketFill` now fails fast with `INVALID_PARAMS` instead of reverting on-chain.

## Migrating to v0.2.1 (Base_r12 deployment)

v0.2.1 is the first 0.2.x release published to npm. It bundles the Base_r12 deployment cutover with 22 fixes that three adversarial code-review passes found in the staged surface. v0.2.0 was prepared internally but never published — there is no v0.2.0 on npm.

### Pin to the deployment you want

- `@thetanuts-finance/thetanuts-client@^0.1.x` — prior Base deployment (immutable on npm; use only if you need to keep talking to the old contracts).
- `@thetanuts-finance/thetanuts-client@^0.2.1` — Base_r12 deployment (recommended).

### Breaking changes from 0.1.x → 0.2.1

- **`client.events.getCollateralReturnedEvents` was renamed to `getExcessCollateralReturnedEvents`** with a new field shape:

  ```typescript
  // ❌ OLD (0.1.x):
  const events = await client.events.getCollateralReturnedEvents(option);
  // events[i] had { optionAddress, seller, amountReturned }

  // ✅ NEW (0.2.1):
  const events = await client.events.getExcessCollateralReturnedEvents(option);
  // events[i] has { seller, collateralToken, collateralReturned }
  ```

- **`OptionSplitEvent` gained two fields.** If you were destructuring, add `feePaid` and `counterparty`:

  ```typescript
  // ❌ OLD: { newOption, collateralAmount }
  // ✅ NEW: { newOption, collateralAmount, feePaid, counterparty }
  ```

- **`TransferApprovalEvent` field order is fixed** to match r12: `{ target, from, isBuyer, isApproved }`. The 0.1.x SDK had `target` and `from` swapped in the typed wrapper for `RangerOption` events specifically.

- **`OptionSettlementFailedEvent` no longer has fields** at the contract level. The SDK still populates `optionAddress` from the filter context for caller convenience.

- **Butterfly reverse-lookup names reconciled.** `getOptionImplementationInfo(addr).name` returns `'CALL_FLY'` / `'PUT_FLY'` instead of `'CALL_FLYS'` / `'PUT_FLYS'`. The `ProductName` union in `client.utils` follows.

- **`RangerModule.reclaimCollateral` parameter renamed** from `recipient` to `ownedOption`. Positional callers unaffected; named callers using a TypeScript object-shape break.

- **`LoanRequest.keepOrderOpen` is now a no-op.** The r12 contract dropped the limit-order conversion field. The SDK still accepts the field for source compatibility but the value is ignored. The internal `LoanCoordinator.requestLoan` parameter tuple no longer includes `convertToLimitOrder` either; the SDK no longer sends it.

- **`LoanIndexerLoan.convertToLimitOrder` is optional.** The lender-opportunity filter at `client.loan.getLendingOpportunities` only skips when the field is explicitly `false`; missing means eligible. If the r12 indexer drops the field entirely, your lender opportunity list still populates.

### What you should also know about 0.2.1

- New `client.ranger` module — see the [Modules Overview](../reference/modules-overview.md#clientranger--rangermodule).
- `chainConfig.implementations.RANGER`, `LINEAR_CALL`, `INVERSE_CALL_SPREAD`, `CALL_LOAN` are new.
- `chainConfig.twapConsumer` (string | null) surfaces the HistoricalPriceConsumerV3_TWAP address.
- Ethereum mainnet (`chainId 1`) is now supported as a vault-only chain (only `client.wheelVault` works there).
- Every RFQ entry point now rejects the seven undeployed `PHYSICAL_*` placeholder addresses with a clear `INVALID_PARAMS` error.
- `RANGER_OPTION_ABI` is exported from the package root.

---

## Breaking Changes

### collateralAmount Parameter

**The most critical change:** `collateralAmount` must now **always be 0** when creating RFQs.

#### Before (Incorrect Pattern)

```typescript
// ❌ OLD: Calculating and passing collateralAmount
const strike = 1850;
const numContracts = 1.5;
const collateralAmount = BigInt(Math.round(strike * numContracts * 1e6));

const params = {
  // ...
  collateralAmount: collateralAmount,  // WRONG!
  // ...
};
```

#### After (Correct Pattern)

```typescript
// ✅ NEW: collateralAmount is always 0
const params = {
  // ...
  collateralAmount: BigInt(0),  // ALWAYS 0
  // ...
};

// Or use buildRFQParams which enforces this automatically
const params = client.optionFactory.buildRFQParams({
  // ... collateralAmount is set to 0 internally
});
```

#### Why This Changed

Collateral is **NOT** locked at RFQ creation time. It is pulled from both parties at **settlement** time. The `collateralAmount` parameter in RFQ was misleading and should always be 0.

**For SELL positions:** You still need to calculate collateral, but only for **token approval**:

```typescript
// For SELL positions, approve tokens before creating RFQ
const strike = 1850;
const numContracts = 1.5;

// PUT: approval = strike * numContracts
const approval = BigInt(Math.round(strike * numContracts * 1e6));
await client.erc20.approve(USDC, optionFactoryAddress, approval);

// Then create RFQ with collateralAmount = 0
const params = client.optionFactory.buildRFQParams({
  isLong: false,  // SELL
  // ...
});
```

---

## New Helper Methods

### buildRFQParams()

High-level RFQ builder that:
- **Enforces `collateralAmount = 0`** automatically
- Resolves addresses from chain config (no hardcoding)
- Handles decimal conversions

```typescript
// Before: Manual address lookup and decimal handling
const params = {
  requester: userAddress,
  existingOptionAddress: '0x0000000000000000000000000000000000000000',
  collateral: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Hardcoded USDC
  collateralPriceFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',  // Hardcoded
  implementation: '0xF480F636301d50Ed570D026254dC5728b746A90F',  // Hardcoded
  strikes: [BigInt(1850) * BigInt(1e8)],
  numContracts: BigInt(Math.round(1.5 * 1e6)),
  // ... more manual conversions
};

// After: Clean, type-safe builder
const params = client.optionFactory.buildRFQParams({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 1850,           // Human-readable
  numContracts: 1.5,      // Human-readable
  expiry: 1741334400,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
});
```

### buildRFQRequest()

Complete RFQ request builder including tracking and reserve price:

```typescript
const request = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 1850,
  expiry: 1741334400,
  numContracts: 1.5,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
  reservePrice: 0.015,        // Optional: max per-contract price
  requesterPublicKey: '0x...', // ECDH public key
});

const { to, data } = client.optionFactory.encodeRequestForQuotation(request);
```

### strikeToChain() / strikeFromChain()

Precision-safe strike conversion using string-based parsing (avoids floating-point errors):

```typescript
// Before: Potential floating-point issues
const strike = BigInt(Math.round(1850.5 * 1e8));  // May have precision errors

// After: Safe conversion
const strike = client.utils.strikeToChain(1850.5);  // 185050000000n
const display = client.utils.strikeFromChain(185050000000n);  // 1850.5
```

### getFullOptionInfo()

Aggregated option info in a single call (replaces multiple Promise.all patterns):

```typescript
// Before: Multiple individual calls
const [info, buyer, seller, isExpired, isSettled, numContracts, collateralAmount] =
  await Promise.all([
    client.option.getOptionInfo(optionAddress),
    client.option.getBuyer(optionAddress),
    client.option.getSeller(optionAddress),
    client.option.isExpired(optionAddress),
    client.option.isSettled(optionAddress),
    client.option.getNumContracts(optionAddress),
    client.option.getCollateralAmount(optionAddress),
  ]);

// After: Single aggregated call
const fullInfo = await client.option.getFullOptionInfo(optionAddress);
console.log(fullInfo.info);
console.log(fullInfo.buyer);
console.log(fullInfo.seller);
console.log(fullInfo.isExpired);
console.log(fullInfo.isSettled);
console.log(fullInfo.numContracts);
console.log(fullInfo.collateralAmount);
```

### MM Pricing Filter Utilities

New utilities for filtering and sorting pricing data:

```typescript
const all = await client.mmPricing.getAllPricing('ETH');
const values = Object.values(all);

// Filter expired
const active = client.mmPricing.filterExpired(values);

// Sort by expiry then strike
const sorted = client.mmPricing.sortByExpiryAndStrike(values);

// Get unique expiries
const expiries = client.mmPricing.getUniqueExpiries(values);

// Filter by type
const puts = client.mmPricing.filterByType(values, false);

// Filter by expiry
const feb16 = client.mmPricing.filterByExpiry(values, '2025-02-16');

// Filter by strike range
const nearATM = client.mmPricing.filterByStrikeRange(values, 1800, 2200);

// Convenience: sorted, non-expired array
const pricing = await client.mmPricing.getPricingArray('ETH');
```

---

## Code Migration Examples

### Example 1: RFQ Creation for BUY Position

```typescript
// ========== BEFORE ==========
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PUT_IMPL = '0xF480F636301d50Ed570D026254dC5728b746A90F';
const ETH_FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';

const strike = 1850;
const numContracts = 1.5;
const strikeScaled = BigInt(strike) * BigInt(1e8);
const numContractsScaled = BigInt(Math.round(numContracts * 1e6));

const params = {
  requester: userAddress,
  existingOptionAddress: ethers.ZeroAddress,
  collateral: USDC,
  collateralPriceFeed: ETH_FEED,
  implementation: PUT_IMPL,
  strikes: [strikeScaled],
  numContracts: numContractsScaled,
  requesterDeposit: BigInt(0),
  collateralAmount: BigInt(1000000),  // WRONG - was calculated
  expiryTimestamp: BigInt(expiry),
  offerEndTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3600),
  isRequestingLongPosition: true,
  convertToLimitOrder: false,
  extraOptionData: '0x',
};

const { to, data } = client.optionFactory.encodeRequestForQuotation({
  params,
  tracking: { referralId: BigInt(0), eventCode: BigInt(0) },
  reservePrice: BigInt(0),
  requesterPublicKey: publicKey,
});

// ========== AFTER ==========
const request = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 1850,
  numContracts: 1.5,
  expiry: expiry,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
  requesterPublicKey: publicKey,
});

const { to, data } = client.optionFactory.encodeRequestForQuotation(request);
```

### Example 2: RFQ Creation for SELL Position

```typescript
// ========== BEFORE ==========
// Calculate approval manually
const strike = 1850;
const numContracts = 1.5;
const approval = BigInt(Math.round(strike * numContracts * 1e6));

await client.erc20.approve(USDC, optionFactory, approval);

const params = {
  // ... same as BUY but with incorrect collateralAmount
  collateralAmount: approval,  // WRONG!
  isRequestingLongPosition: false,
};

// ========== AFTER ==========
// Step 1: Approve tokens (still required for SELL)
const strike = 1850;
const numContracts = 1.5;
const approval = BigInt(Math.round(strike * numContracts * 1e6));
await client.erc20.approve(
  client.chainConfig.tokens.USDC.address,
  client.optionFactory.contractAddress,
  approval
);

// Step 2: Build RFQ (collateralAmount = 0 enforced automatically)
const request = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 1850,
  numContracts: 1.5,
  expiry: expiry,
  isLong: false,  // SELL
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
  requesterPublicKey: publicKey,
});

const { to, data } = client.optionFactory.encodeRequestForQuotation(request);
```

### Example 3: Option Position Queries

```typescript
// ========== BEFORE ==========
// Multiple separate calls
const buyer = await client.option.getBuyer(optionAddress);
const seller = await client.option.getSeller(optionAddress);
const isExpired = await client.option.isExpired(optionAddress);
const numContracts = await client.option.getNumContracts(optionAddress);

// Or Promise.all pattern
const [buyer, seller, isExpired, numContracts] = await Promise.all([
  client.option.getBuyer(optionAddress),
  client.option.getSeller(optionAddress),
  client.option.isExpired(optionAddress),
  client.option.getNumContracts(optionAddress),
]);

// ========== AFTER ==========
// Single aggregated call
const info = await client.option.getFullOptionInfo(optionAddress);

console.log(info.buyer);
console.log(info.seller);
console.log(info.isExpired);
console.log(info.numContracts);
```

### Example 4: Strike Price Conversion

```typescript
// ========== BEFORE ==========
// Manual conversion with potential precision issues
const strikeNumber = 1850.5;
const strikeOnChain = BigInt(Math.round(strikeNumber * 1e8));

// Parsing back
const strikeDisplay = Number(strikeOnChain) / 1e8;

// ========== AFTER ==========
// Safe string-based conversion
const strikeOnChain = client.utils.strikeToChain(1850.5);
const strikeDisplay = client.utils.strikeFromChain(strikeOnChain);
```

---

## Deprecation Notices

### Deprecated Patterns

| Pattern | Status | Replacement |
|---------|--------|-------------|
| Hardcoded contract addresses | Deprecated | Use `client.chainConfig` |
| Manual `collateralAmount` calculation | Deprecated | Always use `BigInt(0)` or `buildRFQParams()` |
| Multiple Promise.all for option info | Deprecated | Use `getFullOptionInfo()` |
| Manual strike scaling | Deprecated | Use `strikeToChain()` / `strikeFromChain()` |

### API Method Renames

To clarify data sources, some API methods have been renamed:

| Old Method | New Method | Data Source |
|------------|------------|-------------|
| `getUserPositions()` | `getUserPositionsFromIndexer()` | Indexer API |
| `getUserHistory()` | `getUserHistoryFromIndexer()` | Indexer API |
| `getStats()` | `getStatsFromIndexer()` | Indexer API |
| `getUserRFQs()` | `getUserRFQsFromRfq()` | State/RFQ API |
| `getRFQ()` | `getRFQFromRfq()` | State/RFQ API |

The old method names are still available as aliases but may be removed in a future version.

---

## Indexer Migration Notes

> Tested 2026-04-07 against `indexer.thetanuts.finance` (new unified indexer).
> Compared with `optionbook-indexer.thetanuts.finance` (old indexer, to be decommissioned).

### Open Issues

#### Issue 1: Referrer `userDailyMetrics` not implemented

- **Endpoint**: `GET /api/v1/book/referrer/:addr/state`
- **Severity**: Medium
- **Description**: Old indexer returns per-user, per-day trading stats. New indexer returns `{}`.
- **SDK impact**: `ReferrerStats.userDailyMetrics` in `src/types/api.ts` expects this data.

#### Issue 2: Referrer `topProfitableTrades` not implemented

- **Endpoint**: `GET /api/v1/book/referrer/:addr/state`
- **Severity**: Medium
- **Description**: Old indexer returns top 100 trades ranked by % return. New indexer returns `[]`.
- **SDK impact**: `ReferrerStats.topProfitableTrades` in `src/types/api.ts` expects this data.

#### Issue 4: Pagination not working on `/api/v1/factory/rfqs`

- **Endpoint**: `GET /api/v1/factory/rfqs?limit=2&offset=0`
- **Severity**: Low
- **Description**: Pagination params are ignored — all RFQs are returned regardless. No pagination metadata in response.
- **SDK impact**: None currently, but will not scale past ~5k RFQs.

#### Issue 6: Old indexer DNS records still active

- **Severity**: Low
- `optionbook-indexer.thetanuts.finance` still resolves and serves stale data.
- Cleanup pending once migration is fully verified.

### Resolved Issues

| Issue | Resolution |
|-------|------------|
| SDK `ReferrerStats` type missing `summary` field | Fixed — `ReferrerStats` now includes optional `summary?: ReferrerSummary` |
| Daily stats endpoints return empty data | Fixed — `getBookDailyStats()`, `getFactoryDailyStats()`, `getDailyStats()` added |
| Factory referrals missing / empty | Fixed — `StateReferral` type corrected to match actual API response shape |
| Active filter bug — cancelled RFQ appearing in active results | Fixed — SDK now applies client-side re-filtering as a safety net |

### New Endpoints (not yet in SDK)

The following endpoints are live on the new indexer but do not yet have dedicated SDK methods:

| Endpoint | Description |
|----------|-------------|
| `GET /api/v1/book/stats/protocol` | Book protocol stats with time windows and implementation-type breakdowns |
| `GET /api/v1/factory/stats/protocol` | Factory protocol stats including `avgTimeToFill`, `avgOffersPerRfq` |
| `GET /api/v1/stats/protocol` | Combined book + factory protocol stats (merged totals + individual breakdowns) |

### Endpoint Status Summary

| Endpoint | Status |
|----------|--------|
| `/api/v1/book/user/:addr/positions` | Working |
| `/api/v1/book/user/:addr/history` | Working |
| `/api/v1/book/stats` | Working |
| `/api/v1/book/referrer/:addr/state` | Partial (positions + summary; `userDailyMetrics` and `topProfitableTrades` missing) |
| `/api/v1/book/stats/protocol` | Working (new) |
| `/api/v1/book/stats/daily` | Working — SDK: `getBookDailyStats()` |
| `/api/v1/factory/rfqs` | Working (no pagination) |
| `/api/v1/factory/rfqs/:id` | Working |
| `/api/v1/factory/offers` | Working |
| `/api/v1/factory/options` | Working |
| `/api/v1/factory/stats` | Working |
| `/api/v1/factory/user/:addr/rfqs` | Working |
| `/api/v1/factory/user/:addr/offers` | Working |
| `/api/v1/factory/user/:addr/positions` | Working |
| `/api/v1/factory/option/:addr` | Working |
| `/api/v1/factory/stats/protocol` | Working (new) |
| `/api/v1/factory/stats/daily` | Working — SDK: `getFactoryDailyStats()` |
| `/api/v1/book/option/:addr` | Working |
| `/api/v1/book/state` | Working |
| `/api/v1/stats/protocol` | Working (new) |
| `/api/v1/stats/daily` | Working — SDK: `getDailyStats()` |
| `/api/state` | Working |
| `/health` | Working |

---

## See Also

- [Changelog](./changelog.md) - Version history and release notes
- [Examples](./examples.md) - Runnable code examples covering common patterns
- [Error Handling](../guides/error-handling.md) — error codes and recovery patterns
