# Create an RFQ

Submit a Request for Quotation to the OptionFactory and have market makers compete to fill your custom option. This page covers **cash-settled** RFQs (the default). For physically settled options, see [Physical Options](physical-options.md).

RFQ uses the same cash-settled implementation contracts as OptionBook (PUT, INVERSE_CALL, spreads, etc.). The difference is that you choose the strike and expiry instead of filling an existing order.

## Prerequisites

- Install the SDK: `npm install @thetanuts-finance/thetanuts-client`
- A funded wallet on Base mainnet (chain ID 8453)
- For **SELL positions**: USDC (or WETH/cbBTC) approved for the OptionFactory
- For **BUY positions**: enough of the collateral token to cover the escrowed
  `reservePrice` — or, in the CLI, fund it from another asset in the same
  transaction with [`--pay-with`](pay-with.md)

---

## Critical Rule: collateralAmount is ALWAYS 0

When creating any RFQ, the `collateralAmount` parameter must always be `0`. Collateral is **not** locked at RFQ creation — it is pulled from the seller at settlement time.

```typescript
// CORRECT — buildRFQParams enforces this automatically
const params = client.optionFactory.buildRFQParams({ ... });
// params.collateralAmount === BigInt(0)  always

// WRONG — never set manually
collateralAmount: BigInt(1000000)  // causes issues at settlement!
```

---

## Approach 1: buildRFQRequest (One-Liner)

`buildRFQRequest` combines `buildRFQParams` and the tracking/key fields into a single object ready for `encodeRequestForQuotation`.

### BUY Position (isLong: true)

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });
const userAddress = await signer.getAddress();

// 1. Generate or load your ECDH keypair (used to decrypt MM offers)
const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// 2. Build the complete RFQ request
const rfqRequest = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',              // 'ETH' | 'BTC'
  optionType: 'PUT',              // 'CALL' | 'PUT'
  strike: 2000,                   // human-readable strike price
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,  // 7 days from now
  numContracts: 1.5,              // human-readable contract count
  isLong: true,                   // true = BUY, false = SELL
  offerDeadlineMinutes: 60,       // how long MMs have to respond
  collateralToken: 'USDC',        // 'USDC' | 'WETH' | 'cbBTC'
  reservePrice: 0.015,            // optional: max price per contract (BUY)
  requesterPublicKey: keyPair.compressedPublicKey,
});

// 3. Encode and send
const { to, data } = client.optionFactory.encodeRequestForQuotation(rfqRequest);
const tx = await signer.sendTransaction({ to, data });
console.log('RFQ created:', tx.hash);
```

### SELL Position (isLong: false) — Approval Required

When selling (going short), **you are the collateral provider**. You must approve the OptionFactory to pull collateral at settlement before creating the RFQ.

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });
const userAddress = await signer.getAddress();

const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// Collateral approval amounts:
//   PUT:           strike × numContracts  (in USDC decimals = 6)
//   CALL (inverse): numContracts          (in WETH decimals = 18)
const strike = 1850;
const numContracts = 1.5;
const approvalAmount = BigInt(Math.round(strike * numContracts * 1e6)); // USDC

const USDC = client.chainConfig.tokens.USDC.address;
await client.erc20.ensureAllowance(
  USDC,
  client.optionFactory.contractAddress,
  approvalAmount
);

// Build and submit SELL RFQ
const rfqRequest = client.optionFactory.buildRFQRequest({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 1850,
  expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
  numContracts: 1.5,
  isLong: false,                  // SELL — you provide collateral
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
  reservePrice: 0.010,            // optional: min acceptable price (SELL)
  requesterPublicKey: keyPair.compressedPublicKey,
});

const { to, data } = client.optionFactory.encodeRequestForQuotation(rfqRequest);
const tx = await signer.sendTransaction({ to, data });
console.log('SELL RFQ created:', tx.hash);
```

---

## Approach 2: buildRFQParams (Two-Step)

`buildRFQParams` builds just the on-chain `QuotationParameters` object. Use this when you want fine-grained control over the tracking fields or reserve price encoding.

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });
const userAddress = await signer.getAddress();

const keyPair = await client.rfqKeys.getOrCreateKeyPair();

// Step 1: Build the QuotationParameters object
const quotationParams = client.optionFactory.buildRFQParams({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike: 1850,           // human-readable; SDK converts to 8-decimal bigint
  expiry: 1741334400,     // unix timestamp
  numContracts: 1.5,      // human-readable; SDK converts to token-decimal bigint
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
});
// quotationParams.collateralAmount === 0n  — enforced automatically

// Step 2: Encode the full request with reserve price and public key
const { to, data } = client.optionFactory.encodeRequestForQuotation({
  params: quotationParams,
  tracking: { referralId: BigInt(0), eventCode: BigInt(0) },
  reservePrice: BigInt(0),  // 0 = no price protection; or set in collateral decimals
  requesterPublicKey: keyPair.compressedPublicKey,
});

