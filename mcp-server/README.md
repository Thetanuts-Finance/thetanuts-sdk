# Thetanuts MCP Server

MCP (Model Context Protocol) server for the Thetanuts SDK. Exposes ~100 tools that let an LLM read state, build transactions, run pricing math, and ship orders end-to-end.

## How it's organized

The server **builds transactions but doesn't sign them.** The signing layer is intentionally separate — pair this MCP with a signer-MCP (MetaMask, Coinbase AgentKit, Safe, or any signer the LLM can call) and you have full execution. See [How to actually fill orders](#how-to-actually-fill-orders) below for the composition pattern and why it's split this way.

This server **does not** hold private keys, sign messages, or broadcast transactions on its own. That layer is your wallet's job — by design, so an LLM can't be tricked into authorizing transactions you never intended.

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
| `prepare_settle_rfq` | Build settlement call for an RFQ after reveal phase |
| `prepare_settle_rfq_early` | Build early-settlement call to accept a specific offer before offer period ends |
| `prepare_cancel_rfq` | Build cancellation call for an RFQ (requester only) |
| `prepare_cancel_offer` | Build offer-cancellation call (offeror only) |

#### RFQ Builder Tools
| Tool | Description |
|------|-------------|
| `build_rfq_request` | Build RFQ request parameters for vanilla PUT or CALL option |
| `build_spread_rfq` | Build RFQ request for a two-leg spread (put spread or call spread) |
| `build_butterfly_rfq` | Build RFQ request for a three-leg butterfly |
| `build_condor_rfq` | Build RFQ request for a four-leg condor (all calls or all puts) |
| `build_iron_condor_rfq` | Build RFQ request for a four-leg iron condor (put spread + call spread) |
| `build_physical_option_rfq` | Build RFQ request for physical-settled vanilla PUT or CALL |
| `prepare_request_rfq` | Build an RFQ creation call bundle, including exact approval when needed |

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
| `validate_ranger` | Validate ranger (zone-bound) option strike configuration (4 strikes: `[callLower, callUpper, putLower, putUpper]`, equal spread widths, callUpper < putLower) |

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

#### Prepare Tools (Transaction Builders)
| Tool | Description |
|------|-------------|
| `prepare_auth_challenge` | Mint a single-use auth challenge for keystore-touching RFQ tools |
| `prepare_approve` | Auth-gated explicit approval for configured collateral tokens to the current OptionFactory |
| `prepare_make_offer` | Encrypt an offer and return EIP-712 typed data to sign |
| `prepare_make_offer_with_signature` | Build the make-offer call after typed-data signing |

**Note:** Prepare tools return Base-MCP-ready `{ chain, calls }` envelopes for wallet signing - they do NOT execute transactions.

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

## Install in your MCP client

