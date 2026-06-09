# Type Definitions

This directory contains all TypeScript type definitions for the SDK.

## File Overview

| File | Purpose |
|------|---------|
| `common.ts` | Shared enums and literal types (OptionType, OptionStructure, OrderSide, etc.) |
| `client.ts` | Client configuration types (ThetanutsClientConfig, SupportedChainId) |
| `errors.ts` | Error codes and error class (ThetanutsErrorCode, ThetanutsError) |
| `logger.ts` | Logger interface (ThetanutsLogger) |
| `optionBook.ts` | OptionBook contract types (ContractOrder, Order, SwapParams, FillOrderResult) |
| `optionFactory.ts` | RFQ/OptionFactory types (QuotationParameters, RFQRequest, ReferralParameters, SwapAndCallParams) |
| `option.ts` | Option position types (OptionInfo, PayoutCalculation, UnpackedOptionType) |
| `events.ts` | Blockchain event types (OrderFillEvent, QuotationRequestedEvent, etc.) |
| `pricing.ts` | Pricing and Greeks types (PayoffInput, PayoffDiagram, Greeks) |
| `erc20.ts` | ERC20 operation types (ApprovalResult, TokenBalance, TokenInfo) |
| `api.ts` | API response types (OrderWithSignature, Position, MarketDataResponse) |
| `stateApi.ts` | State API types for RFQ indexer (StateApiResponse, StateRfq, StateOffer, StateOption) |
| `websocket.ts` | WebSocket types (WebSocketState, SubscriptionType, OrderUpdate, PriceUpdate) |
| `rfqKeyManager.ts` | RFQ key management types (RFQKeyPair, EncryptedOffer, DecryptedOffer, KeyStorageProvider) |

---

## Common Types (`common.ts`)

### Basic Enums

```typescript
type OptionType = 'call' | 'put';

type ProductType = 'spread' | 'butterfly' | 'condor';

type OptionStructure =
  | 'call' | 'put'
  | 'call_spread' | 'put_spread'
  | 'butterfly' | 'iron_condor'
  | 'straddle' | 'strangle';

type OrderSide = 'buy' | 'sell';

type OrderStatus = 'open' | 'filled' | 'partially_filled' | 'cancelled' | 'expired';

type PositionStatus = 'open' | 'closed' | 'expired' | 'exercised';
```

---

## Client Types (`client.ts`)

### Configuration

```typescript
type SupportedChainId = 8453; // Base mainnet only

type Environment = 'dev' | 'prod';

interface ThetanutsClientConfig {
  chainId: SupportedChainId;
  provider: Provider;
  signer?: Signer;
  referrer?: string;
  apiBaseUrl?: string;
  indexerApiUrl?: string;
  pricingApiUrl?: string;
  wsUrl?: string;
  env?: Environment;
  logger?: ThetanutsLogger;
}
```

---

## Error Types (`errors.ts`)

### Error Codes

```typescript
type ThetanutsErrorCode =
  | 'ORDER_EXPIRED'
  | 'SLIPPAGE_EXCEEDED'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'INSUFFICIENT_BALANCE'
  | 'NETWORK_UNSUPPORTED'
  | 'HTTP_ERROR'
  | 'CONTRACT_REVERT'
  | 'INVALID_PARAMS'
  | 'ORDER_NOT_FOUND'
  | 'SIZE_EXCEEDED'
  | 'SIGNER_REQUIRED'
  | 'WEBSOCKET_ERROR'
  | 'KEY_NOT_FOUND'
  | 'INVALID_KEY'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'UNKNOWN';
```

### Error Class

```typescript
class ThetanutsError extends Error {
  code: ThetanutsErrorCode;
  cause?: unknown;
  meta?: Record<string, unknown>;
}

// Type guard
function isThetanutsError(error: unknown): error is ThetanutsError;
```

---

## Order Types (`optionBook.ts`)

### Contract Order (On-chain)

```typescript
interface ContractOrder {
  maker: string;
  orderExpiryTimestamp: bigint;
  collateral: string;
  isCall: boolean;
  priceFeed: string;
  implementation: string;
  isLong: boolean;
  maxCollateralUsable: bigint;
  strikes: bigint[];
  expiry: bigint;
  price: bigint;
  numContracts: bigint;
  extraOptionData: string;
}
```

