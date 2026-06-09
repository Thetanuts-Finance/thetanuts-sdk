# Client

The `ThetanutsClient` is the single entry point to the Thetanuts SDK — it initializes all modules, manages provider/signer connections, and exposes chain configuration.

## Constructor

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,              // Required: Chain ID (Base = 8453)
  provider: Provider,         // Required: ethers.js provider
  signer?: Signer,            // Optional: For write operations
  referrer?: string,          // Optional: Referrer address for fees
  apiBaseUrl?: string,        // Optional: Override API URL
  indexerApiUrl?: string,     // Optional: Override indexer URL
  pricingApiUrl?: string,     // Optional: Override pricing URL
  wsUrl?: string,             // Optional: Override WebSocket URL
  stateApiUrl?: string,       // Optional: Override RFQ state indexer URL
  env?: 'dev' | 'prod',       // Optional: Environment (default: prod)
  logger?: ThetanutsLogger,   // Optional: Custom logger
  keyStorageProvider?: KeyStorageProvider,  // Optional: Custom RFQ key storage
  rfqKeyPrefix?: string,      // Optional: Custom RFQ key prefix
});
```

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `chainId` | `number` | Active chain ID (e.g. `8453`) |
| `chainConfig` | `ChainConfig` | Chain configuration with addresses and tokens |
| `provider` | `Provider` | ethers.js provider instance |
| `signer` | `Signer \| undefined` | Signer for transactions |
| `referrer` | `string \| undefined` | Default referrer address |
| `apiBaseUrl` | `string` | Orders API endpoint URL |
| `indexerApiUrl` | `string` | Indexer API endpoint URL |
| `pricingApiUrl` | `string` | Pricing API endpoint URL |
| `stateApiUrl` | `string` | RFQ state indexer URL |

## Modules Access

All SDK modules are accessed as properties on the client instance:

```typescript
client.erc20          // Token operations (approvals, balances, transfers)
client.optionBook     // Order book operations (fill, cancel, fees)
client.api            // API interactions (orders, positions, stats)
client.optionFactory  // RFQ lifecycle management
client.option         // Position management
client.ranger         // RangerOption zone-bound positions
client.events         // Blockchain events
client.ws             // WebSocket subscriptions
client.mmPricing      // Market maker pricing
client.rfqKeys        // ECDH key management and offer encryption
client.utils          // Utility functions (decimals, payoffs)
client.loan           // Non-liquidatable lending
client.collar         // Collar loan pricing and write helpers
client.wheelVault     // Ethereum wheel vaults
client.strategyVault  // Base strategy vaults
```

## Chain Config Access

```typescript
const config = client.chainConfig;

// Tokens
config.tokens.USDC.address   // '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
config.tokens.USDC.decimals  // 6
config.tokens.WETH.address   // '0x4200000000000000000000000000000000000006'
config.tokens.WETH.decimals  // 18
config.tokens.cbBTC.address  // '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'
config.tokens.cbBTC.decimals // 8

// Option implementations — cash-settled
config.implementations.PUT
config.implementations.INVERSE_CALL
config.implementations.LINEAR_CALL
config.implementations.PUT_SPREAD
config.implementations.CALL_SPREAD
config.implementations.INVERSE_CALL_SPREAD
config.implementations.PUT_FLY
config.implementations.CALL_FLY
config.implementations.PUT_CONDOR
config.implementations.CALL_CONDOR
config.implementations.IRON_CONDOR
config.implementations.RANGER       // r12: zone-bound (4-strike) RangerOption
config.implementations.CALL_LOAN    // r12: physically-settled call loan handler

// Option implementations — physically settled (vanilla deployed in r12)
config.implementations.PHYSICAL_CALL
config.implementations.PHYSICAL_PUT

// Option implementations — physically settled multi-leg (NOT YET DEPLOYED in r12;
// addresses below are 0x000…000 placeholders. RFQ flows that try to route through
// these throw INVALID_PARAMS at the SDK level — see optionFactory.ts:2241).
config.implementations.PHYSICAL_CALL_SPREAD
config.implementations.PHYSICAL_PUT_SPREAD
config.implementations.PHYSICAL_CALL_FLY
config.implementations.PHYSICAL_PUT_FLY
config.implementations.PHYSICAL_CALL_CONDOR
config.implementations.PHYSICAL_PUT_CONDOR
config.implementations.PHYSICAL_IRON_CONDOR

// Price feeds
config.priceFeeds.ETH  // Chainlink ETH/USD feed
config.priceFeeds.BTC  // Chainlink BTC/USD feed

// Contracts
config.contracts.optionFactory
config.contracts.optionBook

// r12: HistoricalPriceConsumerV3_TWAP (Chainlink TWAP consumer used at settlement).
// null on chains where the consumer is not deployed.
config.twapConsumer
```

## Helper Methods

### getSignerAddress()

Get the address of the current signer. Throws `SIGNER_REQUIRED` if no signer is configured.

```typescript
const address = await client.getSignerAddress();
// Returns: '0x1234...'
```

### requireSigner()

Get the signer instance, throwing `SIGNER_REQUIRED` if unavailable.

```typescript
const signer = client.requireSigner();
```

## Initialization Patterns

### Read-only (no signer)

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
});

// Read-only operations work without a signer
const orders = await client.api.fetchOrders();
const balance = await client.erc20.getBalance(tokenAddress, userAddress);
```

### With signer (for transactions)

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
  referrer: '0xYourReferrerAddress',
});

await client.erc20.approve(tokenAddress, spenderAddress, amount);
await client.optionBook.fillOrder(order, 10_000000n);
```

### Browser with MetaMask

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
});
```

### Custom logger

```typescript
import { ThetanutsClient, consoleLogger } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: consoleLogger,
});
```

### URL overrides

```typescript
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  apiBaseUrl: 'https://my-custom-api.example.com',
  indexerApiUrl: 'https://my-indexer.example.com/api/v1',
  pricingApiUrl: 'https://my-pricing.example.com',
  stateApiUrl: 'https://my-state-api.example.com',
  wsUrl: 'wss://my-websocket.example.com',
});
```

## Error Handling

The client throws `ThetanutsError` for typed error conditions:

```typescript
import { isThetanutsError } from '@thetanuts-finance/thetanuts-client';

try {
  const address = await client.getSignerAddress();
} catch (error) {
  if (isThetanutsError(error) && error.code === 'SIGNER_REQUIRED') {
    console.log('Please connect a wallet');
  }
}
```

## Architecture

```
ThetanutsClient
├── chainConfig     ← Addresses, tokens, price feeds
├── provider        ← ethers.js provider
├── signer          ← Optional signer for write ops
│
├── erc20           ← ERC20Module
├── optionBook      ← OptionBookModule
├── api             ← APIModule
├── optionFactory   ← OptionFactoryModule
├── option          ← OptionModule
├── ranger          ← RangerModule
├── events          ← EventsModule
├── ws              ← WebSocketModule
├── mmPricing       ← MMPricingModule
├── rfqKeys         ← RFQKeyManagerModule
├── utils           ← UtilsModule
├── loan            ← LoanModule
├── collar          ← CollarModule
├── wheelVault      ← WheelVaultModule
└── strategyVault   ← StrategyVaultModule
```

---

## See Also

- [Modules Overview](./modules-overview.md) — All 15 modules at a glance
- [Chain Config](./chain-config.md) — Full chain configuration reference
- [../getting-started/configuration.md](../getting-started/configuration.md) — Getting started with configuration
