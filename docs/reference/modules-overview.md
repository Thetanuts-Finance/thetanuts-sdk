# Modules Overview

All 15 SDK modules are accessed as properties on the `ThetanutsClient` instance — no separate instantiation needed.

## Module Table

| Module | Client Property | Purpose | Requires Signer |
|--------|----------------|---------|-----------------|
| ERC20 | `client.erc20` | Token approvals, balances, transfers | Write ops only |
| OptionBook | `client.optionBook` | Fill/cancel orders, fee claiming | Write ops only |
| API | `client.api` | Fetch orders, positions, stats | No |
| OptionFactory | `client.optionFactory` | RFQ lifecycle management | Write ops only |
| Option | `client.option` | Position management and payouts | Write ops only |
| Ranger | `client.ranger` | RangerOption (zone-bound, 4-strike) position management | Write ops only |
| Events | `client.events` | Query blockchain events | No |
| WebSocket | `client.ws` | Real-time subscriptions | No |
| MM Pricing | `client.mmPricing` | Market maker pricing and Greeks | No |
| RFQ Keys | `client.rfqKeys` | ECDH key management and offer encryption | No |
| Utils | `client.utils` | Decimal conversions, payoff calculations | No |
| Loan | `client.loan` | Non-liquidatable lending | Write ops only |
| Collar | `client.collar` | Zero-interest collar loans and collar pricing helpers | Write ops only |
| WheelVault | `client.wheelVault` | WheelVault (Ethereum mainnet) interactions | Write ops only |
| StrategyVault | `client.strategyVault` | StrategyVault (Base) interactions | Write ops only |

## Module Descriptions

### `client.erc20` — ERC20Module

Handles all ERC-20 token operations: reading balances and allowances, approving spenders, and transferring tokens. Provides `ensureAllowance()` to conditionally approve only when the existing allowance is insufficient.

Relevant section: [OptionBook overview](../optionbook/overview.md)

### `client.optionBook` — OptionBookModule

Fills and cancels orders on the OptionBook contract. Use `previewFillOrder()` for a dry-run before executing. Also handles referrer fee tracking and claiming across all collateral tokens.

Relevant section: [OptionBook overview](../optionbook/overview.md)

### `client.api` — APIModule

Fetches data from Thetanuts APIs. Methods are read-only and organized by source: `*FromIndexer` for the book indexer, `*FromRfq` for the RFQ/factory indexer. Covers orders, user positions, trade history, protocol stats, and daily time series.

### `client.optionFactory` — OptionFactoryModule

Manages the full RFQ (Request for Quotation) lifecycle: building parameters, submitting requests, polling quotation state, revealing offers, and settling. Supports vanilla, spread, butterfly, condor, iron condor, and physically settled structures. Also exposes the RFQ-side referral surface (`registerReferral`, `getReferralOwner`, `getReferralFees`, `withdrawFees`) — see the [RFQ Referrals](../rfq/referrals.md) guide.

Relevant section: [RFQ overview](../rfq/overview.md)

### `client.option` — OptionModule

Queries and manages individual option positions. Reads option info, checks expiry/settlement state, calculates payouts at a given price, and executes close/transfer/split/payout operations.

### `client.ranger` — RangerModule

Manages RangerOption positions — the r12 zone-bound, 4-strike payoff. The buyer earns the maximum payout when the settlement price lands inside the zone (between strikes 2 and 3) and a linearly decaying payout outside. Reads include `getInfo()`, `getZone()`, `getSpreadWidth()`, `getStrikes()`, `getTWAP()`, `calculatePayout(price)`, `simulatePayout(...)`, and `calculateRequiredCollateral(...)`. Writes include `payout()`, `close()`, `split(amount)`, `transfer(isBuyer, target)`, `reclaimCollateral(ownedOption)`, and `returnExcessCollateral()`.

The module throws `NETWORK_UNSUPPORTED` on chains where RangerOption is not deployed (e.g., Ethereum mainnet today) — no silent eth_call failures.

### `client.events` — EventsModule

Queries on-chain events from the Thetanuts contracts: order fills, cancellations, RFQ requests, MM offers, offer reveals, settlements, and position closes. Block ranges are auto-chunked into 10K-block segments.

### `client.ws` — WebSocketModule