### SDK Order (Simplified)

```typescript
interface Order {
  maker: string;
  taker: string;
  option: string;
  isBuyer: boolean;
  numContracts: bigint;
  price: bigint;
  expiry: bigint;
  nonce: bigint;
  optionType?: number;
  /**
   * All strike prices (8 decimals). Array length indicates product type:
   * - 1 strike: vanilla (put/call)
   * - 2 strikes: spread
   * - 3 strikes: butterfly
   * - 4 strikes: condor/iron condor
   */
  strikes?: bigint[];
  /** @deprecated Use strikes[0] instead */
  strikePrice?: bigint;
  collateralToken?: string;
  underlyingToken?: string;
  deadline?: bigint;
}
```

### Order with Signature

```typescript
interface OrderWithSignature {
  order: Order;
  signature: string;
  availableAmount: bigint;
  makerAddress: string;
  rawApiData?: OdetteRawOrderData;
}
```

### Raw API Data

```typescript
interface OdetteRawOrderData {
  collateral: string;
  priceFeed: string;
  implementation: string;
  strikes: string[];
  isCall: boolean;
  isLong: boolean;
  orderExpiryTimestamp: number;
  extraOptionData: string;
  maxCollateralUsable: string;
  /** OptionBook contract address the order was signed for */
  optionBookAddress?: string;
  /** Option greeks from pricing API */
  greeks?: {
    delta: number;   // Price sensitivity to underlying (-1 to 1)
    iv: number;      // Implied volatility (0 to 1+)
    gamma: number;   // Rate of change of delta
    theta: number;   // Time decay per day
    vega: number;    // Sensitivity to volatility
  };
}
```

**Accessing Greeks:**

```typescript
const orders = await client.api.fetchOrders();

for (const order of orders) {
  if (order.rawApiData?.greeks) {
    const { delta, iv, gamma, theta, vega } = order.rawApiData.greeks;
    console.log(`Delta: ${delta.toFixed(4)}, IV: ${(iv * 100).toFixed(1)}%`);
  }
}
```

### OptionBook Result Types

```typescript
interface FillOrderResult {
  txHash: string;
  tx: TransactionResponse;
  optionAddress: string;
  numContractsFilled: bigint;
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

interface SwapAndFillOrderResult extends FillOrderResult {
  swapParams: SwapParams;
  amountSwapped: bigint;
}

interface TransactionResult {
  txHash: string;
  tx: TransactionResponse;
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

interface EncodedTransaction {
  to: string;
  data: string;
}

interface Eip712Domain {
  fields: string;
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
  salt: string;
  extensions: bigint[];
}
```

---

## API Types (`api.ts`)

### Market Data

```typescript
interface MarketDataPrices {
  ETH: number;
  BTC: number;
  SOL: number;
  XRP: number;
  BNB: number;
  AVAX: number;
  [key: string]: number; // Extensible
}

interface MarketDataMetadata {
  lastUpdated: number;
  currentTime: number;
}

interface MarketDataResponse {
  prices: MarketDataPrices;
  metadata: MarketDataMetadata;
}
```

### Protocol Stats

```typescript
interface ProtocolStats {
  totalOptionsTracked: number;
  openPositions: number;
  settledPositions: number;
  closedPositions: number;
  uniqueUsers: number;
  lastProcessedBlock: number;
  lastUpdateTimestamp: number;
  positions: PositionBreakdown;
}

interface PositionBreakdown {
  total: number;
  open: number;
  settled: number;
  closed: number;
  pendingInit: number;
}
```

### PositionSettlement

Settlement details for closed or settled positions.

```typescript
interface PositionSettlement {
  /** Settlement price from oracle (8 decimals) */
  settlementPrice: bigint;
  /** Payout to buyer (collateral decimals) */
  payoutBuyer: bigint;
  /** Collateral returned to seller (collateral decimals) */
  collateralReturnedSeller: bigint;
  /** Whether the option was exercised (ITM at expiry) */
  exercised: boolean;
  /** Physical delivery amount */
  deliveryAmount: bigint;
  /** Collateral for physical delivery */
  deliveryCollateral: bigint;
  /** Whether settlement was an explicit user decision */
  explicitDecision: boolean;
  /** Whether oracle failed during settlement */
  oracleFailure: boolean;
  /** Reason for oracle failure if applicable */
  oracleFailureReason: string;
}
```

