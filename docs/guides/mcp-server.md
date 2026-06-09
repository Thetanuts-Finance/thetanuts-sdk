# MCP Server

An MCP (Model Context Protocol) server that exposes Thetanuts SDK functionality to AI agents and LLM-powered tools.

The server reads protocol state and builds transaction calldata. It does not hold wallet private keys, sign wallet transactions, or broadcast transactions itself; `prepare_*` tools return wallet-signable call bundles.

For full details, see [mcp-server/README.md](../../mcp-server/README.md) and [mcp-server/SPEC.md](../../mcp-server/SPEC.md).

> **Tip for LLM users:** if you don't need a persistent MCP connection, you can paste a one-line prompt into Claude or Cursor and have your LLM fetch the SDK context directly. See [LLM Context](../resources/llm-context.md) for the copy-paste prompt.

## Available Tools

### LLM Context Tools (call these first)

If you're an LLM connecting for the first time, call `get_sdk_context` once and cache the result for the session — it returns the full embedded SDK context (every module, key types, common workflows, gotchas) in ~35 KiB of markdown. Same content as the [`llms-full.txt`](https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms-full.txt) at the repo root.

| Tool | Description |
|------|-------------|
| `get_sdk_context` | Full long-form SDK context. Call this first — covers every module and the common gotchas |
| `get_sdk_context_index` | Curated index of canonical SDK docs (llmstxt.org spec) — links only |
| `get_sdk_context_size` | Byte size of the embedded context — use to budget before fetching |

These three handlers run before the chain client is initialized, so they don't consume an RPC call.

### Indexer API (OptionBook data)

| Tool | Description |
|------|-------------|
| `get_stats` | Protocol statistics |
| `get_user_positions` | User's option positions |
| `get_user_history` | User's trade history |
| `get_referrer_stats` | Aggregated stats for a referrer address |

### State / RFQ API

| Tool | Description |
|------|-------------|
| `get_rfq` | Get specific RFQ by ID |
| `get_user_rfqs` | User's RFQ history |

### Market & Orders

| Tool | Description |
|------|-------------|
| `get_market_data` | Current prices for BTC, ETH, SOL, etc. |
| `get_market_prices` | All supported asset prices |
| `fetch_orders` | All orders from the order book |
| `filter_orders` | Filter orders by asset, type, or expiry |

### Token & Option Data

| Tool | Description |
|------|-------------|
| `get_token_balance` | Token balance for address |
| `get_token_allowance` | Token allowance for spender |
| `get_token_info` | Token decimals and symbol |
| `get_option_info` | Option contract details |
| `get_full_option_info` | All strikes, positions, and settlement status |
| `calculate_option_payout` | Calculate payout at settlement price |
| `preview_fill_order` | Dry-run order fill preview |

### MM Pricing

| Tool | Description |
|------|-------------|
| `get_mm_all_pricing` | All MM-adjusted pricing for an asset |
| `get_mm_ticker_pricing` | MM pricing for a specific ticker |
| `get_mm_position_pricing` | Position-aware MM pricing with collateral cost |
| `get_mm_spread_pricing` | MM pricing for a two-leg spread |
| `get_mm_condor_pricing` | MM pricing for a four-leg condor |
| `get_mm_butterfly_pricing` | MM pricing for a three-leg butterfly |

### RFQ Quotation Tools

| Tool | Description |
|------|-------------|
| `get_quotation` | Quotation info by ID including parameters and state |
| `get_quotation_count` | Total quotations created |
| `get_user_offers` | All RFQ offers made by a user |
| `get_user_options` | All options held by a user |
| `prepare_settle_rfq` | Build settlement call after reveal phase |
| `prepare_settle_rfq_early` | Build early-settlement call before offer period ends |
| `prepare_cancel_rfq` | Build RFQ cancellation call |
| `prepare_cancel_offer` | Build offer cancellation call |

### RFQ Builder Tools

| Tool | Description |
|------|-------------|
| `prepare_suggest_reserve_price` | Suggest a per-contract reserve price from the live IV surface |
| `prepare_request_rfq` | Auth-gated RFQ creation call bundle with product-specific strike validation |

