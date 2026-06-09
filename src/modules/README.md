# SDK Modules

This directory contains the feature modules that provide all SDK functionality.

## Module Overview

| Module | File | Purpose | Requires Signer |
|--------|------|---------|-----------------|
| ERC20 | `erc20.ts` | Token operations | Write ops only |
| OptionBook | `optionBook.ts` | Order execution | Write ops only |
| API | `api.ts` | Data fetching | No |
| OptionFactory | `optionFactory.ts` | RFQ lifecycle | Write ops only |
| Option | `option.ts` | Position management | Write ops only |
| Ranger | `ranger.ts` | RangerOption zone-bound positions | Write ops only |
| Events | `events.ts` | Blockchain events | No |
| WebSocket | `websocket.ts` | Real-time data | No |
| Utils | `utils.ts` | Calculations | No |
| MMPricing | `mmPricing.ts` | Market Maker pricing | No |
| RFQKeyManager | `rfqKeyManager.ts` | ECDH keys & encryption for RFQ | No |
| Loan | `loan.ts` | Non-liquidatable lending | Write ops only |
| Collar | `collar.ts` | Zero-interest collar loans | Write ops only |
| WheelVault | `wheelVault.ts` | Ethereum wheel vaults | Write ops only |
| StrategyVault | `strategyVault.ts` | Base fixed-strike and CLVEX vaults | Write ops only |

## Table of Contents