### Position

User position with full details from the Indexer API.

```typescript
interface Position {
  // Core fields
  id: string;                    // Position ID
  optionAddress: string;         // Option contract address
  side: 'buyer' | 'seller';      // Position side
  amount: bigint;                // Number of contracts (18 decimals)
  entryPrice: bigint;            // Entry price (collateral decimals)
  currentValue: bigint;          // Current market value
  pnl: bigint;                   // Unrealized PnL

  // Option details
  option: {
    underlying: string;          // 'ETH' or 'BTC'
    collateral: string;          // Collateral token address
    strikes: bigint[];           // Strike prices (8 decimals)
    expiry: number;              // Expiry timestamp
    optionType: number;          // Option type enum
  };

  // Status and participants
  status: string;                // 'open', 'closed', 'settled'
  buyer: string;                 // Buyer wallet address
  seller: string;                // Seller wallet address
  referrer: string;              // Referrer address
  createdBy: string;             // Position creator address

  // Entry details
  entryTimestamp: bigint;        // Entry timestamp
  entryTxHash: string;           // Entry transaction hash
  entryBlock: bigint;            // Entry block number
  entryFeePaid: bigint;          // Fee paid at entry

  // Collateral details
  collateralAmount: bigint;      // Collateral amount
  collateralSymbol: string;      // Collateral symbol ('USDC', etc.)
  collateralDecimals: number;    // Collateral decimals
  priceFeed: string;             // Chainlink price feed address

  // Close details (when closed/settled)
  closeTimestamp: bigint;        // Close timestamp
  closeTxHash: string;           // Close transaction hash
  closeBlock: bigint;            // Close block number
  explicitClose: boolean;        // Whether explicitly closed by user
  optionTypeRaw: number;         // Raw option type number

  // Settlement (present when settled)
  settlement?: PositionSettlement;
}
```

### TradeHistory

Trade history entry with extended details.

```typescript
interface TradeHistory {
  // Core fields
  id: string;                    // Trade ID
  timestamp: number;             // Trade timestamp
  txHash: string;                // Transaction hash
  type: 'fill' | 'cancel' | 'exercise' | 'settle' | 'close';
  amount: bigint;                // Amount traded (18 decimals)
  price: bigint;                 // Price per contract

  // Option details
  option: {
    address: string;             // Option contract address
    underlying: string;          // 'ETH' or 'BTC'
    expiry: number;              // Expiry timestamp
  };

  // Extended fields
  status: string;                // Position status
  buyer: string;                 // Buyer address
  seller: string;                // Seller address
  referrer: string;              // Referrer address
  createdBy: string;             // Creator address
  entryBlock: bigint;            // Entry block number
  entryFeePaid: bigint;          // Entry fee paid

  // Collateral info
  collateralAmount: bigint;      // Collateral amount
  collateralSymbol: string;      // Collateral symbol
  collateralDecimals: number;    // Collateral decimals

  // Option info
  priceFeed: string;             // Price feed address
  optionTypeRaw: number;         // Raw option type
  strikes: bigint[];             // Strike prices

  // Close info
  explicitClose: boolean;        // Whether explicitly closed
  closeTimestamp: bigint;        // Close timestamp
  closeTxHash: string;           // Close tx hash
  closeBlock: bigint;            // Close block number

  // Settlement
  settlement?: PositionSettlement;
}
```

### ReferrerStats

```typescript
interface ReferrerStats {
  /** Referrer address */
  referrer: string;
  /** Positions referred by this referrer, indexed by option address */
  positions: Record<string, Record<string, unknown>>;
  /** User daily metrics */
  userDailyMetrics: Record<string, unknown>;
  /** Top profitable trades */
  topProfitableTrades: Array<Record<string, unknown>>;
  /** Last update timestamp (unix seconds) */
  lastUpdateTimestamp: number;
}
```

---

## Option Types (`option.ts`)

### Option Info

```typescript
interface OptionInfo {
  address: string;
  optionType: number;
  strikes: bigint[];
  expiry: bigint;
  collateralToken: string;
  underlyingToken: string;
}
```

### Payout & Position Results

