# Thetanuts MCP Server

Read-only MCP (Model Context Protocol) server for the Thetanuts SDK.

## Features

**This server is READ-ONLY. It does NOT:**
- Execute transactions
- Handle private keys
- Perform any state-changing operations

### LLM context (call this first)

If you are an LLM connecting to this server for the first time, your single best move is to call `get_sdk_context` once and cache the result for the rest of the session. It returns the full embedded SDK context (every module, key types, common workflows, gotchas) — the same content as `<repo-root>/llms-full.txt`. Roughly 35 KiB of markdown.

#### Context Tools
| Tool | Description |
|------|-------------|
| `get_sdk_context` | Full long-form SDK context. Call this first — covers every module and the common gotchas |
| `get_sdk_context_index` | Curated index of canonical SDK docs (llmstxt.org spec) — links only |
| `get_sdk_context_size` | Byte size of the embedded context — use to budget before fetching |

The context is embedded at build time via the `prebuild` npm script (`scripts/embed-sdk-context.ts`), which reads `<repo-root>/llms.txt` and `<repo-root>/llms-full.txt` and writes them as TypeScript string constants into `src/sdk-context.generated.ts`. No filesystem access needed at runtime.

### Available Tools

#### Indexer API Tools (OptionBook data)
| Tool | Description |
|------|-------------|
| `get_stats` | Protocol statistics (from Indexer API) |
| `get_user_positions` | User's option positions (from Indexer API) |
| `get_user_history` | User's trade history (from Indexer API) |
| `get_referrer_stats` | Aggregated stats for a referrer address (book side, from Indexer API) |
| `get_factory_referrer_stats` | Referrer stats scoped to factory/RFQ side (RFQs, referral IDs, protocol stats) |
| `get_fees` | Accumulated referrer fees for a specific token on OptionBook |
| `get_all_claimable_fees` | All claimable fees across every collateral token for a referrer |

#### State/RFQ API Tools
| Tool | Description |
|------|-------------|
| `get_rfq` | Get specific RFQ by ID (from State/RFQ API) |
| `get_user_rfqs` | User's RFQ history (from State/RFQ API) |

#### Market & Orders
| Tool | Description |
|------|-------------|
| `get_market_data` | Current prices for BTC, ETH, SOL, etc. |
| `get_market_prices` | All supported asset prices |
| `fetch_orders` | All orders from the orderbook |
| `filter_orders` | Filter orders by asset/type/expiry |

#### Token & Option Data
| Tool | Description |
|------|-------------|
| `get_token_balance` | Token balance for address |
| `get_token_allowance` | Token allowance for spender |
| `get_token_info` | Token decimals and symbol |
| `get_option_info` | Option contract details |
| `calculate_option_payout` | Calculate payout for an option at settlement price |
| `preview_fill_order` | Preview order fill (dry-run) |

#### Utilities
| Tool | Description |
|------|-------------|
| `calculate_payout` | Calculate payoff for structures |
| `convert_decimals` | Convert to/from chain decimals |
| `get_order_fill_events` | Historical fill events |
| `get_chain_config` | Chain contracts and tokens |

#### MM Pricing
| Tool | Description |
|------|-------------|
| `get_mm_all_pricing` | Get all MM-adjusted pricing for an asset |
| `get_mm_ticker_pricing` | Get MM pricing for a specific ticker |
| `get_mm_position_pricing` | Get position-aware MM pricing with collateral cost |
| `get_mm_spread_pricing` | Get MM pricing for a two-leg spread |
| `get_mm_condor_pricing` | Get MM pricing for a four-leg condor |
| `get_mm_butterfly_pricing` | Get MM pricing for a three-leg butterfly |

#### RFQ Quotation Tools
| Tool | Description |
|------|-------------|
| `get_quotation` | Get detailed quotation info by ID including parameters and current state |
| `get_quotation_count` | Get total number of quotations created |
| `get_user_offers` | Get all RFQ offers made by a user |
| `get_user_options` | Get all options held by a user |
| `encode_settle_quotation` | Encode settlement transaction for an RFQ after reveal phase (returns tx data) |
| `encode_settle_quotation_early` | Encode early settlement to accept a specific offer before offer period ends |
| `encode_cancel_quotation` | Encode cancellation transaction for an RFQ (requester only) |
| `encode_cancel_offer` | Encode offer cancellation transaction (offeror only) |

#### RFQ Builder Tools
| Tool | Description |
|------|-------------|
| `build_rfq_request` | Build RFQ request parameters for vanilla PUT or CALL option |
| `build_spread_rfq` | Build RFQ request for a two-leg spread (put spread or call spread) |
| `build_butterfly_rfq` | Build RFQ request for a three-leg butterfly |
| `build_condor_rfq` | Build RFQ request for a four-leg condor (all calls or all puts) |
| `build_iron_condor_rfq` | Build RFQ request for a four-leg iron condor (put spread + call spread) |
| `build_physical_option_rfq` | Build RFQ request for physical-settled vanilla PUT or CALL |
| `encode_request_for_quotation` | Encode RFQ creation transaction from built request parameters |