- [ERC20Module](#erc20module)
- [OptionBookModule](#optionbookmodule)
- [APIModule](#apimodule)
- [OptionFactoryModule](#optionfactorymodule)
- [OptionModule](#optionmodule)
- [RangerModule](#rangermodule)
- [EventsModule](#eventsmodule)
- [WebSocketModule](#websocketmodule)
- [UtilsModule](#utilsmodule)
- [MMPricingModule](#mmpricingmodule)
- [RFQKeyManagerModule](#rfqkeymanagermodule)
- [LoanModule](#loanmodule)
- [CollarModule](#collarmodule)
- [WheelVaultModule](#wheelvaultmodule)
- [StrategyVaultModule](#strategyvaultmodule)
- [Excluded Admin Functions](#excluded-admin-functions)

---

## ERC20Module

Token approval, balance, and transfer operations.

### Methods (read-only and requires signer)

```typescript
// Get token balance
const balance = await client.erc20.getBalance(tokenAddress, ownerAddress?);

// Get allowance
const allowance = await client.erc20.getAllowance(tokenAddress, owner, spender);

// Approve spending (requires signer)
const receipt = await client.erc20.approve(tokenAddress, spender, amount);

// Ensure allowance exists, approve if needed (requires signer)
const receipt = await client.erc20.ensureAllowance(tokenAddress, spender, amount);

// Transfer tokens (requires signer)
const receipt = await client.erc20.transfer(tokenAddress, to, amount);

// Get token decimals (cached)
const decimals = await client.erc20.getDecimals(tokenAddress);

// Get token symbol
const symbol = await client.erc20.getSymbol(tokenAddress);
```

### Example: Approve Before Trading

```typescript
const usdcAddress = client.chainConfig.tokens['USDC'].address;
const optionBookAddress = client.chainConfig.contracts.optionBook;

// Check current allowance
const allowance = await client.erc20.getAllowance(
  usdcAddress,
  await client.getSignerAddress(),
  optionBookAddress
);

// Approve if needed
if (allowance < requiredAmount) {
  await client.erc20.approve(usdcAddress, optionBookAddress, requiredAmount);
}

// Or use ensureAllowance (does both in one call)
await client.erc20.ensureAllowance(usdcAddress, optionBookAddress, requiredAmount);
```

---

## OptionBookModule

Execute trades by filling orders from the orderbook.

### Methods (read-only)

```typescript
// Preview a fill order (dry-run, no transaction)
const preview = client.optionBook.previewFillOrder(orderWithSig, usdcAmount?, referrer?);

// Calculate number of contracts from USDC amount and price
const numContracts = client.optionBook.calculateNumContracts(usdcAmount, price);

// Encode fillOrder for external wallet use (viem/wagmi/AA wallets)
const { to, data } = client.optionBook.encodeFillOrder(orderWithSig, usdcAmount?, referrer?);

// Encode swapAndFillOrder for external wallet use
const { to, data } = client.optionBook.encodeSwapAndFillOrder(orderWithSig, swapParams);

// Get fees for a single token
const fees = await client.optionBook.getFees(collateralToken, referrer);

// Get all claimable fees across every collateral token (USDC, WETH, cbBTC, etc.)
const claimable = await client.optionBook.getAllClaimableFees(referrerAddress);
// Returns: [{ token, symbol, decimals, amount }] for non-zero balances

// Get amount filled for a nonce
const filled = await client.optionBook.getAmountFilled(nonce);

// Get referrer fee split in basis points
const feeBps = await client.optionBook.getReferrerFeeSplit(referrerAddress);

// Get factory address
const factory = await client.optionBook.getFactory();

// Get price decimals constant
const decimals = await client.optionBook.getPriceDecimals();

// Compute nonce for an order
const nonce = await client.optionBook.computeNonce(orderWithSig);

// Get order hash
const hash = await client.optionBook.hashOrder(orderWithSig);

// Get EIP-712 domain info
const domain = await client.optionBook.getEip712Domain();

// Get limit order typehash
const typehash = await client.optionBook.getLimitOrderTypehash();
```

### Methods (requires signer)

```typescript
// Fill an order
const result = await client.optionBook.fillOrder(orderWithSig, usdcAmount?, referrer?);

// Fill with token swap
const result = await client.optionBook.swapAndFillOrder(orderWithSig, swapParams);

// Cancel an order
const result = await client.optionBook.cancelOrder(orderWithSig);

// Claim accumulated fees for a single token
const receipt = await client.optionBook.claimFees(collateralToken);

// Claim all non-zero fee balances across every collateral token
const results = await client.optionBook.claimAllFees();
// Returns: [{ symbol, amount, receipt?, error? }] for each token attempted

// Set referrer fee split (owner-gated)
const receipt = await client.optionBook.setReferrerFeeSplit(referrer, feeBps);

// Sweep protocol fees (owner-gated)
const receipt = await client.optionBook.sweepProtocolFees(tokenAddress);
```

### Example: Fill an Order

```typescript
// Fetch orders
const orders = await client.api.fetchOrders();
const order = orders[0]; // OrderWithSignature

// Ensure token approval
await client.erc20.ensureAllowance(
  order.rawApiData.collateral,
  client.chainConfig.contracts.optionBook,
  order.availableAmount
);

// Fill the order (pass full OrderWithSignature)
const result = await client.optionBook.fillOrder(order);

console.log('Trade executed:', result.txHash);
```

---

## APIModule

Fetch data from the Thetanuts APIs. All methods are read-only except `triggerIndexerUpdate()`.

All data comes from the unified indexer at `indexer.thetanuts.finance`. Book endpoints use `/api/v1/book/*`, factory endpoints use `/api/v1/factory/*`.

### Health

```typescript
const health = await client.api.getHealth();
// → { status, chainId, lastIndexedBlock, headBlock, lagBlocks, lastPing, secondsSincePing, timestamp }
```

### Factory (RFQ) Endpoints

```typescript
// Full state blob (all RFQs, offers, options, user mappings)
const state = await client.api.getStateFromRfq();

// Single RFQ by ID (direct fetch, no blob)
const rfq = await client.api.getRfq('42');

// All RFQs (with optional status filter)
const allRfqs = await client.api.getFactoryRfqs('active');

// All offers
const allOffers = await client.api.getFactoryOffers();

// All options
const allOptions = await client.api.getFactoryOptions();

// User's RFQs
const rfqs = await client.api.getUserRfqs('0x...');

// User's offers
const offers = await client.api.getUserOffersFromRfq('0x...');

// User's factory positions / options
const options = await client.api.getUserOptionsFromRfq('0x...');

// Factory stats
const stats = await client.api.getFactoryStats();
// → { totalRfqs, activeRfqs, settledRfqs, cancelledRfqs, totalOffers, totalOptions, lastProcessedBlock, ... }
```

### Book (OptionBook) Endpoints

```typescript
// Full book state blob (all positions + user index)
const bookState = await client.api.getBookState();

// User's positions (auto-paginated)
const positions = await client.api.getUserPositionsFromIndexer('0x...');

// User's trade history (auto-paginated)
const history = await client.api.getUserHistoryFromIndexer('0x...');

// Book stats
const stats = await client.api.getStatsFromIndexer();
// → { totalOptionsTracked, openPositions, settledPositions, closedPositions, uniqueUsers, positions: {...} }

// Referrer stats (book side)
const ref = await client.api.getReferrerStatsFromIndexer('0x...');

// Referrer stats (factory/RFQ side)
const factoryRef = await client.api.getFactoryReferrerStats('0x...');

// Trigger indexer refresh (POST)
await client.api.triggerIndexerUpdate();
```

### Protocol Stats (Book, Factory, Combined)

```typescript
// Book (OptionBook) protocol stats with 24h/7d/30d windows
const bookStats = await client.api.getBookProtocolStats();
// → { stats: { totalPositions, totalVolumeUsd, '24h': {...}, '7d': {...}, '30d': {...}, exerciseRate } }

// Factory (RFQ) protocol stats — includes avgTimeToFill, avgOffersPerRfq
const factoryStats = await client.api.getFactoryProtocolStats();
// → { stats: { totalPositions, totalVolumeUsd, avgTimeToFill, avgOffersPerRfq, '24h': {...} } }

// Combined book + factory stats
const combined = await client.api.getProtocolStats();
// → { stats: { totalPositions, totalVolumeUsd, ... } }
```

### Daily Stats (Time Series)

```typescript
// Book daily trading stats (all history)
const bookDaily = await client.api.getBookDailyStats();
// → { daily: [{ date, trades, volume, premium, fees, volumeUsd, premiumUsd, feesUsd }, ...] }

// Factory daily trading stats
const factoryDaily = await client.api.getFactoryDailyStats();

// Combined book + factory daily stats
const allDaily = await client.api.getDailyStats();
```

### Single Option Detail (with PnL)

```typescript
// Factory option detail (RFQ-created)
const factoryOpt = await client.api.getFactoryOption('0x...');
// → { rfqs, events, status, settlement, pnl, ... }

// Book option detail (OptionBook-created)
const bookOpt = await client.api.getBookOption('0x...');
// → { position, events, status, settlement, pnl, ... }
```

### Orders & Market Data (Odette API)

```typescript
// Fetch all orders
const orders = await client.api.fetchOrders();

// Filter orders
const ethCalls = await client.api.filterOrders({ asset: 'ETH', type: 'call' });

// Market data (BTC, ETH, SOL, XRP, BNB, AVAX prices)
const marketData = await client.api.getMarketData();

// Market prices
const prices = await client.api.getMarketPrices();
```

---

## OptionFactoryModule

Request for Quotation (RFQ) system for custom options.

### RFQ Lifecycle Methods (requires signer)

```typescript
// Create RFQ
const receipt = await client.optionFactory.requestForQuotation(rfqRequest);

// Make offer (encrypted)
const receipt = await client.optionFactory.makeOfferForQuotation(offerParams);

// Reveal offer
const receipt = await client.optionFactory.revealOffer(revealParams);

// Settle quotation after reveal phase
const receipt = await client.optionFactory.settleQuotation(quotationId);

// Settle quotation early with specific offer
const receipt = await client.optionFactory.settleQuotationEarly(quotationId, offerAmount, nonce, offeror);

// Cancel quotation (requester only)
const receipt = await client.optionFactory.cancelQuotation(quotationId);

// Cancel an offer
const receipt = await client.optionFactory.cancelOfferForQuotation(quotationId);
```

### View Methods — Quotation State (read-only)

```typescript
// Get quotation by ID (returns params + state)
// Throws NotFoundError for out-of-range IDs
const quotation = await client.optionFactory.getQuotation(quotationId);

// Get total quotation count
const count = await client.optionFactory.getQuotationCount();

// Calculate fee for a quotation
const fee = await client.optionFactory.calculateFee(numContracts, premium, price);
```

### View Methods — Constants (read-only)

```typescript
// Get maximum RFQ value
const maxValue = await client.optionFactory.getMaxRfqValue();

// Get EIP-712 offer typehash
const typehash = await client.optionFactory.getOfferTypehash();

// Get reveal window duration (seconds)
const window = await client.optionFactory.getRevealWindow();

// Get TWAP period duration (seconds)
const period = await client.optionFactory.getTwapPeriod();
```

### View Methods — State (read-only)

```typescript
// Check if a router address is authorized
const authorized = await client.optionFactory.isRouterAuthorized(routerAddress);

// Get EIP-712 domain separator fields
const domain = await client.optionFactory.getEip712Domain();

// Get historical TWAP consumer address
const consumer = await client.optionFactory.getHistoricalTWAPConsumer();
```

### View Methods — Referral (read-only)

```typescript
// Get tracking data for a quotation (referralId + eventCode)
const tracking = await client.optionFactory.getQuotationTracking(quotationId);

// Get accumulated fees for a referral
const fees = await client.optionFactory.getReferralFees(referralId);

// Get full referral parameters
const params = await client.optionFactory.getReferralParameters(referralId);
```

**Note:** The `StateReferral` type from the State API has this shape:
```typescript
interface StateReferral {
  id: string;
  referrer: string;       // Referrer address
  createdAt: number;      // Unix timestamp
  createdTx: string;      // Creation tx hash
  createdBlock: number;
  executed: ReferralExecution[];  // { quotationId, amount, executedBlock }
}
```

### Write Methods — Referral & Swap (requires signer)

```typescript
// Register a new referral
const receipt = await client.optionFactory.registerReferral(quotationParams);

// Swap tokens and execute a call atomically
const receipt = await client.optionFactory.swapAndCall(swapAndCallParams);
```

### RFQ Lifecycle

```
1. requestForQuotation() → PENDING
2. makeOfferForQuotation() → OFFERED (encrypted)
3. revealOffer() → REVEALED
4. settleQuotation() → SETTLED (option created)
   OR settleQuotationEarly() → SETTLED (with specific offer)
   OR cancelQuotation() → CANCELLED
```

---

## OptionModule

Manage option positions after trading (BaseOption contract).

### Write Methods (requires signer)

```typescript
// Close position
const result = await client.option.close(optionAddress);

// Transfer buyer or seller role (requires signer)
const result = await client.option.transfer(optionAddress, isBuyer, target);

// Split position by collateral amount (requires signer)
const result = await client.option.split(optionAddress, splitCollateralAmount);

// Execute payout after expiry — REMOVED in r12 (TNU-AUDIT-0046)
// Settlement is automatic via factory callbacks; calling client.option.payout()
// now throws INVALID_PARAMS. Use `getOptionInfo(address).settled` to check
// status and `calculatePayout(...)` (view) to compute the payout amount.

// Approve address for position transfer (requires signer)
const result = await client.option.approveTransfer(optionAddress, isBuyer, target, isApproved);

// Rescue stuck ERC20 tokens (requires signer)
const result = await client.option.rescueERC20(optionAddress, tokenAddress);
```

### Read Methods (read-only)

```typescript
// Get all option data in one call (fields are nullable for incompatible proxy contracts)
const fullInfo = await client.option.getFullOptionInfo(optionAddress);
// → { info, buyer, seller, isExpired, isSettled, numContracts, collateralAmount }
// Use { sequential: true } for RPC providers with batch limits
const fullInfo = await client.option.getFullOptionInfo(optionAddress, { sequential: true });

// Get option info (strikes, expiry, collateral, type)
const info = await client.option.getOptionInfo(optionAddress);

// Calculate payout at settlement price
const payout = await client.option.calculatePayout(optionAddress, settlementPrice);

// Calculate required collateral for given strikes and numContracts
const collateral = await client.option.calculateRequiredCollateral(optionAddress, strikes, numContracts);

// Simulate payout (pure calculation, no state)
const simPayout = await client.option.simulatePayout(optionAddress, price, strikes, numContracts);

// Strike prices
const strikes = await client.option.getStrikes(optionAddress);
const strike = await client.option.getStrikeAtIndex(optionAddress, 0n);

// Expiry and settlement
const expiry = await client.option.getExpiry(optionAddress);
const expired = await client.option.isExpired(optionAddress);
const settled = await client.option.isSettled(optionAddress);

// Option type
const optionType = await client.option.getOptionType(optionAddress);
const unpacked = await client.option.unpackOptionType(optionAddress);
// { isQuoteCollateral, isPhysicallySettled, optionStyle, optionStructure }

// Position holders
const buyer = await client.option.getBuyer(optionAddress);
const seller = await client.option.getSeller(optionAddress);

// Transfer approvals
const allowed = await client.option.getBuyerAllowance(optionAddress, owner, spender);
const allowed = await client.option.getSellerAllowance(optionAddress, owner, spender);

// Collateral info
const token = await client.option.getCollateralToken(optionAddress);
const amount = await client.option.getCollateralAmount(optionAddress);
const contracts = await client.option.getNumContracts(optionAddress);

// Oracle info
const priceFeed = await client.option.getChainlinkPriceFeed(optionAddress);
const twapConsumer = await client.option.getHistoricalTWAPConsumer(optionAddress);
const twap = await client.option.getTWAP(optionAddress);
const period = await client.option.getTwapPeriod(optionAddress);

// Contract addresses
const impl = await client.option.getImplementation(optionAddress);
const factory = await client.option.getFactory(optionAddress);
const rescue = await client.option.getRescueAddress(optionAddress);

// Constants
const decimals = await client.option.getPriceDecimals(optionAddress);

// Cache management
client.option.clearCache();
```

---

## EventsModule

Query blockchain events from contracts.

**Block range handling:** Event queries automatically chunk large block ranges into 10K-block segments to work with any RPC provider (public free-tier, Alchemy, Infura, custom nodes). When no `fromBlock` is specified, queries search backward from the latest block — most recent events are found first. `getRfqHistory()` runs its sub-queries sequentially to avoid rate limiting.

### OptionBook / OptionFactory Events (read-only)

```typescript
// Get order fill events
const fills = await client.events.getOrderFillEvents(filters?);

// Get order cancelled events
const cancels = await client.events.getOrderCancelledEvents(filters?);

// Get option created events
const options = await client.events.getOptionCreatedEvents(filters?);

// Get RFQ events
const rfqs = await client.events.getQuotationRequestedEvents(filters?);
const offers = await client.events.getOfferMadeEvents(filters?);
const reveals = await client.events.getOfferRevealedEvents(filters?);
const settlements = await client.events.getQuotationSettledEvents(filters?);
const cancelled = await client.events.getQuotationCancelledEvents(filters?);

// Get position events
const closes = await client.events.getPositionClosedEvents(optionAddress, filters?);
const transfers = await client.events.getPositionTransferredEvents(optionAddress, filters?);

// Get RFQ history
const history = await client.events.getRfqHistory(quotationId, filters?);

// Generic event query
const events = await client.events.queryEvents(params);
```

### BaseOption Events (read-only)

Query events from individual option contracts (requires option address):

```typescript
// Excess collateral returned to seller (renamed from CollateralReturned in v0.2.1)
const events = await client.events.getExcessCollateralReturnedEvents(optionAddress, filters?);

// Option closed
const events = await client.events.getOptionClosedEvents(optionAddress, filters?);

// Option expired with settlement price
const events = await client.events.getOptionExpiredEvents(optionAddress, filters?);

// Payout executed to buyer
const events = await client.events.getOptionPayoutEvents(optionAddress, filters?);

// Settlement failed
const events = await client.events.getOptionSettlementFailedEvents(optionAddress, filters?);

// Position split into new option
const events = await client.events.getOptionSplitEvents(optionAddress, filters?);

// Buyer/seller role transferred
const events = await client.events.getRoleTransferredEvents(optionAddress, filters?);

// Transfer approval granted/revoked
const events = await client.events.getTransferApprovalEvents(optionAddress, filters?);

// ERC20 tokens rescued
const events = await client.events.getERC20RescuedEvents(optionAddress, filters?);
```

### Example: Get Recent Fills

```typescript
const fills = await client.events.getOrderFillEvents({
  fromBlock: -10000, // Last 10,000 blocks
  maker: userAddress, // Filter by maker
});

for (const fill of fills) {
  console.log(`Fill: ${fill.amount} @ ${fill.price}`);
  console.log(`  Tx: ${fill.transactionHash}`);
}
```

---

## WebSocketModule

Real-time data subscriptions.

### Methods (read-only)

```typescript
// Connect to WebSocket
await client.ws.connect(config?);

// Subscribe to updates
const subscriptionId = client.ws.subscribe(options, callback);

// Unsubscribe
client.ws.unsubscribe(subscriptionId);

// Get connection state
const state = client.ws.getState();

// Disconnect
client.ws.disconnect();
```

### Subscription Types

| Type | Data |
|------|------|
| `orders` | Order updates (new, filled, cancelled) |
| `positions` | Position changes |
| `prices` | Real-time price updates |
| `trades` | Trade executions |
| `quotations` | RFQ updates |

### Example: Subscribe to Orders

```typescript
// Connect
await client.ws.connect();

// Subscribe to order updates
const subId = client.ws.subscribe(
  { type: 'orders' },
  (update) => {
    console.log('Order update:', update);
    // { type: 'new' | 'filled' | 'cancelled', order: {...} }
  }
);

// Subscribe to price updates
client.ws.subscribe(
  { type: 'prices', assets: ['BTC', 'ETH'] },
  (update) => {
    console.log(`${update.asset}: $${update.price}`);
  }
);

// Later: unsubscribe and disconnect
client.ws.unsubscribe(subId);
client.ws.disconnect();
```

---

## UtilsModule

Utility calculations for options.

### Methods (read-only)

```typescript
// Calculate payout at settlement
const payout = client.utils.calculatePayout(params);

// Calculate required collateral
const collateral = client.utils.calculateCollateral(params);

// Generate payoff diagram data
const diagram = client.utils.generatePayoffDiagram(params);

// Decimal conversions
const strikeRaw = client.utils.toStrikeDecimals(100000); // $100,000 → 10000000000000n
const strikeHuman = client.utils.fromStrikeDecimals(10000000000000n); // → "100000"

const usdcRaw = client.utils.toUsdcDecimals(1000); // $1,000 → 1000000000n
const usdcHuman = client.utils.fromUsdcDecimals(1000000000n); // → "1000"

const priceRaw = client.utils.toPriceDecimals(0.05); // $0.05 → 5000000n
```

### Supported Structures

| Structure | Strikes | Description |
|-----------|---------|-------------|
| `call` | 1 | Long/short call |
| `put` | 1 | Long/short put |
| `call_spread` | 2 | Bull/bear call spread |
| `put_spread` | 2 | Bull/bear put spread |
| `butterfly` | 3 | Butterfly spread |
| `iron_condor` | 4 | Iron condor |
| `straddle` | 1 | Long/short straddle |
| `strangle` | 2 | Long/short strangle |

### Example: Calculate Spread Payoff

```typescript
const payoff = client.utils.calculatePayout({
  structure: 'call_spread',
  strikes: [
    client.utils.toStrikeDecimals(100000), // $100,000
    client.utils.toStrikeDecimals(105000), // $105,000
  ],
  size: 1000000n, // 1 contract (6 decimals)
  price: client.utils.toStrikeDecimals(102000), // Settlement: $102,000
  isLong: true,
});

console.log(`Payoff: $${client.utils.fromUsdcDecimals(payoff)}`);
```

---

## RFQKeyManagerModule

ECDH keypair generation, secure storage, and encryption/decryption for the sealed-bid auction RFQ workflow.

### Key Generation Methods

```typescript
// Generate a new keypair (does NOT store automatically)
const keyPair = client.rfqKeys.generateKeyPair();
// Returns: { privateKey, compressedPublicKey, publicKey }

// Get or create keypair (loads from storage or generates + stores new one)
const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// Load existing keypair from storage
const keyPair = await client.rfqKeys.loadKeyPair();

// Check if a keypair exists in storage
const hasKey = await client.rfqKeys.hasStoredKey();
```

### Key Storage Methods

```typescript
// Store a keypair
await client.rfqKeys.storeKeyPair(keyPair);

// Remove stored keypair (WARNING: prevents decrypting old offers)
await client.rfqKeys.removeStoredKey();

// Export private key for backup
const privateKey = await client.rfqKeys.exportPrivateKey();

// Import keypair from private key
const keyPair = await client.rfqKeys.importFromPrivateKey(privateKey, store?);
```

### Encryption Methods

```typescript
// Encrypt offer for requester (as offeror)
const encrypted = await client.rfqKeys.encryptOffer(
  offerAmount,    // bigint - the offer amount
  nonce,          // bigint - random nonce for EIP-712 signature
  requesterPublicKey, // string - requester's compressed public key
  keyPair?        // optional - uses stored key if not provided
);
// Returns: { ciphertext, signingKey }

// Decrypt offer (as requester viewing incoming bids)
const decrypted = await client.rfqKeys.decryptOffer(
  encryptedData,      // string - IV + ciphertext hex
  offerorPublicKey,   // string - offeror's public key (signingKey from event)
  keyPair?            // optional - uses stored key if not provided
);
// Returns: { offerAmount, nonce }
```

### Utility Methods

```typescript
// Generate random 128-bit nonce for offers
const nonce = client.rfqKeys.generateNonce();

// Get public key from private key
const publicKey = client.rfqKeys.getPublicKeyFromPrivate(privateKey);

// Validate public key format
const isValid = client.rfqKeys.isValidPublicKey(publicKey);

// Get storage key ID for current chain
const keyId = client.rfqKeys.getStorageKeyId();
// Returns: 'thetanuts_rfq_key_8453' (for Base mainnet)
```

### Storage Providers

The module auto-detects the environment:
- **Browser**: Uses `localStorage`
- **Node.js**: Uses in-memory storage (keys lost on exit)

Custom storage can be configured:

```typescript
import { ThetanutsClient, MemoryStorageProvider } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  keyStorageProvider: new MemoryStorageProvider(), // or custom implementation
  rfqKeyPrefix: 'my_app_rfq_key', // optional custom prefix
});
```

### Example: Complete RFQ Offer Flow

```typescript
// 1. Get or create keypair
const keyPair = await client.rfqKeys.getOrCreateKeyPair();
console.log('My public key:', keyPair.compressedPublicKey);

// 2. Fetch quotation to get requester's public key
const quotation = await client.optionFactory.getQuotation(quotationId);

// 3. Generate nonce and encrypt offer
const nonce = client.rfqKeys.generateNonce();
const offerAmount = client.utils.toUsdcDecimals(100); // $100 USDC

const encrypted = await client.rfqKeys.encryptOffer(
  offerAmount,
  nonce,
  quotation.params.requesterPublicKey
);

// 4. Sign the offer with EIP-712 (using wallet)
const signature = await signOffer(quotationId, offerAmount, nonce);

// 5. Submit encrypted offer to contract
await client.optionFactory.makeOfferForQuotation({
  quotationId,
  signature,
  signingKey: encrypted.signingKey,      // Our compressed public key
  encryptedOffer: encrypted.ciphertext,  // Encrypted offer data
});

// 6. Store offer locally for reveal phase
localStorage.setItem(`offer_${quotationId}`, JSON.stringify({
  offerAmount: offerAmount.toString(),
  nonce: nonce.toString(),
}));
```

### Example: Decrypt Incoming Offers (Requester)

The `OfferMade` event itself only carries `(quotationId, offeror)` after the
SDK's curated decoder runs — the encrypted payload and the offeror's
ephemeral `signingKey` are not surfaced on the event type. Fetch the
hydrated offers from the State API instead:

```typescript
// As requester, decrypt offers to evaluate bids
const rfq = await client.api.getRfq(quotationId.toString());
const keyPair = await client.rfqKeys.loadKeyPair();

for (const [offerorAddr, offer] of Object.entries(rfq.offers ?? {})) {
  try {
    const decrypted = await client.rfqKeys.decryptOffer(
      offer.signedOfferForRequester,
      offer.signingKey, // Offeror's ephemeral public key
      keyPair
    );
    console.log(`Offer from ${offerorAddr}: ${client.utils.fromUsdcDecimals(decrypted.offerAmount)} USDC`);
  } catch (error) {
    console.log(`Could not decrypt offer from ${offerorAddr}`);
  }
}
```

To fetch a single offer instead of iterating, use
`client.api.getOffer(quotationId, offerorAddress)`.

### Encryption Details

The module uses industry-standard cryptography:
- **Key Exchange**: ECDH (secp256k1) for shared secret derivation
- **Key Derivation**: SHA-256 hash of shared secret
- **Encryption**: AES-256-GCM with 12-byte random IV
- **Payload**: JSON encoded `{ offerAmount, nonce }`
- **Output**: `IV (12 bytes) || ciphertext` as hex string

---

## MMPricingModule

Market Maker pricing with fee adjustments and collateral costs.

### Methods (read-only)

```typescript
// Get all MM pricing for an asset
const allPricing = await client.mmPricing.getAllPricing('ETH');

// Get pricing for a specific ticker
const pricing = await client.mmPricing.getTickerPricing('ETH-25FEB26-1800-P');
console.log('MM Bid:', pricing.byCollateral.USD.mmBidPrice);
console.log('MM Ask:', pricing.byCollateral.USD.mmAskPrice);

// Get spread pricing
const spread = await client.mmPricing.getSpreadPricing({
  underlying: 'ETH',
  isCall: false,
  strikes: [1800n * 10n**8n, 1900n * 10n**8n],
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
});
console.log('Spread MM Bid:', spread.netMmBidPrice);
console.log('Spread MM Ask:', spread.netMmAskPrice);

// Get condor pricing
const condor = await client.mmPricing.getCondorPricing({
  underlying: 'ETH',
  type: 'call',
  strikes: [1700n * 10n**8n, 1800n * 10n**8n, 1900n * 10n**8n, 2000n * 10n**8n],
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
});

// Get butterfly pricing
const butterfly = await client.mmPricing.getButterflyPricing({
  underlying: 'ETH',
  isCall: true,
  strikes: [1800n * 10n**8n, 1900n * 10n**8n, 2000n * 10n**8n],
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
});
```

### MM Pricing Adjustments

MM pricing includes:
1. **Fee adjustment**: `min(0.0004, price * 0.125)`
2. **Collateral cost**: Based on APR rates (USD: 7%, BTC: 1%, ETH: 4%)
3. **Buffered prices**: Additional safety margin for execution
4. **Bid price floor**: Multi-leg bid prices (spread, butterfly, condor) are floored to 0 — prevents negative pricing when collateral cost exceeds net premium

**Error handling:** `getTickerPricing()` throws `NotFoundError` when a ticker is not found in exchange data. The error log includes the first 20 available tickers for diagnosis.

---

## RangerModule

RangerOption support for zone-bound, 4-strike payoff structures on Base.

### Common methods

```typescript
const info = await client.ranger.getInfo(rangerAddress);
const strikes = await client.ranger.getStrikes(rangerAddress);
const zone = await client.ranger.getZone(rangerAddress);
const payout = await client.ranger.calculatePayout(rangerAddress, settlementPrice);
const simulated = await client.ranger.simulatePayout(rangerAddress, price, strikes, numContracts);
const collateral = await client.ranger.calculateRequiredCollateral(rangerAddress, strikes, numContracts);

await client.ranger.payout(rangerAddress);
await client.ranger.close(rangerAddress);
await client.ranger.split(rangerAddress, splitCollateralAmount);
await client.ranger.transfer(rangerAddress, isBuyer, target);
await client.ranger.reclaimCollateral(rangerAddress, ownedOption);
await client.ranger.returnExcessCollateral(rangerAddress);
```

The module is chain-gated: methods throw `NETWORK_UNSUPPORTED` on chains where the `RANGER` implementation is not deployed.

---

## LoanModule

Non-liquidatable lending backed by physically settled call options on Base.

### Common methods

```typescript
const result = await client.loan.requestLoan(request);
await client.loan.acceptOffer(quotationId, offerAmount, nonce, offeror);
await client.loan.cancelLoan(quotationId);
await client.loan.exerciseOption(optionAddress);
await client.loan.doNotExercise(optionAddress);
await client.loan.swapAndExercise(optionAddress, swapParams);
await client.loan.splitOption(optionAddress, splitCollateralAmount);
await client.loan.reclaimCollateral(optionAddress, ownedOption);

const opportunities = await client.loan.getLendingOpportunities();
const requestState = await client.loan.getLoanRequest(quotationId);
const userLoans = await client.loan.getUserLoans(userAddress);
const optionInfo = await client.loan.getOptionInfo(optionAddress);
const strikes = await client.loan.getStrikeOptions('ETH');
const calc = client.loan.calculateLoan(params);
```

The module uses the Base loan coordinator configuration and is not available from an Ethereum-mainnet client.

---

## CollarModule

Zero-interest collar loan helpers. Pricing and strike filtering are available now; on-chain write methods require the collar-v12 coordinator addresses to be populated.

### Common methods

```typescript
const deployed = client.collar.isDeployed();
const estimate = client.collar.estimateCollar(params);
const filtered = client.collar.filterCapStrikes(capStrikes, settings);
const groups = await client.collar.getCapStrikeOptions('ETH', settings);
const maxCap = await client.collar.getMaxCapStrike('ETH');
const loanRequest = await client.collar.getLoanRequest(quotationId);

await client.collar.requestLoan(request);
await client.collar.cancelLoan(quotationId);
await client.collar.acceptOffer(quotationId, offerAmount, nonce, offeror);
await client.collar.exerciseCollar(optionAddress);
await client.collar.walkAwayCollar(optionAddress);
```

When `isDeployed()` is false, on-chain methods throw `NETWORK_UNSUPPORTED` instead of routing to zero-address placeholders.

---

## WheelVaultModule

Gyro-style wheel-strategy vault interactions on Ethereum mainnet.

### Common methods

```typescript
const state = await client.wheelVault.getVaultState(vaultAddress, seriesId);
const series = await client.wheelVault.getSeries(vaultAddress, seriesId);
const count = await client.wheelVault.getSeriesCount(vaultAddress);
const split = await client.wheelVault.estimateDepositSplit(vaultAddress, seriesId, token, amount);
const shares = await client.wheelVault.previewDeposit(vaultAddress, seriesId, baseAmount, quoteAmount);

await client.wheelVault.deposit(vaultAddress, seriesId, baseAmount, quoteAmount, expectedPrice);
await client.wheelVault.withdraw(vaultAddress, seriesId, shares, expectedPrice);
await client.wheelVault.depositSingle(params);
await client.wheelVault.withdrawSingle(params);
await client.wheelVault.marketFill(marketsAddress, fillParams);
```

The module is chain-gated to `chainId: 1`; Base-configured clients throw `NETWORK_UNSUPPORTED`.

---

## StrategyVaultModule

Fixed-strike and CLVEX strategy vault interactions on Base.

### Common methods

```typescript
const state = await client.strategyVault.getVaultState(vaultAddress);
const assets = await client.strategyVault.getTotalAssets(vaultAddress);
const shares = await client.strategyVault.getShareBalance(vaultAddress, userAddress);
const nextExpiry = await client.strategyVault.getNextExpiry(vaultAddress);
const canCreate = await client.strategyVault.canCreateOption(vaultAddress);
const recovery = await client.strategyVault.isRecoveryMode(vaultAddress);

await client.strategyVault.deposit(vaultAddress, amount, assetIndex);
await client.strategyVault.withdraw(vaultAddress, shares);
await client.strategyVault.createOption(vaultAddress);

const fixedStrike = await client.strategyVault.getFixedStrikeVaults();
const clvex = await client.strategyVault.getClvexVaults();
const all = await client.strategyVault.getAllVaults();
```

The module is chain-gated to Base (`chainId: 8453`).

---

## Excluded Admin Functions

The following on-chain admin functions are **intentionally excluded** from the SDK. They require contract owner authorization and are not relevant to application developers or market makers.

| Contract | Function Signature | On-Chain Modifier | Reason |
|----------|-------------------|-------------------|--------|
| OptionFactory | `setMaxRfqValue(uint256)` | `onlyOwner` | Protocol governance — sets max RFQ size |
| OptionFactory | `setBaseSplitFee(uint256)` | `onlyOwner` | Protocol governance — sets option split fee |
| OptionFactory | `deprecateFactory()` | `onlyOwner` | Protocol governance — permanently disables factory |
| OptionBook | `setMinimumThresholds(uint256, uint256)` | `factory.owner()` | Protocol governance — sets min premium/contracts |

**BaseOption** has zero admin-only functions. All methods are gated by buyer/seller roles or option state.

### Owner-Gated Methods That ARE Included

These methods are included because they serve referral partners or have broader utility, but they require owner authorization:

| Module | Method | Note |
|--------|--------|------|
| `optionFactory` | `withdrawFees()` | Requires owner auth — see `@remarks` in JSDoc |
| `optionBook` | `setReferrerFeeSplit()` | Requires owner auth — see `@remarks` in JSDoc |
| `optionBook` | `sweepProtocolFees()` | Sends fees to owner — see `@remarks` in JSDoc |
