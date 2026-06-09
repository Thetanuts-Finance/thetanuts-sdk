# Chain Config

The chain configuration bundles all on-chain addresses, token metadata, price feeds, and API endpoints for a supported network. Access it via `client.chainConfig`.

Currently supported: **Base Mainnet** (chain ID `8453`) for the full options surface, and **Ethereum Mainnet** (chain ID `1`) for vault-only modules (`client.wheelVault`). Collar pricing/preview helpers are available on Base, but on-chain collar write methods are gated until collar-v12 contract addresses are populated. See [Supported Chains](../getting-started/supported-chains.md) for the full breakdown.

## Accessing Chain Config

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({ chainId: 8453, provider });
const config = client.chainConfig;
```

## Tokens

| Symbol | Address | Decimals | Description |
|--------|---------|----------|-------------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | USD Coin |
| WETH | `0x4200000000000000000000000000000000000006` | 18 | Wrapped Ether |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | Coinbase Wrapped BTC |
| aBasWETH | `0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7` | 18 | Aave Base WETH |
| aBascbBTC | `0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6` | 8 | Aave Base cbBTC |
| aBasUSDC | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` | 6 | Aave Base USDC |
| cbDOGE | `0x73c7A9C372F31c1b1C7f8E5A7D12B8735c817C79` | 8 | Coinbase Wrapped DOGE |
| cbXRP | `0x7B2Cd9EA5566c345C9cdbcF58f5E211a0dB47444` | 6 | Coinbase Wrapped XRP |

```typescript
config.tokens.USDC.address;      // '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
config.tokens.USDC.decimals;     // 6
config.tokens.WETH.address;      // '0x4200000000000000000000000000000000000006'
config.tokens.WETH.decimals;     // 18
config.tokens.cbBTC.address;     // '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
config.tokens.cbBTC.decimals;    // 8
config.tokens.aBasWETH.address;  // '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7'
config.tokens.aBascbBTC.address; // '0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6'
config.tokens.aBasUSDC.address;  // '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB'
config.tokens.cbDOGE.address;    // '0x73c7A9C372F31c1b1C7f8E5A7D12B8735c817C79'
config.tokens.cbXRP.address;     // '0x7B2Cd9EA5566c345C9cdbcF58f5E211a0dB47444'
```

## Option Implementations

### Cash-Settled

Used by both OptionBook (filling listed orders) and RFQ (creating custom options via `buildRFQRequest()`). The same implementation contracts are shared between both systems.

| Key | Address | Description |
|-----|---------|-------------|
| `PUT` | `0x7355EB92dfb0503DB558a70c10843618932ab290` | Vanilla PUT |
| `INVERSE_CALL` | `0xE6c5756b0289e3f0994CB12eb8aB71Cd903Ed0Ea` | Vanilla CALL |
| `LINEAR_CALL` | `0x051791df68223AE173Fade5217C48875e36eef61` | Linear CALL |
| `CALL_SPREAD` | `0xfaeD63f7040E65b79cF0Ae29706fDc423eE249A9` | Call spread (2 strikes) |
| `PUT_SPREAD` | `0x02Fe0d9635e0139DBB3768a5d5Db404Fd84d9134` | Put spread (2 strikes) |
| `INVERSE_CALL_SPREAD` | `0x7Be48100b1B0349528A96D64953295Cd0Bbe4B70` | Inverse call spread (2 strikes) |
| `CALL_FLY` | `0xa1d5f6b16A2e7f298F8d2cDF78F7779B4A20C4C2` | Call butterfly (3 strikes) |
| `PUT_FLY` | `0x4fd2C6D271cC6FF3EbD2027da9815a0608d03AA3` | Put butterfly (3 strikes) |
| `CALL_CONDOR` | `0x14476CF2ea9F7C448100F061670E390f17c78817` | Call condor (4 strikes) |
| `PUT_CONDOR` | `0xC742E422c7BB43A7FDe1CEF47997bC9D5b543cDD` | Put condor (4 strikes) |
| `IRON_CONDOR` | `0x9ebd7E23AfD52a48F557523019285EfEF2170D59` | Iron condor (4 strikes) |
| `RANGER` | `0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc` | Zone-bound 4-strike payoff (r12) |
| `CALL_LOAN` | `0x7c444A2375275DaB925b32493B64a407eE955DEd` | Loan handler (physically-settled call) |

### Physically Settled

Used by RFQ only, via `buildPhysicalOptionRFQ()`. Vanilla options only. At expiry, the underlying asset is delivered rather than a cash payout.

| Key | Address | Description |
|-----|---------|-------------|
| `PHYSICAL_CALL` | `0x8c56100caE246f7daa4BC1EC4d1477d71178c563` | Vanilla physical CALL |
| `PHYSICAL_PUT` | `0x6aD53DD058bea004829cCf58a282C21a7Df02DcA` | Vanilla physical PUT |

> Multi-leg physical implementations (`PHYSICAL_*_SPREAD`, `PHYSICAL_*_FLY`, `PHYSICAL_*_CONDOR`, `PHYSICAL_IRON_CONDOR`) are placeholders set to `0x0…0` — the contracts are not yet deployed. The SDK's runtime guard throws a clear error if a user attempts to route through any of these zero addresses.

