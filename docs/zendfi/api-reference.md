# Zendfi API reference

Curated cross-reference of the `client.loan` and `client.collar` public surface. Each entry links to the JSDoc on the source file — your editor's hover-help is authoritative; this page exists to give you an at-a-glance map.

> All recoverable errors are typed as [`ZendfiError<'CODE'>`](./errors.md). The throw lists below are non-exhaustive — see the JSDoc for each method's complete `@throws` set, or [errors.md](./errors.md) for the full code reference.

## `client.loan` — single-leg loan module

Non-liquidating loans via physically-settled call options. Borrower deposits ETH/BTC, receives USDC, repays at expiry.

### Write methods

| Method | Returns | Key throws |
| --- | --- | --- |
| `requestLoan(params)` | `Promise<LoanResult>` | `SIGNER_REQUIRED`, `INSUFFICIENT_BALANCE`, `INSUFFICIENT_ALLOWANCE`, `CONTRACT_REVERT` |
| `acceptOffer(qid, offerAmount, nonce, offeror)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |
| `cancelLoan(qid)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `CONTRACT_REVERT` |
| `exerciseOption(optionAddress)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INVALID_PARAM`, `INSUFFICIENT_ALLOWANCE`, `CONTRACT_REVERT` |
| `doNotExercise(optionAddress)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |
| `swapAndExercise(optionAddress, aggregator, swapData)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |
| `splitOption(optionAddress, splitCollateralAmount)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |
| `reclaimCollateral(optionAddress, ownedOption)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |

### Lending methods (the maker side)

| Method | Returns | Key throws |
| --- | --- | --- |
| `lend(qid)` | `Promise<TransactionReceipt>` | `SIGNER_REQUIRED`, `INSUFFICIENT_ALLOWANCE`, `INSUFFICIENT_BALANCE`, `CONTRACT_REVERT` |
| `getLendingOpportunities(options?)` | `Promise<LoanLendingOpportunity[]>` | `INDEXER_UNAVAILABLE` |

### Read methods

| Method | Returns | Key throws |
| --- | --- | --- |
| `getLoanRequest(qid)` | `Promise<LoanState>` | `CONTRACT_REVERT` |
| `getUserLoans(address)` | `Promise<LoanIndexerLoan[]>` | `INVALID_PARAM`, `INDEXER_UNAVAILABLE` |
| `getOptionInfo(optionAddress)` | `Promise<LoanOptionInfo>` | `INVALID_PARAM`, `CONTRACT_REVERT` |
| `isOptionITM(optionAddress)` | `Promise<boolean>` | `INVALID_PARAM`, `CONTRACT_REVERT` |

### Pricing & math

| Method | Returns | Key throws |
| --- | --- | --- |
| `fetchPricing()` | `Promise<DeribitPricingMap>` | `PRICING_UNAVAILABLE` |
| `getStrikeOptions(underlying, settings?)` | `Promise<LoanStrikeOptionGroup[]>` | `PRICING_UNAVAILABLE` |
| `calculateLoan(params)` | `LoanCalculation \| null` | — (pure) |
| `isPromoOption(strike, underlyingPrice, expiry, loanAmountUsd?)` | `boolean` | — (pure) |

### Encoding methods (for viem/wagmi)

| Method | Returns | Key throws |
| --- | --- | --- |
| `encodeRequestLoan(params)` | `{ to, data }` | `INVALID_PARAM` |
| `encodeAcceptOffer(qid, offerAmount, nonce, offeror)` | `{ to, data }` | `INVALID_PARAM` |
| `encodeCancelLoan(qid)` | `{ to, data }` | — (pure) |

## `client.collar` — collar (two-leg) module

Zero-interest, capped-upside loans via Thetanuts V4 RFQ. Borrower buys a put at `K_lo` (default trigger) and sells a call at `K_hi` (cap); MM funds an up-front USDC loan from the call premium it earns.

### Capability checks

| Method | Returns | Notes |
| --- | --- | --- |
| `capability()` | `CollarCapability` | `{ mode: 'pricing-only' \| 'full', chainId, missingContracts? }` |
| `isWriteEnabled()` | `this is CollarModuleWriteEnabled` | Compile-time narrowing — write methods light up on the type inside the guard |
| `isPricingOnly()` | `boolean` | `!isWriteEnabled()` in affirmative form |
| `isDeployed()` | `boolean` | **Deprecated** — kept as back-compat shim |

See [pricing-only-mode.md](./pricing-only-mode.md) for how the runtime mode interacts with the write surface.

### Pricing helpers

| Method | Returns | Key throws |
| --- | --- | --- |
| `quickQuote(underlying, collateralAmount, capUsd, expiryLabel, options?)` | `Promise<CollarEstimate>` | `PRICING_UNAVAILABLE`, `NO_MATCHING_STRIKE` |
| `estimateCollar(params)` | `CollarEstimate \| null` | — (pure) |
| `filterCapStrikes(pricingData, underlying, underlyingPrice, settings, maxCapUsd?)` | `CollarCapStrikeGroup[]` | — (pure) |
| `getCapStrikeOptions(underlying, settings, overrides?)` | `Promise<CollarCapStrikeGroup[]>` | `PRICING_UNAVAILABLE` |
| `fetchPricing()` | `Promise<DeribitPricingMap>` | `PRICING_UNAVAILABLE` |
| `extractUnderlyingPrice(pricingData, underlying)` | `number` | — (pure) |

### On-chain reads

| Method | Returns | Key throws |
| --- | --- | --- |
| `getMaxCapStrike(underlying)` | `Promise<bigint \| null>` | — (returns `null` on error) |
| `getLoanRequest(qid)` | `Promise<CollarLoanRequestRecord>` | `PRICING_ONLY_MODE`, `CONTRACT_REVERT` |
| `getOptionInfo(optionAddress)` | `CollaredOptionContract` (proxy) | `INVALID_PARAM` |

### Write methods (require `isWriteEnabled()`)

| Method | Returns | Key throws |
| --- | --- | --- |
| `requestLoan(req)` | `Promise<CollarLoanResult>` | `PRICING_ONLY_MODE`, `SIGNER_REQUIRED`, `EXPIRY_IN_PAST`, `EXPIRY_TOO_SOON`, `INVALID_CAP`, `INSUFFICIENT_ALLOWANCE`, `CONTRACT_REVERT` |
| `acceptOffer(qid, offerAmount, nonce, offeror)` | `Promise<ContractTransactionResponse>` | `PRICING_ONLY_MODE`, `SIGNER_REQUIRED`, `CONTRACT_REVERT` |
| `cancelLoan(qid)` | `Promise<ContractTransactionResponse>` | `PRICING_ONLY_MODE`, `SIGNER_REQUIRED`, `CONTRACT_REVERT` |
| `exerciseCollar(optionAddress)` | `Promise<ContractTransactionResponse>` | `PRICING_ONLY_MODE`, `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |
| `walkAwayCollar(optionAddress)` | `Promise<ContractTransactionResponse>` | `PRICING_ONLY_MODE`, `SIGNER_REQUIRED`, `INVALID_PARAM`, `CONTRACT_REVERT` |

### Config accessors

| Member | Returns | Notes |
| --- | --- | --- |
| `config` (getter) | `typeof COLLAR_CONFIG` | Raw config (contracts, settlement, assets, defaults) |
| `asset(underlying)` | `CollarAssetConfig` | Per-asset (`collateral`, `priceFeed`, `decimals`) |
| `defaultSettings` (property) | `CollarSettings` | Spread into `getCapStrikeOptions` settings |
