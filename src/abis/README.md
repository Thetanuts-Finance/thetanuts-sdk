# Smart Contract ABIs

This directory contains Application Binary Interface (ABI) definitions for the Thetanuts Finance smart contracts.

## What is an ABI?

An ABI defines how to interact with a smart contract - it specifies:
- Function names and their parameters
- Event definitions
- Return types

## Available ABIs

### erc20.ts - ERC20 Token Interface

Standard ERC20 token interface for USDC, WETH, and other tokens.

```typescript
import { ERC20_ABI } from '@thetanuts-finance/thetanuts-client';
```

**Methods:**
| Method | Description |
|--------|-------------|
| `approve(spender, amount)` | Approve token spending |
| `transfer(to, amount)` | Transfer tokens |
| `transferFrom(from, to, amount)` | Transfer on behalf |
| `allowance(owner, spender)` | Check allowance |
| `balanceOf(account)` | Get balance |
| `decimals()` | Get token decimals |
| `symbol()` | Get token symbol |
| `name()` | Get token name |
| `totalSupply()` | Get total supply |

**Events:**
- `Approval(owner, spender, value)`
- `Transfer(from, to, value)`

---

### optionBook.ts - OptionBook Contract

Main trading contract for filling and canceling orders.

```typescript
import { OPTION_BOOK_ABI } from '@thetanuts-finance/thetanuts-client';
```

**Key Structs:**
```typescript
// Order structure (ContractOrder)
struct Order {
  address maker;
  address taker;
  address option;
  bool isBuyer;
  uint256 numContracts;
  uint256 price;
  uint256 expiry;
  uint256 nonce;
}
```

**Methods:**
| Method | Description |
|--------|-------------|
| `fillOrder(order, signature, referrer)` | Fill an order |
| `swapAndFillOrder(order, signature, swapRouter, swapSrcToken, swapSrcAmount, swapData, referrer)` | Fill with token swap |
| `cancelOrder(order)` | Cancel an order |
| `hashOrder(order)` | Get order hash |
| `computeNonce(order)` | Compute nonce for an order |
| `fees(token, referrer)` | Get fee structure |
| `claimFees(collateral)` | Claim accumulated fees |
| `amountFilled(nonce)` | Get amount filled for a nonce |
| `referrerFeeSplitBps(referrer)` | Get referrer fee split in bps |
| `setReferrerFeeSplit(referrer, feeBps)` | Set referrer fee split (admin) |
| `sweepProtocolFees(token)` | Sweep protocol fees (admin) |
| `factory()` | Get factory address |
| `PRICE_DECIMALS()` | Get price decimals constant |
| `eip712Domain()` | Get EIP-712 domain info |
| `LIMIT_ORDER_TYPEHASH()` | Get limit order typehash |

**Events:**
- `OrderFill(orderHash, maker, taker, option, isBuyer, amount, price)`
- `OrderCancelled(orderHash, maker)`
- `OptionCreated(option, underlying, collateral, strikes, expiry, optionType)`

---

### optionFactory.ts - OptionFactory Contract

Request for Quotation (RFQ) system for creating custom options.

```typescript
import { OPTION_FACTORY_ABI } from '@thetanuts-finance/thetanuts-client';
```

**Methods:**
| Method | Description |
|--------|-------------|
| `requestForQuotation(params)` | Create an RFQ |
| `makeOfferForQuotation(quotationId, params)` | Submit encrypted offer |
| `revealOfferForQuotation(quotationId, params)` | Reveal offer |
| `settleQuotation(quotationId)` | Settle quotation |
| `cancelQuotation(quotationId)` | Cancel quotation |

**Events:**
- `QuotationRequested(quotationId, requester, params)`
- `OfferMade(quotationId, maker, encryptedOffer)`
- `OfferRevealed(quotationId, maker, price, size)`
- `QuotationSettled(quotationId, winner, option)`
- `QuotationCancelled(quotationId)`

---

### option.ts - BaseOption Contract

Individual option position management. Exported as both `OPTION_ABI` and `BASE_OPTION_ABI`.

```typescript
import { OPTION_ABI, BASE_OPTION_ABI } from '@thetanuts-finance/thetanuts-client';
```

