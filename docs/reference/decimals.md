# Decimal Reference

Token amounts and prices in the Thetanuts SDK are always passed as `bigint` values scaled to the token's native decimal precision. This page documents the decimal scale for every value type you will encounter.

## Decimal Table

| Type | Decimals | Constant | Example |
|------|----------|----------|---------|
| USDC | 6 | `DECIMALS.USDC` | `1000000n` = 1 USDC |
| WETH | 18 | `DECIMALS.WETH` | `1000000000000000000n` = 1 WETH |
| cbBTC | 8 | `DECIMALS.cbBTC` | `100000000n` = 1 cbBTC |
| Strike / Price | 8 | `DECIMALS.PRICE` | `185000000000n` = $1850 |
| numContracts | collateral decimals | — | Depends on the collateral token |

`numContracts` uses the same decimal precision as the position's collateral token. For a USDC-collateralized option, `numContracts` is expressed in 6 decimals; for a WETH-collateralized option, it is 18 decimals.

## Decimal Constants

```typescript
import { DECIMALS } from '@thetanuts-finance/thetanuts-client';

DECIMALS.USDC   // 6
DECIMALS.WETH   // 18
DECIMALS.cbBTC  // 8
DECIMALS.PRICE  // 8  — strikes and settlement prices
DECIMALS.SIZE   // 18 — numContracts (independent of collateral)
```

## Conversion Examples

The SDK provides helpers for all conversions. Use them instead of manual multiplication to avoid floating-point precision errors.

### To on-chain values

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const client = new ThetanutsClient({ chainId: 8453, provider });

// Generic: toBigInt(humanValue, decimals)
const usdc   = client.utils.toBigInt('100.5', 6);    // 100500000n
const weth   = client.utils.toBigInt('1.5', 18);     // 1500000000000000000n
const cbBTC  = client.utils.toBigInt('0.001', 8);    // 100000n

// USDC shorthand
const usdc2  = client.utils.toUsdcDecimals('100.5'); // 100500000n

// Strike price (8 decimals) — string-based to avoid float errors
const strike = client.utils.strikeToChain(1850.5);   // 185050000000n
const btcStrike = client.utils.strikeToChain(95000); // 9500000000000n
```

### From on-chain values

```typescript
// Generic: fromBigInt(bigintValue, decimals) -> string
const display = client.utils.fromBigInt(100500000n, 6);           // '100.5'
const eth     = client.utils.fromBigInt(1500000000000000000n, 18); // '1.5'

// USDC shorthand
const usdcStr = client.utils.fromUsdcDecimals(100500000n);        // '100.5'

// Strike price
const strikePx = client.utils.strikeFromChain(185050000000n);     // 1850.5
```

## Real-World Usage

### Approving collateral for an order fill

```typescript
// 10 USDC = 10_000000n (6 decimals)
await client.erc20.ensureAllowance(
  client.chainConfig.tokens.USDC.address,
  client.chainConfig.contracts.optionBook,
  10_000000n,
);
```

### Building an RFQ with a human-readable strike

```typescript
// Pass the number directly — buildRFQParams handles the conversion
const params = client.optionFactory.buildRFQParams({
  strikes: 1850,        // human-readable, no manual conversion needed
  numContracts: 1.5,    // also human-readable
  collateralToken: 'USDC',
  // ...
});
```

### Reading settlement prices from on-chain

Settlement prices and price feeds return values with 8 decimal places:

```typescript
// Settlement price: 200000000000n = $2000.00
const priceUsd = Number(200000000000n) / 1e8;  // 2000
// Or use the helper:
const priceStr = client.utils.strikeFromChain(200000000000n);  // 2000
```

### Formatting balances for display

```typescript
import { ethers } from 'ethers';

const usdcBalance = await client.erc20.getBalance(usdcAddress, userAddress);
console.log(ethers.formatUnits(usdcBalance, 6), 'USDC');

const wethBalance = await client.erc20.getBalance(wethAddress, userAddress);
console.log(ethers.formatUnits(wethBalance, 18), 'WETH');
```

## Common Mistakes

**Do not use JavaScript `number` arithmetic for on-chain values.** JavaScript's 64-bit float loses precision at large integers. Always use `bigint` or the SDK helpers:

```typescript
// WRONG — float precision error
const strike = 95000.5 * 1e8;  // may not equal 9500050000000

// CORRECT — string-based, exact
const strike = client.utils.strikeToChain(95000.5);  // 9500050000000n
```

**Do not hardcode decimal scales.** Use the `DECIMALS` constants or read `.decimals` from `client.chainConfig.tokens`:

```typescript
// WRONG
const amount = BigInt(1.5 * 1e6);  // could drift

// CORRECT
const amount = client.utils.toUsdcDecimals('1.5');  // 1500000n
```

---

## See Also

- [Utilities](./utilities.md) — Full UtilsModule method reference
- [Chain Config](./chain-config.md) — Token addresses and decimals per chain
- [Modules Overview](./modules-overview.md) — All 15 modules at a glance
