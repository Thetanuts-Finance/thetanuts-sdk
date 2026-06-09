# OptionBook Overview

Fill existing market-maker orders for options on-chain without needing a counterparty.

## What is OptionBook?

OptionBook is the order-book side of the Thetanuts protocol. Market makers post signed orders for options (vanilla PUTs/CALLs, spreads, butterflies, condors, and iron condors on ETH and BTC). As a taker, you browse those orders, pick one you like, and fill it in a single transaction.

The number of strikes in `order.strikes[]` tells you the product type:
- **1 strike** = Vanilla (PUT or CALL)
- **2 strikes** = Spread
- **3 strikes** = Butterfly
- **4 strikes** = Condor or Iron Condor

Collateral is paid upfront by the taker. All OptionBook options are **cash-settled**: at expiry, the payout is calculated based on the difference between the strike price and the settlement price (Chainlink oracle), and paid out in the collateral token:

- **PUT options**: Collateral and payout in USDC
- **CALL options (Inverse Call)**: Collateral and payout in the underlying token (WETH for ETH, cbBTC for BTC)

No physical delivery of assets occurs. For physically settled options (actual delivery of underlying at expiry), use [RFQ/Factory](../rfq/overview.md) instead.

## OptionBook vs RFQ

| | **OptionBook** | **RFQ (Factory)** |
|---|---|---|
| **What** | Fill existing market-maker orders | Create custom options via sealed-bid auction |
| **When to use** | Quick trades on listed options (vanilla and multi-leg) | Custom options via sealed-bid auction: any strike, any expiry, cash-settled or physically settled |
| **Structures** | Vanilla, spread, butterfly, condor, iron condor (cash-settled) | Vanilla, spread, butterfly, condor, iron condor (cash-settled or physically settled for vanilla) |
| **Key methods** | `fillOrder()`, `previewFillOrder()` | `buildRFQRequest()`, `requestForQuotation()` |
| **Pricing** | Order prices from `fetchOrders()` | MM pricing from `getAllPricing()` |
| **Data source** | Book indexer (`/api/v1/book/`) | Factory indexer (`/api/v1/factory/`) |
| **User data** | `getUserPositionsFromIndexer()` | `getUserRfqs()`, `getUserOptionsFromRfq()` |
| **Stats** | `getBookProtocolStats()`, `getBookDailyStats()` | `getFactoryProtocolStats()`, `getFactoryDailyStats()` |
| **Collateral** | Paid upfront by taker | `collateralAmount = 0` (held by factory) |
| **Settlement** | Cash-settled (payout in USDC/WETH/cbBTC based on price difference at expiry) | Cash-settled by default; physically settled optional via `buildPhysicalOptionRFQ()` |

Both OptionBook and RFQ create cash-settled options using the same on-chain implementation contracts (PUT, INVERSE_CALL, spreads, etc.). The difference is how you get there:

- **OptionBook**: Fill a pre-priced order instantly. The strike, expiry, and price are already set by the maker.
- **RFQ**: Request your own custom strike and expiry. Market makers compete via sealed-bid auction (~60 seconds for offers).

If OptionBook has an order matching your trade, use it. It's faster. Use RFQ when you need parameters that aren't currently listed.

## Core Flow

Every OptionBook trade follows the same four steps:

```
fetchOrders()          — browse available maker orders
    ↓
previewFillOrder()     — dry-run: see contracts, collateral, price per contract
    ↓
ensureAllowance()      — approve the collateral token
    ↓
fillOrder()            — execute the trade on-chain
```

## Quick Example

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const client = new ThetanutsClient({
  chainId: 8453, // Base mainnet
  provider,
  signer,
});

// 1. Fetch available orders
const orders = await client.api.fetchOrders();
const order = orders.find((o) => o.order.expiry > BigInt(Math.floor(Date.now() / 1000)));
if (!order) throw new Error('No active orders');

// 2. Preview the fill (no transaction, no signer needed)
const preview = client.optionBook.previewFillOrder(order, 10_000000n); // 10 USDC
console.log(`Contracts: ${preview.numContracts}`);
console.log(`Collateral token: ${preview.collateralToken}`);
console.log(`Price per contract: ${preview.pricePerContract}`);

// 3. Approve collateral spending
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.chainConfig.contracts.optionBook,
  10_000000n,
);

// 4. Fill the order
const receipt = await client.optionBook.fillOrder(order, 10_000000n);
console.log(`Trade executed: ${receipt.hash}`);
```

## OptionBook Implementations

All OptionBook options are cash-settled. The implementation address on each order determines the product type:

Use `client.chainConfig.implementations` for the current Base r12 implementation addresses. Orders from `fetchOrders()` may reference current or earlier implementation versions; the SDK reverse lookup handles both transparently.

## Data Source

OptionBook orders come from the Book indexer at `/api/v1/book/`. The SDK abstracts this — you call `client.api.fetchOrders()` and receive typed `OrderWithSignature` objects with pre-computed Greeks and metadata.

## Module Access

All OptionBook operations go through two modules:

| Module | Purpose |
|--------|---------|
| `client.api` | Fetch orders, positions, stats (read-only, no signer) |
| `client.optionBook` | Fill/cancel orders, claim fees (write ops require signer) |

---

## See Also

- [Browse and Filter Orders](browse-filter-orders.md)
- [Preview Fills](preview-fills.md)
- [Fill Orders](fill-orders.md)