```typescript
interface PayoutResult {
  txHash: string;
  tx: TransactionResponse;
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

interface PayoutCalculation {
  payout: bigint;
  settlementPrice: bigint;
  optionAddress: string;
}

interface UnpackedOptionType {
  isQuoteCollateral: boolean;
  isPhysicallySettled: boolean;
  optionStyle: number;    // 0=European, 1=American
  optionStructure: number; // 0=Vanilla, 1=Spread, 2=Butterfly, 3=Condor
}
```

### Option Parameters

```typescript
interface OptionParams {
  collateralToken: string;
  chainlinkPriceFeed: string;
  historicalTWAPConsumer: string;
  buyer: string;
  seller: string;
  strikes: bigint[];
  expiryTimestamp: bigint;
  twapPeriod: bigint;
  numContracts: bigint;
  collateralAmount: bigint;
  rescueAddress: string;
  factoryAddress: string;
  extraOptionData: string;
}
```

---

## Event Types (`events.ts`)

### Order Events

```typescript
interface OrderFillEvent {
  orderHash: string;
  maker: string;
  taker: string;
  option: string;
  isBuyer: boolean;
  amount: bigint;
  price: bigint;
  blockNumber: number;
  transactionHash: string;
}

interface OrderCancelledEvent {
  orderHash: string;
  maker: string;
  blockNumber: number;
  transactionHash: string;
}
```

### RFQ Events

```typescript
interface QuotationRequestedEvent {
  quotationId: string;
  requester: string;
  params: RFQParams;
  blockNumber: number;
  transactionHash: string;
}

interface OfferMadeEvent {
  quotationId: string;
  maker: string;
  encryptedOffer: string;
  blockNumber: number;
  transactionHash: string;
}

interface QuotationSettledEvent {
  quotationId: string;
  winner: string;
  option: string;
  price: bigint;
  size: bigint;
  blockNumber: number;
  transactionHash: string;
}
```

### BaseOption Events

```typescript
interface ExcessCollateralReturnedEvent extends BaseEvent {
  seller: string;
  collateralToken: string;
  collateralReturned: bigint;
}

interface OptionClosedEvent extends BaseEvent {
  optionAddress: string;
  closedBy: string;
  collateralReturned: bigint;
}

interface OptionExpiredEvent extends BaseEvent {
  optionAddress: string;
  settlementPrice: bigint;
}

interface OptionPayoutEvent extends BaseEvent {
  optionAddress: string;
  buyer: string;
  amountPaidOut: bigint;
}

interface OptionSettlementFailedEvent extends BaseEvent {
  optionAddress: string;
}

interface OptionSplitEvent extends BaseEvent {
  originalOption: string;
  newOption: string;
  collateralAmount: bigint;
  feePaid: bigint;        // r12: split fee paid as msg.value
  counterparty: string;   // r12: counterparty address (indexed)
}

interface RoleTransferredEvent extends BaseEvent {
  optionAddress: string;
  from: string;
  to: string;
  isBuyer: boolean;
}

interface TransferApprovalEvent extends BaseEvent {
  optionAddress: string;
  target: string;
  from: string;
  isBuyer: boolean;
  isApproved: boolean;
}

interface ERC20RescuedEvent extends BaseEvent {
  optionAddress: string;
  rescueAddress: string;
  tokenAddress: string;
  amount: bigint;
}
```

---

## State API Types (`stateApi.ts`)

Types for the RFQ State API indexer, providing a snapshot of on-chain OptionFactory state.

### User Data Types

```typescript
interface UserRfqData {
  /** Active RFQ IDs */
  active: string[];
  /** Completed RFQ IDs */
  completed: string[];
}

interface UserOfferData {
  /** Active offer quotation IDs */
  active: string[];
  /** Completed offer quotation IDs */
  completed: string[];
}

interface UserOptionData {
  /** Active option addresses */
  active: string[];
  /** Historical option addresses */
  history: string[];
}
```

### State API Response

