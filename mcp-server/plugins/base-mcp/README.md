# Thetanuts × Base MCP Plugin

A [Base MCP](https://docs.base.org/ai-agents) plugin that lets any MCP-aware LLM (Claude Desktop, Claude Code, Cursor, ChatGPT, Codex, Hermes) trade options on Thetanuts Finance using Base Account for signing.

## How it works

Base MCP gives the LLM a Base Account smart wallet plus a `send_calls` tool. This plugin adds a **markdown skill** (`SKILL.md` + `plugins/thetanuts.md`) that teaches the LLM how to call the Thetanuts prepare API at `https://api.thetanuts.finance/v1/prepare/*`. The prepare API returns unsigned calldata (`{ to, data, value, chainId }`), which the LLM passes to `send_calls` for user approval and signing.

The plugin itself never signs, never broadcasts, never holds keys. All signing happens inside Base Account.

```
┌─────────────┐    web_request    ┌──────────────────────────┐    encode*    ┌──────────────┐
│ LLM (Claude │ ────────────────▶ │ api.thetanuts.finance    │ ────────────▶ │ Thetanuts    │
│  + Base MCP)│                   │ /v1/prepare/*            │               │ SDK helpers  │
│             │ ◀──────────────── │ → {transactions:[...]}   │               │ (read-only)  │
└──────┬──────┘   unsigned tx     └──────────────────────────┘               └──────────────┘
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
2. A funded Base Account on Base mainnet (8453).

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

| Workflow | Endpoint | Notes |
|---|---|---|
| Fill an orderbook limit order | `POST /v1/prepare/fill-order` | Bundles approval if needed |
| Atomic swap-then-fill | `POST /v1/prepare/swap-and-fill` | Pay in any token |
| Request a quote (RFQ) | `POST /v1/prepare/request-rfq` | All 10 products: PUT, CALL, spreads, flies, condors, iron condor, RANGER |
| Make an offer on an RFQ | `POST /v1/prepare/make-offer` | Offer is encrypted server-side via ECDH |
| Settle accepted quotation | `POST /v1/prepare/settle-rfq` | |
| Early settlement | `POST /v1/prepare/settle-rfq-early` | Decrypts offer server-side |
| Cancel your RFQ | `POST /v1/prepare/cancel-rfq` | |
| Cancel your offer | `POST /v1/prepare/cancel-offer` | |
| Atomic swap + RFQ action | `POST /v1/prepare/swap-and-call` | Wraps native ETH or swaps any token to collateral |
| Standalone approve | `POST /v1/prepare/approve` | Only when explicit |

Reads (orderbook, positions, RFQs, IV surface, pricing) are served by the existing Indexer/State API and by the read-only MCP `@thetanuts-finance/mcp` — this plugin focuses on the **signed-write** path.

## Out of scope (v1)

- Vault deposits/withdrawals (`strategyVault`, `wheelVault`)
- Ethereum mainnet (chainId 1)
- Physical-settled options multi-leg (only PHYSICAL_CALL / PHYSICAL_PUT are deployed)
- Loan flows (`client.loan`)

These will land in v2 once the v1 RFQ surface is stable.

## RFQ key management — important

RFQ requesters need an ECDH keypair so market makers can encrypt offers to them; market makers need the requester's public key to encrypt and need to decrypt offers themselves at settlement. **The prepare API handles all of this server-side**:

- `POST /v1/prepare/request-rfq` derives a deterministic ECDH keypair scoped to the requester's address, stores the private key in an encrypted server-side keystore, and includes the public key in the calldata. The LLM never sees the key.
- `POST /v1/prepare/make-offer` fetches the requester's public key from on-chain state and encrypts the offer before encoding the call.
- `POST /v1/prepare/settle-rfq-early` decrypts the offer using the requester's stored private key before encoding the call.

This means the prepare service must run with access to the keystore. Plain-text keys never leave the service. See the prepare service implementation for details.

## Spec compliance

This plugin follows the Base MCP custom plugin spec at https://docs.base.org/ai-agents/plugins/custom-plugins:

- **Markdown-only plugin file** (`plugins/thetanuts.md`)
- **Ordered batch response shape** on every prepare endpoint: `{ transactions: [{ step, to, data, value, chainId }, ...] }`
- **No private keys, no local signing, no `cast send`** — all execution flows through Base MCP's `send_calls`
- **Onboarding gate** in the plugin frontmatter — refuses to act before `get_wallets`

## Status

**Phase A of the Thetanuts agent integration.** Phase B (AgentKit ActionProvider for autonomous backends) lives in the sibling repo `thetanuts-agentkit` (not yet published). Phase C (worked example agent) will land under `examples/options-trading-agent/`.

## Source

- Plugin spec: [`plugins/thetanuts.md`](./plugins/thetanuts.md) ← *(see `thetanuts.md` in this directory; the `plugins/` prefix is required by Base MCP's loader)*
- Skill manifest: [`SKILL.md`](./SKILL.md)
- SDK encode helpers wrapped by the prepare service:
  - `src/modules/erc20.ts:408` (`encodeApprove`)
  - `src/modules/optionBook.ts:545` (`encodeFillOrder`)
  - `src/modules/optionBook.ts:860` (`encodeSwapAndFillOrder`)
  - `src/modules/optionFactory.ts:1030` (`encodeRequestForQuotation`)
  - `src/modules/optionFactory.ts:1080` (`encodeMakeOfferForQuotation`)
  - `src/modules/optionFactory.ts:1098` (`encodeSettleQuotation`)
  - `src/modules/optionFactory.ts:1145` (`encodeSettleQuotationEarly`)
  - `src/modules/optionFactory.ts:1111` (`encodeCancelQuotation`)
  - `src/modules/optionFactory.ts:1171` (`encodeCancelOfferForQuotation`)
  - `src/modules/optionFactory.ts:1234` (`encodeSwapAndCall`)
