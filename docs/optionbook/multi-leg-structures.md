# Multi-Leg Structures

Fill existing multi-leg orders from the OptionBook, including spreads, butterflies, condors, and iron condors.

## How It Works

OptionBook orders can contain 1 to 4 strikes. The number of strikes tells you the product type:

```
order.strikes.length === 1  →  VANILLA    (single option)
order.strikes.length === 2  →  SPREAD     (2-leg)
order.strikes.length === 3  →  BUTTERFLY  (3-leg)
order.strikes.length === 4  →  CONDOR or IRON CONDOR  (4-leg)
```

You don't need to handle multi-leg differently in code. The same `previewFillOrder()` and `fillOrder()` methods work for all structures. The SDK reads the implementation address and strike count from the order and calculates collateral accordingly.

> **All OptionBook options are cash-settled.** For physically settled options, use [RFQ](../rfq/physical-options.md).

---

## Identifying Multi-Leg Orders

When you fetch orders from the book, you can identify the structure by checking `strikes.length` or the implementation address:

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const client = new ThetanutsClient({ chainId: 8453, provider });

const orders = await client.api.fetchOrders();

for (const order of orders) {
  const strikes = order.rawApiData?.strikes ?? [];
  const impl = order.rawApiData?.implementation ?? '';
  const isCall = order.rawApiData?.isCall;

  let structure = 'UNKNOWN';
  if (strikes.length === 1) structure = isCall ? 'VANILLA CALL' : 'VANILLA PUT';
  if (strikes.length === 2) structure = isCall ? 'CALL SPREAD' : 'PUT SPREAD';
  if (strikes.length === 3) structure = isCall ? 'CALL BUTTERFLY' : 'PUT BUTTERFLY';
  if (strikes.length === 4) structure = 'CONDOR / IRON CONDOR';

  console.log(`${structure} | ${strikes.length} strikes | impl: ${impl}`);
}
```

### Filtering by Structure

```typescript
// Get only spread orders
const spreads = orders.filter((o) => (o.rawApiData?.strikes ?? []).length === 2);

// Get only butterfly orders
const butterflies = orders.filter((o) => (o.rawApiData?.strikes ?? []).length === 3);

// Get only condor/iron condor orders
const condors = orders.filter((o) => (o.rawApiData?.strikes ?? []).length === 4);

// Get only vanilla orders
const vanillas = orders.filter((o) => (o.rawApiData?.strikes ?? []).length === 1);
```

---

## Structures Summary

| Structure | Strikes | Implementation | Collateral Formula |
|-----------|---------|----------------|--------------------|
| Vanilla PUT | 1 | `PUT` | `(collateral x 1e8) / strike` |
| Vanilla CALL | 1 | `INVERSE_CALL` | `collateral / 1e12` |
| Spread | 2 | `PUT_SPREAD` / `CALL_SPREAD` | `(collateral x 1e8) / spreadWidth` |
| Butterfly | 3 | `PUT_FLY` / `CALL_FLY` | `(collateral x 1e8) / maxSpread` |
| Condor | 4 | `PUT_CONDOR` / `CALL_CONDOR` | `(collateral x 1e8) / maxSpread` |
| Iron Condor | 4 | `IRON_CONDOR` | `(collateral x 1e8) / maxSpread` |

---

## Preview and Fill a Multi-Leg Order

The workflow is identical to vanilla orders. `previewFillOrder()` automatically uses the correct collateral formula based on the strike count.

### Spread Example

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });

// 1. Find a spread order (2 strikes)
const orders = await client.api.fetchOrders();
const spreadOrder = orders.find((o) => (o.rawApiData?.strikes ?? []).length === 2);

if (!spreadOrder) throw new Error('No spread orders available');

// 2. Preview the fill
const preview = client.optionBook.previewFillOrder(spreadOrder, 50_000000n); // 50 USDC
console.log(`Contracts: ${preview.numContracts}`);
console.log(`Max contracts: ${preview.maxContracts}`);
console.log(`Strikes: ${preview.strikes.join(', ')}`);
console.log(`Collateral token: ${preview.collateralToken}`);

// 3. Approve collateral
await client.erc20.ensureAllowance(
  preview.collateralToken,
  client.chainConfig.contracts.optionBook,
  preview.totalCollateral,
);

// 4. Fill
const receipt = await client.optionBook.fillOrder(spreadOrder, 50_000000n);
console.log(`Spread filled: ${receipt.hash}`);
```

### Butterfly Example

