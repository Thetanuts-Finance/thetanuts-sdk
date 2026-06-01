# Chain Configuration

This directory contains network configuration for supported blockchain networks.

## Supported Chains

| Chain | Chain ID | Status |
|-------|----------|--------|
| Base Mainnet | 8453 | Supported |

## Configuration Structure

### ChainConfig Interface

```typescript
interface ChainConfig {
  // Basic info
  chainId: number;
  name: string;

  // Contract addresses
  contracts: {
    optionBook: string;
    optionFactory: string;
  };

  // Implementation addresses for option strategies
  implementations: {
    PUT: string;
    INVERSE_CALL: string;
    CALL_SPREAD: string;
    PUT_SPREAD: string;
    CALL_FLY: string;
    PUT_FLY: string;
    CALL_CONDOR: string;
    PUT_CONDOR: string;
    IRON_CONDOR: string;
  };

  // Token configurations
  tokens: {
    [symbol: string]: {
      address: string;
      symbol: string;
      decimals: number;
    };
  };

  // API endpoints
  apiBaseUrl: string;
  indexerApiUrl: string;
  pricingApiUrl: string;
  wsBaseUrl: string;
  stateApiUrl: string;   // RFQ state indexer

  // RPC endpoints
  defaultRpcUrls: string[];
}
```

## Base Mainnet Configuration (8453_r12)

```typescript
const baseMainnet: ChainConfig = {
  chainId: 8453,
  name: 'Base',

  contracts: {
    // Base_r12 deployment (deployed 2026-05-05, block 45601440)
    optionBook: '0x1bDff855d6811728acaDC00989e79143a2bdfDed',
    optionFactory: '0x8118daD971dEbffB49B9280047659174128A8B94',
  },

  implementations: {
    PUT: '0x7355EB92dfb0503DB558a70c10843618932ab290',
    INVERSE_CALL: '0xE6c5756b0289e3f0994CB12eb8aB71Cd903Ed0Ea',
    LINEAR_CALL: '0x051791df68223AE173Fade5217C48875e36eef61',
    CALL_SPREAD: '0xfaeD63f7040E65b79cF0Ae29706fDc423eE249A9',
    PUT_SPREAD: '0x02Fe0d9635e0139DBB3768a5d5Db404Fd84d9134',
    INVERSE_CALL_SPREAD: '0x7Be48100b1B0349528A96D64953295Cd0Bbe4B70',
    CALL_FLY: '0xa1d5f6b16A2e7f298F8d2cDF78F7779B4A20C4C2',
    PUT_FLY: '0x4fd2C6D271cC6FF3EbD2027da9815a0608d03AA3',
    CALL_CONDOR: '0x14476CF2ea9F7C448100F061670E390f17c78817',
    PUT_CONDOR: '0xC742E422c7BB43A7FDe1CEF47997bC9D5b543cDD',
    IRON_CONDOR: '0x9ebd7E23AfD52a48F557523019285EfEF2170D59',
    RANGER: '0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc',
    CALL_LOAN: '0x7c444A2375275DaB925b32493B64a407eE955DEd',
    PHYSICAL_CALL: '0x8c56100caE246f7daa4BC1EC4d1477d71178c563',
    PHYSICAL_PUT: '0x6aD53DD058bea004829cCf58a282C21a7Df02DcA',
  },

  tokens: {
    USDC: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      decimals: 6,
    },
    WETH: {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      decimals: 18,
    },
    cbBTC: {
      address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      symbol: 'cbBTC',
      decimals: 8,
    },
  },

  twapConsumer: '0xE909fb38767e0ac5F7a347DF9Dd4222217E10816',
  deploymentBlock: 45601440,
  apiBaseUrl: 'https://round-snowflake-9c31.devops-118.workers.dev',
  indexerApiUrl: 'https://indexer.thetanuts.finance/api/v1/book',
  pricingApiUrl: 'https://pricing.thetanuts.finance',
  wsBaseUrl: 'wss://ws.thetanuts.finance/v4',
  stateApiUrl: 'https://indexer.thetanuts.finance',
  defaultRpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com'],
};
```

## Exported Functions

### getChainConfigById

Get the full chain configuration for a given chain ID.

```typescript
import { getChainConfigById } from '@thetanuts-finance/thetanuts-client';

const config = getChainConfigById(8453);
console.log(config.name); // 'Base'
console.log(config.contracts.optionBook); // '0x1bDff855...'
```

### getTokenConfigById

Get token configuration for a specific chain and token symbol.

```typescript
import { getTokenConfigById } from '@thetanuts-finance/thetanuts-client';

const usdc = getTokenConfigById(8453, 'USDC');
console.log(usdc.address);  // '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
console.log(usdc.decimals); // 6
```

### getSupportedTokensById

Get list of all supported tokens for a chain.

```typescript
import { getSupportedTokensById } from '@thetanuts-finance/thetanuts-client';

const tokens = getSupportedTokensById(8453);
// Returns: ['USDC', 'WETH', 'cbBTC']
```

### isChainIdSupported

Check if a chain ID is supported.

```typescript
import { isChainIdSupported } from '@thetanuts-finance/thetanuts-client';

isChainIdSupported(8453);  // true
isChainIdSupported(1);     // false (Ethereum mainnet not supported)
```

## Price Feeds

The SDK uses Chainlink price feeds for BTC and ETH pricing:

| Asset | Price Feed Address |
|-------|-------------------|
| BTC | `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` |
| ETH | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |

## Adding New Chains

To add support for a new chain:

1. Add chain configuration to `chains/index.ts`
2. Update the `SupportedChainId` type in `types/client.ts`
3. Add contract addresses for the new chain
4. Add token configurations

```typescript
// Example: Adding Arbitrum
const arbitrum: ChainConfig = {
  chainId: 42161,
  name: 'Arbitrum',
  contracts: {
    optionBook: '0x...',
    optionFactory: '0x...',
  },
  // ... rest of config
};
```

## API Endpoints

| Endpoint | Purpose | URL Pattern |
|----------|---------|-------------|
| Orders API | Fetch available orders | `{apiBaseUrl}/` |
| Indexer API | User positions, stats | `{indexerApiUrl}/...` |
| Pricing API | Greeks, IV surfaces | `{pricingApiUrl}/...` |
| State API | RFQ state indexer | `{stateApiUrl}/api/state` |
| WebSocket | Real-time updates | `{wsBaseUrl}` |
