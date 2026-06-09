# Configuration

All options you can pass when creating a `ThetanutsClient` instance, plus how to plug in a custom logger.

## ThetanutsClientConfig

```typescript
interface ThetanutsClientConfig {
  chainId: 8453;                    // Required: Chain ID
  provider: Provider;               // Required: ethers.js provider
  signer?: Signer;                  // Optional: For transactions
  referrer?: string;                // Optional: Referrer address for fees
  apiBaseUrl?: string;              // Optional: Override API URL
  indexerApiUrl?: string;           // Optional: Override indexer URL
  pricingApiUrl?: string;           // Optional: Override pricing URL
  wsUrl?: string;                   // Optional: Override WebSocket URL
  stateApiUrl?: string;             // Optional: Override RFQ state indexer URL
  env?: 'dev' | 'prod';             // Optional: Environment (default: prod)
  logger?: ThetanutsLogger;         // Optional: Custom logger
  keyStorageProvider?: KeyStorageProvider; // Optional: RFQ key storage override
  rfqKeyPrefix?: string;            // Optional: RFQ key namespace
}
```

## Custom Logger

Pass a custom logger to capture SDK debug output in your own monitoring system (Sentry, Datadog, etc.):

```typescript
import { ThetanutsClient, consoleLogger } from '@thetanuts-finance/thetanuts-client';

// Option 1: Use the built-in console logger
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: consoleLogger,
});

// Option 2: Provide your own logger implementation
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: {
    debug: (msg, meta) => myLogger.debug(msg, meta),
    info: (msg, meta) => myLogger.info(msg, meta),
    warn: (msg, meta) => myLogger.warn(msg, meta),
    error: (msg, meta) => myLogger.error(msg, meta),
  },
});
```

---

## See also

- [Installation](./installation.md)
- [Quick Start](./quick-start.md)
- [Supported Chains](./supported-chains.md)
