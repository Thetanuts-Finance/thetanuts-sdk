# RFQ (Factory) Overview

Create custom options through a sealed-bid auction — choose any strike, expiry, and structure, then let market makers compete to fill your request.

## What is RFQ / Factory?

The RFQ (Request for Quotation) system, also called the **Factory**, lets you create fully custom options that are not listed on the OptionBook. You specify exactly what you want — underlying asset, strike(s), expiry, direction, and structure — and market makers respond with encrypted, competitive offers. The best offer wins and an option contract is deployed atomically at settlement.

Under the hood the OptionFactory contract acts as both auctioneer and deployer: it collects encrypted MM offers, runs the reveal auction, and mints a fresh EIP-1167 proxy option contract (or transfers an existing one) when the trade settles.

## Key Features

- **Privacy via sealed-bid auction** — Offers are encrypted with ECDH until the reveal phase. No MM can see a competitor's bid, preventing front-running and last-second sniping.
- **Competitive pricing** — Multiple market makers respond to each RFQ; the best price (lowest for BUY, highest for SELL) wins.
- **Full collateralization** — Every option created through the factory is 100% collateralized. Collateral is pulled at settlement, not at RFQ creation.
- **Atomic settlement** — Option deployment and collateral/premium transfer happen in a single transaction.
- **Multi-leg structures** — Vanilla, spreads (2-leg), butterflies (3-leg), condors and iron condors (4-leg), plus physically settled variants.
- **Cash-settled by default, physical optional** — RFQs are cash-settled by default via `buildRFQRequest()`. Cash settlement pays out the price difference in the collateral token (USDC for PUTs, WETH/cbBTC for CALLs). For physically settled options (actual delivery of underlying at expiry), use `buildPhysicalOptionRFQ()` instead (vanilla only).

## OptionBook vs RFQ (Factory)

| | **OptionBook** | **RFQ (Factory)** |
|---|---|---|
| **What** | Fill existing market-maker orders | Create custom options via sealed-bid auction |
| **When to use** | Quick trades on listed options (vanilla and multi-leg) | Custom options via sealed-bid auction: any strike, any expiry, cash-settled or physically settled |
| **Structures** | Vanilla, spread, butterfly, condor, iron condor (cash-settled) | Vanilla, spread, butterfly, condor, iron condor (cash-settled or physically settled for vanilla) |
| **Key methods** | `fillOrder()`, `previewFillOrder()` | `buildRFQRequest()`, `requestForQuotation()` |
| **Pricing** | Order prices from `fetchOrders()` | MM pricing from `getAllPricing()` |
| **Data source** | Book indexer (`/api/v1/book/`) | Factory indexer (`/api/v1/factory/`) |
| **User data** | `getUserPositionsFromIndexer()` | `getUserRfqs()`, `getUserOptionsFromRfq()` |
| **Collateral** | Paid upfront by taker | `collateralAmount = 0` (held by factory) |
| **Settlement** | Cash-settled (payout in USDC/WETH/cbBTC based on price difference at expiry) | Cash-settled by default; physically settled optional via `buildPhysicalOptionRFQ()` |

## When to Use RFQ

RFQ uses the same cash-settled implementation contracts as OptionBook (PUT, INVERSE_CALL, spreads, etc.). The difference is that you choose the parameters instead of filling an existing order.

Choose the RFQ system when you need:

- A **cash-settled option with custom parameters** ... any strike price, any expiry date, any structure ... that isn't currently listed on the OptionBook (use `buildRFQRequest()`)
- **Price competition** ... you want multiple MMs to submit sealed bids rather than taking a single listed price
- A specific **multi-leg structure** (spread, butterfly, condor, iron condor) at your chosen strikes and expiry
- A **physically settled** option where actual tokens are delivered at expiry (use `buildPhysicalOptionRFQ()`, vanilla only)
- To **close an existing position** by specifying `existingOptionAddress`

Choose OptionBook when an existing maker order already matches what you want. OptionBook is faster (instant fill vs ~60 second auction).

## Quick Example

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });
const userAddress = await signer.getAddress();

