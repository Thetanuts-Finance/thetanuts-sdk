# Pricing-only mode

The collar module ships ahead of the `CollarLoanCoordinator` (collar-v12) deploy. On chains where the contracts are not yet populated, `client.collar` operates in **pricing-only mode**:

- Read-only / Deribit-pricing methods (`quickQuote`, `estimateCollar`, `filterCapStrikes`, `getCapStrikeOptions`, `fetchPricing`, `extractUnderlyingPrice`, `getMaxCapStrike`) work today.
- Write methods (`requestLoan`, `cancelLoan`, `acceptOffer`, `exerciseCollar`, `walkAwayCollar`) and the on-chain `getLoanRequest` throw a typed [`ZendfiError<'PRICING_ONLY_MODE'>`](./errors.md#pricing_only_mode) until the contract addresses are populated.

This page is for integrators who want to ship a UI today and have it light up automatically once the contracts deploy.

## Inspect capability

```typescript
const cap = client.collar.capability();
console.log(cap);
// → { mode: 'pricing-only', chainId: 8453, missingContracts: ['collarCoordinator', ...] }
```

The `missingContracts` array is a sorted, deduplicated list of `COLLAR_CONFIG.contracts` keys that are still zero placeholders. It's empty (and absent on the return type) when `mode === 'full'`.

## Compile-time narrowing

```typescript
if (client.collar.isWriteEnabled()) {
  // TypeScript narrows `client.collar` to `CollarModuleWriteEnabled`
  // here — write methods are typed as definitely-callable.
  const { quotationId } = await client.collar.requestLoan(req);
} else {
  // Pricing methods still work — render a quote-only UI.
  const est = await client.collar.quickQuote('BTC', 0.5, 150000, '26DEC25');
  renderQuoteOnly(est);
}
```

`isWriteEnabled()` is a TypeScript type guard, so write methods are visible on the narrowed type without `!` non-null assertions.

The affirmative form is `isPricingOnly()` — equivalent to `!isWriteEnabled()` but reads better when you want to branch on the negative case.

## Migration from the deprecated `isDeployed()`

`isDeployed()` is kept as a back-compat shim — it still returns the same boolean (`true` when collar-v12 is deployed). New code should prefer `isWriteEnabled()` (which also narrows the type) or `capability()` (which surfaces `missingContracts`).

```typescript
// before (still works)
if (client.collar.isDeployed()) await client.collar.requestLoan(req);

// after
if (client.collar.isWriteEnabled()) await client.collar.requestLoan(req);
```

## Handling `PRICING_ONLY_MODE` errors

If a call site can't be gated by `isWriteEnabled()`, catch the error and recover:

```typescript
import { isZendfiError } from '@thetanuts-finance/thetanuts-client';

try {
  await client.collar.requestLoan(req);
} catch (err) {
  if (isZendfiError(err) && err.code === 'PRICING_ONLY_MODE') {
    showBanner(err.humanMessage, err.actionable);
    return;
  }
  throw err;
}
```

The `meta` payload on these errors includes the failing `operation` name so error UI can render context.

## What flips the mode

Every collar contract slot in `COLLAR_CONFIG.contracts` must be a non-zero address for `capability()` to return `mode: 'full'`. Slots that are still placeholders show up in `missingContracts`. Once any slot is populated by a config update on `beta`, the mode flips automatically — no code changes required at integrator call sites.

## What about the loan module?

`client.loan` does not have a pricing-only mode — the loan contracts are already live on Base. If you need to feature-flag the loan flow at the integrator layer (e.g. behind a regional gate), do so in your own app code; the SDK won't throw `PRICING_ONLY_MODE` for any `client.loan` method.