```typescript
interface StateApiResponse {
  rfqs: Record<string, StateRfq>;
  offers: Record<string, StateOffer[]>;
  options: Record<string, StateOption>;
  userRFQs: Record<string, UserRfqData>;
  userOffers: Record<string, UserOfferData>;
  userOptions: Record<string, UserOptionData>;
  protocolStats: StateProtocolStats;
  referrals: Record<string, StateReferral>;
  lastUpdateTimestamp: number;
  lastProcessedBlock: number;
}

interface StateRfq {
  id: string;
  requester: string;
  status: string;           // 'active' | 'settled' | 'cancelled'
  collateral: string;
  strikes: string[];
  numContracts: string;
  expiryTimestamp: number;
  offerEndTimestamp: number;
  isRequestingLongPosition: boolean;
  currentBestPrice: string;
  winner?: string;
  optionAddress?: string;
  // ... additional fields
}

interface StateOffer {
  quotationId: string;
  offeror: string;
  encryptedOffer: string;
  timestamp: number;
  txHash: string;
}

interface StateOption {
  address: string;
  quotationId: string;
  creator: string;
  collateral: string;
  strikes: string[];
  expiry: number;
  optionType: number;
}

interface StateProtocolStats {
  totalRfqs: number;
  activeRfqs: number;
  settledRfqs: number;
  cancelledRfqs: number;
  totalOffers: number;
  totalOptions: number;
}

interface StateReferral {
  owner: string;
  feeRate: string;
  isActive: boolean;
}
```

---

## OptionFactory Types (`optionFactory.ts`)

### Enums

```typescript
enum OptionTypeEnum {
  CALL = 0, PUT = 1, CALL_SPREAD = 2,
  PUT_SPREAD = 3, BUTTERFLY = 4, IRON_CONDOR = 5,
}

enum QuotationStatus {
  PENDING = 0, OFFER_PHASE = 1, REVEAL_PHASE = 2,
  SETTLED = 3, CANCELLED = 4,
}
```

### Core Types

```typescript
interface QuotationParameters {
  requester: string;
  existingOptionAddress: string;
  collateral: string;
  collateralPriceFeed: string;
  implementation: string;
  strikes: bigint[];
  numContracts: bigint;
  requesterDeposit: bigint;
  collateralAmount: bigint;
  expiryTimestamp: bigint;
  offerEndTimestamp: bigint;
  isRequestingLongPosition: boolean;
  convertToLimitOrder: boolean;
  extraOptionData: string;
}

interface QuotationTracking {
  referralId: bigint;
  eventCode: bigint;
}

interface RFQRequest {
  params: QuotationParameters;
  tracking: QuotationTracking;
  reservePrice: bigint;
  requesterPublicKey: string;
}

interface Quotation {
  params: QuotationParameters;
  state: QuotationState;
}

interface QuotationState {
  isActive: boolean;
  currentWinner: string;
  currentBestPriceOrReserve: bigint;
  feeCollected: bigint;
  optionContract: string;
}
```

### Referral & Swap Types

```typescript
interface ReferralParameters {
  collateral: string;
  collateralPriceFeed: string;
  implementation: string;
  strikes: bigint[];
  expiryTimestamp: bigint;
  isRequestingLongPosition: boolean;
  extraOptionData: string;
}

interface SwapAndCallParams {
  swapRouter: string;
  swapSrcToken: string;
  swapDstToken: string;
  swapSrcAmount: bigint;
  swapCallData: string;
  selfCallData: string;
  value?: bigint;
}

interface Eip712DomainResult {
  fields: string;
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
  salt: string;
  extensions: bigint[];
}
```

### Transaction Result Types

```typescript
interface RequestQuotationResult {
  txHash: string;
  tx: TransactionResponse;
  quotationId: bigint;
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

interface MakeOfferResult { txHash: string; tx: TransactionResponse; quotationId: bigint; wait(...): Promise<TransactionReceipt>; }
interface RevealOfferResult { txHash: string; tx: TransactionResponse; quotationId: bigint; offerAmount: bigint; wait(...): Promise<TransactionReceipt>; }
interface SettleQuotationResult { txHash: string; tx: TransactionResponse; quotationId: bigint; optionAddress: string; wait(...): Promise<TransactionReceipt>; }
```

---

## Pricing Types (`pricing.ts`)

### Greeks

```typescript
interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  iv: number;
}

interface GreeksInput {
  underlying: string;
  structure: OptionStructure;
  strikes: bigint[];
  expiry: number;
  spotPrice: bigint;
  size: bigint;
}
```

### Payoff