### Calculation Tools

| Tool | Description |
|------|-------------|
| `calculate_payout` | Calculate payoff for structures |
| `calculate_num_contracts` | Number of contracts from trade amount |
| `calculate_collateral_required` | Collateral required for a position in USDC |
| `calculate_premium_per_contract` | Premium per contract in USD from MM price |
| `calculate_reserve_price` | Total reserve price (minimum acceptable premium) |
| `calculate_delivery_amount` | Delivery amount for physical options |
| `calculate_protocol_fee` | Protocol fee for an RFQ trade |
| `convert_decimals` | Convert to/from chain decimals |

### Validation Tools

| Tool | Description |
|------|-------------|
| `validate_butterfly` | Validate butterfly strike configuration |
| `validate_condor` | Validate condor strike configuration |
| `validate_iron_condor` | Validate iron condor strike configuration |
| `validate_ranger` | Validate ranger option strike configuration |

### Chain Configuration Tools

| Tool | Description |
|------|-------------|
| `get_chain_config` | Chain contracts and tokens |
| `get_chain_config_by_id` | Full chain configuration by chain ID |
| `get_token_config_by_id` | Token configuration by chain ID and symbol |
| `get_option_implementation_info` | All implementation addresses and deployment status |

### Prepare Tools (Transaction Builders)

| Tool | Description |
|------|-------------|
| `prepare_auth_challenge` | Mint a single-use auth challenge |
| `prepare_approve` | Auth-gated OptionFactory collateral-token approval |
| `prepare_request_rfq` | Build an RFQ creation call bundle |
| `prepare_suggest_reserve_price` | Suggest a reserve price for `prepare_request_rfq` |
| `prepare_make_offer` | Encrypt an offer and return typed data to sign |
| `prepare_make_offer_with_signature` | Build the make-offer call after signing |

### Event Query Tools

| Tool | Description |
|------|-------------|
| `get_order_fill_events` | Historical fill events |
| `get_option_created_events` | Historical option creation events |
| `get_quotation_requested_events` | Historical RFQ request events |
| `get_quotation_settled_events` | Historical RFQ settlement events |
| `get_position_closed_events` | Position close events for a specific option |

### Utility Tools

| Tool | Description |
|------|-------------|
| `parse_ticker` | Parse option ticker (e.g., "ETH-16FEB26-1800-P") into components |
| `build_ticker` | Build option ticker from components |
| `get_position_info` | Position information for buyer or seller |
| `generate_example_keypair` | Generate example ECDH keypair (demo only) |

### Ranger Tools (RangerOption — zone-bound 4-strike payoff)

| Tool | Description |
|------|-------------|
| `get_ranger_info` | Full state of a Ranger position (buyer, seller, strikes, zone, expiry) |
| `get_ranger_zone` | Inner zone bounds where the buyer earns max payout |
| `get_ranger_spread_width` | Per-leg spread width (s2-s1 == s4-s3) |
| `get_ranger_twap` | Current TWAP from the option's price-feed consumer |
| `calculate_ranger_payout` | On-chain payout at a specific settlement price |
| `simulate_ranger_payout` | Simulate payout for hypothetical strikes/numContracts (pure) |
| `calculate_ranger_required_collateral` | Required collateral for given strikes + numContracts |

### Loan Tools (Non-liquidatable lending)

| Tool | Description |
|------|-------------|
| `get_lending_opportunities` | Fetch unfilled loan limit orders from the loan indexer |
| `get_loan_request` | On-chain state for a specific loan quotation |
| `get_user_loans` | All loans for an address from the loan indexer |
| `get_loan_option_info` | Details for a loan-issued option (strike, expiry, collateral, underlying) |
| `is_loan_option_itm` | Whether a loan-issued option is currently in-the-money |
| `fetch_loan_pricing` | Deribit-style option pricing (30s cache) |
| `get_loan_strike_options` | Filtered strike options grouped by expiry |

### WheelVault Tools (Ethereum mainnet — chainId 1)