**View Functions:**
| Method | Description |
|--------|-------------|
| `buyer()` | Get buyer address |
| `seller()` | Get seller address |
| `buyerAllowance(owner, spender)` | Check buyer transfer approval |
| `sellerAllowance(owner, spender)` | Check seller transfer approval |
| `collateralToken()` | Get collateral token address |
| `collateralAmount()` | Get collateral amount |
| `numContracts()` | Get number of contracts |
| `optionType()` | Get option type (packed uint256) |
| `unpackOptionType()` | Unpack option type flags |
| `getStrikes()` | Get all strike prices |
| `strikes(index)` | Get strike at index |
| `expiryTimestamp()` | Get expiry timestamp |
| `optionSettled()` | Check if option is settled |
| `chainlinkPriceFeed()` | Get Chainlink price feed address |
| `historicalTWAPConsumer()` | Get TWAP consumer address |
| `getTWAP()` | Get current TWAP price |
| `twapPeriod()` | Get TWAP period |
| `calculatePayout(price)` | Calculate payout at settlement price |
| `calculateRequiredCollateral(strikes, numContracts)` | Calculate required collateral |
| `simulatePayout(price, strikes, numContracts)` | Simulate payout (pure) |
| `getImplementation()` | Get proxy implementation address |
| `factory()` | Get factory address |
| `rescueAddress()` | Get rescue address |
| `PRICE_DECIMALS()` | Get price decimals constant |
| `packExtraOptionData()` | Get packed extra option data |

**Write Functions:**
| Method | Description |
|--------|-------------|
| `close()` | Close option position |
| `payout()` | Execute payout after expiry |
| `transfer(isBuyer, target)` | Transfer buyer or seller role |
| `split(splitCollateralAmount)` | Split position by collateral amount |
| `approveTransfer(isBuyer, target, isApproved)` | Approve address for transfer |
| `rescueERC20(token)` | Rescue stuck ERC20 tokens |
| `validateParams(strikes)` | Validate strike parameters |

**Events:**
| Event | Parameters |
|-------|------------|
| `ExcessCollateralReturned` | `seller, collateralToken, collateralReturned` |
| `OptionClosed` | `closedBy, collateralReturned` |
| `OptionExpired` | `settlementPrice` |
| `OptionInitialized` | `buyer, seller, createdBy, optionType, collateralToken, priceFeed, strikes, expiryTimestamp, numContracts, collateralAmount, extraOptionData` |
| `OptionPayout` | `buyer, amountPaidOut` |
| `OptionSettlementFailed` | _(no parameters)_ |
| `OptionSplit` | `newOption, collateralAmount, feePaid, counterparty` |
| `RoleTransferred` | `from, to, isBuyer` |
| `TransferApproval` | `target, from, isBuyer, isApproved` |
| `ERC20Rescued` | `rescueAddress, tokenAddress, amount` |

---

## Usage with ethers.js

```typescript
import { ethers } from 'ethers';
import { ERC20_ABI, OPTION_BOOK_ABI, BASE_OPTION_ABI } from '@thetanuts-finance/thetanuts-client';

// Create contract instance for reading
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const usdcContract = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

// Read balance
const balance = await usdcContract.balanceOf(userAddress);

// Create contract instance for writing
const signer = new ethers.Wallet(privateKey, provider);
const optionBook = new ethers.Contract(optionBookAddress, OPTION_BOOK_ABI, signer);

// Fill an order
const tx = await optionBook.fillOrder(order, signature, referrer);
await tx.wait();

// Read option state
const optionContract = new ethers.Contract(optionAddress, BASE_OPTION_ABI, provider);
const strikes = await optionContract.getStrikes();
const expiry = await optionContract.expiryTimestamp();
```

## Contract Addresses (Base Mainnet - 8453_r12)

| Contract | Address |
|----------|---------|
| OptionBook | `0x1bDff855d6811728acaDC00989e79143a2bdfDed` |
| OptionFactory | `0x8118daD971dEbffB49B9280047659174128A8B94` |
| TWAP Consumer | `0xE909fb38767e0ac5F7a347DF9Dd4222217E10816` |
| LoanCoordinator | `0x9FB75b24d9d6f7c29D6BdE2870697A4FE0395994` |
| LoanHandler (PSCO) | `0x7c444A2375275DaB925b32493B64a407eE955DEd` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

## Note

These ABIs are automatically used by the SDK modules. You typically don't need to use them directly unless building custom functionality.
