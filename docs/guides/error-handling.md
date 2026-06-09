# Error Handling

All SDK methods throw `ThetanutsError` or a typed subclass. Use the `code` property or `instanceof` to branch on specific errors.

## Error Codes

| Code | Description | Typical Cause |
|------|-------------|---------------|
| `ORDER_EXPIRED` | Order has expired | Order's expiry timestamp has passed |
| `SLIPPAGE_EXCEEDED` | Price moved beyond tolerance | Market moved during transaction |
| `INSUFFICIENT_ALLOWANCE` | Token approval needed | Haven't approved tokens for contract |
| `INSUFFICIENT_BALANCE` | Not enough tokens | Wallet balance too low |
| `NETWORK_UNSUPPORTED` | Chain not supported | Using unsupported chain ID |
| `HTTP_ERROR` | API request failed | Network issues, API downtime |
| `BAD_REQUEST` | Invalid API request | Malformed parameters |
| `NOT_FOUND` | Resource not found | Invalid order ID or address |
| `RATE_LIMIT` | Rate limit exceeded | Too many API requests |
| `CONTRACT_REVERT` | Contract call failed | Transaction reverted on-chain |
| `INVALID_PARAMS` | Invalid parameters | Wrong types, missing required fields |
| `INVALID_ORDER` | Order validation failed | Malformed order structure |
| `ORDER_NOT_FOUND` | Order doesn't exist | Order ID not in orderbook |
| `SIZE_EXCEEDED` | Fill size too large | Requested more than available |
| `SIGNER_REQUIRED` | Signer needed | Write operation without signer |
| `WEBSOCKET_ERROR` | WebSocket error | Connection issues |
| `KEY_NOT_FOUND` | RFQ key missing | No ECDH keypair generated |
| `INVALID_KEY` | Invalid key format | Corrupted or wrong key format |
| `ENCRYPTION_FAILED` | Encryption failed | ECDH encryption error |
| `DECRYPTION_FAILED` | Decryption failed | Wrong key or corrupted data |
| `UNKNOWN` | Unknown error | Unexpected error |

## Error Classes

### Base Class

```typescript
class ThetanutsError extends Error {
  readonly code: ThetanutsErrorCode;
  readonly cause?: unknown;
  readonly meta?: Record<string, unknown>;
}
```

### API Errors

```typescript
class APIError extends ThetanutsError {
  readonly status: number;  // HTTP status code
}

class BadRequestError extends APIError {}  // HTTP 400
class NotFoundError extends APIError {}    // HTTP 404
class RateLimitError extends APIError {}   // HTTP 429
```

### Contract Errors

```typescript
class ContractRevertError extends ThetanutsError {}
class InsufficientAllowanceError extends ThetanutsError {}
class InsufficientBalanceError extends ThetanutsError {}
class OrderExpiredError extends ThetanutsError {}
class SlippageExceededError extends ThetanutsError {}
```

### Client Errors

```typescript
class SignerRequiredError extends ThetanutsError {}
class InvalidParamsError extends ThetanutsError {}
class NetworkUnsupportedError extends ThetanutsError {}
class WebSocketError extends ThetanutsError {}
```

### RFQ Key Errors

```typescript
class KeyNotFoundError extends ThetanutsError {}   // KEY_NOT_FOUND
class InvalidKeyError extends ThetanutsError {}    // INVALID_KEY
class EncryptionError extends ThetanutsError {}    // ENCRYPTION_FAILED
class DecryptionError extends ThetanutsError {}    // DECRYPTION_FAILED
```

## Handling Errors with `isThetanutsError`

```typescript
import {
  isThetanutsError,
  ThetanutsClient,
} from '@thetanuts-finance/thetanuts-client';

try {
  await client.optionBook.fillOrder(orderWithSig);
} catch (error) {
  if (isThetanutsError(error)) {
    switch (error.code) {
      case 'ORDER_EXPIRED':
        console.log('Order has expired — fetch fresh orders');
        break;
      case 'INSUFFICIENT_ALLOWANCE':
        console.log('Approve tokens before filling');
        break;
      case 'SIGNER_REQUIRED':
        console.log('Initialize client with a signer');
        break;
      default:
        console.log(`SDK error [${error.code}]: ${error.message}`);
    }
  }
}
```

## Handling Errors with `instanceof`

Use typed error classes for branch-specific recovery logic:

```typescript
import {
  ThetanutsError,
  ContractRevertError,
  InsufficientAllowanceError,
  OrderExpiredError,
} from '@thetanuts-finance/thetanuts-client';

try {
  await client.optionBook.fillOrder(order, 10_000000n);
} catch (error) {
  if (error instanceof OrderExpiredError) {
    console.log('Order expired — fetching fresh orders...');
    const freshOrders = await client.api.fetchOrders();
    // retry with a fresh order

  } else if (error instanceof InsufficientAllowanceError) {
    console.log('Approving tokens...');
    await client.erc20.ensureAllowance(
      client.chainConfig.tokens.USDC.address,
      client.chainConfig.contracts.optionBook,
      10_000000n
    );
    // retry

  } else if (error instanceof ContractRevertError) {
    console.log('Contract reverted:', error.message);
    console.log('Cause:', error.cause);

  } else if (error instanceof ThetanutsError) {
    console.log(`SDK error [${error.code}]: ${error.message}`);
    console.log('Meta:', error.meta);  // Additional context
  }
}
```