```typescript
interface PayoffInput {
  structure: OptionStructure;
  strikes: bigint[];
  size: bigint;
  premium: bigint;
  isBuy: boolean;
}

interface PayoffPoint {
  price: bigint;
  payoff: bigint;
}

interface PayoffDiagram {
  points: PayoffPoint[];
  breakeven: bigint[];
  maxProfit: bigint;
  maxLoss: bigint;
}
```

---

## WebSocket Types (`websocket.ts`)

### Connection

```typescript
type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface WebSocketConfig {
  url?: string;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  pingInterval?: number;
}
```

### Subscriptions

```typescript
type SubscriptionType = 'orders' | 'positions' | 'prices' | 'trades' | 'quotations';

interface SubscriptionOptions {
  type: SubscriptionType;
  assets?: string[];
  filter?: Record<string, unknown>;
}
```

### Updates

```typescript
interface OrderUpdate {
  type: 'new' | 'filled' | 'cancelled' | 'expired';
  order: OrderWithSignature;
}

interface PriceUpdate {
  asset: string;
  price: number;
  timestamp: number;
}

interface PositionUpdate {
  type: 'opened' | 'closed' | 'updated';
  position: Position;
}

interface TradeUpdate {
  type: 'fill';
  trade: {
    orderHash: string;
    maker: string;
    taker: string;
    amount: bigint;
    price: bigint;
    txHash: string;
  };
}
```

---

## Logger Types (`logger.ts`)

```typescript
interface ThetanutsLogger {
  debug?(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
}
```

---

## RFQ Key Manager Types (`rfqKeyManager.ts`)

Types for ECDH keypair generation, storage, and encryption for the sealed-bid RFQ workflow.

### Keypair Types

```typescript
interface RFQKeyPair {
  /** Private key as hex string (0x-prefixed, 32 bytes) */
  privateKey: string;
  /** Compressed public key as hex string (0x-prefixed, 33 bytes) */
  compressedPublicKey: string;
  /** Uncompressed public key as hex string (0x-prefixed, 65 bytes) */
  publicKey: string;
}
```

### Encryption Types

```typescript
interface EncryptedOffer {
  /** IV (12 bytes) + AES-GCM ciphertext as hex string */
  ciphertext: string;
  /** Offeror's compressed public key (to share with requester) */
  signingKey: string;
}

interface DecryptedOffer {
  /** Decrypted offer amount */
  offerAmount: bigint;
  /** Decrypted nonce */
  nonce: bigint;
}
```

### Storage Provider Interface

```typescript
interface KeyStorageProvider {
  /** Get stored private key by ID, returns null if not found */
  get(keyId: string): Promise<string | null> | string | null;
  /** Store a private key */
  set(keyId: string, privateKey: string): Promise<void> | void;
  /** Remove a stored key */
  remove(keyId: string): Promise<void> | void;
  /** Check if a key exists */
  has(keyId: string): Promise<boolean> | boolean;
}
```

### Storage Providers

The root package exports `LocalStorageProvider`, `MemoryStorageProvider`, and the `KeyStorageProvider` interface. Node.js uses an internal file-backed default provider that persists keys to `./.thetanuts-keys/` with owner-only permissions.

```typescript
import { MemoryStorageProvider, ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

// Default Node.js persistence uses ./.thetanuts-keys/
const client = new ThetanutsClient({ chainId: 8453, provider });

// Custom storage: pass any KeyStorageProvider implementation.
const storage: KeyStorageProvider = new MemoryStorageProvider();
const testClient = new ThetanutsClient({
  chainId: 8453,
  provider,
  keyStorageProvider: storage,
});
```

---

## Usage Example

```typescript
import type {
  ThetanutsClientConfig,
  Order,
  OrderWithSignature,
  Position,
  Greeks,
  ThetanutsError,
  WebSocketState,
} from '@thetanuts-finance/thetanuts-client';

// Type-safe configuration
const config: ThetanutsClientConfig = {
  chainId: 8453,
  provider: myProvider,
};

// Type-safe order handling
function handleOrder(order: OrderWithSignature) {
  const isBuyOrder = order.order.isBuyer;
  const price = order.order.price;
  // TypeScript knows all properties
}

// Type-safe error handling
function handleError(error: ThetanutsError) {
  switch (error.code) {
    case 'ORDER_EXPIRED':
      // Handle expired order
      break;
    case 'INSUFFICIENT_ALLOWANCE':
      // Handle allowance issue
      break;
  }
}
```