Provides real-time subscriptions over WebSocket for order updates, price feeds, and connection state changes. Includes automatic reconnection.

### `client.mmPricing` — MMPricingModule

Fetches market maker pricing from the pricing API. Returns fee-adjusted bid/ask prices per collateral token with collateral cost included. Includes filter and sort helpers and multi-leg pricing for spreads, butterflies, and condors.

Relevant section: [MM Pricing guide](../pricing/mm-pricing.md)

### `client.rfqKeys` — RFQKeyManagerModule

Manages ECDH key pairs used in the sealed-bid auction RFQ flow. Generates, stores, loads, and backs up keys. Provides `encryptOffer()` for market makers and `decryptOffer()` for requesters.

Relevant section: [RFQ overview](../rfq/overview.md)

### `client.utils` — UtilsModule

Pure utility functions with no network calls: decimal conversions (`toBigInt`, `fromBigInt`, `strikeToChain`, `strikeFromChain`, `toUsdcDecimals`, `fromUsdcDecimals`), payout calculations, collateral calculations, and payoff diagram data generation.

Relevant section: [Utilities](./utilities.md)

### `client.loan` — LoanModule

Non-liquidatable lending. Borrowers deposit ETH/BTC collateral and receive USDC. At expiry, repay to reclaim collateral or walk away. Includes pricing, cost calculation, lending opportunities, and option exercise.

Relevant section: [Loan overview](../loan/overview.md)

### `client.collar` — CollarModule

Zero-interest collar loan helpers. Pricing and strike filtering work today; on-chain write methods are gated until collar-v12 contract addresses are populated.

Relevant section: [Collar loans](../loan/collar.md)

### `client.wheelVault` — WheelVaultModule

Reads and interacts with the WheelVault contracts on Ethereum mainnet. The module is chain-gated — methods throw `NETWORK_UNSUPPORTED` when the client is configured for any chain other than `chainId 1`.

Relevant section: [Wheel Vault overview](../wheel-vault/overview.md)

### `client.strategyVault` — StrategyVaultModule

Reads and interacts with the StrategyVault contracts (fixed-strike and CLVEX strategies) on Base. The module is chain-gated — methods throw `NETWORK_UNSUPPORTED` when the client is configured for any chain other than `chainId 8453`.

Relevant section: [Strategy Vault overview](../strategy-vault/overview.md)

## Quick Reference

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({ chainId: 8453, provider, signer });

// ERC20
const balance = await client.erc20.getBalance(tokenAddress, userAddress);
await client.erc20.ensureAllowance(token, spender, amount);

// OptionBook
const preview = client.optionBook.previewFillOrder(order, 10_000000n);
const receipt = await client.optionBook.fillOrder(order, 10_000000n);

// API
const orders = await client.api.fetchOrders();
const positions = await client.api.getUserPositionsFromIndexer(address);

// OptionFactory
const request = client.optionFactory.buildRFQRequest({ /* params */ });
await client.optionFactory.requestForQuotation(request);

// Option
const info = await client.option.getFullOptionInfo(optionAddress);

// Ranger (RangerOption — zone-bound, 4-strike)
const rangerInfo = await client.ranger.getInfo(rangerAddress);
const { zoneLower, zoneUpper } = await client.ranger.getZone(rangerAddress);

// Events
const fills = await client.events.getOrderFillEvents();

// WebSocket
await client.ws.connect();
client.ws.subscribeOrders((update) => console.log(update));

// MM Pricing
const all = await client.mmPricing.getAllPricing('ETH');
const active = client.mmPricing.filterExpired(Object.values(all));

// RFQ Keys
const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// Utils
const onChain = client.utils.strikeToChain(1850);  // 185000000000n
const human = client.utils.fromBigInt(100500000n, 6);  // '100.5'

// Loan
const strikes = await client.loan.getStrikeOptions('ETH');
const calc = client.loan.calculateLoan({ depositAmount: '1.0', underlying: 'ETH', strike: 1600, expiryTimestamp: 1780041600, askPrice: 0.007, underlyingPrice: 2328 });
```

---

## See Also

- [Client](./client.md) — ThetanutsClient constructor and properties
- [Utilities](./utilities.md) — UtilsModule method reference
- [../getting-started/configuration.md](../getting-started/configuration.md) — Getting started with configuration
