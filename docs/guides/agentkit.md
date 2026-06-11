# AgentKit — Autonomous Agents

[`@thetanuts-finance/agentkit`](https://www.npmjs.com/package/@thetanuts-finance/agentkit) is a [Coinbase AgentKit](https://docs.cdp.coinbase.com/agent-kit/welcome) `ActionProvider` for agents that **own their own wallet** and trade Thetanuts options unattended — request RFQs, receive encrypted sealed-bid offers, and settle, with no human approval per transaction.

It lives in a sibling repo: [`Thetanuts-Finance/thetanuts-agentkit`](https://github.com/Thetanuts-Finance/thetanuts-agentkit). This page is the orientation; the repo's [SETUP.md](https://github.com/Thetanuts-Finance/thetanuts-agentkit/blob/main/SETUP.md) is the step-by-step guide.

> **This is the autonomous route.** The agent's wallet signs by itself — the configured `SafetyPolicy` caps are the only brake. If you want to approve each trade in your own wallet, use the [Base MCP plugin](base-mcp-plugin.md) instead. See [Pick Your Route](agents-overview.md).

## Action surface

7 write actions + 3 read actions, each Zod-validated with LLM-friendly descriptions:

| Action | Purpose |
|---|---|
| `approve` | ERC20 approval to the OptionFactory (auto-bundled for SELL RFQs) |
| `request_rfq` | Open an RFQ — puts, calls, spreads, butterflies, condors, iron condors |
| `make_offer` | Sealed-bid offer on someone's RFQ (EIP-712 signed, encrypted to the requester) |
| `settle_rfq` / `settle_rfq_early` | Settle after the window closes / accept a specific offer early |
| `cancel_rfq` / `cancel_offer` | Withdraw the agent's own RFQ / offer |
| `get_user_positions`, `get_rfq`, `get_market_prices` | Reads |

## The safety model

Every value-moving action passes a **fail-closed `SafetyPolicy`** — omit it and all writes throw `SAFETY_LIMITS_REQUIRED`:

```typescript
thetanutsActionProvider({
  safetyLimits: {
    maxNotionalUsdcPerAction: 50_000_000n, // $50 hard cap per action
    maxApprovalAmount: 'exact',            // never grant MAX_UINT256
    allowedCollateral: ['USDC'],
    // onWriteAction: (ctx) => 'allow' | 'reject'  — host audit/review hook
  },
})
```

Run it only with a **dedicated wallet** funded with what you're prepared to let an agent spend. The recommended wallet is a CDP server wallet (MPC — the agent never sees key material); viem and Privy providers also work.

## Two ways to consume it

**Embedded in your own bot** — LangChain or Vercel AI SDK, via Coinbase's framework adapters. Runnable quickstarts: [`examples/`](https://github.com/Thetanuts-Finance/thetanuts-agentkit/tree/main/examples) in the agentkit repo, plus a complete [covered-call premium hunter](https://github.com/Thetanuts-Finance/thetanuts-sdk/tree/main/examples/options-trading-agent) in this repo.

**As an autonomous-signing MCP server** — Coinbase's official [`@coinbase/agentkit-model-context-protocol`](https://docs.cdp.coinbase.com/agent-kit/core-concepts/model-context-protocol) adapter turns the ActionProvider into a stdio MCP server, so a chat client (Claude Desktop, Claude Code, Cursor, Codex) gets tools that sign on their own. Runnable server: [`examples/mcp-server-quickstart.ts`](https://github.com/Thetanuts-Finance/thetanuts-agentkit/blob/main/examples/mcp-server-quickstart.ts); client configs for all four clients are in [SETUP.md](https://github.com/Thetanuts-Finance/thetanuts-agentkit/blob/main/SETUP.md). This is deliberately a **separate server** from `@thetanuts-finance/mcp`, which never signs — the two can be installed side by side.

## Walkthrough skill

The repo ships a [SKILL.md](https://github.com/Thetanuts-Finance/thetanuts-agentkit/blob/main/SKILL.md) (`npx skills add Thetanuts-Finance/thetanuts-agentkit`, also inside the npm package) that teaches any skill-aware agent to walk a user through the kit — detection, setup, funding, a read-only demo, and a safe first trade.

## Requirements

- `@thetanuts-finance/thetanuts-client` **>= 0.3.0** — `make_offer` / `settle_rfq_early` use the `buildOfferTypedData`, `getRequesterPublicKey`, and `getOffer` APIs introduced in 0.3.0
- `@coinbase/agentkit` >= 0.10.0, `reflect-metadata`
- Base mainnet only (chainId 8453) — the provider rejects any other network