#### Calculation Tools
| Tool | Description |
|------|-------------|
| `calculate_num_contracts` | Calculate number of contracts from trade amount |
| `calculate_collateral_required` | Calculate collateral required for a position in USDC |
| `calculate_premium_per_contract` | Calculate premium per contract in USD from MM price |
| `calculate_reserve_price` | Calculate total reserve price (minimum acceptable premium) |
| `calculate_delivery_amount` | Calculate delivery amount for physical options |
| `calculate_protocol_fee` | Calculate protocol fee for an RFQ trade |

#### Validation Tools
| Tool | Description |
|------|-------------|
| `validate_butterfly` | Validate butterfly option strike configuration (3 strikes with equal wing widths) |
| `validate_condor` | Validate condor option strike configuration (4 strikes with equal spread widths) |
| `validate_iron_condor` | Validate iron condor strike configuration (put spread below, call spread above) |
| `validate_ranger` | Validate ranger (range) option strike configuration (2 strikes) |

#### Chain Configuration Tools
| Tool | Description |
|------|-------------|
| `get_chain_config_by_id` | Get full chain configuration by chain ID |
| `get_token_config_by_id` | Get token configuration (address, decimals) by chain ID and symbol |
| `get_option_implementation_info` | Get all option implementation addresses and deployment status |
| `generate_example_keypair` | Generate an example ECDH keypair (for demonstration only) |

#### Option Query Tools
| Tool | Description |
|------|-------------|
| `get_full_option_info` | Get comprehensive option information including all strikes, positions, and settlement status |
| `get_position_info` | Get position information for buyer or seller of an option |
| `parse_ticker` | Parse an option ticker string (e.g., "ETH-16FEB26-1800-P") into its components |
| `build_ticker` | Build an option ticker string from components |

#### Event Query Tools
| Tool | Description |
|------|-------------|
| `get_option_created_events` | Get historical option creation events |
| `get_quotation_requested_events` | Get historical RFQ quotation requested events |
| `get_quotation_settled_events` | Get historical RFQ quotation settled events |
| `get_position_closed_events` | Get historical position closed events for a specific option contract |

#### Encoding Tools (Transaction Builders)
| Tool | Description |
|------|-------------|
| `encode_fill_order` | Encode a transaction to fill an order from the orderbook |
| `encode_approve` | Encode a token approval transaction |

**Note:** Encoding tools return transaction data for wallet signing - they do NOT execute transactions.

#### Ranger Tools (RangerOption — zone-bound 4-strike payoff)
| Tool | Description |
|------|-------------|
| `get_ranger_info` | Full state of a Ranger position (buyer, seller, strikes, zone, expiry) |
| `get_ranger_zone` | Inner zone bounds where the buyer earns max payout |
| `get_ranger_spread_width` | Per-leg spread width (s2-s1 == s4-s3) |
| `get_ranger_twap` | Current TWAP from the option's price-feed consumer |
| `calculate_ranger_payout` | On-chain payout at a specific settlement price |
| `simulate_ranger_payout` | Simulate payout for hypothetical strikes/numContracts (pure) |
| `calculate_ranger_required_collateral` | Required collateral for given strikes + numContracts |

#### Loan Tools (Non-liquidatable lending)
| Tool | Description |
|------|-------------|
| `get_lending_opportunities` | Fetch unfilled loan limit orders from the loan indexer |
| `get_loan_request` | On-chain state for a specific loan quotation |
| `get_user_loans` | All loans for an address from the loan indexer |
| `get_loan_option_info` | Details for a loan-issued option (strike, expiry, collateral, underlying) |
| `is_loan_option_itm` | Whether a loan-issued option is currently in-the-money |
| `fetch_loan_pricing` | Deribit-style option pricing (30s cache) |
| `get_loan_strike_options` | Filtered strike options grouped by expiry |

#### WheelVault Tools (Ethereum mainnet — chainId 1)
WheelVault is gated to Ethereum mainnet. These tools require `THETANUTS_RPC_URL` to point at an Ethereum RPC; they throw `NETWORK_UNSUPPORTED` on Base.

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

#### StrategyVault Tools (Base — Fixed-strike + CLVEX vaults)
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

## Installation

The published package is on npm — no clone required.

```bash
# Run via npx (no install)
npx -y @thetanuts-finance/mcp

# Or install globally
npm install -g @thetanuts-finance/mcp
```

To hack on the server locally (changes to source need a fresh build):

