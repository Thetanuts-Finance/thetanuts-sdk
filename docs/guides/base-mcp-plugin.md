# Trade from Chat — the Base MCP Plugin

The Base MCP plugin lets anyone trade Thetanuts options from a chat client (Claude Desktop, Claude Code, Cursor, ChatGPT, Codex) **while keeping every signature in their own hands**. The LLM prepares the trade; you approve it in [Base Account](https://docs.base.org/ai-agents/quickstart). The plugin never signs, never broadcasts, never holds keys.

Source: [`mcp-server/plugins/base-mcp/`](https://github.com/Thetanuts-Finance/thetanuts-sdk/tree/main/mcp-server/plugins/base-mcp) — it follows Base's [custom plugin spec](https://docs.base.org/ai-agents/plugins/custom-plugins).

## How it works

Two MCP servers split the job — protocol knowledge and key custody never share a process:

```
┌─────────────┐   prepare_*    ┌──────────────────────────┐    encode*    ┌──────────────┐
│ LLM (Claude │ ─────────────▶ │ Thetanuts MCP (stdio)    │ ────────────▶ │ Thetanuts    │
│  + Base MCP)│                │ v1.0.0+                  │               │ SDK helpers  │
│             │ ◀───────────── │ → { chain, calls[] }     │               │              │
└──────┬──────┘   unsigned tx  └──────────────────────────┘               └──────────────┘
       │
       │ send_calls
       ▼
┌─────────────┐
│ Base Account│ → user approval → tx broadcast on Base 8453
└─────────────┘
```

The Thetanuts MCP's `prepare_*` tools return Base-MCP-ready `{ chain, calls }` envelopes; the LLM hands them to Base MCP's `send_calls`; you review and confirm in Base Account.

## Install

1. **Base MCP** in your client — see the [Base quickstart](https://docs.base.org/ai-agents/quickstart).
2. **Thetanuts MCP** (v1.0.0+):

   ```bash
   claude mcp add thetanuts-mcp \
     -e KEYSTORE_MASTER_KEY="$(openssl rand -hex 32)" \
     -- npx -y @thetanuts-finance/mcp
   ```

   (Equivalent config-file entries for Claude Desktop / Cursor / Codex.)
3. **The plugin skill**:

   ```bash
   npx skills add Thetanuts-Finance/thetanuts-sdk \
     --skill mcp-server/plugins/base-mcp \
     -a claude-code        # or: cursor | codex | hermes
   ```

   For Claude Desktop / claude.ai or ChatGPT, zip the plugin directory and upload it as a custom skill.
4. A funded Base Account on Base mainnet (USDC for collateral/premium, a little ETH for gas).

## What it can do

RFQ is the only write path: request quotes (all 9 products — puts, calls, spreads, butterflies, condors, iron condors), make sealed-bid offers, settle (normal or early), cancel, and standalone approvals. OptionBook fills are deliberately not surfaced — their silent-rejection failure modes (maker offline, indexer lag, race-loss) make poor first-trade UX in chat. Reads (orderbook, positions, IV surface, pricing) come from the same Thetanuts MCP.

## RFQ keys, handled for you

Sealed-bid RFQs need an ECDH keypair so market makers can encrypt offers to you. The Thetanuts MCP manages this server-side: keys are derived per wallet, stored AES-256-GCM-encrypted in a local SQLite keystore rooted in your `KEYSTORE_MASTER_KEY`, and **never enter the LLM transcript**. These are encryption keys only — they cannot move funds.

## Out of scope (v1)

Vault deposits/withdrawals, Ethereum mainnet (chainId 1), physical multi-leg options, and loan flows.

## See also

- [AI Agents overview](agents-overview.md) — how this route compares to autonomous AgentKit trading
- [MCP Server guide](mcp-server.md) — the full tool reference behind this plugin
