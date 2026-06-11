# Overview

TypeScript SDK for Thetanuts Finance V4 — options trading on EVM chains.

> **Using an LLM (Claude, Cursor, ChatGPT)?** This SDK ships an MCP server that exposes ~100 tools — read state, build transactions, run pricing math. One-line install: `npx -y @thetanuts-finance/mcp`, or paste [the LLM context prompt](../resources/llm-context.md) into your LLM. Want to actually **trade** from chat? Pair it with Base MCP and approve each transaction in your wallet ([Trade from Chat](../guides/base-mcp-plugin.md)), or run a fully autonomous agent with its own wallet ([AgentKit](../guides/agentkit.md)). Start at [AI Agents — Pick Your Route](../guides/agents-overview.md).

## Features

- **Complete Options Trading**: Fill orders, manage positions, handle RFQs
- **Settlement Types**: Cash-settled and physically settled options
- **Multi-Strategy Support**: Spreads, butterflies, condors, iron condors (cash-settled)
- **Real-time Data**: WebSocket subscriptions for live updates
- **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Modular Design**: Use only what you need
- **ESM and CJS builds**: Maximum compatibility

## OptionBook vs RFQ

The SDK supports two trading systems. Choose based on your use case:

|  | **OptionBook** | **RFQ (Factory)** |
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

## Which one should I use?

Both OptionBook and RFQ create cash-settled options using the same on-chain contracts. The difference is how you get there:

```
Is there an existing order that matches your trade?
  YES --> Use OptionBook (instant fill, no waiting)
  NO  --> Use RFQ (custom strike/expiry, MMs compete on price)

Need physical settlement (actual token delivery at expiry)?
  YES --> Use RFQ with buildPhysicalOptionRFQ()
  NO  --> Either works. OptionBook is faster if an order exists.
```

**OptionBook** is like a limit order book. Makers have already posted orders with set strikes, expiries, and prices. You pick one and fill it instantly.

**RFQ** is like sending out a request for bids. You specify what you want (any strike, any expiry), and market makers compete via sealed-bid auction. It takes ~60 seconds for offers to arrive, but you get competitive pricing on exactly the parameters you need.

---

## See also

- [Installation](./installation.md)
- [Quick Start](./quick-start.md)
- [Supported Chains](./supported-chains.md)
- [MCP Server](../guides/mcp-server.md) — Claude / Cursor / VS Code one-click install
- [LLM Context](../resources/llm-context.md) — copy-paste prompt to teach any LLM the full SDK