// 1. Generate ECDH keypair (used to decrypt MM offers)
const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// 2. Create a cash-settled PUT RFQ
const rfqRequest = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 2000,
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
  numContracts: 1,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
  requesterPublicKey: keyPair.compressedPublicKey,
});

// 3. Send the RFQ transaction
const { to, data } = client.optionFactory.encodeRequestForQuotation(rfqRequest);
const tx = await signer.sendTransaction({ to, data });
console.log('RFQ created:', tx.hash);

// 4. Wait for MM offers, then settle (see Early Settlement or RFQ Lifecycle)
```

## High-Level Flow

```
1. You call requestForQuotation() with your ECDH public key
        ↓
2. Market makers see the on-chain event and submit encrypted offers
        ↓
3a. Early settlement: you decrypt an offer and accept it immediately
        — OR —
3b. Offer period ends → MMs reveal their amounts → anyone calls settleQuotation()
        ↓
4. OptionFactory deploys option contract, transfers collateral and premium atomically
        ↓
5. Option expires → oracle provides price → payout distributed
```

## Supported Structures

| Strikes | Structure | Settlement | Implementation | SDK Method |
|---------|-----------|------------|----------------|------------|
| 1 | Vanilla | Cash | `PUT` / `INVERSE_CALL` | `buildRFQRequest()` |
| 1 | Vanilla | Physical | `PHYSICAL_PUT` / `PHYSICAL_CALL` | `buildPhysicalOptionRFQ()` |
| 2 | Spread | Cash | `PUT_SPREAD` / `CALL_SPREAD` | `buildRFQRequest()` or `buildSpreadRFQ()` |
| 3 | Butterfly | Cash | `PUT_FLY` / `CALL_FLY` | `buildRFQRequest()` or `buildButterflyRFQ()` |
| 4 | Condor | Cash | `PUT_CONDOR` / `CALL_CONDOR` | `buildRFQRequest()` or `buildCondorRFQ()` |
| 4 | Iron Condor | Cash | `IRON_CONDOR` | `buildRFQRequest()` or `buildIronCondorRFQ()` |

The SDK detects the structure automatically from the length of the `strikes` array passed to `buildRFQParams()` or `buildRFQRequest()`.

---

## Advanced: Swap and Create in One Tx

`client.optionFactory.swapAndCall(params)` lets a user swap a source token through a DEX aggregator and then call any OptionFactory function (most commonly `requestForQuotation`) in a single atomic transaction. Useful when the user holds the wrong token for collateral and doesn't want to send two separate transactions.

```typescript
await client.optionFactory.swapAndCall({
  swapRouter,        // aggregator router address
  swapSrcToken,      // token the user is paying with
  swapDstToken,      // token expected as collateral / escrow
  swapSrcAmount,     // amount of source token to swap
  swapCallData,      // encoded swap calldata from the aggregator
  selfCallData,      // encoded call to OptionFactory (e.g. requestForQuotation)
});
```

The aggregator's calldata must be quoted client-side; the SDK passes it through unchanged.
The CLI wraps this whole flow behind `rfq request --pay-with` — see
[Paying with a Different Token](pay-with.md).

Two constraints are easy to miss:

- **The factory executes the swap, not the caller.** Approve the `OptionFactory`
  (not the router) for `swapSrcToken`, and build the aggregator route with
  `sender` and `recipient` both set to the factory. A route built for the user's
  wallet delivers the output to the wrong address and reverts.
- **Native ETH only reaches WETH.** Pass `swapRouter: ZeroAddress` with the ETH
  in `msg.value` and the factory wraps it 1:1 — `swapSrcAmount` is not read on
  that path. There is no native-ETH swap: supplying `msg.value` alongside a
  router reverts `NativeTokenNotAllowedForSwap`. To fund non-WETH collateral
  from ETH, wrap to WETH first and swap from there.

---

## See Also

- [Create an RFQ](create-rfq.md) — Step-by-step guide to submitting your first RFQ
- [Paying with a Different Token](pay-with.md) — Fund collateral from an asset you already hold
- [RFQ Lifecycle](lifecycle.md) — Detailed phases, collateral handling, and settlement paths
- [Multi-Leg Structures](multi-leg-structures.md) — Spreads, butterflies, and condors with examples