The current MCP process is pinned to Base (`chainId 8453`), so WheelVault tools throw `NETWORK_UNSUPPORTED` here. Use the TypeScript SDK with `chainId: 1` for Ethereum WheelVault access.

| Tool | Description |
|------|-------------|
| `get_wheel_vault_state` | Full state of a WheelVault series (balances, shares, last price) |
| `get_wheel_vault_series` | Raw on-chain series struct |
| `get_wheel_vault_series_count` | Total number of series in a WheelVault |
| `preview_wheel_deposit` | Pre-flight: expected shares minted for a paired deposit |
| `preview_wheel_withdraw` | Pre-flight: expected base/quote returned for a share redemption |
| `get_wheel_depth_chart` | Depth-chart data across IV buckets |
| `get_wheel_buyer_options` | Options held by a buyer (paginated via fromId/maxCount) |
| `get_wheel_seller_positions` | Seller exposures within a series |
| `get_wheel_claimable_summary` | Aggregate claimable amounts across multiple series |

### StrategyVault Tools (Base — Fixed-strike + CLVEX vaults)

| Tool | Description |
|------|-------------|
| `get_strategy_vault_state` | Full vault state (assets, shares, next expiry, recovery state) |
| `get_strategy_vault_total_assets` | Base + quote assets currently held |
| `get_strategy_vault_share_balance` | A user's share balance in a vault |
| `get_strategy_vault_next_expiry` | Next option-creation expiry timestamp |
| `can_strategy_vault_create_option` | Whether `createOption()` is currently eligible |
| `is_strategy_vault_recovery_mode` | Whether the vault is paused for emergency withdrawals |
| `get_all_strategy_vaults` | Live state of every fixed-strike + CLVEX vault |
| `get_fixed_strike_vaults` | Live state of fixed-strike vaults only |
| `get_clvex_vaults` | Live state of CLVEX directional/condor vaults only |

## Setup

### Build

```bash
cd mcp-server
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "thetanuts": {
      "command": "node",
      "args": ["/path/to/thetanuts-sdk/mcp-server/dist/index.js"],
      "env": {
        "THETANUTS_RPC_URL": "https://mainnet.base.org",
        "KEYSTORE_MASTER_KEY": "<32-byte-hex-for-prepare-tools>"
      }
    }
  }
}
```

### Other MCP Clients

Add to `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "thetanuts": {
      "command": "node",
      "args": ["./mcp-server/dist/index.js"]
    }
  }
}
```

### Development (no build required)

```bash
cd mcp-server
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THETANUTS_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint; this MCP currently constructs the SDK with `chainId: 8453` |
| `KEYSTORE_MASTER_KEY` | required for `prepare_*` RFQ write tools | 32-byte hex key used to encrypt the local RFQ ECDH keystore |
| `THETANUTS_KEYSTORE_PATH` | `./thetanuts-mcp-keystore.sqlite` | Optional path for the encrypted RFQ keystore |

## Example Calls

### Get market prices
```
Tool: get_market_data
Result: { prices: { BTC: 95000, ETH: 3200, ... } }
```

### Filter ETH call orders
```
Tool: filter_orders
Args: { asset: "ETH", type: "call" }
Result: { count: 5, orders: [...] }
```

### Get MM pricing for a specific ticker
```
Tool: get_mm_ticker_pricing
Args: { ticker: "ETH-28FEB26-2800-C" }
Result: { rawBidPrice: 0.0245, rawAskPrice: 0.0255, feeAdjustedBid: 0.0241, ... }
```

### Prepare a settlement call (returns calldata, does not send)
```
Tool: prepare_settle_rfq
Args: { quotationId: "744" }
Result: { chain: "base", calls: [{ to: "0x...", data: "0x...", value: "0x0" }] }
```

## See Also

- [mcp-server/README.md](../../mcp-server/README.md) — full setup instructions and examples
- [mcp-server/SPEC.md](../../mcp-server/SPEC.md) — tool parameter schemas
- [Error Handling](./error-handling.md) — error codes used by the underlying SDK
