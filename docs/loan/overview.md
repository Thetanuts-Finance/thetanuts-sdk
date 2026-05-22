# Loan Module

Borrow USDC against ETH or BTC collateral with no liquidation risk. At expiry, repay and reclaim your collateral, or walk away and keep the USDC.

## How It Works

The Loan module wraps the LoanCoordinator contract, which uses Thetanuts V4 physically-settled call options under the hood. The flow:

1. **Deposit collateral** (WETH or cbBTC) and specify a strike price and expiry
2. **Market makers compete** to fill your loan via a sealed-bid RFQ auction
3. **Receive USDC** minus borrowing costs (option premium + interest + protocol fee)
4. **At expiry**, choose to exercise (repay USDC, get collateral back) or walk away (keep USDC, forfeit collateral)

No margin calls. No liquidation. Your collateral is locked in a smart contract, not lent out.

---

## Quick Start

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
const client = new ThetanutsClient({ chainId: 8453, provider, signer });

// 1. Browse available strike/expiry combinations
const groups = await client.loan.getStrikeOptions('ETH');
const firstOption = groups[0].options[0];

// 2. Calculate exact loan costs
const calc = client.loan.calculateLoan({
  depositAmount: '1.0',
  underlying: 'ETH',
  strike: firstOption.strike,
  expiryTimestamp: firstOption.expiry,
  askPrice: firstOption.askPrice,
  underlyingPrice: firstOption.underlyingPrice,
});

console.log(`Receive: ${calc.formatted.receive} USDC`);
console.log(`Repay:   ${calc.formatted.repay} USDC`);
console.log(`APR:     ${calc.formatted.apr}%`);

// 3. Request the loan
const result = await client.loan.requestLoan({
  underlying: 'ETH',
  collateralAmount: '1.0',
  strike: firstOption.strike,
  expiryTimestamp: firstOption.expiry,
  minSettlementAmount: calc.finalLoanAmount,
});

console.log(`Loan ID: ${result.quotationId}`);
```

---

## Method Overview

| Method | Description | Signer |
|--------|-------------|--------|
| `requestLoan(params)` | Deposit collateral and request a loan | Yes |
| `acceptOffer(id, amount, nonce, offeror)` | Accept an MM's offer (early settlement) | Yes |
| `cancelLoan(id)` | Cancel a pending loan request | Yes |
| `exerciseOption(address)` | Repay USDC and reclaim collateral at expiry | Yes |
| `doNotExercise(address)` | Walk away at expiry (keep USDC, forfeit collateral) | Yes |
| `swapAndExercise(address, aggregator, data)` | Swap collateral to USDC via DEX, then exercise | Yes |
| `lend(id)` | Fill a borrower's limit order with USDC | Yes |
| `getLendingOpportunities(options?)` | Fetch unfilled limit orders from indexer | No |
| `getLoanRequest(id)` | Query on-chain loan state | No |
| `getUserLoans(address)` | Get all loans for an address from indexer | No |
| `getOptionInfo(address)` | Get option contract details | No |
| `isOptionITM(address)` | Check if option is in-the-money | No |
| `fetchPricing()` | Fetch Deribit-style option pricing (30s cache) | No |
| `getStrikeOptions(underlying, settings?)` | Get filtered strikes grouped by expiry | No |
| `calculateLoan(params)` | Calculate exact costs (synchronous, BigInt math) | No |
| `isPromoOption(strike, price, expiry)` | Check promotional pricing eligibility | No |
| `encodeRequestLoan(params)` | Encode tx for viem/wagmi | No |
| `encodeAcceptOffer(...)` | Encode tx for viem/wagmi | No |
| `encodeCancelLoan(id)` | Encode tx for viem/wagmi | No |

---

## Loan Cost Formula

All costs are computed in USDC (6 decimals) using BigInt arithmetic:

```
OWE = depositAmount * strike / 10^(collateralDecimals + 8 - 6)
optionCost = askPrice * underlyingPrice * depositAmount / 10^collateralDecimals
capitalCost = OWE * (APR / 100) * durationInYears    (min 0.01 USDC)
protocolFee = OWE * 4 / 10000                         (4 basis points)
finalAmount = OWE - optionCost - capitalCost - protocolFee
```

### Promotional Pricing

Loans qualifying for promo get reduced costs:
- **Eligibility:** >90 days to expiry AND <50% LTV (strike/underlyingPrice)
- **Benefits:** Option premium waived, borrowing rate fixed at 5.68% APR
- **Limits:** $250,000 per person, $2,000,000 total pool

---

## Contract Addresses (Base)

| Contract | Address |
|----------|---------|
| LoanCoordinator | `0x9FB75b24d9d6f7c29D6BdE2870697A4FE0395994` |
| LoanHandler | `0x7c444A2375275DaB925b32493B64a407eE955DEd` |
| USDC (settlement) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH (ETH collateral) | `0x4200000000000000000000000000000000000006` |
| cbBTC (BTC collateral) | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

---

## See Also

- [Borrowing Guide](borrowing.md) — Full borrowing workflow with code examples
- [Lending Guide](lending.md) — Fill limit orders and earn yield
- [Pricing & Calculation](pricing.md) — Strike selection and cost calculation details
- [Collar Loans](collar.md) — Zero-interest, capped-upside variant (`client.collar`)
- [RFQ Key Management](../rfq/key-management.md) — ECDH keys used in loan auctions
