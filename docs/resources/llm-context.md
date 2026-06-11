# LLM Context — Use this SDK with Claude, Cursor, or any LLM

> **Want your AI assistant to know this SDK cold?** Paste the prompt below into Claude Code, Cursor, ChatGPT, or any LLM-powered tool. It pulls in the full SDK context in one fetch — every module, key types, common workflows, and the gotchas that bite real users.

## Copy-paste this prompt

```
Please fetch and read https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms-full.txt before answering any further questions about the Thetanuts Finance SDK or generating code that uses it. That file is the full LLM-targeted context for @thetanuts-finance/thetanuts-client — it covers every module, key types, common workflows with runnable examples, and the gotchas that cause real bugs.

Once you've read it, you can answer questions about the SDK directly without making additional doc fetches.
```

That's it. Copy, paste, and your LLM has every module on `client.*`, every type, every common workflow, and every "this will silently revert in production" gotcha — about 35 KiB of curated markdown.

## What's in `llms-full.txt`

Self-contained reference, designed to replace multiple page-fetches:

- **Architecture**: every public module on `ThetanutsClient`, what it does, when to use it
- **Key concepts**: OptionBook vs RFQ, decimal handling, collateral by option type
- **Per-module reference**: `client.optionBook`, `client.optionFactory`, `client.option`, `client.ranger`, `client.events`, `client.ws`, `client.utils`, `client.rfqKeys`, `client.mmPricing`, `client.loan`, `client.collar`, `client.wheelVault`, `client.strategyVault`, `client.api`, `client.erc20`
- **Common workflows**: read market data, fill an order, create a custom RFQ, manage positions, borrow USDC, deposit into a vault, real-time subscriptions
- **Error handling**: every typed `ThetanutsError` code and what triggers it
- **Gotchas**: the recurring footguns — `availableAmount` is collateral budget not contract count, `collateralAmount` in RFQ params is always 0, `split`/`reclaimCollateral` are payable in r12, butterfly names changed in v0.2.1, etc.
- **Contract addresses**: Base mainnet r12 deployment

## Two files, two audiences

The repo has two LLM-targeted files at the root:

| File | Size | Use case |
|------|------|----------|
| [`llms.txt`](https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms.txt) | ~8 KiB | Curated **index** of canonical docs — link-only, grouped by topic. Use when your LLM wants to know which doc page to fetch next. |
| [`llms-full.txt`](https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms-full.txt) | ~35 KiB | **Full embedded context** — every module and the gotchas in one file. Fetch this first; cache for the session. |

Both follow the [llmstxt.org](https://llmstxt.org) spec, so any tool that auto-discovers LLM context files will find them.

## Other ways to consume

### Connect via the MCP server

If you're using Claude Desktop or any MCP-aware client, the SDK ships an MCP server that surfaces the same context as a tool call. Three context tools, plus SDK read tools and `prepare_*` calldata builders:

- `get_sdk_context` — full long-form context (same content as `llms-full.txt`)
- `get_sdk_context_index` — curated index (same content as `llms.txt`)
- `get_sdk_context_size` — byte size, for budgeting before fetch

See the [MCP Server guide](../guides/mcp-server.md) for setup instructions.

### Direct fetch in your code

If you're building an LLM application that wraps Thetanuts, fetch `llms-full.txt` once at startup and inject it as a system message:

```typescript
const sdkContext = await fetch(
  'https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/llms-full.txt'
).then((r) => r.text());

// Then use sdkContext as a system message or inject before user prompts
```

The file is generated at the same time as the npm package, so what you see matches the latest published version.

## Versioning

The two LLM files track the latest published SDK release. To pin to a specific version, replace `main` in the URL with a version tag:

```
https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/v0.3.0/llms-full.txt
```

See [GitHub Releases](https://github.com/Thetanuts-Finance/thetanuts-sdk/releases) for the available tags.

## See also

- [GitHub: `llms.txt`](https://github.com/Thetanuts-Finance/thetanuts-sdk/blob/main/llms.txt) — the curated index, viewed in GitHub
- [GitHub: `llms-full.txt`](https://github.com/Thetanuts-Finance/thetanuts-sdk/blob/main/llms-full.txt) — the full context, viewed in GitHub
- [MCP Server](../guides/mcp-server.md) — same content surfaced as MCP tool calls
- [llmstxt.org](https://llmstxt.org) — the spec these files follow