## Retry Pattern for Transient Errors

Use exponential backoff for rate limiting and transient network errors:

```typescript
import { RateLimitError } from '@thetanuts-finance/thetanuts-client';

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RateLimitError) {
        const delay = Math.pow(2, attempt) * 1000; // exponential backoff
        console.log(`Rate limited, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw error; // non-retryable — rethrow immediately
    }
  }
  throw new Error('Max retries exceeded');
}

const orders = await withRetry(() => client.api.fetchOrders());
```

## Contract Revert Reasons

### OptionFactory

| Revert Reason | Cause | Solution |
|---------------|-------|----------|
| `InvalidImplementation` | Unknown option implementation | Use valid implementation from `chainConfig.implementations` |
| `InvalidCollateral` | Unsupported collateral token | Use USDC, WETH, or cbBTC |
| `InvalidExpiry` | Expiry in past or too far | Set expiry between now and a reasonable future date |
| `InvalidStrikes` | Strike price invalid | Ensure strikes are positive and properly scaled |
| `OfferPeriodEnded` | Offer period has closed | Cannot make offer after `offerEndTimestamp` |
| `OfferPeriodNotEnded` | Offer period still open | Wait for period to end before revealing |
| `RevealPeriodEnded` | Reveal window closed | Reveal within the reveal window |
| `NoOffersToReveal` | No offers submitted | At least one MM offer required to settle |
| `QuotationAlreadySettled` | Already settled | Cannot settle twice |
| `NotRequester` | Wrong caller | Only the requester can cancel their RFQ |

### OptionBook

| Revert Reason | Cause | Solution |
|---------------|-------|----------|
| `OrderExpired` | Order has expired | Fetch fresh orders |
| `OrderCancelled` | Order was cancelled | Use a different order |
| `InsufficientSize` | Not enough to fill | Reduce fill amount |
| `InvalidOrder` | Malformed order | Re-fetch order from API |

### Option Contract

| Revert Reason | Cause | Solution |
|---------------|-------|----------|
| `NotExpired` | Option not expired yet | Wait for expiry before calling `payout()` |
| `AlreadySettled` | Already settled | Cannot payout twice |
| `NotBuyer` | Caller is not buyer | Only buyer can execute payout |
| `NotBuyerOrSeller` | Wrong caller | Only buyer/seller can close |

### ERC20

| Revert Reason | Cause | Solution |
|---------------|-------|----------|
| `ERC20: insufficient allowance` | Not approved | Call `approve()` or `ensureAllowance()` first |
| `ERC20: transfer amount exceeds balance` | Insufficient balance | Check balance before transacting |

## Common Issues

### INSUFFICIENT_ALLOWANCE

Always call `ensureAllowance()` before `fillOrder()` or `requestForQuotation()`. The SDK does not auto-approve.

```typescript
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.chainConfig.contracts.optionBook,
  requiredAmount
);
```

### ORDER_EXPIRED

Check expiry before filling to avoid wasted gas:

```typescript
const now = Math.floor(Date.now() / 1000);
const validOrders = orders.filter(o => Number(o.order.expiry) > now + 60); // 60s buffer
```

### SIGNER_REQUIRED

Initialize the client with a signer for any write operation:

```typescript
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer: wallet,  // required for fillOrder, approve, close, payout, etc.
});
```

Alternatively, use the `encode*` methods (e.g., `encodeFillOrder()`) to construct transaction data for an external wallet.

### KEY_NOT_FOUND

Generate or restore an ECDH keypair before creating RFQs:

```typescript
const keyPair = await client.rfqKeys.getOrCreateKeyPair();
// Keys are automatically persisted to disk in Node.js.
// Browser apps must configure keyStorageProvider explicitly.
```

### DECRYPTION_FAILED

Verify you are using the same keypair that was used when the RFQ was created:

```typescript
const currentKeyPair = await client.rfqKeys.getOrCreateKeyPair();
const rfq = await client.api.getRFQFromRfq(quotationId);

if (currentKeyPair.compressedPublicKey !== rfq.requesterPublicKey) {
  console.error('Key mismatch — import the original private key via importFromPrivateKey()');
}
```

## Debugging

### Enable Debug Logging

```typescript
import { consoleLogger, ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: consoleLogger,
});
```

### Inspect Error Details

```typescript
import { ThetanutsError } from '@thetanuts-finance/thetanuts-client';

try {
  await client.optionBook.fillOrder(order);
} catch (error) {
  if (error instanceof ThetanutsError) {
    console.log('Code:', error.code);
    console.log('Message:', error.message);
    console.log('Cause:', error.cause);  // Original underlying error
    console.log('Meta:', error.meta);    // Additional SDK context
  }
}
```

## See Also

- [Token Operations](./token-operations.md) — `ensureAllowance` before fills
- [Production Checklist](./production-checklist.md) — error logging in production
- [WebSocket](./websocket.md) — `WEBSOCKET_ERROR` reconnection handling