const tx = await signer.sendTransaction({ to, data });
console.log('RFQ created:', tx.hash);
```

---

## Reserve Price

The `reservePrice` parameter protects you from unfavorable fills:

| Position | Meaning | Behavior if violated |
|----------|---------|----------------------|
| BUY (`isLong: true`) | Maximum price per contract you will pay | RFQ fails; deposit returned |
| SELL (`isLong: false`) | Minimum price per contract you will accept | RFQ fails |
| omitted or `0` | No price protection | Accept any offer |

**Example:** BUY with reserve price 0.015 USDC, 10 contracts → total escrow = 0.015 × 10 = **0.15 USDC** locked until settlement.

In `buildRFQRequest`, pass `reservePrice` as a human-readable number (e.g. `0.015`). When using `buildRFQParams` + `encodeRequestForQuotation` directly, pass it as a bigint in collateral token decimals.

---

## RFQ Parameters Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `requester` | `address` | Your wallet address |
| `underlying` | `'ETH' \| 'BTC'` | Underlying asset |
| `optionType` | `'CALL' \| 'PUT'` | Option type |
| `strike` | `number` | Strike price (human-readable) |
| `strikes` | `number[]` | Strike array for multi-leg. The generic SDK builder selects structure from option type plus strike count; MCP callers use explicit `product`. |
| `expiry` | `number` | Unix timestamp; must be after offer deadline |
| `numContracts` | `number \| bigint \| string` | Contract count; use `bigint` when closing positions |
| `isLong` | `boolean` | `true` = BUY, `false` = SELL |
| `offerDeadlineMinutes` | `number` | Minutes MMs have to respond |
| `collateralToken` | `'USDC' \| 'WETH' \| 'cbBTC'` | Collateral denomination |
| `reservePrice` | `number` | Optional max (BUY) or min (SELL) price per contract |
| `requesterPublicKey` | `hex string` | Your ECDH compressed public key |

For MCP callers, `prepare_request_rfq` validates the explicit `product` against the strike count before calldata is built: `PUT`/`CALL` require 1 strike, `*_SPREAD` require 2, `*_FLY` require 3, and `*_CONDOR`/`IRON_CONDOR` require 4. BUY RFQs require a positive per-contract `reservePrice`; use `prepare_suggest_reserve_price` instead of guessing.

---

## Convenience Helpers: Multi-Leg Builders

The factory module exposes named helpers that make parameter intent explicit:

```typescript
// Spread: pass named lower/upper strikes
const spreadRFQ = client.optionFactory.buildSpreadRFQ({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  lowerStrike: 1800,
  upperStrike: 2000,
  expiry: 1741334400,
  numContracts: 1,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
});

// Butterfly: pass lower, middle, upper
const butterflyRFQ = client.optionFactory.buildButterflyRFQ({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'CALL',
  lowerStrike: 1800,
  middleStrike: 1900,
  upperStrike: 2000,
  expiry: 1741334400,
  numContracts: 1,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'WETH',
});

// Condor: pass four ordered strikes
const condorRFQ = client.optionFactory.buildCondorRFQ({
  requester: userAddress,
  underlying: 'ETH',
  optionType: 'PUT',
  strike1: 1700,
  strike2: 1800,
  strike3: 1900,
  strike4: 2000,
  expiry: 1741334400,
  numContracts: 1,
  isLong: true,
  offerDeadlineMinutes: 60,
  collateralToken: 'USDC',
});
```

These return the same shape as `buildRFQRequest` and can be passed directly to `encodeRequestForQuotation` or `requestForQuotation`.

---

## Using requestForQuotation (Convenience)

Instead of encoding and sending manually, the module also provides a transaction-sending wrapper:

```typescript
const receipt = await client.optionFactory.requestForQuotation(rfqRequest);
console.log('TX hash:', receipt.hash);
console.log('Block:', receipt.blockNumber);

// Get the new RFQ ID
const rfqCount = await client.optionFactory.getQuotationCount();
const rfqId = rfqCount - 1n;
console.log('RFQ ID:', rfqId.toString());
```

---

## Common Pitfalls

| Mistake | Fix |
|---------|-----|
| `collateralAmount != 0` | Always use `buildRFQParams`; never set manually |
| SELL RFQ without token approval | Call `ensureAllowance` before submitting |
| `expiry` before offer deadline | Ensure `expiry > now + offerDeadlineMinutes * 60` |
| Floating-point `numContracts` when closing a position | Pass the on-chain `bigint` value directly |
| `reservePrice` in wrong decimals | Use `buildRFQRequest` with human-readable number |

---

## See Also

- [RFQ Lifecycle](lifecycle.md) — What happens after you submit: MM offers, reveal phase, settlement
- [Multi-Leg Structures](multi-leg-structures.md) — Spreads, butterflies, condors with collateral math
- [Key Management](key-management.md) — How ECDH keys are stored and used for offer decryption
