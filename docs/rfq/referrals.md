# RFQ Referrals

Earn a share of RFQ fees by registering a referral and routing requests through it. The OptionFactory referral system is **separate** from the OptionBook referral flow — different mechanics, different claim path.

> **Quick distinction:** OptionBook referrals use a per-address whitelist set by the protocol owner, and you claim your fees yourself. RFQ referrals use a self-service `referralId` you mint via `registerReferral`, and only the protocol owner can withdraw the accrued fees. If you want self-claim, see the [OptionBook Referrer Fees](../optionbook/referrer-fees.md) guide instead.

## How RFQ referrals work

1. You call `registerReferral(QuotationParameters)` to mint a fresh `referralId`. The contract sets `referralOwner[id] = your address` and assigns the next available numeric ID.
2. To use the referral on a real RFQ, pass `tracking.referralId = id` when calling `requestForQuotation(...)`. Fees on settled quotations accrue to that ID.
3. You monitor accrual via `getReferralFees(id)` and ownership via `getReferralOwner(id)` — both are public views.
4. When the protocol owner runs `withdrawFees(token, [ids…])`, fees from your referralId are paid out. **Third parties cannot call `withdrawFees`** — the contract reverts. Coordinate with Thetanuts on the withdrawal cadence.

## Differences vs OptionBook referrals

| | OptionBook | OptionFactory (RFQ) |
|---|---|---|
| **Whitelist** | Owner-only `setReferrerFeeSplit(addr, bps)` | None — `registerReferral` is self-service |
| **Identifier** | Your address | A `referralId` (uint256) the contract assigns |
| **Refer a trade** | Pass `referrer` to `fillOrder` | Pass `tracking.referralId` to `requestForQuotation` |
| **Track accrual** | `getAllClaimableFees(addr)` | `getReferralFees(id)` |
| **Claim** | **You** call `claimFees(token)` / `claimAllFees()` | **Owner** calls `withdrawFees(token, [ids])` — third parties revert |
| **SDK module** | `client.optionBook` | `client.optionFactory` |

## Registering a referral

`registerReferral` takes the same `QuotationParameters` shape as `requestForQuotation` (see [Create an RFQ](./create-rfq.md)) and returns a transaction receipt. The contract emits a `ReferralRegistered(referralId, referrer)` event from which you read your new ID.

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });

const chainConfig = client.chainConfig;

const receipt = await client.optionFactory.registerReferral({
  requester: await signer.getAddress(),
  existingOptionAddress: '0x0000000000000000000000000000000000000000',
  collateral: chainConfig.tokens.USDC.address,
  collateralPriceFeed: chainConfig.priceFeeds.ETH,
  implementation: chainConfig.implementations.PUT,
  strikes: [BigInt(2000) * BigInt(1e8)],
  numContracts: BigInt(10) * BigInt(1e6),
  requesterDeposit: BigInt(0),
  collateralAmount: BigInt(0),  // ALWAYS 0
  expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
  offerEndTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
  isRequestingLongPosition: true,
  convertToLimitOrder: false,
  extraOptionData: '0x',
});

// Pull the new referralId from the ReferralRegistered event in the receipt logs.
// Or, simpler: query the on-chain quotationCount before vs after to derive it.
```

> **Zero-address guard (v0.2.1+):** if `params.implementation` resolves to `0x000…000`, the SDK throws `INVALID_PARAMS` before the transaction is built. The seven `PHYSICAL_*_SPREAD/FLY/CONDOR/IRON_CONDOR` slots are placeholders in r12. See the [v0.2.1 GitHub Release](https://github.com/Thetanuts-Finance/thetanuts-sdk/releases/tag/v0.2.1) for the safety-upgrade details.

### Reading the new referralId

The cleanest path is parsing the `ReferralRegistered` event from `receipt.logs` using the OptionFactory ABI. The event signature lives in the package — `import { OPTION_FACTORY_ABI } from '@thetanuts-finance/thetanuts-client'`. If you'd rather not parse logs, the contract assigns IDs sequentially, so a "before/after" read of the on-chain referral counter works as a fallback.

## Using a referralId on an RFQ

Once you have an ID, attach it to any `requestForQuotation` call via `tracking.referralId`:

```typescript
await client.optionFactory.requestForQuotation({
  params: { /* the QuotationParameters for the option */ },
  tracking: {
    referralId: 42n,    // your registered referralId
    eventCode: 0n,
  },
  reservePrice: 0n,
  requesterPublicKey,
});
```

For the full `requestForQuotation` walkthrough, see [Create an RFQ](./create-rfq.md). The placeholder `referralId: BigInt(0)` shown there is the "no referral" value — replace it with your real ID to route fees to your accrual bucket.

## Reading referral state

One on-chain view, available without a signer:

```typescript
// What's accrued?
const fees = await client.optionFactory.getReferralFees(42n);
// returns bigint — accumulated fees for this referralId, in collateral token units
```

> The previous `getReferralOwner` helper was removed in the v4 r12 audit pass — the
> matching `referralOwner` view does not exist on the deployed OptionFactory. To
> resolve a referralId back to its owner, listen for `ReferralRegistered` events
> or use the indexer (`client.api.getFactoryReferrerStats()`).

For richer aggregated stats (volume, fee breakdowns, daily metrics) the off-chain indexer exposes `client.api.getFactoryReferrerStats()` — see the [Examples](../resources/examples.md) page for the indexer flow.

## Claiming fees (owner-only)

> **Important.** `withdrawFees(token, ids[])` requires the OptionFactory contract owner. Calls from any other address revert. As a third-party referrer, you **cannot self-claim** RFQ fees. Track accrual via `getReferralFees(id)` and coordinate the actual payout with Thetanuts.

The owner-side method signature is the same on the SDK:

```typescript
// Owner only — non-owner calls revert at the contract level
await client.optionFactory.withdrawFees(
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // token (e.g. USDC)
  [42n, 73n, 158n],                              // referralIds to sweep
);
```

The contract pays out in whatever token the referred quotation settled into. If you ran multiple RFQs that settled in different tokens (USDC, WETH, cbBTC), the owner has to call `withdrawFees` once per token.

### Why the owner gate?

RFQ fees are denominated in collateral that's escrowed during the auction lifecycle. Routing claims through the owner lets the contract enforce that only fees from *settled* quotations get paid out, and to the right token + amount. The trade-off is that third-party referrers don't have the OptionBook flow's "claim whenever you want" property.

## ExpiredReferralSwept event

When a referral's underlying RFQ expires without settling, the owner can sweep the dangling fees. The contract emits:

```solidity
event ExpiredReferralSwept(uint256 indexed referralId, address indexed token, uint256 amount);
```

Listen for this event if you want to reconcile your expected accrual against on-chain reality. Same access rule applies — only the owner can trigger the sweep.

## See also

- [OptionBook Referrer Fees](../optionbook/referrer-fees.md) — the other referral system, with self-claim
- [Create an RFQ](./create-rfq.md) — the full `requestForQuotation` walkthrough where you'd attach your `referralId`
- [Modules Overview — `client.optionFactory`](../reference/modules-overview.md) — full OptionFactory module surface
- [v0.2.1 GitHub Release](https://github.com/Thetanuts-Finance/thetanuts-sdk/releases/tag/v0.2.1) — context on the zero-address guards and r12 changes that affect referral registration