```bash
git clone https://github.com/Thetanuts-Finance/thetanuts-sdk.git
cd thetanuts-sdk/mcp-server
npm install
npm run build
```

## Usage

### With Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "thetanuts": {
      "command": "npx",
      "args": ["-y", "@thetanuts-finance/mcp"],
      "env": {
        "THETANUTS_RPC_URL": "https://mainnet.base.org"
      }
    }
  }
}
```

### With Clawdbot / other MCP clients

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "thetanuts": {
      "command": "npx",
      "args": ["-y", "@thetanuts-finance/mcp"]
    }
  }
}
```

### Local development (running from source)

```bash
cd mcp-server
npm run dev  # Run with tsx (no build needed)
```

If you want Claude Desktop to point at your local checkout instead of npm, swap the `command` to `node` and `args` to `["/absolute/path/to/thetanuts-sdk/mcp-server/dist/index.js"]`.

## Need to execute, not just read?

**This server is read-only by design.** It never holds private keys, never signs messages, never broadcasts transactions. Why: an LLM with wallet write access plus untrusted text in its context window is one prompt injection away from a drained wallet. The May 2026 Bankr/Grok incident (~$150K drained via a Morse-encoded reply on X) is the canonical example of why agentic-wallet patterns need to be carefully separated.

The right pattern for execution is **transaction-crafter**: the Thetanuts MCP builds the unsigned calldata, a separate signer-MCP signs and broadcasts in a wallet you control.

The `encode_*` tools already do half of this:

- `encode_fill_order` — fill an OptionBook order
- `encode_request_for_quotation` — submit an RFQ
- `encode_settle_quotation`, `encode_settle_quotation_early`, `encode_cancel_quotation`, `encode_cancel_offer` — RFQ lifecycle
- `encode_approve` — ERC20 approval

Each returns calldata (`{to, data, value}`) you hand to a signer-MCP. Concrete signer-MCP options to pair with:

| Signer-MCP | What signs the tx | Best for |
|---|---|---|
| [`metamask-mcp`](https://github.com/Xiawpohr/metamask-mcp) | Your real MetaMask extension via EIP-6963 | Single-user manual approval per tx |
| [`nikicat/mcp-wallet-signer`](https://github.com/nikicat/mcp-wallet-signer) | Generic browser wallet picker (MetaMask, Rabby, Coinbase Wallet) | Multi-wallet single-user setups |
| [`base-mcp`](https://mcpservers.org/servers/base/base-mcp) + [Coinbase AgentKit](https://docs.cdp.coinbase.com/agent-kit/core-concepts/model-context-protocol) | TEE/MPC keys in CDP Server Wallets v2 with policy engine | Autonomous agentic flows with per-tx caps |
| [`safe-mcp-server`](https://github.com/5ajaki/safe-mcp-server) | Multisig — agent proposes, M-of-N humans sign | Treasury / institutional flows |

A typical LLM workflow:

1. Ask Thetanuts MCP to build the tx: "Use `encode_fill_order` for the cheapest ETH put expiring next Friday."
2. Pass the resulting calldata to your signer-MCP: "Sign and send this tx using my MetaMask."
3. Confirm in your wallet UI. Done.

This split keeps the Thetanuts MCP surface read-only forever. The signer holds keys; we don't.

For the full "FORBIDDEN operations" list, see [SPEC.md](./SPEC.md).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THETANUTS_RPC_URL` | `https://mainnet.base.org` | RPC endpoint |

## Examples

### Get Market Data
```
Tool: get_market_data
Result: { prices: { BTC: 95000, ETH: 3200, ... } }
```

### Filter ETH Calls
```
Tool: filter_orders
Args: { asset: "ETH", type: "call" }
Result: { count: 5, orders: [...] }
```

### Get MM Pricing
```
Tool: get_mm_ticker_pricing
Args: { ticker: "ETH-28FEB26-2800-C" }
Result: {
  ticker: "ETH-28FEB26-2800-C",
  rawBidPrice: 0.0245,
  rawAskPrice: 0.0255,
  feeAdjustedBid: 0.0241,
  feeAdjustedAsk: 0.0259,
  strike: 2800,
  expiry: 1740700800,
  isCall: true,
  byCollateral: { ... }
}
```

### Get RFQ Quotation
```
Tool: get_quotation
Args: { quotationId: "744" }
Result: {
  quotationId: "744",
  requester: "0x...",
  status: "SETTLED",
  parameters: { ... },
  offers: [ ... ]
}
```

### Encode Settlement Transaction
```
Tool: encode_settle_quotation
Args: { quotationId: "744" }
Result: {
  to: "0x...",           // OptionFactory address
  data: "0x...",         // Encoded calldata
  description: "Settle quotation 744"
}
```

**Note:** Use the returned `to` and `data` with your wallet to sign and send the transaction.

## License

MIT
