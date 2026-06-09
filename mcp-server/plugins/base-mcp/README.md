# Thetanuts × Base MCP Plugin

A [Base MCP](https://docs.base.org/ai-agents) plugin that lets any MCP-aware LLM (Claude Desktop, Claude Code, Cursor, ChatGPT, Codex, Hermes) trade options on Thetanuts Finance using Base Account for signing.

## How it works

Base MCP gives the LLM a Base Account smart wallet plus a `send_calls` tool. This plugin adds a **markdown skill** (`SKILL.md` + `plugins/thetanuts.md`) that teaches the LLM how to call the `prepare_*` tools on the Thetanuts MCP (`@thetanuts-finance/mcp` v1.0.0+). Each prepare tool returns Base-MCP-ready `{ chain, calls }`, which the LLM passes to `send_calls` for user approval and signing.

The plugin itself never signs, never broadcasts, never holds keys. All signing happens inside Base Account.

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

## Install

### Prerequisites

1. Base MCP installed in your client. See https://docs.base.org/ai-agents/quickstart.
2. The Thetanuts MCP installed:
   ```bash
   claude mcp add thetanuts-mcp \
     -e KEYSTORE_MASTER_KEY="$(openssl rand -hex 32)" \
     -- npx -y @thetanuts-finance/mcp
   ```
   (Or the equivalent in Claude Desktop / Cursor / etc.)
3. A funded Base Account on Base mainnet (8453).

> **v1.0.0 change:** The separate `@thetanuts-finance/prepare-service` MCP has been merged into `@thetanuts-finance/mcp`. There is no longer a `thetanuts-prepare` MCP — remove any leftover entry from your client config.

### Claude Desktop / Claude.ai

Upload the skill as a custom skill:
1. Zip the contents of this directory (`SKILL.md`, `plugins/thetanuts.md`, `README.md`).
2. Open https://claude.ai/customize/skills → **Upload skill**.
3. Select the zip. The skill loads alongside Base MCP automatically when the user mentions Thetanuts.

### Claude Code

```bash
npx skills add Thetanuts-Finance/thetanuts-sdk \
  --skill mcp-server/plugins/base-mcp \
  -a claude-code
```

Or paste the raw skill URL into chat:

```
https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/mcp-server/plugins/base-mcp/SKILL.md
```

Claude Code fetches `SKILL.md` and lazy-loads `plugins/thetanuts.md` on demand.

### Cursor / Codex / Hermes

Same `npx skills add ... -a [cursor|codex|hermes]` pattern.

### ChatGPT

Upload the zip at https://chatgpt.com/skills.

## What this plugin can do

| Workflow | Tool | Notes |
|---|---|---|
| Request a quote (RFQ) | `mcp__thetanuts-mcp__prepare_request_rfq` | 9 products: PUT, CALL, spreads, flies, condors, iron condor |
| Make an offer on an RFQ | `mcp__thetanuts-mcp__prepare_make_offer` | Two-step signed flow; offer encrypted server-side via ECDH |
| Settle accepted quotation | `mcp__thetanuts-mcp__prepare_settle_rfq` | |
| Early settlement | `mcp__thetanuts-mcp__prepare_settle_rfq_early` | Decrypts offer server-side |
| Cancel your RFQ | `mcp__thetanuts-mcp__prepare_cancel_rfq` | |
| Cancel your offer | `mcp__thetanuts-mcp__prepare_cancel_offer` | |
| Standalone approve | `mcp__thetanuts-mcp__prepare_approve` | Bundled automatically by RFQ when needed |

OptionBook fills (`fill-order`, `swap-and-fill`) and atomic `swap-and-call` are **not** surfaced — see the design plan's Phase A.6 for rationale. RFQ is the only write path.

Reads (orderbook, positions, RFQs, IV surface, pricing) are served by the same Thetanuts MCP — this plugin focuses on the **signed-write** path.

## Out of scope (v1)

- Vault deposits/withdrawals (`strategyVault`, `wheelVault`)
- Ethereum mainnet (chainId 1)
- Physical-settled options multi-leg (only PHYSICAL_CALL / PHYSICAL_PUT are deployed)
- Loan flows (`client.loan`)

These will land in v2 once the v1 RFQ surface is stable.

## RFQ key management — important

RFQ requesters need an ECDH keypair so market makers can encrypt offers to them; market makers need the requester's public key to encrypt and need to decrypt offers themselves at settlement. **The Thetanuts MCP handles all of this server-side**:

- `prepare_request_rfq` derives or loads a per-wallet ECDH keypair from an encrypted SQLite keystore, stores the private key under AES-256-GCM with per-row scrypt salt, and includes the public key in the calldata. The LLM never sees the key.
- `prepare_make_offer` fetches the requester's public key from the State API and encrypts the offer before encoding the call.
- `prepare_settle_rfq_early` decrypts the offer using the requester's stored private key before encoding the call.

Keystore encryption is rooted in the `KEYSTORE_MASTER_KEY` env var (32 bytes hex). Plain-text keys never leave the process.

## Spec compliance

This plugin follows the Base MCP custom plugin spec at https://docs.base.org/ai-agents/plugins/custom-plugins:

- **Markdown-only plugin file** (`plugins/thetanuts.md`)
- **Base MCP send_calls envelope** on every prepare tool: `{ chain, calls: [{ step, to, data, value }, ...] }`
- **No private keys, no local signing, no `cast send`** — all execution flows through Base MCP's `send_calls`
- **Onboarding gate** in the plugin frontmatter — refuses to act before `get_wallets`

## Status

**v1.0.0** — single Thetanuts MCP. Previously the architecture was three MCPs (Base + read-only Thetanuts + prepare-service); the latter two have been folded into one.

## Source

- Plugin spec: [`plugins/thetanuts.md`](./plugins/thetanuts.md) ← *(see `thetanuts.md` in this directory; the `plugins/` prefix is required by Base MCP's loader)*
- Skill manifest: [`SKILL.md`](./SKILL.md)
- SDK encode helpers wrapped by `prepare_*`:
  - `src/modules/erc20.ts` (`encodeApprove`)
  - `src/modules/optionFactory.ts` (`encodeRequestForQuotation`, `encodeMakeOfferForQuotation`, `encodeSettleQuotation`, `encodeSettleQuotationEarly`, `encodeCancelQuotation`, `encodeCancelOfferForQuotation`)
</content>
</invoke>