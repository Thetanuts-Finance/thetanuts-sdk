# Getting started with Zendfi

## What is Zendfi?

Zendfi is the integrator-friendly surface for **non-liquidating, fixed-term loans** built on top of Thetanuts V4 RFQ on Base. Borrowers deposit ETH or BTC as collateral, receive USDC up front, and either repay (and reclaim collateral) or walk away at expiry — there is no margin-call mechanic, no liquidation engine, and no oracle keeper to bribe. The SDK exposes two modules: `client.loan` (single-leg put-collateralised loans, live today) and `client.collar` (two-leg collar with a capped upside, shipping ahead of contract deploy in pricing-only mode).

## Install

```bash
npm i @thetanuts-finance/thetanuts-client ethers
```

## Boot a client

```typescript
// hooks/useThetanutsClient.ts — matches examples/zendfi-quickstart
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

export function useThetanutsClient(signer?: ethers.Signer) {
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  return new ThetanutsClient({
    chainId: 8453, // Base mainnet
    provider,
    signer,
  });
}
```

A provider-only client can read pricing, indexer state, and on-chain reads. Pass a signer when you want to call `requestLoan` / `acceptOffer` / `cancelLoan` / `exerciseOption`.

## Get a quote (collar one-call path)

```typescript
const est = await client.collar.quickQuote('BTC', 0.5, 150000, '26DEC25');
console.log(`Loan: $${est.loanUsd}, default trigger: $${est.triggerUsd}`);
```

`quickQuote` hides `fetchPricing` / `extractUnderlyingPrice` / `estimateCollar`. Power users who want to share a pricing snapshot across multiple quotes should keep calling `estimateCollar` directly.

## Show a cap-strike picker

```typescript
const groups = await client.collar.getCapStrikeOptions('BTC', {
  ...client.collar.defaultSettings,
  collateralAmount: 0.5,
});

for (const g of groups) {
  console.log(g.expiryLabel);
  for (const row of g.caps) {
    console.log(`  cap $${row.cap} → trigger $${row.estimate.triggerUsd}`);
  }
}
```

For the put-only (loan-module) flow, use `client.loan.getStrikeOptions('ETH')` and `client.loan.calculateLoan({ ... })` to fan out by strike and expiry.

## Submit a loan request

```typescript
// Gate the write surface on the runtime capability — see pricing-only-mode.md.
if (client.collar.isWriteEnabled()) {
  const keys = await client.rfqKeys.getOrCreateKeyPair();
  const { quotationId, txHash } = await client.collar.requestLoan({
    underlying: 'BTC',
    collateralAmount: '0.5',
    capUsd: 150000,
    minLoanUsd: 40000,
    expiryTimestamp: 1780041600,
    requesterPublicKey: keys.compressedPublicKey,
  });
  console.log(`quotation ${quotationId} submitted in tx ${txHash}`);
} else {
  showBanner('Collar contracts not yet live on this chain — pricing only.');
}
```

The single-leg loan path is symmetric: `client.loan.requestLoan({ underlying, collateralAmount, strike, expiryTimestamp, minSettlementAmount })`.

## Accept an offer

When a market maker returns a sealed-bid offer, decrypt it with the keypair you used at request time, then settle on-chain:

```typescript
const decrypted = await client.rfqKeys.decryptOffer(encrypted, keys.signingKey);
await client.loan.acceptOffer(quotationId, decrypted.offerAmount, decrypted.nonce, offerorAddr);
```

The collar path mirrors this: `client.collar.acceptOffer(qid, amount, nonce, offeror)` returns a `ContractTransactionResponse`; `await tx.wait()` for the receipt.

## Cancel a pending loan

```typescript
await client.loan.cancelLoan(quotationId);     // or: client.collar.cancelLoan(...)
```

Only valid while the quotation is still open. After settlement, use the option-contract methods instead.

## Repay and exercise

At expiry, repay the borrowed USDC and reclaim collateral:

```typescript
await client.loan.exerciseOption(optionAddress);     // single-leg loan
await client.collar.exerciseCollar(optionAddress);   // collar
```

Or skip the repayment and forfeit the collateral:

```typescript
await client.loan.doNotExercise(optionAddress);
await client.collar.walkAwayCollar(optionAddress);
```

## Swap-and-exercise

If you don't already hold the repayment USDC, route the exercise through a DEX aggregator (KyberSwap, 1inch, etc.) in one tx:

```typescript
const quote = await aggregator.fetchQuote({ from: 'WETH', to: 'USDC', amount });
await client.loan.swapAndExercise(optionAddress, quote.router, quote.calldata);
```

## Split an option

Peel a portion of a loan option's collateral off into a new child option — useful for partial exercise:

```typescript
await client.loan.splitOption(optionAddress, ethers.parseEther('0.4'));
```

## Reclaim after walk-away

After an option settles with `doNotExercise`, reclaim residual collateral via the option's reclaim path:

```typescript
await client.loan.reclaimCollateral(routingOption, ownedOption);
```

## Provide liquidity (lend)

Fill a borrower's open loan request by providing USDC. Approve once, then fill:

```typescript
const opps = await client.loan.getLendingOpportunities({ underlying: 'ETH' });
const top = opps[0]!;
await client.erc20.ensureAllowance(USDC, client.chainConfig.contracts.optionFactory, top.lendAmount);
await client.loan.lend(BigInt(top.quotationId));
```

Each row pre-computes APR and human-formatted strings so you can render directly without re-deriving the math.

## Common errors and how to handle them

Every recoverable error in the Zendfi surface is a typed `ZendfiError` with a stable `code`, a `humanMessage` you can render directly, an `actionable` recovery hint, and a `docsUrl` pointer:

```typescript
import { isZendfiError } from '@thetanuts-finance/thetanuts-client';

try {
  await client.collar.requestLoan(req);
} catch (err) {
  if (isZendfiError(err)) {
    switch (err.code) {
      case 'PRICING_ONLY_MODE':
        showBanner(err.humanMessage, err.actionable);
        break;
      case 'NO_MATCHING_STRIKE':
        // err.meta.availableStrikes lists nearby OTM put strikes
        suggestCap(err.meta?.availableStrikes as number[] | undefined);
        break;
      case 'INSUFFICIENT_COLLATERAL':
      case 'INSUFFICIENT_ALLOWANCE':
      case 'INSUFFICIENT_BALANCE':
        showTopUpFlow(err.actionable);
        break;
      default:
        showGenericError(err.humanMessage);
    }
  } else {
    throw err;
  }
}
```

See [errors.md](./errors.md) for the full code list and recovery snippets.

## Where to go next

- [`examples/zendfi-quickstart`](../../examples/zendfi-quickstart) — a minimal Next.js app exercising `borrow` and `lend` flows end-to-end.
- [`docs/zendfi/api-reference.md`](./api-reference.md) — every public method on `client.loan` and `client.collar`, with `@param`, `@returns`, and `@throws` pulled from JSDoc.
- [`docs/zendfi/errors.md`](./errors.md) — one section per `ZendfiErrorCode` with recovery snippets.
- [`docs/zendfi/pricing-only-mode.md`](./pricing-only-mode.md) — how the collar module behaves on chains where the v12 contracts aren't deployed yet.
