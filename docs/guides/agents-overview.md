# AI Agents — Pick Your Route

Thetanuts ships two agent-facing packages on top of the SDK. Both are thin layers over the same [`@thetanuts-finance/thetanuts-client`](https://www.npmjs.com/package/@thetanuts-finance/thetanuts-client) encode helpers — the difference is **who signs the transaction and where the safety boundary lives**.

## The two packages

| | [`@thetanuts-finance/mcp`](https://www.npmjs.com/package/@thetanuts-finance/mcp) | [`@thetanuts-finance/agentkit`](https://www.npmjs.com/package/@thetanuts-finance/agentkit) |
|---|---|---|
| What it is | MCP server: ~100 tools an LLM client calls over the Model Context Protocol | Coinbase AgentKit `ActionProvider` library you embed in your own agent code |
| Who signs | **Never signs.** Pairs with a signer — Base MCP (you approve each tx in Base Account), Safe, or a CDP policy wallet | **The agent's own wallet** (CDP, viem, Privy server wallets), unattended |
| Runs in | Claude Desktop, Claude Code, Cursor, ChatGPT, Codex — any MCP client | Your backend agent process (LangChain, Vercel AI SDK), or as its own MCP server |
| Safety boundary | Outside the LLM: wallet approval UI or signer policy | In code: fail-closed `SafetyPolicy` (notional caps, collateral allowlist, host hook) |
| Use when | Human-in-the-loop chat trading; maximum client reach | Headless trading bots, MM bots, custodied agent vaults |

This split is deliberate: the MCP server can guarantee it **cannot move funds** (it holds no keys and builds calldata only), while autonomous signing stays an explicit, separately-installed opt-in. The two can run side by side.

## The three routes

| You want | You run | Guide |
|---|---|---|
| **Trade from chat, approving every transaction yourself** | `@thetanuts-finance/mcp` + [Base MCP](https://docs.base.org/ai-agents/quickstart) — calldata is prepared, you click approve in Base Account | [Trade from Chat](base-mcp-plugin.md) |
| **Trade from chat, but the agent signs by itself** | `@thetanuts-finance/agentkit` run as an MCP server (Coinbase's MCP adapter + a CDP wallet under `SafetyPolicy` caps) | [AgentKit](agentkit.md) |
| **A fully headless bot — no chat client at all** | `@thetanuts-finance/agentkit` embedded in your own code (LangChain, Vercel AI SDK) | [AgentKit](agentkit.md) |

If you're unsure, take the first route — a transaction can never leave your wallet without your click.

## Reads only?

If you just want an LLM that can *read* the protocol (markets, positions, IV, Greeks) and help you write SDK code, the MCP server alone is enough — no wallet, no signer. See [MCP Server](mcp-server.md), or skip servers entirely with the copy-paste [LLM Context](../resources/llm-context.md) prompt.

## Deeper material

- [MCP Server guide](mcp-server.md) — every tool, environment variables, the full comparison
- [Trade from Chat](base-mcp-plugin.md) — the Base MCP plugin setup
- [AgentKit guide](agentkit.md) — autonomous agents, both modes
- AgentKit repo: [SETUP.md](https://github.com/Thetanuts-Finance/thetanuts-agentkit/blob/main/SETUP.md) (end-to-end setup: CDP wallet, client configs for Claude Desktop/Code, Cursor, Codex) and [SKILL.md](https://github.com/Thetanuts-Finance/thetanuts-agentkit/blob/main/SKILL.md) (a walkthrough skill any skill-aware agent can load)
