# Source Code Overview

This directory contains the complete source code for the Thetanuts SDK.

## Architecture

```
src/
├── index.ts           # Main entry point - exports all public APIs
├── abis/              # Smart contract ABIs
├── chains/            # Chain configuration and network support
├── client/            # ThetanutsClient main class
├── modules/           # Feature modules (15 total)
├── types/             # TypeScript type definitions
└── utils/             # Utility functions
```

## Module Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      ThetanutsClient                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Configuration: chainId, provider, signer, URLs         │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                         MODULES                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  ERC20   │ │OptionBook│ │   API    │ │  OptionFactory   │  │
│  │  Module  │ │  Module  │ │  Module  │ │     Module       │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  Option  │ │  Ranger  │ │  Events  │ │    WebSocket     │  │
│  │  Module  │ │  Module  │ │  Module  │ │     Module       │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ ┌──────────┐  │
│  │MMPricing │ │  Utils   │ │   RFQKeyManager  │ │   Loan   │  │
│  │  Module  │ │  Module  │ │      Module      │ │  Module  │  │
│  └──────────┘ └──────────┘ └──────────────────┘ └──────────┘  │
│  ┌──────────┐ ┌──────────────────┐ ┌──────────────────┐        │
│  │  Collar  │ │    WheelVault    │ │  StrategyVault   │        │
│  │  Module  │ │      Module      │ │      Module      │        │
│  └──────────┘ └──────────────────┘ └──────────────────┘        │
├─────────────────────────────────────────────────────────────────┤
│                      DEPENDENCIES                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  Types   │ │   ABIs   │ │  Chains  │ │     Utils        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Entry Point: index.ts

The main entry point (`index.ts`) exports:

### Client
```typescript
export { ThetanutsClient } from './client/ThetanutsClient.js';
```

### ABIs
```typescript
export { ERC20_ABI } from './abis/erc20.js';
export { OPTION_BOOK_ABI } from './abis/optionBook.js';
export { OPTION_FACTORY_ABI } from './abis/optionFactory.js';
export { OPTION_ABI, BASE_OPTION_ABI } from './abis/option.js';
```

### Types
All type definitions from `./types/`:
- Client configuration types (`client.ts`)
- Common enums and literals (`common.ts`)
- OptionBook order and trading types (`optionBook.ts`)
- OptionFactory RFQ types (`optionFactory.ts`)
- Option position types (`option.ts`)
- API response types (`api.ts`)
- State API types for RFQ indexer (`stateApi.ts`)
- Event types (`events.ts`)
- Error types (`errors.ts`)
- ERC20 operation types (`erc20.ts`)
- WebSocket types (`websocket.ts`)
- Pricing types (`pricing.ts`)
- Logger interface (`logger.ts`)

### Utilities
```typescript
export { createError, wrapError, mapHttpError, mapContractError } from './utils/errors.js';
export { noopLogger, consoleLogger, Logger } from './utils/logger.js';
export { DECIMALS, toBigInt, fromBigInt, scaleDecimals, formatAmount, parseAmount } from './utils/decimals.js';
export { validateAddress, validateOrderExpiry, validateFillSize, validateBuySlippage, validateSellSlippage, calculateSlippagePrice } from './utils/validation.js';
```

### Chain Configuration
```typescript
export { CHAIN_CONFIGS_BY_ID, getChainConfigById, getTokenConfigById, getSupportedTokensById, isChainIdSupported } from './chains/index.js';
```

## Data Flow

### Read Operations
```
User Code
    │
    ▼
ThetanutsClient
    │
    ├── API Module ──────────► Odette API / Indexer API / State API
    │
    ├── ERC20 Module ────────► Blockchain (via Provider)
    │
    ├── Events Module ───────► Blockchain Events
    │
    ├── MMPricing Module ────► Pricing API
    │
    ├── Loan / Collar Modules ───► Pricing and loan APIs
    │
    └── Vault Modules ───────► Vault contracts and lens APIs
```

### Write Operations
```
User Code
    │
    ▼
ThetanutsClient
    │
    ├── ERC20.approve() ─────► ERC20 Contract (via Signer)
    │
    ├── OptionBook.fillOrder() ──► OptionBook Contract
    │
    └── OptionFactory.requestForQuotation() ──► OptionFactory Contract
```

## Build Output

After running `npm run build`, the `dist/` directory contains:

```
dist/
├── index.js           # CommonJS build
├── index.js.map       # Source map for CJS
├── index.mjs          # ES Module build
├── index.mjs.map      # Source map for ESM
├── index.d.ts         # TypeScript declarations (CJS)
└── index.d.mts        # TypeScript declarations (ESM)
```

## File Size Summary

| Directory | Files | Description |
|-----------|-------|-------------|
| `abis/` | 6 | Smart contract ABI definitions |
| `chains/` | 2 | Chain configuration (Base mainnet, Loan config) |
| `client/` | 2 | ThetanutsClient entry point |
| `modules/` | 15 | Feature modules (ERC20, OptionBook, API, OptionFactory, Option, Ranger, Events, WebSocket, MMPricing, Utils, RFQKeyManager, Loan, Collar, WheelVault, StrategyVault) |
| `types/` | 14 | TypeScript type definitions |
| `utils/` | 5 | Utility functions (decimals, errors, logger, validation) |
| `index.ts` | 1 | Main entry point — exports all public APIs |

## See Also

- [ABIs Documentation](abis/README.md)
- [Chains Documentation](chains/README.md)
- [Client Documentation](client/README.md)
- [Modules Documentation](modules/README.md)
- [Types Documentation](types/README.md)
- [Utils Documentation](utils/README.md)
