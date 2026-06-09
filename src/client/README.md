# ThetanutsClient

The main client class for interacting with Thetanuts Finance.

## Overview

`ThetanutsClient` is the entry point to the SDK. It:
- Initializes all feature modules
- Manages provider and signer connections
- Provides access to chain configuration
- Handles HTTP client for API calls

## Initialization

### Read-Only Mode (No Signer)

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
});

// Read-only operations work
const orders = await client.api.fetchOrders();
const balance = await client.erc20.getBalance(tokenAddress, userAddress);
```

### With Signer (For Transactions)

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(privateKey, provider);

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
});

// Now transactions work too
await client.erc20.approve(tokenAddress, spenderAddress, amount);
await client.optionBook.fillOrder(order, signature);
```

### Browser with MetaMask

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

// Get provider from MetaMask
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
});
```

## Configuration Options

```typescript
interface ThetanutsClientConfig {
  // Required
  chainId: 8453;              // Only Base mainnet supported
  provider: Provider;         // ethers.js provider

  // Optional
  signer?: Signer;            // For write operations
  referrer?: string;          // Referrer address for fee sharing
  apiBaseUrl?: string;        // Override orders API URL
  indexerApiUrl?: string;     // Override indexer API URL
  pricingApiUrl?: string;     // Override pricing API URL
  stateApiUrl?: string;       // Override state API URL (RFQ indexer)
  wsUrl?: string;             // Override WebSocket URL
  env?: 'dev' | 'prod';       // Environment (default: 'prod')
  logger?: ThetanutsLogger;   // Custom logger
  keyStorageProvider?: KeyStorageProvider;  // Custom RFQ key storage
  rfqKeyPrefix?: string;      // Custom RFQ key prefix (default: 'thetanuts_rfq_key')
}
```

## Client Properties

### chainId
```typescript
client.chainId // 8453
```

### chainConfig
Access chain configuration including contract addresses and tokens.

```typescript
client.chainConfig.name                    // 'Base'
client.chainConfig.contracts.optionBook    // '0xd58b814...'
client.chainConfig.tokens['USDC'].address  // '0x833589...'
client.chainConfig.tokens['USDC'].decimals // 6
```

### provider
The ethers.js provider instance.

```typescript
const blockNumber = await client.provider.getBlockNumber();
```

### apiBaseUrl, indexerApiUrl, pricingApiUrl, stateApiUrl
API endpoint URLs.

```typescript
console.log(client.apiBaseUrl);     // 'https://round-snowflake-9c31...'
console.log(client.indexerApiUrl);  // 'https://optionbook-indexer...'
console.log(client.pricingApiUrl);  // 'https://pricing.thetanuts.finance'
console.log(client.stateApiUrl);    // 'https://dry-cake-8c44...'
```

## Modules

All modules are accessed as properties on the client:

| Module | Property | Purpose |
|--------|----------|---------|
| ERC20 | `client.erc20` | Token operations |
| OptionBook | `client.optionBook` | Order filling/cancellation |
| API | `client.api` | Data fetching |
| OptionFactory | `client.optionFactory` | RFQ lifecycle |
| Option | `client.option` | Position management |
| Events | `client.events` | Blockchain events |
| WebSocket | `client.ws` | Real-time subscriptions |
| MM Pricing | `client.mmPricing` | Option pricing |
| Utils | `client.utils` | Decimal conversions |
| RFQKeyManager | `client.rfqKeys` | ECDH keys & encryption for RFQ |

See [modules/README.md](../modules/README.md) for detailed documentation.

## Helper Methods

### getSignerAddress()

Get the address of the current signer.

```typescript
const address = await client.getSignerAddress();
// Returns: '0x1234...'
// Throws: ThetanutsError with code 'SIGNER_REQUIRED' if no signer
```

### requireSigner()

Get the signer, throwing if not available.

```typescript
const signer = client.requireSigner();
// Returns: Signer instance
// Throws: ThetanutsError with code 'SIGNER_REQUIRED' if no signer
```

## Custom Logger

Pass a custom logger for debugging:

```typescript
import { ThetanutsClient, consoleLogger } from '@thetanuts-finance/thetanuts-client';

// Use built-in console logger
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: consoleLogger,
});

// Or custom logger
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: {
    debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta),
    info: (msg, meta) => console.info(`[INFO] ${msg}`, meta),
    warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta),
    error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta),
  },
});
```

## URL Overrides

Override API URLs for development or testing:

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

## Example: Complete Setup

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient, consoleLogger } from '@thetanuts-finance/thetanuts-client';

async function main() {
  // Setup provider and signer
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

  // Initialize client
  const client = new ThetanutsClient({
    chainId: 8453,
    provider,
    signer,
    referrer: '0xYourReferrerAddress',
    logger: consoleLogger,
  });

  // Log configuration
  console.log('Chain:', client.chainConfig.name);
  console.log('OptionBook:', client.chainConfig.contracts.optionBook);
  console.log('Signer:', await client.getSignerAddress());

  // Fetch and display market data
  const marketData = await client.api.getMarketData();
  console.log('BTC:', marketData.prices.BTC);
  console.log('ETH:', marketData.prices.ETH);

  // Check USDC balance
  const usdcAddress = client.chainConfig.tokens['USDC'].address;
  const balance = await client.erc20.getBalance(usdcAddress);
  console.log('USDC Balance:', ethers.formatUnits(balance, 6));
}

main().catch(console.error);
```

## Error Handling

The client throws `ThetanutsError` for various conditions:

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
