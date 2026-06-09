# Production Checklist

Items to verify before deploying an application that uses the Thetanuts SDK.

---

## RPC Provider

Do not use the public `https://mainnet.base.org` endpoint in production. Public endpoints have strict rate limits and may be unreliable under sustained load.

```typescript
// Not recommended for production
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

// Recommended: use a dedicated RPC provider
const provider = new ethers.JsonRpcProvider(
  'https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY'
);
// Alternatives:
// https://base-mainnet.infura.io/v3/YOUR_PROJECT_ID
// https://base.quiknode.pro/YOUR_ENDPOINT
```

---

## Referrer Configuration

Set the `referrer` address in the client config to earn fee-sharing revenue on every order fill. If not set, fees go to the zero address.

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
  referrer: '0xYourReferrerAddress',
});
```

The referrer can be overridden per call if needed:

```typescript
await client.optionBook.fillOrder(order, amount, '0xOverrideReferrer');
```

---

## Error Logging

Pass a custom `logger` to capture SDK errors in your monitoring system (Sentry, Datadog, etc.):

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: {
    debug: (msg, meta) => myLogger.debug(msg, meta),
    info:  (msg, meta) => myLogger.info(msg, meta),
    warn:  (msg, meta) => myLogger.warn(msg, meta),
    error: (msg, meta) => myLogger.error(msg, meta),
  },
});
```

During development, use the built-in `consoleLogger`:

```typescript
import { consoleLogger } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({ chainId: 8453, provider, logger: consoleLogger });
```

---

## Gas Buffer

The SDK adds a 20% gas buffer automatically for Account Abstraction wallets (Coinbase Smart Wallet, Safe). This buffer also applies for standard EOA wallets as a safety margin. No action required, but factor this into gas cost estimates.

---

## Collateral Approval Flow

The SDK does not auto-approve token spending. Always call `ensureAllowance()` before `fillOrder()`. Failure to do so results in an `INSUFFICIENT_ALLOWANCE` error.

```typescript
// Always approve before filling
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.chainConfig.contracts.optionBook,
  requiredAmount  // from previewFillOrder()
);

const receipt = await client.optionBook.fillOrder(order, requiredAmount);
```

For SELL (short) positions in the RFQ flow, approve the OptionFactory contract before creating the RFQ:

```typescript
const collateralNeeded = BigInt(Math.round(strike * numContracts * 1e6)); // PUT: strike × contracts
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.chainConfig.contracts.optionFactory,
  collateralNeeded
);
```

---

## WebSocket Reconnection

The WebSocket module auto-reconnects by default (up to 10 attempts). For high-availability applications, monitor the connection state and configure reconnection settings:

```typescript
client.ws.onStateChange((state) => {
  if (state === 'disconnected') {
    console.warn('WebSocket disconnected — SDK will auto-reconnect');
    // Alert your monitoring system if reconnection is critical
  }
});

await client.ws.connect({
  maxReconnectAttempts: 20,   // override default of 10
  reconnectInterval: 3000,    // ms between attempts
});
```

---

## Order Expiry Checks

Always check `order.expiry` before filling. The SDK throws `OrderExpiredError` when you try to fill an expired order, but checking upfront avoids unnecessary gas estimation calls.

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const orders = await client.api.fetchOrders();
const now = Math.floor(Date.now() / 1000);

// Filter with a 60-second buffer to account for block time
const validOrders = orders.filter(
  (o) => Number(o.order.expiry) > now + 60
);

if (validOrders.length === 0) {
  throw new Error('No active orders available');
}

const order = validOrders[0];
const preview = client.optionBook.previewFillOrder(order, 10_000000n);
```

---

## RFQ Key Backup

If your application creates RFQs, back up the ECDH private key. Without it, you cannot decrypt market maker offers or perform early settlement.

```typescript
// Export key for backup storage
const privateKey = await client.rfqKeys.exportPrivateKey();
// Store securely — losing this means you can't decrypt offers!

// Restore from backup
await client.rfqKeys.importFromPrivateKey(backupPrivateKey, true);
```

Node.js keys are stored in `.thetanuts-keys/` with secure permissions. Browser apps must configure an explicit encrypted/passphrase-backed `keyStorageProvider`; do not rely on plaintext `localStorage` for production RFQ private keys.

---

## Compatibility Requirements

| Requirement | Minimum Version |
|-------------|----------------|
| Node.js | >= 18 |
| ethers.js | v6 |
| TypeScript | >= 5.0 |

## See Also

- [Error Handling](./error-handling.md) — error codes and retry patterns
- [Token Operations](./token-operations.md) — `ensureAllowance` details
- [WebSocket](./websocket.md) — connection state and reconnection
