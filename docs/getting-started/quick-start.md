# Quick Start

Get up and running with read-only access to the Thetanuts SDK in minutes — no signer required.

> **Skipping straight to LLM workflows?** Use the [MCP server](../guides/mcp-server.md) (`npx -y @thetanuts-finance/mcp`) or paste the [LLM context prompt](../resources/llm-context.md) into Claude / Cursor / ChatGPT. The rest of this page covers direct TypeScript usage.

## Read-only example

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

// Initialize with provider (read-only — no signer needed for any of this)
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const client = new ThetanutsClient({
  chainId: 8453, // Base mainnet
  provider,
});

// 1. Fetch available orders from the book
const orders = await client.api.fetchOrders();
console.log(`Found ${orders.length} orders`);

// 2. Get market data
const marketData = await client.api.getMarketData();
console.log(`BTC: $${marketData.prices.BTC}`);
console.log(`ETH: $${marketData.prices.ETH}`);

// 3. Preview what a fill would actually cost (no transaction, no signer)
//    For PUTs and spreads, contract count is NOT the same as premium —
//    previewFillOrder runs the same collateral math the contract uses.
if (orders.length > 0) {
  const preview = client.optionBook.previewFillOrder(orders[0], 10_000000n); // 10 USDC
  console.log(`Contracts: ${preview.numContracts}`);
  console.log(`Collateral: ${preview.collateralToken}`);
  console.log(`Price per contract: ${preview.pricePerContract}`);
}

// 4. Get MM pricing for custom RFQ options
const pricing = await client.mmPricing.getAllPricing('ETH');
const active = client.mmPricing.filterExpired(Object.values(pricing));
console.log(`${active.length} active ETH options available for RFQ`);
```

## Next steps

To actually execute a fill you need a signer. Jump to [OptionBook: browse and fill an order](../optionbook/overview.md), or to create a custom option jump to [RFQ: create a custom option](../rfq/overview.md).

---

## See also

- [Configuration](./configuration.md)
- [OptionBook overview](../optionbook/overview.md)
- [RFQ overview](../rfq/overview.md)
