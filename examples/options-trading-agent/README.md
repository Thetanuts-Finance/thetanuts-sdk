# Options trading agent

A worked end-to-end example of an autonomous Thetanuts options agent. One file, one strategy: **a covered-call premium hunter** that reads the ETH market, opens an RFQ to sell a short-dated out-of-the-money call, watches for offers, and settles early when a maker bids above the reserve.

Stack:
- **[`@thetanuts-finance/agentkit`](https://github.com/Thetanuts-Finance/thetanuts-agentkit)** — the Thetanuts AgentKit ActionProvider, for autonomous agents that own their own wallet.
- **`@coinbase/agentkit`** + **CDP MPC wallet** — the agent's key never leaves Coinbase's MPC network.
- **Vercel AI SDK** + **Anthropic Claude** — the model that drives the loop.

This is **reference code**, not a production trading system. Read the "Safety" section before running anything against real funds.

## What it does

```
┌──────────────────────────────────────────────────────────┐
│  Anthropic Claude (Opus 4.7)                             │
│    ↓ tool calls via Vercel AI SDK                        │
│  thetanutsActionProvider                                 │
│    ↓ SafetyPolicy gate (notional cap, USDC-only)         │
│    ↓ SDK encode* helpers                                 │
│  wallet.sendTransaction / signTypedData                  │
│    ↓ Coinbase CDP MPC                                    │
│  Base mainnet (chain 8453)                               │
└──────────────────────────────────────────────────────────┘
```

Per invocation the agent runs **one cycle**:

1. `get_market_prices` — read the current ETH oracle price.
2. `get_user_positions` — confirm no open RFQ.
3. `prepare_request_rfq` — build a SELL call RFQ call bundle with a chosen strike + expiry + reserve premium.
4. Sleep ~60 s.
5. `get_rfq` — check for offers (the encrypted blobs are stripped server-side, so the LLM only sees offeror + status + revealedAmount).
6. `prepare_settle_rfq_early` if there's an acceptable offer, else `prepare_cancel_rfq`.

No infinite loop — run it on cron, or wrap it in a `while true` if you trust it.

## Setup

```bash
cd examples/options-trading-agent
cp .env.example .env
# fill in CDP_API_KEY_NAME, CDP_API_KEY_PRIVATE_KEY, ANTHROPIC_API_KEY,
# and (optional) BASE_RPC_URL.

npm install
```

## Run

**First time — dry-run mode:**

```bash
npm run dry-run
```

`DRY_RUN=true` flips the `onWriteAction` hook to reject every write. The agent still plans, reasons, and calls reads, but no transaction lands. Watch the `[safety]` log lines to see what the agent *would* have done. Iterate on the system prompt + parameters until the planned trades look right.

**Live:**

```bash
npm start
```

The agent makes at most one RFQ per invocation, capped at $25 notional by the safety policy.

## Safety

This is the **single most important section.** The agent's wallet is autonomous — there's no "are you sure?" prompt between the LLM's tool call and the chain. Three layers of defense:

1. **Hardcoded `SafetyPolicy` in `src/agent.ts`:**
   ```ts
   safetyLimits: {
     maxNotionalUsdcPerAction: 25_000_000n,  // $25 hard ceiling
     maxApprovalAmount: 'exact',             // never approve MAX_UINT256
     allowedCollateral: ['USDC'],            // refuse non-USDC RFQs
     onWriteAction: (ctx) => { ... },        // host gate, logs every write
   }
   ```
   These limits are enforced in code by the ActionProvider. **The LLM cannot exceed them, even if prompt-injected.**

2. **System prompt** restates the same limits in natural language so the LLM doesn't waste turns trying actions that will be rejected.

3. **Dry-run mode** lets you verify behavior with zero on-chain risk.

If the model loops on a refused action, the safety log makes it obvious why. If you see `SAFETY_NOTIONAL_EXCEEDED` repeatedly in the output, the system prompt and the limit have drifted out of sync.

**The wallet should be dedicated to this agent.** Funding it with ~$50 USDC is plenty for testing the cycle end-to-end. Don't reuse a wallet that holds anything you can't afford to lose.

## Strategy notes

The example agent is deliberately simple — it's a teaching aid, not alpha. To get a real edge you'd want:

- Better IV fitting (the example just uses the oracle price + a heuristic on the LLM's part).
- Proper Greeks: the SDK exposes `client.mmPricing.getGreeks(...)` — wire it into the prompt or expose it as a new action.
- Position management across multiple expiries.
- Risk limits beyond notional: max delta, max vega, expiry concentration.
- A retry policy when the offer window expires with no acceptable bid.

The agent is a starting point — feel free to fork and extend.

## What the LLM sees (transcript shape)

After a successful cycle the output looks roughly like:

```
[agent] wallet=0x... dry_run=false
[safety] requestRfq amount=12500000 token=0x000...000
[safety] settleRfqEarly amount=0 token=0x000...000   ← read-only-from-safety perspective

=== agent text ===
Opened RFQ 4218 (CALL ETH strike=3450, expiry=2026-06-09, premium target=12.5 USDC).
After 60 s waiting, 0x9fa... bid 13.2 USDC (revealed). Settled early; tx 0x7c...

=== tool calls ===
- get_market_prices({})
- get_user_positions({})
- prepare_request_rfq({ product: "CALL", underlying: "ETH", ... })
- get_rfq({ quotationId: "4218" })
- prepare_settle_rfq_early({ quotationId: "4218", offerorAddress: "0x9fa..." })
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Missing env: ...` | Forgot to copy `.env.example` to `.env` and fill it in | See Setup |
| `Refused (SAFETY_LIMITS_REQUIRED)` | Tried to bypass the constructor — shouldn't happen with this code | Verify `safetyLimits` is still in `src/agent.ts` |
| `Refused (SAFETY_NOTIONAL_EXCEEDED)` | LLM tried a write above $25 | Tighten the system prompt or raise the cap |
| `wallet provider only supports Base mainnet` | CDP wallet on the wrong network | Set `networkId: 'base-mainnet'` |
| Agent loops without settling | No offer arrived in the polling window | Raise `offerEndTimestamp` or accept the cancel and try again |
| `Order index N not found` | The State API is behind, or the orderbook moved | Refresh and retry |

## See also

- **Base MCP plugin** at `mcp-server/plugins/base-mcp/` — the user-in-the-loop alternative: `@thetanuts-finance/mcp` builds the calldata and the user approves each transaction in Base Account (Claude Desktop, Cursor, ChatGPT).
- **Thetanuts AgentKit package** at https://github.com/Thetanuts-Finance/thetanuts-agentkit — the ActionProvider this example imports.
- **SDK reference** at https://docs.thetanuts.finance/sdk.