[![Add to Cursor](https://img.shields.io/badge/Add_to-Cursor-000000?style=for-the-badge&logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=thetanuts&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB0aGV0YW51dHMtZmluYW5jZS9tY3AiXX0=)
[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22name%22%3A%22thetanuts%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40thetanuts-finance%2Fmcp%22%5D%7D)

**Cursor** and **VS Code** support one-click installation; click either badge to register the server with the IDE. Other clients require a single command or JSON snippet, documented below.

<details>
<summary><b>Claude Code</b> — single command (or commit <code>.mcp.json</code> for your team)</summary>

```bash
claude mcp add --transport stdio thetanuts -- npx -y @thetanuts-finance/mcp
```

For team installations, commit a `.mcp.json` file to your repository root and every developer receives the configuration automatically. See [Team setup](#team-setup) below.
</details>

<details>
<summary><b>Claude Desktop</b> — edit config JSON</summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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
</details>

<details>
<summary><b>Antigravity</b> — Agent Panel → ⋯ → MCP Servers → raw config</summary>

Open the **Agent Panel → ⋯ menu → MCP Servers → Manage MCP Servers → View raw config** and paste the configuration below. The config file is located at `~/.gemini/antigravity/mcp_config.json` on macOS and Linux.

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
</details>

<details>
<summary><b>Cline, Continue, other MCP clients</b></summary>

Paste this JSON into your client's MCP configuration file (typically `.mcp.json` at the workspace root, or via the client's settings UI):

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
</details>

After installation, restart your client. A `thetanuts` indicator will appear once the server has connected, typically within five seconds on first run while `npx` fetches the package.

## Team setup

Teams building on `@thetanuts-finance/thetanuts-client` are recommended to commit a `.mcp.json` file at the repository root. Every developer using **Claude Code** within the repository receives the MCP server configuration automatically, with no per-developer setup.

```json
{
  "mcpServers": {
    "thetanuts": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@thetanuts-finance/mcp"]
    }
  }
}
```

On first invocation within the repository, Claude Code prompts each user to approve the workspace's MCP servers; subsequent loads are automatic.

## Local development (contributors)

```bash
git clone https://github.com/Thetanuts-Finance/thetanuts-sdk.git
cd thetanuts-sdk/mcp-server
npm install
npm run dev   # Run with tsx; no build step required
```

If you want Claude Desktop to point at your local checkout instead of npm, swap the `command` to `node` and `args` to `["/absolute/path/to/thetanuts-sdk/mcp-server/dist/index.js"]`.

## How to actually fill orders

**You can fill orders, create RFQs, settle quotations, and approve tokens with this MCP.** The execution flow is just split across two MCP servers — by design, for security. Here's the picture and why.

### The split: Thetanuts MCP builds the tx, a signer-MCP signs it

Every transaction has two parts: the **calldata** (what to do) and the **signature** (the user authorizing it).

This MCP does the first part. The `prepare_*` tools return ready-to-sign call envelopes:

| Tool | What it builds |
|---|---|
| `prepare_request_rfq` | Submit an RFQ, with approval prepended when needed |
| `prepare_make_offer` / `_with_signature` | Create and submit an encrypted RFQ offer |
| `prepare_settle_rfq` / `_early` | Settle an RFQ after / before reveal |
| `prepare_cancel_rfq` / `_offer` | Cancel an RFQ or an MM offer |
| `prepare_approve` | Auth-gated ERC20 approval outside the RFQ flow, limited to configured collateral tokens and the current OptionFactory |

Each returns an object like `{ chain: "base", calls: [{ to: "0x...", data: "0x...", value: "0x0" }] }` — the calldata your wallet broadcasts. **All you need to actually send it is a signature.**

For the signature, you compose this MCP with one of these:

| Signer-MCP | Where the key lives | Best for |
|---|---|---|
| [`metamask-mcp`](https://github.com/Xiawpohr/metamask-mcp) | Your MetaMask extension (EIP-6963) | Single user, manual click-confirm per tx |
| [`nikicat/mcp-wallet-signer`](https://github.com/nikicat/mcp-wallet-signer) | Any browser wallet picker (MetaMask, Rabby, Coinbase) | Multi-wallet single-user setups |
| [`base-mcp`](https://mcpservers.org/servers/base/base-mcp) + [Coinbase AgentKit](https://docs.cdp.coinbase.com/agent-kit/core-concepts/model-context-protocol) | Coinbase CDP Server Wallets v2 (TEE/MPC) with programmable policies | Autonomous agentic flows ("max $500/tx, only Thetanuts contracts") — no per-tx click |
| [`safe-mcp-server`](https://github.com/5ajaki/safe-mcp-server) | Gnosis Safe multisig — agent proposes, M-of-N humans sign | Treasury / institutional flows |

### What it looks like end to end

In Claude Desktop (or any MCP client), wire up both servers:

```json
{
  "mcpServers": {
    "thetanuts": {
      "command": "npx",
      "args": ["-y", "@thetanuts-finance/mcp"]
    },
    "wallet": {
      "command": "npx",
      "args": ["-y", "metamask-mcp"]
    }
  }
}
```

Then ask Claude:

> "Find the cheapest ETH put expiring next Friday for 1 contract, build the fill, sign it with my wallet, and send."

Claude calls `thetanuts.fetch_orders`, picks the order, calls the appropriate `thetanuts.prepare_*` tool to get calldata, hands the call envelope to your signer MCP. Your wallet pops up with the transaction details. You click confirm. The transaction executes on-chain.

For autonomous flows where you don't want to click every time, swap MetaMask for Coinbase AgentKit:

```json
{
  "mcpServers": {
    "thetanuts": { "command": "npx", "args": ["-y", "@thetanuts-finance/mcp"] },
    "wallet":    { "command": "npx", "args": ["-y", "@coinbase/cdp-mcp"] }
  }
}
```

CDP holds the key in a Trusted Execution Environment behind a policy you set ("max 5 tx/hour, max $500/tx, only Thetanuts contracts"). The agent can fill orders without per-tx confirmation, but it can't violate the policy you set.

### Why this is split (the security reason)

If this MCP held a private key directly, an LLM could be tricked into signing transactions you never intended. Real example from May 2026: **the Bankr/Grok agent lost ~$150K** when an attacker replied to its X thread with a Morse-encoded "send 3B DRB to 0x…". Grok decoded the prompt and Bankr executed.

Splitting calldata-building from signing puts a hard checkpoint between "an LLM proposed this transaction" and "this transaction got broadcast." That checkpoint is either your wallet UI (manual mode) or a policy engine (autonomous mode). Either way, the protocol-knowledge layer (Thetanuts MCP) and the key-custody layer (signer-MCP) are independently auditable, independently versioned, and independently swappable.

This is the same architecture every DeFi frontend uses: the website builds the calldata, your wallet signs. The Thetanuts MCP is the same idea, exposed for LLMs.

### TL;DR

- **Want to read?** This MCP alone is enough.
- **Want to fill orders?** This MCP + a signer-MCP. You stay in control of signing.
- **Want autonomous agents?** This MCP + Coinbase AgentKit (or Safe, or thirdweb Engine) with policies you configure.

For the full SDK context (every module, every workflow, every gotcha), call `get_sdk_context` once at session start.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `THETANUTS_RPC_URL` | `https://mainnet.base.org` | RPC endpoint |
| `KEYSTORE_MASTER_KEY` | required for `prepare_*` RFQ write tools | 32-byte hex key used to encrypt the local RFQ ECDH keystore. Generate with `openssl rand -hex 32` |
| `THETANUTS_KEYSTORE_PATH` | `./thetanuts-mcp-keystore.sqlite` | Optional path for the encrypted RFQ keystore |

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

### Prepare Settlement Transaction
```
Tool: prepare_settle_rfq
Args: { quotationId: "744" }
Result: {
  chain: "base",
  calls: [{ to: "0x...", data: "0x...", value: "0x0" }]
}
```

**Note:** Pass the returned `chain` and `calls` envelope to your wallet MCP to sign and send the transaction.

## License

MIT
