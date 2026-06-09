# Utilities

Pure utility functions for decimal conversions, payout calculations, and payoff diagram generation — no network calls required.

Access via `client.utils`.

## Method Reference

| Method | Description | Signer |
|--------|-------------|--------|
| `toBigInt(value, decimals)` | Convert human-readable string/number to bigint | No |
| `fromBigInt(value, decimals)` | Convert bigint to human-readable string | No |
| `strikeToChain(strike)` | Convert strike price to on-chain format (8 decimals) | No |
| `strikeFromChain(value)` | Convert on-chain strike to human-readable number | No |
| `toUsdcDecimals(value)` | Convert to USDC (6 decimals) | No |
| `fromUsdcDecimals(value)` | Convert from USDC bigint to string | No |
| `calculatePayout(params)` | Option payoff calculation | No |
| `calculateCollateral(params)` | Required collateral for a position | No |
| `generatePayoffDiagram(params)` | Payoff chart data points | No |

## Decimal Conversions

### toBigInt()

Convert a human-readable value to a bigint with the specified decimal precision. Uses string-based parsing to avoid floating-point errors.

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({ chainId: 8453, provider });

const usdc = client.utils.toBigInt('100.5', 6);   // 100500000n
const weth = client.utils.toBigInt('1.5', 18);    // 1500000000000000000n
const btc  = client.utils.toBigInt('0.001', 8);   // 100000n
```

### fromBigInt()

Convert a bigint back to a human-readable string.

```typescript
const display = client.utils.fromBigInt(100500000n, 6);          // '100.5'
const eth     = client.utils.fromBigInt(1500000000000000000n, 18); // '1.5'
```

## Strike / Price Conversions

Strikes and prices are stored on-chain with 8 decimal places. Use these helpers instead of manual multiplication to avoid floating-point errors.

### strikeToChain()

```typescript
const strikeOnChain = client.utils.strikeToChain(1850.5);
// Returns: 185050000000n  (8 decimals)

const btcStrike = client.utils.strikeToChain(95000);
// Returns: 9500000000000n
```

### strikeFromChain()

```typescript
const strikeNumber = client.utils.strikeFromChain(185050000000n);
// Returns: 1850.5

const price = client.utils.strikeFromChain(9500000000000n);
// Returns: 95000
```

## Convenience Methods

```typescript
// USDC (6 decimals)
client.utils.toUsdcDecimals('100.5');       // 100500000n
client.utils.fromUsdcDecimals(100500000n);  // '100.5'

