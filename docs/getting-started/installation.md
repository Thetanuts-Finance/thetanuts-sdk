# Installation

Add the Thetanuts SDK to your project using npm or yarn.

> **Just want to use this with an LLM?** Skip the SDK install. The [MCP server](../guides/mcp-server.md) gives Claude / Cursor / VS Code one-click access to ~100 SDK tools without writing code: `npx -y @thetanuts-finance/mcp`.

## Install the package

Using npm:

```bash
npm install @thetanuts-finance/thetanuts-client
```

Using yarn:

```bash
yarn add @thetanuts-finance/thetanuts-client
```

## Compatibility

| Requirement | Minimum Version |
|-------------|----------------|
| Node.js | >= 18 |
| ethers.js | v6 |
| TypeScript | >= 5.0 |

## Build Formats

The SDK ships as both ESM and CJS with TypeScript declarations (`.d.ts`), built with [tsup](https://tsup.egoist.dev/). This means it works out of the box in:

- Node.js projects (CommonJS or ESM)
- TypeScript projects
- Bundlers (Vite, webpack, esbuild, etc.)

No additional build configuration is required.

---

## See also

- [Quick Start](./quick-start.md)
- [Configuration](./configuration.md)
- [Supported Chains](./supported-chains.md)
