# Thetanuts MCP Server Specification

## Overview

This MCP (Model Context Protocol) server provides **read-only** access to the Thetanuts SDK for querying options data on Base mainnet.

## MCP Protocol Compliance

This server implements the [Model Context Protocol](https://modelcontextprotocol.io/) specification:

### Transport
- **Type:** stdio (stdin/stdout)
- **Format:** JSON-RPC 2.0

### Required Methods
| Method | Description | Status |
|--------|-------------|--------|
| `tools/list` | List available tools | ✅ Implemented |
| `tools/call` | Execute a tool | ✅ Implemented |

### Response Format
All tool responses follow MCP standard:
```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{ ... JSON result ... }"
      }
    ]
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

## Security Constraints

### ✅ ALLOWED (Read-Only)
- Fetch market data and prices
- Query orderbook
- Get user positions and history
- Check token balances/allowances
- Calculate option payouts
- Preview order fills (dry-run)
- Query blockchain events
- Get protocol statistics

### ❌ FORBIDDEN (Not Implemented)
- Execute transactions
- Fill/cancel orders
- Handle private keys
- Sign messages
- Approve token spending
- Any state-changing operations

## Tools Specification

### Market Data Tools

#### `get_market_data`
Returns current prices for all supported assets (BTC, ETH, SOL, XRP, BNB, AVAX).

**Input:** None
**Output:** `{ prices: { ETH: number, BTC: number, ... }, metadata: { lastUpdated, currentTime } }`

#### `get_market_prices`
Returns raw price data for all assets.

**Input:** None
**Output:** `Record<string, MarketPrice>`

---

### Order Tools

#### `fetch_orders`
Fetches all available orders from the Thetanuts orderbook.

**Input:** None
**Output:** `{ count: number, orders: OrderSummary[] }`

#### `filter_orders`
Filter orders by type or expiry.

**Input:**
- `isCall?: boolean` - Filter call/put
- `minExpiry?: number` - Minimum expiry timestamp

**Output:** `{ count: number, orders: OrderSummary[] }`

#### `preview_fill_order`
Preview what a fill would look like (dry-run, no execution).

**Input:**
- `orderIndex: number` - Index from fetch_orders
- `usdcAmount?: string` - Amount to spend (6 decimals)

**Output:** `{ numContracts, collateralToken, totalCollateral, ... }`

---

### User Data Tools

#### `get_user_positions`
Get all option positions for an address.

**Input:** `{ address: string }`
**Output:** Array of position objects

#### `get_user_history`
Get trade history for an address.

**Input:** `{ address: string }`
**Output:** Array of trade history entries

---

### Token Tools

#### `get_token_balance`
**Input:** `{ tokenAddress: string, ownerAddress: string }`
**Output:** `{ balance: string }`

#### `get_token_allowance`
**Input:** `{ tokenAddress: string, owner: string, spender: string }`
**Output:** `{ allowance: string }`

#### `get_token_info`
**Input:** `{ tokenAddress: string }`
**Output:** `{ decimals: number, symbol: string }`

---

### Option Tools

#### `get_option_info`
Get detailed info about an option contract.

**Input:** `{ optionAddress: string }`
**Output:** Full option details including strikes, expiry, buyer, seller, etc.

#### `calculate_option_payout`
Calculate payout for an existing option at a settlement price.

**Input:** `{ optionAddress: string, settlementPrice: string }`
**Output:** `{ payout: string }`

---

### Pricing Tools

#### `get_greeks`
Calculate option Greeks.

**Input:**
- `underlying: string` - "ETH" or "BTC"
- `optionType: "call" | "put"`
- `strike: string` - Strike in 8 decimals
- `expiry: number` - Unix timestamp
- `size?: string` - Position size (18 decimals)

**Output:** `{ delta, gamma, theta, vega, rho, impliedVolatility, ... }`

#### `get_iv_surface`
Get implied volatility surface.

**Input:** `{ underlying: string }`
**Output:** `{ underlying, points: [...], timestamp }`

---

### Utility Tools

#### `calculate_payout`
Pure calculation of option payoff for any supported structure.

**Input:**
- `type:` one of:
  - `"call"`, `"put"` — vanilla; strikes `[strike]`
  - `"call_spread"`, `"put_spread"` — strikes `[lower, upper]` ASCENDING
  - `"call_fly"` — strikes `[K1, K2, K3]` ASCENDING, equidistant
  - `"put_fly"` — strikes `[K3, K2, K1]` DESCENDING, equidistant
  - `"call_condor"`, `"put_condor"` — strikes `[K1, K2, K3, K4]` ASCENDING (condors are always ascending), with `K2-K1 === K4-K3`
  - `"iron_condor"` — strikes `[putLower, putUpper, callLower, callUpper]` with `putUpper <= callLower`
  - `"ranger"` — strikes `[callLower, callUpper, putLower, putUpper]` with equal spread widths and `callUpper < putLower`
- `strikes: string[]` - Strike prices (8 decimals)
- `settlementPrice: string` - Settlement price (8 decimals)
- `numContracts: string` - Size (18 decimals)

**Output:** `{ payout: string }`

#### `convert_decimals`
Convert between human-readable and on-chain values.

**Input:**
- `value: string`
- `decimals: number` - 6 for USDC, 8 for prices, 18 for size
- `direction: "toChain" | "fromChain"`

**Output:** `{ result: string }`

---

### Event Tools

#### `get_order_fill_events`
Query historical fill events.

**Input:**
- `fromBlock?: number` - Starting block (negative = relative)
- `maker?: string` - Filter by maker
- `taker?: string` - Filter by taker

**Output:** `{ count: number, events: [...] }`

---

### RFQ Tools

#### `get_rfq`
Get a specific RFQ by ID.

**Input:** `{ quotationId: string }`
**Output:** RFQ details

#### `get_user_rfqs`
Get all RFQs for a user.

**Input:** `{ address: string }`
**Output:** Array of RFQs

---

### Config Tools

#### `get_chain_config`
Get chain configuration.

**Input:** None
**Output:** `{ chainId, name, contracts, tokens }`

---

### Ranger Tools (RangerOption)

`client.ranger` is gated to chains where `chainConfig.implementations.RANGER` is non-zero. On Base mainnet (the default RPC), all tools work. Other chains throw `NETWORK_UNSUPPORTED`.

| Tool | Input | Output (key fields) |
|------|-------|---------------------|
| `get_ranger_info` | `rangerAddress` | Full `RangerInfo` struct (buyer, seller, strikes, zone, expiry) |
| `get_ranger_zone` | `rangerAddress` | `{ zoneLower, zoneUpper }` (8-decimal price strings) |
| `get_ranger_spread_width` | `rangerAddress` | `{ spreadWidth }` |
| `get_ranger_twap` | `rangerAddress` | `{ twap }` (current 8-decimal price) |
| `calculate_ranger_payout` | `rangerAddress, price` | `{ payout }` (collateral-token decimals) |
| `simulate_ranger_payout` | `rangerAddress, price, strikes[], numContracts` | `{ payout }` |
| `calculate_ranger_required_collateral` | `rangerAddress, strikes[], numContracts` | `{ requiredCollateral }` |

### Loan Tools

| Tool | Input | Output |
|------|-------|--------|
| `get_lending_opportunities` | `?{ underlying, excludeAddress }` | Array of `LoanLendingOpportunity` |
| `get_loan_request` | `quotationId` | `LoanState` |
| `get_user_loans` | `address` | Array of `LoanIndexerLoan` |
| `get_loan_option_info` | `optionAddress` | `LoanOptionInfo` |
| `is_loan_option_itm` | `optionAddress` | `{ isITM: boolean }` |
| `fetch_loan_pricing` | None | `DeribitPricingMap` |
| `get_loan_strike_options` | `underlying, ?{ minDurationDays, maxStrikes, sortOrder }` | Array of `LoanStrikeOptionGroup` |

### WheelVault Tools (Ethereum mainnet — chainId 1)

WheelVault is gated to chainId 1. Set `THETANUTS_RPC_URL` to an Ethereum RPC before invoking these. Otherwise the tool throws `NETWORK_UNSUPPORTED`.

| Tool | Input | Output |
|------|-------|--------|
| `get_wheel_vault_state` | `vaultAddress, seriesId` | `VaultState` (full snapshot) |
| `get_wheel_vault_series` | `vaultAddress, seriesId` | Raw `VaultSeries` |
| `get_wheel_vault_series_count` | `vaultAddress` | `{ seriesCount }` |
| `preview_wheel_deposit` | `vaultAddress, seriesId, baseAmt, quoteAmt` | `{ expectedShares }` |
| `preview_wheel_withdraw` | `vaultAddress, seriesId, shares` | `WithdrawPreview` (base + quote) |
| `get_wheel_depth_chart` | `lensAddress, seriesId, isCall, maxIvBps` | `DepthChartResult` |
| `get_wheel_buyer_options` | `lensAddress, buyerAddress, fromId, maxCount` | Array of `BuyerOption` (paginated) |
| `get_wheel_seller_positions` | `lensAddress, sellerAddress, seriesId, maxIvBps, maxEntries` | Array of `SellerPosition` |
| `get_wheel_claimable_summary` | `lensAddress, sellerAddress, seriesIds[]` | `ClaimableSummary` |

### StrategyVault Tools (Base — Fixed-strike + CLVEX)

| Tool | Input | Output |
|------|-------|--------|
| `get_strategy_vault_state` | `vaultAddress` | `StrategyVaultState` |
| `get_strategy_vault_total_assets` | `vaultAddress` | `StrategyVaultAssets` |
| `get_strategy_vault_share_balance` | `vaultAddress, userAddress` | `{ shareBalance }` |
| `get_strategy_vault_next_expiry` | `vaultAddress` | `{ nextExpiry }` (Unix ts) |
| `can_strategy_vault_create_option` | `vaultAddress` | `{ canCreateOption: boolean }` |
| `is_strategy_vault_recovery_mode` | `vaultAddress` | `{ isRecoveryMode: boolean }` |
| `get_all_strategy_vaults` | None | Array of `StrategyVaultState` (every vault) |
| `get_fixed_strike_vaults` | None | Array of `StrategyVaultState` (fixed-strike only) |
| `get_clvex_vaults` | None | Array of `StrategyVaultState` (CLVEX only) |

---

## Testing

### Manual Testing
```bash
# List tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# Call a tool
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_chain_config","arguments":{}}}' | node dist/index.js
```

### MCP Inspector
```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

### Automated Tests
```bash
./test.sh
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THETANUTS_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |

## Decimal Reference

| Type | Decimals | Example |
|------|----------|---------|
| USDC amounts | 6 | 1000 USDC = `1000000000` |
| Prices (strike, settlement) | 8 | $3000 = `300000000000` |
| numContracts | 6 | 1 contract = `1000000` |

### Precision Notes

**numContracts Precision:** When closing positions, use exact BigInt values from the chain to avoid precision loss. The SDK accepts `numContracts` as `number`, `bigint`, or `string`:

- `number`: Human-readable (e.g., 1.5) - converted using decimals
- `bigint`: On-chain format - used directly, no conversion (recommended for position closing)
- `string`: Parsed as BigInt

**Nonce Handling:** API responses may contain `null` nonce values. The SDK handles this gracefully by defaulting to `0n`.