```typescript
// Find a butterfly order (3 strikes)
const butterflyOrder = orders.find((o) => (o.rawApiData?.strikes ?? []).length === 3);

if (butterflyOrder) {
  const preview = client.optionBook.previewFillOrder(butterflyOrder);
  console.log(`Butterfly: ${preview.strikes.length} strikes`);
  console.log(`Max contracts: ${preview.maxContracts}`);
  console.log(`Price per contract: ${preview.pricePerContract}`);

  // Approve and fill
  await client.erc20.ensureAllowance(
    preview.collateralToken,
    client.chainConfig.contracts.optionBook,
    preview.totalCollateral,
  );
  const receipt = await client.optionBook.fillOrder(butterflyOrder);
  console.log(`Butterfly filled: ${receipt.hash}`);
}
```

### Condor Example

```typescript
// Find a condor order (4 strikes, not iron condor)
const condorOrder = orders.find((o) => {
  const strikes = o.rawApiData?.strikes ?? [];
  const impl = o.rawApiData?.implementation?.toLowerCase() ?? '';
  // Condor has 4 strikes but is NOT an iron condor
  return strikes.length === 4 && !impl.includes('iron');
});

if (condorOrder) {
  const preview = client.optionBook.previewFillOrder(condorOrder);
  console.log(`Condor: ${preview.strikes.length} strikes`);
  console.log(`Strikes: ${preview.strikes.join(', ')}`);
  console.log(`Max contracts: ${preview.maxContracts}`);
  console.log(`Price per contract: ${preview.pricePerContract}`);

  // Approve and fill
  await client.erc20.ensureAllowance(
    preview.collateralToken,
    client.chainConfig.contracts.optionBook,
    preview.totalCollateral,
  );
  const receipt = await client.optionBook.fillOrder(condorOrder);
  console.log(`Condor filled: ${receipt.hash}`);
}
```

### Iron Condor Example

An iron condor combines a put spread and a call spread. It uses the `IRON_CONDOR` implementation with 4 strikes.

```typescript
// Find an iron condor order
// Iron condors use a specific implementation address
const ironCondorImpl = client.chainConfig.implementations.IRON_CONDOR.toLowerCase();

const ironCondorOrder = orders.find((o) => {
  const strikes = o.rawApiData?.strikes ?? [];
  const impl = (o.rawApiData?.implementation ?? '').toLowerCase();
  return strikes.length === 4 && impl === ironCondorImpl;
});

if (ironCondorOrder) {
  const preview = client.optionBook.previewFillOrder(ironCondorOrder);
  console.log(`Iron Condor: ${preview.strikes.length} strikes`);
  console.log(`Strikes: ${preview.strikes.join(', ')}`);
  console.log(`Max contracts: ${preview.maxContracts}`);

  // Approve and fill
  await client.erc20.ensureAllowance(
    preview.collateralToken,
    client.chainConfig.contracts.optionBook,
    preview.totalCollateral,
  );
  const receipt = await client.optionBook.fillOrder(ironCondorOrder);
  console.log(`Iron Condor filled: ${receipt.hash}`);
}
```

---

## Implementation Addresses

These are the cash-settled implementation contracts used by OptionBook orders:

Use `client.chainConfig.implementations` for the current Base r12 implementation addresses. The SDK also keeps reverse-lookup metadata for older implementation versions that may appear in indexed orders.

Orders from `fetchOrders()` may also reference earlier implementation versions. The SDK handles both transparently.

---

## OptionBook vs RFQ for Multi-Leg

Both systems support the same multi-leg structures using the same implementation contracts.

| | OptionBook | RFQ |
|---|---|---|
| **How** | Fill an existing order from the book | Create a new option with custom parameters |
| **Speed** | Instant fill | ~60 second auction |
| **Parameters** | Fixed by the maker | You choose strike(s) and expiry |
| **Settlement** | Cash-settled only | Cash-settled or physically settled (vanilla only) |
| **SDK method** | `fillOrder(order)` | `buildRFQRequest({ strikes: [...] })` |

If there's a multi-leg order on the book that matches your trade, use OptionBook. If you need custom strikes or expiry, use [RFQ multi-leg](../rfq/multi-leg-structures.md).

---

## See Also

- [Preview Fills](preview-fills.md) - Collateral formulas and preview details
- [Fill Orders](fill-orders.md) - Execute a fill
- [Browse & Filter Orders](browse-filter-orders.md) - Find orders on the book
- [RFQ Multi-Leg Structures](../rfq/multi-leg-structures.md) - Create custom multi-leg options