```typescript
// Cash-settled
config.implementations.PUT;
config.implementations.INVERSE_CALL;
config.implementations.PUT_SPREAD;
config.implementations.CALL_SPREAD;
config.implementations.PUT_FLY;
config.implementations.CALL_FLY;
config.implementations.PUT_CONDOR;
config.implementations.CALL_CONDOR;
config.implementations.IRON_CONDOR;

// Physically settled (vanilla only)
config.implementations.PHYSICAL_CALL;
config.implementations.PHYSICAL_PUT;
```

## Price Feeds (Chainlink)

| Asset | Feed Address |
|-------|-------------|
| ETH | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |
| BTC | `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` |
| SOL | `0x975043adBb80fc32276CbF9Bbcfd4A601a12462D` |
| DOGE | `0x8422f3d3CAFf15Ca682939310d6A5e619AE08e57` |
| XRP | `0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34` |
| BNB | `0x4b7836916781CAAfbb7Bd1E5FDd20ED544B453b1` |
| PAXG | `0x5213eBB69743b85644dbB6E25cdF994aFBb8cF31` |
| AVAX | `0xE70f2D34Fd04046aaEC26a198A35dD8F2dF5cd92` |

```typescript
config.priceFeeds.ETH;   // Chainlink ETH/USD feed
config.priceFeeds.BTC;   // Chainlink BTC/USD feed
config.priceFeeds.SOL;   // Chainlink SOL/USD feed
config.priceFeeds.DOGE;  // Chainlink DOGE/USD feed
config.priceFeeds.XRP;   // Chainlink XRP/USD feed
config.priceFeeds.BNB;   // Chainlink BNB/USD feed
config.priceFeeds.PAXG;  // Chainlink PAXG/USD feed
config.priceFeeds.AVAX;  // Chainlink AVAX/USD feed
```

## Contracts

| Contract | Address |
|----------|---------|
| `optionBook` | `0x1bDff855d6811728acaDC00989e79143a2bdfDed` |
| `optionFactory` | `0x8118daD971dEbffB49B9280047659174128A8B94` |
| `twapConsumer` | `0xE909fb38767e0ac5F7a347DF9Dd4222217E10816` |

```typescript
config.contracts.optionBook;      // '0x1bDff855d6811728acaDC00989e79143a2bdfDed'
config.contracts.optionFactory;   // '0x8118daD971dEbffB49B9280047659174128A8B94'
config.contracts.twapConsumer;    // '0xE909fb38767e0ac5F7a347DF9Dd4222217E10816'
```

## API Endpoints

| Field | Purpose | Default URL |
|-------|---------|-------------|
| `apiBaseUrl` | Orders API | `https://round-snowflake-9c31.devops-118.workers.dev` |
| `indexerApiUrl` | Book indexer (positions, stats) | `https://indexer.thetanuts.finance/api/v1/book` |
| `pricingApiUrl` | Greeks and IV surfaces | `https://pricing.thetanuts.finance` |
| `stateApiUrl` | RFQ state indexer | `https://indexer.thetanuts.finance` |
| `wsBaseUrl` | WebSocket server | `wss://ws.thetanuts.finance/v4` |

## ChainConfig Interface

```typescript
interface ChainConfig {
  chainId: number;
  name: string;

  contracts: {
    optionBook: string;
    optionFactory: string;
  };

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
    // Physical implementations also included
  };

  tokens: {
    [symbol: string]: {
      address: string;
      symbol: string;
      decimals: number;
    };
  };

  priceFeeds: {
    ETH: string;
    BTC: string;
  };

  apiBaseUrl: string;
  indexerApiUrl: string;
  pricingApiUrl: string;
  wsBaseUrl: string;
  stateApiUrl: string;

  defaultRpcUrls: string[];
}
```

## Helper Functions

These exported functions let you access chain config without a client instance:

```typescript
import {
  getChainConfigById,
  getTokenConfigById,
  getSupportedTokensById,
  isChainIdSupported,
} from '@thetanuts-finance/thetanuts-client';

// Full config
const config = getChainConfigById(8453);
console.log(config.name);                    // 'Base'
console.log(config.contracts.optionBook);    // '0x1bDff855...'

// Single token
const usdc = getTokenConfigById(8453, 'USDC');
console.log(usdc.address);   // '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
console.log(usdc.decimals);  // 6

// All tokens
const tokens = getSupportedTokensById(8453);
// ['USDC', 'WETH', 'cbBTC', 'aBasWETH', 'aBascbBTC', 'aBasUSDC', 'cbDOGE', 'cbXRP']

// Chain support check
isChainIdSupported(8453);  // true (Base)
isChainIdSupported(1);     // true (Ethereum, vault-only)
```

## Never Hardcode Addresses

Always read addresses from `client.chainConfig` rather than hardcoding them. This ensures your code works correctly if addresses change in a future SDK release:

```typescript
// Preferred
const usdcAddress = client.chainConfig.tokens.USDC.address;
const optionBook  = client.chainConfig.contracts.optionBook;

// Then use in approvals and transactions
await client.erc20.ensureAllowance(usdcAddress, optionBook, amount);
```

---

## See Also

- [Decimal Reference](./decimals.md) — Token decimal table
- [Client](./client.md) — ThetanutsClient properties
- [../getting-started/configuration.md](../getting-started/configuration.md) — Getting started with configuration