// Strike / price (8 decimals)  — same as strikeToChain / strikeFromChain
client.utils.toStrikeDecimals(1850);            // 185000000000n
client.utils.fromStrikeDecimals(185000000000n); // '1850'
```

## Payout Calculation

### calculatePayout()

Calculate option payoff at a given settlement price. Pure math — no chain calls.

```typescript
const payout = client.utils.calculatePayout({
  type: 'call',                           // see PayoutType union below
  strikes: [200000000000n],               // Strike(s) in 8 decimals
  settlementPrice: 250000000000000000n,   // Settlement price in 8 decimals
  numContracts: 10000000000000000000n,    // In 18 decimals (SIZE decimals)
});
```

**Supported types and strike orderings.** Strike order must match what the
on-chain factory expects — pass strikes exactly as listed:

| `type` | Strikes | Order | Invariant |
|--------|---------|-------|-----------|
| `'call'` | 1 | `[strike]` | — |
| `'put'` | 1 | `[strike]` | — |
| `'call_spread'` | 2 | `[lower, upper]` ASCENDING | — |
| `'put_spread'` | 2 | `[lower, upper]` ASCENDING | — |
| `'call_fly'` | 3 | `[K1, K2, K3]` ASCENDING | `K2 - K1 === K3 - K2` (equidistant) |
| `'put_fly'` | 3 | `[K3, K2, K1]` DESCENDING | `K3 - K2 === K2 - K1` (equidistant) |
| `'call_condor'` | 4 | `[K1, K2, K3, K4]` ASCENDING | `K2 - K1 === K4 - K3` (equal wings) |
| `'put_condor'` | 4 | `[K1, K2, K3, K4]` ASCENDING (condors are always ascending) | `K2 - K1 === K4 - K3` |
| `'iron_condor'` | 4 | `[putLower, putUpper, callLower, callUpper]` | `putUpper <= callLower` |
| `'ranger'` | 4 | `[callLower, callUpper, putLower, putUpper]` | spread widths equal AND `callUpper < putLower` |

**Multi-leg example (iron condor — buyer's payoff):**

```typescript
const payout = client.utils.calculatePayout({
  type: 'iron_condor',
  strikes: [
    180000000000n, // putLower  $1800
    190000000000n, // putUpper  $1900
    210000000000n, // callLower $2100
    220000000000n, // callUpper $2200
  ],
  settlementPrice: 175000000000n, // $1750 (left wing fully ITM)
  numContracts: 1000000000000000000n,
});
// Returns 100000000n (= $100 USDC, capped at max(put-spread, call-spread))
```

**Ranger example (zone-bound):**

```typescript
const payout = client.utils.calculatePayout({
  type: 'ranger',
  strikes: [
    190000000000n, // callLower $1900
    200000000000n, // callUpper $2000
    210000000000n, // putLower  $2100
    220000000000n, // putUpper  $2200
  ],
  settlementPrice: 205000000000n, // $2050 (inside the zone)
  numContracts: 1000000000000000000n,
});
// Returns 100000000n (= $100 USDC, max payout = spread width k)
```

Ranger seller posts `2k` collateral (use `calculateCollateral`) even though
the buyer's max payoff is `k` — either ramp can max out independently.

### calculateCollateral()

Calculate the required collateral for a position.

```typescript
const collateral = client.utils.calculateCollateral({
  // params depend on option type; see API Reference for full signature
});
```

### generatePayoffDiagram()

Generate an array of `{ price, payout }` data points for rendering a payoff chart.

```typescript
const diagram = client.utils.generatePayoffDiagram({
  type: 'put_spread',
  strikes: [180000000000n, 200000000000n],  // 8 decimals
  numContracts: 1000000000000000000n,       // 1 contract in 18 decimals
  priceRange: { min: 150000000000n, max: 250000000000n },
  steps: 100,
});

// Returns: Array<{ price: bigint; payout: bigint }>
for (const { price, payout } of diagram) {
  console.log(`$${client.utils.strikeFromChain(price)}: ${payout}`);
}
```

## Decimal Constants

Import the `DECIMALS` constant to avoid hardcoding decimal values:

```typescript
import { DECIMALS } from '@thetanuts-finance/thetanuts-client';

DECIMALS.USDC   // 6
DECIMALS.WETH   // 18
DECIMALS.cbBTC  // 8
DECIMALS.PRICE  // 8  (strikes and settlement prices)
DECIMALS.SIZE   // 18 (numContracts)
```

## Full Conversion Example

```typescript
import { ThetanutsClient, DECIMALS } from '@thetanuts-finance/thetanuts-client';
import { ethers } from 'ethers';

const client = new ThetanutsClient({ chainId: 8453, provider });

// Human-readable inputs
const strikeUsd = 1850;
const numContracts = 1.5;
const collateralUsdc = '100.50';

// Convert to on-chain values
const strikeOnChain   = client.utils.strikeToChain(strikeUsd);        // 185000000000n
const contractsOnChain = client.utils.toBigInt(String(numContracts), DECIMALS.SIZE); // 1500000000000000000n
const usdcOnChain     = client.utils.toUsdcDecimals(collateralUsdc);   // 100500000n

// Convert back for display
console.log('Strike:', client.utils.strikeFromChain(strikeOnChain));           // 1850
console.log('Contracts:', client.utils.fromBigInt(contractsOnChain, DECIMALS.SIZE)); // '1.5'
console.log('USDC:', client.utils.fromUsdcDecimals(usdcOnChain));              // '100.5'
```

---

## See Also

- [Decimal Reference](./decimals.md) — Token decimal table and conversion rules
- [Modules Overview](./modules-overview.md) — All 15 modules at a glance
- [Chain Config](./chain-config.md) — Token addresses and decimals per chain
