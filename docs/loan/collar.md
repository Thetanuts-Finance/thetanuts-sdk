# Collar loans (`client.collar`)

Collar loans are a **zero-interest, capped-upside** variant of the standard physically-settled call loan. The borrower buys a put at `K_lo` (default trigger) and sells a call at `K_hi` (cap); the lender funds an up-front USDC loan from the call premium it earns.

> **Status:** the `CollarLoanCoordinator` contract is not yet deployed on Base mainnet (placeholder addresses in `src/chains/collar.ts`). Pricing math (`estimateCollar`, `getCapStrikeOptions`, `filterCapStrikes`) works today against live Deribit data; write methods (`requestLoan`, `cancelLoan`, `acceptOffer`) throw `NETWORK_UNSUPPORTED` until the addresses are populated.

## Terminal payoff

At expiry (TWAP `S`):

| Region | Borrower outcome |
| --- | --- |
| `S < K_lo` | Walk: keep `L` USDC, lose collateral `N` |
| `K_lo ≤ S ≤ K_hi` | Repay `L` USDC, recover `N` |
| `S > K_hi` | Cap settlement: receive `N · (K_hi − K_lo)` USDC, lose `N` |

## Pricing model (frontend estimate)

```
target_put_premium = call_premium × (1 − mm_margin)
K_lo               = highest OTM put strike whose ask ≤ target_put_premium
L                  = K_lo · N
cap_payout         = (K_hi − K_lo) · N
```

`mm_margin` defaults to 4% and is tunable per call. When the call premium is too small to fund any OTM put, the estimator falls back to the cheapest available put strike so the row still surfaces.

## Shared infrastructure (do not re-implement)

`CollarModule` deliberately reuses the loan module's plumbing instead of duplicating it:

- **`client.collar.fetchPricing()` delegates to `client.loan.fetchPricing()`.** The 30-second pricing cache is shared between both modules — calling either one populates the same cached map. Don't add a second cache.
- **Expiry parsing lives in `utils/expiry.ts`.** Use `parseDeribitExpiry(label)` (returns `number | null`) or `parseDeribitExpiryOrThrow(label)`. Same for `formatDeribitExpiry`. Both `LoanModule` and `CollarModule` import from there.
- **`DeribitPricingMap` and `DeribitOptionData` types live in `types/loan.ts`.** The collar leg uses the optional `bid_price` field; the put leg ignores it.

## Examples

```ts
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({ chainId: 8453, provider, signer });

// 1. Read pricing math without any on-chain calls
const pricingData = await client.collar.fetchPricing();   // uses shared cache
const spot = client.collar.extractUnderlyingPrice(pricingData, 'BTC');

const est = client.collar.estimateCollar({
  underlying: 'BTC',
  collateralAmount: 0.5,
  capUsd: 150_000,
  expiryLabel: '26DEC25',
  pricingData,
  underlyingPrice: spot,
});
// est = { loanUsd, triggerUsd, capPayoutUsd, callBtc, putBtc, putStrike } | null

// 2. Build a UI strike picker
const groups = await client.collar.getCapStrikeOptions('BTC', {
  ...client.collar.defaultSettings,
  collateralAmount: 0.5,
});
// groups[].caps[].estimate carries the per-row loanUsd, triggerUsd, capPayoutUsd

// 3. Post an auction (requires deployed coordinator + signer)
if (client.collar.isDeployed()) {
  const { quotationId, txHash } = await client.collar.requestLoan({
    underlying: 'BTC',
    collateralAmount: '0.5',
    capUsd: 150_000,
    minLoanUsd: 65_000,
    expiryTimestamp: 1798934400,
    requesterPublicKey: await client.rfqKeys.getOrCreateKeyPair().then(k => k.publicKey),
  });
}
```

## Default settings (asset-aware)

```ts
client.collar.defaultSettings
// {
//   minDurationDays: 30,
//   minCapStrikeUsd: 0,        // 0 disables — set per asset, see note
//   minCapGapPct: 20,
//   maxStrikesPerExpiry: 6,
//   mmMarginPct: 4,
//   reserveFloorPct: 90,
// }
```

`minCapStrikeUsd` defaults to `0` (disabled) because a single dollar floor can't fit both BTC (spot ~$90k) and ETH (~$2k). Set a per-asset floor at call time if your UI needs one (e.g. BTC=$100k, ETH=$3k).

## Smoke tests

```bash
# Offline (synthetic Deribit fixture)
npx tsx scripts/test-collar-module.ts

# + live Deribit fetch (verifies BTC and ETH paths against real data)
npx tsx scripts/test-collar-module.ts --live
```

26 assertions cover capability gating, math correctness, null guards, dedup behavior, the asset-aware default, and the shared cache identity between `collar.fetchPricing` and `loan.fetchPricing`.

## Reference

The contract layout mirrors the existing `LoanModule` — a coordinator wraps Thetanuts V4 RFQ auctions and instantiates a `CollaredCallOption` proxy on settle. See `src/abis/collar.ts` for the coordinator ABI and `CollaredCallOption` exercise surface.

> Note: the ABIs in `src/abis/collar.ts` are a best-effort port of the `collar.html` reference at `https://thetanuts.finance/dev/zendfi_v1/collar.html` (which itself uses zero placeholder addresses) plus extrapolation from `LOAN_OPTION_ABI` for the option exercise surface. They are not verified against a deployed contract yet — replace with the live contract ABIs when collar-v12 ships.
