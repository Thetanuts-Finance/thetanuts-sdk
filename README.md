# @thetanuts-finance/thetanuts-client

TypeScript client for trading options on **Base mainnet** via Thetanuts Finance V4 — listed orderbook fills, custom-built RFQs, and real-time price/order streams over WebSocket. Works in Node 18+ and modern browsers, ships as ESM and CJS with full type definitions.

> **Full documentation:** [docs.thetanuts.finance/sdk](https://docs.thetanuts.finance/sdk)

## Contents

- [30-second start](#30-second-start)
- [Two paths: read market data, or trade](#two-paths-read-market-data-or-trade)
- [Choosing between OptionBook and RFQ](#choosing-between-optionbook-and-rfq)
- [Modules](#modules)
- [Common workflows](#common-workflows)
- [Error handling](#error-handling)
- [Production checklist](#production-checklist)
- [Reference](#reference)
- [Development](#development)
- [Documentation & links](#documentation--links)

---

## 30-second start

Install:

```bash
npm install @thetanuts-finance/thetanuts-client ethers
```

Instantiate a read-only client and prove it works:

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const client = new ThetanutsClient({
  chainId: 8453, // Base mainnet
  provider,
});

const orders = await client.api.fetchOrders();
console.log(`Found ${orders.length} live orders on the book`);

const market = await client.api.getMarketData();
console.log(`ETH: $${market.prices.ETH}  BTC: $${market.prices.BTC}`);
```

No signer, no approvals, no transactions — just network reads. If that prints, your setup is good.

---

## Two paths: read market data, or trade

### Path A — I just want to read market data

You don't need a signer. The client above can already:

- Browse the OptionBook (`client.api.fetchOrders`)
- Fetch MM pricing for RFQ-style options (`client.mmPricing.getAllPricing`)
- Pull positions, stats, and historical data from the indexer (`client.api.*`)
- Subscribe to live orders, prices, and trades (`client.ws.*`)

Quick examples:

```typescript
// All active ETH option quotes the MM is showing
const pricing = await client.mmPricing.getAllPricing('ETH');
const active = client.mmPricing.filterExpired(Object.values(pricing));
console.log(`${active.length} active ETH options`);

// Real-time price stream
await client.ws.connect();
client.ws.subscribePrices((update) => {
  console.log(`${update.underlying}: $${update.price}`);
}, 'ETH');
```

### Path B — I want to trade

You need three things in order:

1. **A signer** — anything `ethers.Signer`-shaped (private key wallet, Coinbase Smart Wallet, Safe, etc.).
2. **Token approvals** — `USDC`, `WETH`, or `cbBTC` must be approved to the OptionBook or OptionFactory contract before you fill or RFQ.
3. **The right module** — `client.optionBook` for filling existing orders, `client.optionFactory` for creating custom RFQs.

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
  // Optional: earn a share of fees on every fill you route
  referrer: '0x92b8ac05b63472d1D84b32bDFBBf3e1887331567',
});

// Approve USDC to OptionBook before filling
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.chainConfig.contracts.optionBook,
  10_000000n, // 10 USDC (6 decimals)
);

// Fill an order — see Common workflows for the full flow
const orders = await client.api.fetchOrders();
const receipt = await client.optionBook.fillOrder(orders[0], 10_000000n);
console.log(`Filled: ${receipt.hash}`);
```

Jump to [Common workflows](#common-workflows) for end-to-end fills, RFQs, multi-leg structures, and position management.

---

## Choosing between OptionBook and RFQ

Both systems use the same cash-settled implementation contracts and produce identical option positions. The difference is **how you get a quote** and **who provides liquidity**.

|                | **OptionBook**                                                | **RFQ (Factory)**                                                                        |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| What           | Fill existing market-maker orders from a public book          | Request a custom option, market makers submit sealed-bid offers                          |
| Best for       | Quick trades on listed strikes/expiries                       | Custom strikes, custom expiries, off-the-run structures                                  |
| Structures     | Vanilla, spread, butterfly, condor, iron condor (cash)        | Same, plus optional physically-settled vanilla                                           |
| Settlement     | Cash-settled (payout in collateral token at expiry)           | **Cash-settled by default**; physical opt-in via `buildPhysicalOptionRFQ()` (vanilla only) |
| Key methods    | `fetchOrders()`, `previewFillOrder()`, `fillOrder()`          | `buildRFQRequest()`, `requestForQuotation()`, `settleQuotationEarly()`                   |
| Pricing source | Per-order from `fetchOrders()`                                | MM continuous quotes from `client.mmPricing.getAllPricing()`                             |
| Collateral     | Taker pays premium upfront                                    | `collateralAmount = 0` at creation; pulled at settlement (SELL needs prior approval)     |
| Data           | Book indexer (`/api/v1/book/`)                                | Factory indexer (`/api/v1/factory/`)                                                     |
| User reads     | `getUserPositionsFromIndexer()`                               | `getUserRfqs()`, `getUserOptionsFromRfq()`                                               |
| Stats          | `getBookProtocolStats()`, `getBookDailyStats()`               | `getFactoryProtocolStats()`, `getFactoryDailyStats()`                                    |

Rule of thumb: if the order you want already exists on the book, fill it. If not, RFQ it.

---

## Modules

The client exposes 15 modules. Pull what you need; the rest stay idle.

| Module                  | Purpose                                              | Needs signer    |
| ----------------------- | ---------------------------------------------------- | --------------- |
| `client.api`            | Indexer reads: orders, positions, stats, market data | No              |
| `client.optionBook`     | Fill / preview / cancel orders, fees                 | Write ops only  |
| `client.optionFactory`  | RFQ lifecycle (create, offer, settle)                | Write ops only  |
| `client.option`         | Position management and payouts                      | Write ops only  |
| `client.ranger`         | RangerOption (zone-bound, 4-strike) positions        | Write ops only  |
| `client.mmPricing`      | Continuous MM pricing, Greeks, fee adjustments       | No              |
| `client.rfqKeys`        | ECDH keypairs for encrypted RFQ offers               | No              |
| `client.erc20`          | Token approvals, balances, transfers                 | Write ops only  |
| `client.events`         | On-chain event queries                               | No              |
| `client.ws`             | Real-time order, price, and trade subscriptions      | No              |
| `client.utils`          | Decimal conversions, payoff math                     | No              |
| `client.loan`           | Non-liquidatable lending (borrow vs ETH/BTC)         | Write ops only  |
| `client.collar`         | Zero-interest collar loans (capped upside, preview)  | Write ops only  |
| `client.wheelVault`     | WheelVault interactions                              | Write ops only  |
| `client.strategyVault`  | StrategyVault interactions                           | Write ops only  |

Note: the pricing module is **`client.mmPricing`**, not `client.pricing`.

See [`src/modules/README.md`](src/modules/README.md) for per-module reference.

---

## Common workflows

### OptionBook flows

#### Browse and fill an order

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  signer,
  referrer: '0x92b8ac05b63472d1D84b32bDFBBf3e1887331567',
});

// 1. Browse the book
const orders = await client.api.fetchOrders();
const order = orders.find(
  (o) => o.order.expiry > BigInt(Math.floor(Date.now() / 1000)),
);
if (!order) throw new Error('No active orders');

// 2. Preview the fill — no transaction, no signer call
//    For PUTs and multi-leg structures, contract count != premium.
//    previewFillOrder runs the same collateral math the contract uses.
const preview = client.optionBook.previewFillOrder(order, 10_000000n); // 10 USDC
console.log(`Buying ${preview.numContracts} contracts at ${preview.pricePerContract}`);
console.log(`Collateral token: ${preview.collateralToken}`);

// 3. Approve collateral
const usdc = client.chainConfig.tokens.USDC.address;
await client.erc20.ensureAllowance(
  usdc,
  client.chainConfig.contracts.optionBook,
  10_000000n,
);

// 4. Fill
const receipt = await client.optionBook.fillOrder(order, 10_000000n);
console.log(`Filled: ${receipt.hash}`);
```

#### Understand collateral vs contracts (PUT footgun)

`availableAmount` on an order is the **maker's collateral budget**, not contract count. The actual fillable contracts depend on option type:

| Type            | Strikes | Formula                                  | Worked example                            |
| --------------- | ------- | ---------------------------------------- | ----------------------------------------- |
| Vanilla PUT     | 1       | `(collateral × 1e8) / strike`            | 10,000 USDC @ $95k strike = 0.105 contracts |
| Inverse CALL    | 1       | `collateral / 1e12`                      | 1 WETH = 1 contract                        |
| Spread          | 2       | `(collateral × 1e8) / spreadWidth`       | 10,000 USDC / $10k spread = 1 contract     |
| Butterfly       | 3       | `(collateral × 1e8) / maxSpread`         | Based on widest strike range               |
| Condor          | 4       | `(collateral × 1e8) / maxSpread`         | Based on widest strike range               |

Always call `previewFillOrder()` before `fillOrder()` — it returns the exact contract count, collateral token, and price-per-contract the contract will use.

#### Referrer fees

Set a referrer to earn a share of fees on every fill you route. Fees accrue per collateral token and can be claimed in bulk.

```typescript
// Set globally on the client
const client = new ThetanutsClient({
  chainId: 8453, provider, signer,
  referrer: '0x92b8ac05b63472d1D84b32bDFBBf3e1887331567',
});

// Or override per-call
await client.optionBook.fillOrder(order, undefined, '0xYourReferrerAddress');

// Or build the calldata for viem/wagmi/AA wallets
const { to, data } = client.optionBook.encodeFillOrder(
  order, 10_000000n, '0x92b8ac05b63472d1D84b32bDFBBf3e1887331567',
);

// Check what's claimable across every collateral token
const claimable = await client.optionBook.getAllClaimableFees('0xYourAddress');
for (const fee of claimable) {
  console.log(`${fee.symbol}: ${ethers.formatUnits(fee.amount, fee.decimals)}`);
}

// Claim every non-zero balance in one call
const results = await client.optionBook.claimAllFees();
for (const r of results) {
  if (r.receipt) console.log(`Claimed ${r.symbol}: ${r.receipt.hash}`);
}
```

If no referrer is set, the zero address is used (no fee sharing).

---

### RFQ flows

RFQs are sealed-bid: you broadcast a request, market makers submit encrypted offers, and you reveal/settle the best one. The SDK handles ECDH encryption automatically.

#### Vanilla RFQ (cash-settled)

```typescript
const client = new ThetanutsClient({ chainId: 8453, provider, signer });
const userAddress = await signer.getAddress();

// 1. Get (or create) your ECDH keypair — used to receive encrypted MM offers
const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// 2. Build the request. buildRFQRequest enforces collateralAmount = 0.
const rfqRequest = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',           // 'ETH' | 'BTC'
  optionType: 'PUT',           // 'CALL' | 'PUT'
  strike: 2000,                // Human-readable USD strike
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days out
  numContracts: 1.5,           // Human-readable
  isLong: true,                // true = BUY, false = SELL
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
  reservePrice: 0.015,         // BUY: max price per contract you'd accept
  requesterPublicKey: keyPair.compressedPublicKey,
});

// 3. Submit
const receipt = await client.optionFactory.requestForQuotation(rfqRequest);
console.log(`RFQ created: ${receipt.hash}`);

// SELL side only: approve collateral to the OptionFactory BEFORE submitting.
// For a PUT, the collateral is strike * contracts (in USDC):
//   const approval = BigInt(Math.round(2000 * 1.5 * 1e6));
//   await client.erc20.approve(USDC, client.optionFactory.contractAddress, approval);
```

See the [RFQ workflow guide](docs/RFQ_WORKFLOW.md) for the full lifecycle: MM offers, the reveal phase, and final settlement.

#### Multi-leg RFQs (spread, butterfly, condor)

Pass an array of strikes instead of a single strike. The generic SDK builder selects the implementation from option type plus strike count; MCP callers must pass the explicit `product` that matches the strike count (`*_SPREAD` = 2, `*_FLY` = 3, `*_CONDOR` / `IRON_CONDOR` = 4).

MCP `prepare_request_rfq` validates the product/strike shape before calldata is built: `PUT`/`CALL` require 1 strike, `*_SPREAD` require 2, `*_FLY` require 3, and `*_CONDOR`/`IRON_CONDOR` require 4. BUY RFQs also require a positive per-contract `reservePrice`; use `prepare_suggest_reserve_price` instead of guessing.

```typescript
const keyPair = await client.rfqKeys.getOrCreateKeyPair();
const expiry = Math.floor(Date.now() / 1000) + 86400 * 7;

// Butterfly: 3 strikes — +1 PUT @lower, -2 PUT @middle, +1 PUT @upper
const butterfly = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strikes: [1700, 1800, 1900],     // 3 strikes = BUTTERFLY
  expiry,
  numContracts: 0.001,
  isLong: false,                   // SELL (short) butterfly
  offerDeadlineMinutes: 6,
  collateralToken: 'USDC',
  reservePrice: 0.0001,
  requesterPublicKey: keyPair.compressedPublicKey,
});

// Collateral for a short PUT butterfly = (middle - lower) * numContracts
// $100 wing width * 0.001 = 0.1 USDC
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.optionFactory.contractAddress,
  100000n,
);
await client.optionFactory.requestForQuotation(butterfly);

// Condor: 4 strikes — +1 @s1, -1 @s2, -1 @s3, +1 @s4
const condor = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strikes: [1600, 1700, 1800, 1900],  // 4 strikes = CONDOR
  expiry,
  numContracts: 0.001,
  isLong: false,
  offerDeadlineMinutes: 6,
  collateralToken: 'USDC',
  reservePrice: 0.0001,
  requesterPublicKey: keyPair.compressedPublicKey,
});
await client.optionFactory.requestForQuotation(condor);
```

#### Physically-settled RFQ (vanilla only)

By default, RFQs are cash-settled. For physical settlement, use the dedicated builder — only vanilla CALL/PUT are supported on-chain.

```typescript
const physical = client.optionFactory.buildPhysicalOptionRFQ({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'CALL',
  strike: 2500,
  expiry,
  numContracts: 1,
  isLong: true,
  offerDeadlineMinutes: 30,
  collateralToken: 'WETH',
  requesterPublicKey: keyPair.compressedPublicKey,
});
await client.optionFactory.requestForQuotation(physical);
```

#### Settle early (accept an MM offer before the deadline)

```typescript
const quotationId = 784n;
const currentBlock = await provider.getBlockNumber();

// 1. Pull the MM offers from chain events
const offerEvents = await client.events.getOfferMadeEvents({
  quotationId,
  fromBlock: currentBlock - 1000,
});
const offer = offerEvents[0];

// 2. Decrypt with your keypair
const keyPair = await client.rfqKeys.loadKeyPair();
const decrypted = await client.rfqKeys.decryptOffer(
  offer.signedOfferForRequester,
  offer.signingKey,
);
console.log(`Offer: ${ethers.formatUnits(decrypted.offerAmount, 6)} USDC`);

// 3. Accept on-chain
const { to, data } = client.optionFactory.encodeSettleQuotationEarly(
  quotationId,
  decrypted.offerAmount,
  decrypted.nonce,
  offer.offeror,
);
const tx = await signer.sendTransaction({ to, data });
console.log(`Settled early: ${tx.hash}`);
```

#### All structures at a glance

| Structure  | Strikes | Implementation              | Strike order              |
| ---------- | ------- | --------------------------- | ------------------------- |
| Vanilla    | 1       | `PUT` / `INVERSE_CALL`      | N/A                       |
| Spread     | 2       | `PUT_SPREAD` / `CALL_SPREAD`| PUT: desc, CALL: asc      |
| Butterfly  | 3       | `PUT_FLY` / `CALL_FLY`      | PUT: desc, CALL: asc      |
| Condor     | 4       | `PUT_CONDOR` / `CALL_CONDOR`| Always ascending          |
| Iron condor| 4       | `IRON_CONDOR`               | `strike1..strike4` asc    |

Iron condor strike params are named `strike1, strike2, strike3, strike4` — **not** `putLowerStrike` / `callLowerStrike`. Butterfly and call/put fly are `PUT_FLY` / `CALL_FLY` (singular, no trailing `S`).

---

### Position & portfolio flows

```typescript
// All on-chain positions for an address — pulled from the book indexer
const positions = await client.api.getUserPositionsFromIndexer(userAddress);

// All RFQs you've created (active + historical)
const rfqs = await client.api.getUserRfqs(userAddress);

// Options that materialized from your RFQs after MM acceptance
const rfqOptions = await client.api.getUserOptionsFromRfq(userAddress);

// Lightweight legacy totals
const stats = await client.api.getStatsFromIndexer();
console.log(`Unique users: ${stats.uniqueUsers}, open: ${stats.openPositions}`);

// Richer time-windowed protocol stats (book / factory / combined)
const bookStats = await client.api.getBookProtocolStats();
const factoryStats = await client.api.getFactoryProtocolStats();
const combined = await client.api.getProtocolStats();

// Compute payoff at a hypothetical settlement price
const payoff = client.utils.calculatePayout({
  structure: 'call_spread',
  strikes: [100000n, 105000n],
  size: 1000000n,
  price: 102000n,
  isLong: true,
});
```

---

### Realtime / WebSocket

```typescript
const client = new ThetanutsClient({ chainId: 8453, provider });
await client.ws.connect();

const unsubOrders = client.ws.subscribeOrders((update) => {
  console.log(`Order ${update.event}:`, update);
});

const unsubPrices = client.ws.subscribePrices((update) => {
  console.log(`ETH: $${update.price}`);
}, 'ETH');

const unsubState = client.ws.onStateChange((state) => {
  console.log(`WS state: ${state}`);
});

// Tear down when done
// unsubOrders(); unsubPrices(); unsubState();
// client.ws.disconnect();
```

The WebSocket module auto-reconnects (default 10 attempts). Tune via `maxReconnectAttempts` / `reconnectInterval`.

---

## Error handling

All SDK methods throw `ThetanutsError` with a typed `code`. The package also exports concrete subclasses for `instanceof` narrowing.

```typescript
import {
  ThetanutsError,
  RateLimitError,
  ContractRevertError,
  InsufficientAllowanceError,
  OrderExpiredError,
} from '@thetanuts-finance/thetanuts-client';

try {
  await client.optionBook.fillOrder(order, 10_000000n);
} catch (error) {
  if (error instanceof OrderExpiredError) {
    const fresh = await client.api.fetchOrders();
    // retry with a fresh order
  } else if (error instanceof InsufficientAllowanceError) {
    await client.erc20.ensureAllowance(usdc, optionBook, amount);
    // retry
  } else if (error instanceof ContractRevertError) {
    console.error('Reverted:', error.message, error.cause);
  } else if (error instanceof ThetanutsError) {
    console.error(`SDK error [${error.code}]: ${error.message}`);
  }
}
```

### Error codes

| Code                     | Meaning                                |
| ------------------------ | -------------------------------------- |
| `ORDER_EXPIRED`          | Order expired or expiring imminently   |
| `SLIPPAGE_EXCEEDED`      | Price moved beyond tolerance           |
| `INSUFFICIENT_ALLOWANCE` | Approve the collateral token first     |
| `INSUFFICIENT_BALANCE`   | Wallet doesn't hold enough tokens      |
| `NETWORK_UNSUPPORTED`    | Configured chainId isn't supported     |
| `HTTP_ERROR`             | API/indexer request failed             |
| `CONTRACT_REVERT`        | On-chain call reverted                 |
| `INVALID_PARAMS`         | Bad arguments to an SDK method         |
| `ORDER_NOT_FOUND`        | No order with that id                  |
| `SIZE_EXCEEDED`          | Fill size exceeds available collateral |
| `SIGNER_REQUIRED`        | This call needs a signer               |
| `WEBSOCKET_ERROR`        | WS transport failure                   |

### Retrying transient errors

```typescript
import { RateLimitError } from '@thetanuts-finance/thetanuts-client';

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof RateLimitError) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}

const orders = await withRetry(() => client.api.fetchOrders());
```

---

## Production checklist

- **Bring your own RPC.** `https://mainnet.base.org` is rate-limited and unreliable under load. Use Alchemy, Infura, QuickNode, or your own node.
- **Set a referrer** if you're routing user flow — fees accrue automatically.
- **Wire a logger.** Pass a custom `logger` to forward to Sentry / Datadog / your stack.
- **Approve before you fill.** The SDK never auto-approves. Always call `client.erc20.ensureAllowance()` first.
- **Check `order.expiry` upfront.** Cheaper than catching `OrderExpiredError` after a failed gas estimate.
- **Configure WS reconnects** (`maxReconnectAttempts`, `reconnectInterval`) for your uptime targets.
- **Back up your RFQ keypair.** Node stores keys in `.thetanuts-keys/` (perms `0600`). If you lose the private key, encrypted MM offers to your old public key are unrecoverable.
- **Use a real key store in production.** `MemoryStorageProvider` loses keys on process exit.

---

## Reference

### Client configuration

```typescript
interface ThetanutsClientConfig {
  chainId: 8453;                         // Required: Base mainnet
  provider: Provider;                    // Required: ethers.js provider
  signer?: Signer;                       // Optional: needed for write ops
  referrer?: string;                     // Optional: fee-share address
  apiBaseUrl?: string;                   // Optional: override REST API base
  indexerApiUrl?: string;                // Optional: override indexer
  pricingApiUrl?: string;                // Optional: override MM pricing
  wsUrl?: string;                        // Optional: override WebSocket
  env?: 'dev' | 'prod';                  // Optional: default 'prod'
  logger?: ThetanutsLogger;              // Optional: custom logger
  keyStorageProvider?: KeyStorageProvider; // Optional: override RFQ key store
  rfqKeyPrefix?: string;                 // Optional: namespace stored keys
}
```

### Chain config (no hardcoded addresses)

```typescript
const config = client.chainConfig;

// Tokens
config.tokens.USDC.address;   // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
config.tokens.USDC.decimals;  // 6
config.tokens.WETH.address;   // 0x4200000000000000000000000000000000000006
config.tokens.cbBTC.address;  // 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf

// Cash-settled implementations (OptionBook + RFQ)
config.implementations.PUT;            // Vanilla PUT
config.implementations.INVERSE_CALL;   // Vanilla CALL
config.implementations.PUT_SPREAD;     // Put spread (2 strikes)
config.implementations.CALL_SPREAD;    // Call spread (2 strikes)
config.implementations.PUT_FLY;        // Put butterfly (3 strikes)
config.implementations.CALL_FLY;       // Call butterfly (3 strikes)
config.implementations.PUT_CONDOR;     // Put condor (4 strikes)
config.implementations.CALL_CONDOR;    // Call condor (4 strikes)
config.implementations.IRON_CONDOR;    // Iron condor (4 strikes)

// Physically settled (vanilla only — multi-leg physicals are zero-addressed)
config.implementations.PHYSICAL_PUT;
config.implementations.PHYSICAL_CALL;

// Chainlink price feeds
config.priceFeeds.ETH;
config.priceFeeds.BTC;
```

### Decimal helpers

| Quantity     | Decimals | Example                                   |
| ------------ | -------- | ----------------------------------------- |
| USDC         | 6        | `1000000n` = 1 USDC                       |
| WETH         | 18       | `1000000000000000000n` = 1 WETH           |
| cbBTC        | 8        | `100000000n` = 1 cbBTC                    |
| Strike/Price | 8        | `185000000000n` = $1,850                  |

```typescript
client.utils.toBigInt('100.5', 6);        // 100500000n
client.utils.strikeToChain(1850);         // 185000000000n
client.utils.fromBigInt(100500000n, 6);   // '100.5'
client.utils.strikeFromChain(185000000000n); // 1850
```

### RFQ collateralAmount is always 0

`collateralAmount` on a quotation params struct **must be `0`**. `buildRFQRequest` / `buildRFQParams` enforce this; never override it. Collateral isn't locked at RFQ creation — it's pulled from both parties at settlement. SELL-side RFQs require a prior `approve()` on the OptionFactory.

### RFQ key management

ECDH keypairs are persisted automatically. The default storage backend depends on environment:

| Environment | Default backend         | Persistence                      |
| ----------- | ----------------------- | -------------------------------- |
| Node.js     | internal file storage   | `.thetanuts-keys/` (perms `0600`) |
| Browser     | explicit provider required | choose app-specific encrypted storage |

```typescript
const keyPair = await client.rfqKeys.getOrCreateKeyPair();
console.log(keyPair.compressedPublicKey);

// Node persists RFQ keys to ./.thetanuts-keys/ by default.
// For custom persistence, pass any object implementing KeyStorageProvider.
// Browser apps must pass keyStorageProvider explicitly; plaintext localStorage is not used by default.

// Memory-only (tests only — logs a warning, keys lost on exit)
import { MemoryStorageProvider } from '@thetanuts-finance/thetanuts-client';
const testClient = new ThetanutsClient({
  chainId: 8453, provider,
  keyStorageProvider: new MemoryStorageProvider(),
});
```

**Back up your private key.** There is no recovery path — lose it and you cannot decrypt offers sent to that public key.

### Custom logger

```typescript
import { ThetanutsClient, consoleLogger } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  logger: consoleLogger, // built-in
  // logger: { debug, info, warn, error }, // or your own
});
```

### Compatibility

| Requirement | Minimum         |
| ----------- | --------------- |
| Node.js     | 18              |
| ethers.js   | v6              |
| TypeScript  | 5.0             |
| Chain       | Base (8453)     |

Builds ship as both ESM and CJS with `.d.ts` declarations, produced by [tsup](https://tsup.egoist.dev/). Both npm and Yarn (incl. Yarn Berry) are supported; CI auto-detects the lockfile.

### Directory layout

```
src/
├── abis/       # Contract ABIs (ERC20, OptionBook, OptionFactory, BaseOption, ...)
├── chains/     # Chain config (addresses, tokens, implementations)
├── client/     # ThetanutsClient
├── modules/    # 14 feature modules
├── types/      # Type definitions
├── utils/      # Helpers
└── index.ts    # Public entry

scripts/
├── run-mainnet-tests.ts       # Live mainnet integration tests
├── benchmark-indexer.ts       # Indexer performance benchmark
└── test-indexer-endpoints.ts  # Indexer endpoint validation
```

---

## Development

```bash
npm install
npm run build           # tsup: ESM + CJS + types
npm run typecheck
npm run lint
npm test                # live mainnet integration tests (needs network)
npm run test:benchmark
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the four required gates and PR conventions.

---

## Documentation & links

| Section                                                                                | Description                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Getting Started](https://docs.thetanuts.finance/sdk/getting-started/overview)         | Installation, quick start, configuration                     |
| [OptionBook](https://docs.thetanuts.finance/sdk/optionbook/overview)                   | Browse, preview, fill                                        |
| [RFQ (Factory)](https://docs.thetanuts.finance/sdk/rfq/overview)                       | Custom options, multi-leg, RFQ lifecycle                     |
| [Pricing](https://docs.thetanuts.finance/sdk/pricing/mm-pricing)                       | MM pricing, spreads, collateral cost                         |
| [Guides](https://docs.thetanuts.finance/sdk/guides/error-handling)                     | Errors, WebSocket, production checklist                      |
| [Loan](https://docs.thetanuts.finance/sdk/loan/overview)                               | Non-liquidatable lending                                     |
| [SDK Reference](https://docs.thetanuts.finance/sdk/reference/client)                   | Client, modules, types, utilities                            |
| [MCP Server](mcp-server/README.md)                                                     | MCP server for SDK reads and prepare-tool calldata builders   |

### Copy-paste examples

| File                                                                | What it shows                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`docs/examples/fill-order.ts`](docs/examples/fill-order.ts)        | Full OptionBook fill: preview, approve, execute, errors    |
| [`docs/examples/claim-fees.ts`](docs/examples/claim-fees.ts)        | Check + claim referrer fees across all tokens              |
| [`docs/examples/create-rfq.ts`](docs/examples/create-rfq.ts)        | RFQ creation (BUY and SELL sides)                          |
| [`docs/examples/physical-option-rfq.ts`](docs/examples/physical-option-rfq.ts) | Physically-settled RFQ (vanilla only)               |
| [`docs/examples/fetch-pricing.ts`](docs/examples/fetch-pricing.ts)  | MM pricing with filters                                    |
| [`docs/examples/option-management.ts`](docs/examples/option-management.ts)     | Position queries and operations                     |
| [`docs/examples/query-stats.ts`](docs/examples/query-stats.ts)      | Protocol and referrer stats                                |

### API reference

- [Source overview](src/README.md)
- [Client](src/client/README.md)
- [Modules](src/modules/README.md)
- [Types](src/types/README.md)
- [Utils](src/utils/README.md)
- [ABIs](src/abis/README.md)
- [Chains](src/chains/README.md)
- [Scripts](scripts/README.md)

### License & policies

- [MIT License](LICENSE)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

### Links

- [Thetanuts Finance](https://thetanuts.finance)
- [Documentation](https://docs.thetanuts.finance)
- [GitHub](https://github.com/Thetanuts-Finance/thetanuts-sdk)
