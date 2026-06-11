# Changelog

All notable changes to `@thetanuts-finance/thetanuts-client` are documented here.

## 0.3.0 — 2026-06-11

### Added

- **RFQ sealed-bid agent helpers.** `optionFactory.buildOfferTypedData()`
  builds the EIP-712 `Offer` envelope for `make_offer` flows and verifies the
  live on-chain `OFFER_TYPEHASH` against the SDK's pinned struct definition
  (fails closed on drift). `api.getRequesterPublicKey(quotationId)` and
  `api.getOffer(...)` expose the State API paths needed to encrypt sealed-bid
  offers to a requester and recover them at settlement. These are the APIs
  that power `@thetanuts-finance/agentkit` and the MCP prepare service —
  agentkit's peer range requires `>=0.3.0` for exactly this reason.
- **Off-chain payout + collateral math for all multi-leg structures.**
  `client.utils.calculatePayout()` and `client.utils.calculateCollateral()`
  now support `call_fly`, `put_fly`, `call_condor`, `put_condor`, `iron_condor`,
  and `ranger` in addition to the existing `call` / `put` / `call_spread` /
  `put_spread` cases. All formulas are pure bigint, no RPC required — usable
  for dapp UI previews against hypothetical strikes pre-trade. Previously
  every multi-leg type threw `INVALID_PARAMS`, forcing callers to use the
  on-chain `client.option.calculatePayout()` (any BaseOption) or
  `client.ranger.calculatePayout()` (RANGER), both of which require a
  deployed contract address and an `eth_call` per quote. See the strike-order
  table in `docs/reference/utilities.md` — order must match the on-chain
  factory's expectations (e.g. `put_fly` is descending, `ranger` strikes are
  `[callLower, callUpper, putLower, putUpper]`). MCP server's
  `calculate_payout` tool enum widened to match.

### Fixed

- **MCP `validate_ranger` tool now requires 4 strikes, matching the SDK
  validator.** The tool description and schema previously claimed
  `[lower, upper]` (2 strikes), and the handler hard-rejected anything not
  length 2 — but `validateRanger()` in `src/utils/rfqCalculations.ts:161`
  has always required 4 strikes `[callLower, callUpper, putLower, putUpper]`
  with equal spread widths and a zone gap. The MCP tool therefore rejected
  every valid ranger config before the validator ran. The new multi-leg
  payout work made the inconsistency visible; both the tool description
  and the length check are now aligned with the SDK contract.
- **`calculateMaxPayout` / `calculatePayoutAtPrice` no longer fall through
  to `'call_spread'` for 3- and 4-strike orders.** The internal helper
  `getPayoutTypeFromOptionType` previously returned `'call_spread' | 'put_spread'`
  for any order with 2 or more strikes, silently producing wrong payouts and
  collateral for butterflies and condors. It now correctly maps 3 strikes to
  `'call_fly' | 'put_fly'` and 4 strikes to `'call_condor' | 'put_condor'`
  (or `'iron_condor'` / `'ranger'` when the order shape carries those flags).
  Both methods accept optional `isIronCondor` / `isRanger` discriminators on
  the order object to disambiguate the 4-strike case.

### Security

- **Hardened SDK and MCP write paths.** Write methods assert the connected
  network before building transactions; OptionBook swap paths
  (`swapAndFillOrder`, `marketFill`) validate the swap router and source
  token addresses, require a positive `swapSrcAmount`, and reject empty
  `swapData`; OptionFactory builders gain stricter input validation. On the
  MCP side, prepare tools tighten auth handling and error responses redact
  URLs.

## 0.2.5 — 2026-06-02

### Fixed

- **Loan indexer URL repointed to the r12 worker.** `src/chains/loan.ts`
  hard-coded the legacy v1 indexer URL, which only contains pre-r12 loans
  created via the retired LoanCoordinator. Loan contract addresses were
  already on r12, so consumers were reading r12 contract state but querying
  the wrong indexer — they would see archived loans and miss every r12
  RFQ / offer / loan. The v1 worker stays alive at its own URL/KV for
  archaeology of historical loans.
- **r12 indexer backfill in `LoanModule`.** The r12 indexer's `state.options`
  entries omit `strike`, `expiryTimestamp`, `buyer`, and `seller`. Without a
  backfill, `getLendingOpportunities()` rejected every r12 row (the
  `expiryTimestamp <= now` filter tripped on zero) and `getUserLoans()`
  returned rows with empty fields, leaving downstream UIs to render "—" for
  strike, expiry, and lender. Both methods now run a private
  `backfillFromOptionInfo()` pass that reads the missing fields from the
  deployed option contract via `getOptionInfo()`, using `Promise.allSettled`
  so a single RPC blip doesn't kill the batch. `LoanIndexerLoan` gains
  optional `buyer` / `seller` fields documented as SDK-populated. Includes
  the role-swap mapping (option.seller → loan.buyer = lender;
  option.buyer → loan.seller = borrower).

### Added

- **Public type surface for `client.collar`.** Re-exported 9 collar types
  from the barrel (`CollarUnderlying`, `CollarEstimate`, `CollarCapStrike`,
  `CollarCapStrikeGroup`, `CollarStrikeFilter`, `CollarLoanRequest`,
  `CollarLoanResult`, `CollarSettings`, `CollarAssetConfig`). The 0.2.4
  release shipped `CollarModule` files but didn't export them or any of
  their types — meaning consumers couldn't reach the module from the
  package's public API at all. TypeScript consumers can now type variables
  and parameters against the collar surface without importing from deep
  `dist/` paths.

### Docs

- **Chain config + ABI READMEs refreshed to r12.** `src/chains/README.md`
  and `src/abis/README.md` still documented the pre-r12 OptionBook
  (`0xd58b81…69A1`) and OptionFactory (`0x1aDcD3…86e5`) in their example
  blocks. The runtime config in `src/chains/index.ts` was already on r12;
  these were docs-only inconsistencies that would have misled anyone
  copy-pasting from the README.

## 0.2.4 — 2026-05-24

### Added

- **`client.collar` — Collar Loan module.** Zero-interest, capped-upside loans via
  Thetanuts V4 RFQ. Borrower buys a put at `K_lo` (default trigger) + sells a call
  at `K_hi` (cap); MM funds an up-front USDC loan from the call premium it earns.
  Three terminal outcomes at expiry: walk / repay / cap-settle.
  - Pricing math against live Deribit quotes:
    `target_put_premium = call_premium × (1 − mm_margin)`,
    `K_lo = highest OTM put whose ask ≤ target`, `L = K_lo · N`.
  - Surface: `estimateCollar`, `filterCapStrikes`, `getCapStrikeOptions`,
    `requestLoan`, `cancelLoan`, `acceptOffer`, `exerciseCollar`, `walkAwayCollar`,
    `getMaxCapStrike`, `getLoanRequest`, `getOptionInfo`, `fetchPricing`,
    `extractUnderlyingPrice`, `isDeployed`.
  - Status: `CollarLoanCoordinator` not yet deployed on Base. Pricing/read-only
    methods work today against live Deribit. Write methods throw
    `NETWORK_UNSUPPORTED` until `COLLAR_CONFIG.contracts.collarCoordinator` is
    populated (`isCollarDeployed()` flips to `true` automatically).
- **`utils/expiry.ts` — shared Deribit expiry parser.** New exports:
  `parseDeribitExpiry`, `parseDeribitExpiryOrThrow`, `formatDeribitExpiry`,
  `MONTH_MAP`. Both `LoanModule` (put leg) and `CollarModule` (call leg) now
  share one source of truth.

### Changed

- **`DeribitOptionData` gains optional `bid_price`.** Collar pricing uses the
  bid for the short-call leg (the conservative side a hedger could actually
  receive on Deribit); existing put-leg consumers ignore the new field.
- **`CollarModule.fetchPricing()` delegates to `LoanModule.fetchPricing()`.**
  Single 30s-cached call against `pricing.thetanuts.finance/all` shared across
  both modules — calling either module's `fetchPricing()` populates the same
  cache. Verified by smoke test.

### Security

Closes the full backlog from the `SECURITY_AUDIT_BETA.md` engagement — 1 Critical
+ 24 High + 73 Medium/Low/Informational findings remediated. Highlights below;
see `SECURITY_AUDIT_BETA.md` for the per-finding tracker.

- **Admin-only entrypoints removed from SDK ABIs and modules** (audit 0002, 0043,
  0044, 0045). `WheelVault.trigger`, `OptionFactory.transferOwnership`,
  `OptionFactory.withdrawFees`, `OptionFactory.renounceOwnership`, plus
  `offerSignatures` / `pendingFees` / `referralOwner` are gone — they reverted for
  non-owner callers and don't exist in r12 canonical ABIs.
- **`BaseOption.payout()` removed from ABI** (audit 0046). Settlement is
  automatic via factory callbacks on r12; the wrapper now throws
  `INVALID_PARAMS` with migration guidance instead of silently failing.
- **WheelVault deposit/withdraw allowance + log filtering** (audit 0003, 0009).
  `deposit`, `depositSingle`, `depositDual`, `depositToBucket` now run
  `ensureAllowance` against the correct spender before pulling tokens; event
  parsers filter receipt logs by `log.address === vaultAddress` to block
  signature-compatible event injection from co-emitting contracts.
- **`marketFill` always validates swap router + approvalTarget against the
  configured aggregator** (audit 0005). The dangerous `useSwap` gating is gone.
- **`LoanModule.splitOption()` and `LoanModule.reclaimCollateral()` wrappers**
  (audit 0006, 0007). Both read the on-chain fee (`getSplitFee` /
  `getReclaimFee(ownedOption)`) and forward as `msg.value` — r12 made these
  payable. Mirrors `OptionModule` / `RangerModule` semantics.
- **`OptionBook.fillOrder` zero-address implementation guard** (audit 0047).
- **MCP `encode_*` tools gated behind `THETANUTS_MCP_ENABLE_ENCODE=1`**
  (audit 0053). `encode_approve` refuses `amount: "max"` and caps at `2^128 - 1`
  regardless of flag.
- **Numeric / input hardening across utils + modules** (audit 0011..0042,
  0040, 0041, 0042, 0054). `toBigInt` rejects `NaN`/`Infinity`/scientific notation;
  `floatToBigInt` throws past `2^53`; `parseDeribitKey` adds explicit radix +
  NaN guard; iron-condor builders reject non-ascending strikes (was silent
  sort); `calculateSlippagePrice` bounded `[0, 10000]`; expiry upper bound
  capped at 5 years; CLI book orders use `1e8/collDec` premium scale instead of
  hardcoded `1e6`.
- **`validateAddress` returns checksummed string + new `validateHexBytes`
  helper.** Surface-wide validation tightening.
- **`api.ts` `safeNumber` helper** guards `NaN`/`Infinity` at the JSON
  boundary.
- **`erc20.ensureAllowance` zero-resets before non-zero approve** (USDT-style
  semantics).
- **`rfqKeyManager`:** case-insensitive `0X` nonce normalize, uint256-length
  cap on encrypted offer fields, `exportPrivateKey` emits a warn log,
  `InvalidKeyError` no longer leaks the ethers cause.
- **`OptionFactory.makeOfferForQuotation` validates signing key + 65-byte
  signature shape** before dispatch.
- **Collar hardening:** longer offer window, expiry validation, `capUsd > 0`
  check, gas-buffer pattern, cheapest-premium fallback put selector, finite-strike
  guard.
- **Supply chain:** `yarn.lock` removed, `packageManager` pinned to `npm@10.8.0`,
  `prepublishOnly` gated on `npm ci`, transitive CVEs fixed via
  `@modelcontextprotocol/sdk ^1.25.4` (clears hono / path-to-regexp / fast-uri /
  ajv cluster — audit 0048..0052) plus picomatch + brace-expansion bumps.
- **MCP server:** response-size caps with `truncated` flag, `sanitizeOnchainString`
  for symbol/name, `requireAddress` validator on user/token/option inputs, RPC
  URL redaction in the global catch, `generate_example_keypair` returns a static
  example instead of a real key.
- **CLI:** `--private-key` argv scrub + warn, `book check` threads underlying
  through ticker formatter, `book preview` throws on unknown collateral,
  `loadConfig` auto-tightens loose perms, `O_NOFOLLOW` on key/config reads,
  `redactSecrets` extended for basic-auth + QuickNode + Etherscan URLs.

Three findings remain explicitly **ACCEPTED** in the tracker: 0035 (ABI-interface
test infra), 0038 (Multicall3 `aggregate3` migration), 0059 (defensive
prototype-pollution lint).

### Tests

- **Property-based invariants:** 39 invariants across `tests/properties/invariants.test.ts`
  (INV-1..INV-39). Adds INV-14..INV-19 specifically to lock in the
  TNU-AUDIT-0002..0009 remediations, plus engagement-wide ABI parity verifier
  for TNU-8.

## 0.2.3 — strategyVault rename (BREAKING)

Renames two public symbols on `client.strategyVault`. Behavior and contract
addresses are unchanged — this is a naming-only release.

> **Heads up:** despite the patch-level version bump, the two API renames below
> are **breaking**. Anyone using the previous config field or method names from
> v0.2.2 must update on upgrade. There are no deprecated aliases — old names
> are gone.

### Breaking

- **`STRATEGY_VAULT_CONFIG.<old-name>` → `STRATEGY_VAULT_CONFIG.fixedStrike`.**
  All sub-fields (`vaults`, `baseAsset`, `quoteAsset`, `oracle`) move with it.
  ```diff
  - const vault = STRATEGY_VAULT_CONFIG.<old>.vaults[0].address;
  + const vault = STRATEGY_VAULT_CONFIG.fixedStrike.vaults[0].address;
  ```
- **`client.strategyVault.<old-method>()` → `client.strategyVault.getFixedStrikeVaults()`.**
  Same return type and behavior — only the method name changes.
  ```diff
  - const vaults = await client.strategyVault.<old>();
  + const vaults = await client.strategyVault.getFixedStrikeVaults();
  ```

### Changed

- Comments, JSDoc, runtime error messages, and docs use neutral terms
  ("fixed-strike", "wheel strategy") throughout. No symbol changes beyond the
  two breaking renames above.

### Unchanged

- `STRATEGY_VAULT_CONFIG.clvex`, `getClvexVaults()`, `getAllVaults()` — all preserved.
- The loan indexer URL (live service endpoint) — kept as-is.
- All on-chain contract addresses, ABIs, and module shapes.

---

## 0.2.2 — DX polish

Small follow-ups from a live `/devex-review` audit. No new features or breaking
changes; fixes a few rough edges that surfaced in error paths and docs.

### Fixed

- **Error mapping no longer clobbers typed errors.** `mapContractError` previously
  re-wrapped `ThetanutsError` instances (e.g. `SIGNER_REQUIRED` from
  `requireSigner()`) as generic `CONTRACT_REVERT`. It now passes them through
  unchanged. Calling `client.optionBook.claimFees(token)` without a signer now
  reports `code: 'SIGNER_REQUIRED'` instead of `code: 'CONTRACT_REVERT'`.
- **Stale chain list in NETWORK_UNSUPPORTED error message.** The error string
  hardcoded `"Supported chains: 8453 (Base)"` and didn't mention Ethereum
  (chainId 1, added in 0.2.1). Now derives the supported list dynamically from
  `CHAIN_CONFIGS_BY_ID`.
- **Broken doc link.** `docs/resources/migration-guide.md` linked to a
  non-existent `reference/error-codes.md`; now points at the real
  `guides/error-handling.md`.

### Added

- `CONTRIBUTING.md` documents the setup, the four required local gates, the
  `/codex review` + `/codex challenge` review process, and the npm publish flow.
- `SECURITY.md` — vulnerability reporting policy and supported-versions table.
- `.github/ISSUE_TEMPLATE/{bug_report,feature_request,question,config}.yml` and
  `.github/PULL_REQUEST_TEMPLATE.md` — structured templates that pre-fill the
  fields a maintainer needs to triage.
- Backfilled v0.1.x entries into `CHANGELOG.md` so the repo changelog matches
  the GitBook changelog history.

## 0.2.1 — Base_r12 deployment + codex-found fixes

The first 0.2.x release published to npm. Bundles the Base_r12 deployment cutover with 22 fixes that three adversarial code-review passes found in the staged 0.2.0 surface. v0.2.0 was prepared internally but never published to npm; everything its CHANGELOG promised plus everything 0.2.1 fixes ships in this single release.

If you are on v0.1.x: pin `@thetanuts-finance/thetanuts-client@^0.1.x` to keep talking to the prior Base deployment, or upgrade to `^0.2.1` to migrate to Base_r12.

### Base_r12 deployment cutover

The Thetanuts protocol shipped a fresh v4 deployment on Base (chainId 8453) under tag `Base_r12` at block 45601440 on 2026-05-05. This SDK release switches every chainId-8453 address to r12 in place. There is no runtime version selector — pin the npm major to pick the deployment.

- All chainId-8453 contract addresses point at r12.
  - `contracts.optionBook` → `0x1bDff855d6811728acaDC00989e79143a2bdfDed`
  - `contracts.optionFactory` → `0x8118daD971dEbffB49B9280047659174128A8B94`
  - All 13 implementation addresses replaced.
  - `deploymentBlock` → `45601440`.
- LoanCoordinator → `0x9FB75b24d9d6f7c29D6BdE2870697A4FE0395994`.
- LoanHandler → `0x7c444A2375275DaB925b32493B64a407eE955DEd`.
- Historical reverse-lookup entries (`8453_v6`, `Base_r10`) preserved so events emitted before the cutover still decode through `getOptionImplementationInfo`.
- Ethereum mainnet (`chainId 1`) added as a vault-only chain.

### New surface

- **RangerOption**: zone-bound, 4-strike payoff. New `client.ranger` module (`RangerModule`) with reads (`getInfo`, `getZone`, `getSpreadWidth`, `getStrikes`, `getTWAP`, `calculatePayout`, `simulatePayout`, `calculateRequiredCollateral`) and writes (`payout`, `close`, `split`, `transfer`, `reclaimCollateral`, `returnExcessCollateral`). Module is chain-gated — throws `NETWORK_UNSUPPORTED` on chains where RangerOption is not deployed.
- `RANGER_OPTION_ABI` exported from `@thetanuts-finance/thetanuts-client`.
- `chainConfig.twapConsumer` (HistoricalPriceConsumerV3_TWAP) surfaced as a top-level chain-config field. `null` on chains without it.
- New chain-config implementation keys: `INVERSE_CALL_SPREAD`, `LINEAR_CALL`, `RANGER`, `CALL_LOAN`.
- New OptionBook ABI surface (user-facing only): `cancelOrders`, `cancelOrdersExpiringBefore`, `getValidNumContracts`, `makerCancellationCutoff`, `minNumContracts`, `minPremiumAmount` + `MakerCutoffUpdated` event.
- New OptionFactory ABI surface: `claimEscrowedFunds`, `claimableTransfers`, `totalClaimableTransfers`, `activeRfqForOption`, `baseSplitFee`, `MAX_TRANSFER_DUST`, `MAX_ORACLE_STALENESS`, `settleQuotationEarlyByOrderBook`, `historicalTWAPConsumer`, `deprecationTime`, `settlementExtension` + 10 new events (`BaseSplitFeeUpdated`, `CollateralDeposited`, `CollateralReturned`, `EscrowClaimed`, `ExpiredReferralSwept`, `FactoryDeprecation`, `MaxRfqValueUpdated`, `OfferAcceptedFromOrderBook`, `SettlementFailedDueToStateChange`, `TransferEscrowed`).
- New BaseOption ABI surface: `creator`, `paramsHash`, `splitGeneration`, `optionParent`, `optionChildren`, `getReclaimFee`, `getSplitFee`, `calculateNumContractsForCollateral`, plus user-facing writes `reclaimCollateral` and `returnExcessCollateral`.

### Production-revert fixes

These would silently revert in production once the protocol owner enabled non-zero contract fees.

- **`split` and `reclaimCollateral` are correctly declared `payable`** in `option.ts`, `ranger.ts`, and `loan.ts` ABIs. The r12 contracts collect `getSplitFee()` and `getReclaimFee(ownedOption)` as `msg.value`.
- **`OptionModule.split` and `RangerModule.split`** read `getSplitFee()` and forward as `msg.value`.
- **`RangerModule.reclaimCollateral`** reads `getReclaimFee(ownedOption)` and forwards as `msg.value`. The fee is keyed on the option being reclaimed, not on the caller. Parameter renamed from `recipient` to `ownedOption`.

### ABI shape corrections

Verified against canonical r12 JSONs.

- **`OptionBook.getValidNumContracts`** returns the canonical tuple `result { validContracts, collateralRequired }`. Inputs match canonical names: `implementation` and `desiredContracts`.
- **`optionType()`** matches each contract's actual state mutability — `view returns (uint256)` for BaseOption, `pure returns (uint256)` for RangerOption.
- **`returnExcessCollateral()`** declares its `uint256` return.
- **`LOAN_COORDINATOR_ABI.assetConfigs(bytes32)`** declares the four-field tuple return `(address collateralToken, address priceFeed, address settlementToken, bool isActive)`.

### Event shape corrections

Without these, any consumer of `client.events.*` for these events would silently misdecode logs against r12 contracts.

- **`OptionInitialized`** added to `BASE_OPTION_ABI` and corrected in `RANGER_OPTION_ABI` — r12 emits 11 fields.
- **`OptionSplit`** corrected in both BaseOption and RangerOption ABIs — r12 shape adds `feePaid` and `counterparty` (indexed).
- **`TransferApproval`** corrected in `RANGER_OPTION_ABI` — first two fields were swapped.
- **`OptionSettlementFailed`** corrected in `RANGER_OPTION_ABI` — r12 has no inputs.
- **`CollateralReturned` renamed to `ExcessCollateralReturned`** in both ABIs with new shape `(seller indexed, collateralToken indexed, collateralReturned)`.
- **`client.events.getCollateralReturnedEvents` renamed to `getExcessCollateralReturnedEvents`** with the new field shape.
- **`getOptionSplitEvents`** field extraction now includes `feePaid` and `counterparty`.

### Safety upgrades

- **Zero-address guard on every RFQ entry point.** All four (`requestForQuotation`, `encodeRequestForQuotation`, `registerReferral`, `callStaticCreateRFQ`) now reject `params.implementation === 0x000…000` with `INVALID_PARAMS` before any tx is built. The seven `PHYSICAL_*_SPREAD/FLY/CONDOR/IRON_CONDOR` placeholders are still 0x0…0 in r12 and bypassing the guard would silently target the zero address on-chain.
- **`RangerModule` chain guard.** Every public method throws `NETWORK_UNSUPPORTED` up-front when `chainConfig.implementations.RANGER` is missing or set to the zero address.
- **`getLendingOpportunities` filter** treats a missing `convertToLimitOrder` indexer field as eligible — only skips when explicitly `false`. The r12 indexer is expected to drop the field.

### Loan changes for r12

- `LOAN_COORDINATOR_ABI` updated: `requestLoan` parameter tuple no longer carries `convertToLimitOrder`; `loanRequests` view now returns 9 fields including `loanClaimed`; `LoanRequested` event lost its `convertToLimitOrder` param; new `LoanClaimed` event added.
- `LoanRequest.keepOrderOpen` is `@deprecated` — the r12 contract ignores the value. The field remains in the public type for source compatibility.
- `LoanIndexerLoan.convertToLimitOrder` is now optional.

### Naming reconciliation

- **`CALL_FLYS` / `PUT_FLYS`** reverse-lookup names renamed to **`CALL_FLY` / `PUT_FLY`** for both historical and r12 entries, matching the public `ImplementationAddresses` keys. The `ProductName` union in `src/utils/rfqCalculations.ts` follows.
- **`OptionImplementationInfo.type`** union: `'RANGE'` replaced by `'RANGER'` to match the on-chain `RangerOption` naming.

### Breaking changes from 0.1.x

For users upgrading from v0.1.x. v0.1.x stays on npm at `@^0.1.x` if you need to keep talking to the prior Base deployment.

- `client.events.getCollateralReturnedEvents` removed; replaced by `getExcessCollateralReturnedEvents` with field shape `{ seller, collateralToken, collateralReturned }` (was `{ optionAddress, seller, amountReturned }`).
- `OptionSplitEvent` adds `feePaid: bigint` and `counterparty: string` fields.
- `getOptionImplementationInfo(addr).name` for butterflies returns `'CALL_FLY'` / `'PUT_FLY'` (was `'CALL_FLYS'` / `'PUT_FLYS'`).
- `ProductName` union no longer includes `'CALL_FLYS'` / `'PUT_FLYS'`.
- `RangerModule.reclaimCollateral` second parameter is `ownedOption` (was `recipient` in the staged 0.2.0). Semantic also changed: the address is the option being reclaimed FROM, not a transfer destination.
- `LoanRequest.keepOrderOpen` is a no-op at the contract level. Still accepted on the type for source compatibility.

### Skipped on purpose

These admin-only and internal-only contract functions are deliberately not added to the SDK:

- OptionFactory: `setBaseSplitFee`, `setMaxRfqValue`, `deprecateFactory`.
- OptionBook: `setMinimumThresholds`.
- LoanCoordinator: `setAssetConfig`, `removeAssetConfig`, `setFee`, `transferOwnership`, `renounceOwnership`, `acceptOwnership`, `rescueToken`, `handleSettlement`, `handleSettlementComplete`.
- BaseOption / RangerOption: `notifyCreationComplete`, `notifyTradeSettled`, `executeCollateralReclaim`, `exerciseInternal`, `exerciseOnOracleFailure`.
- `partnerFeeBrokerFactory` is deployed at `0x0843078cAF4B5B8732e723AA8f22381cd7e9f186` but not exposed by the SDK — upstream artifacts directory ships no public ABI for it.

Already-shipped admin-ish methods on existing modules (`sweepProtocolFees`, `setReferrerFeeSplit`, `withdrawFees`, `claimFees`, `rescueERC20`, `approveTransfer`) are left untouched; removing them is a separate concern.

### Notes for users

- **Pin to the deployment you want.** v0.1.x tracks the prior Base deployment; v0.2.x tracks Base_r12. Don't mix.
- The seven physical multi-leg implementation slots (`PHYSICAL_CALL_SPREAD`, `PHYSICAL_PUT_SPREAD`, `PHYSICAL_*_FLY`, `PHYSICAL_*_CONDOR`, `PHYSICAL_IRON_CONDOR`) remain `0x000…000` in r12. The runtime guards in `optionFactory.ts` throw a clear `INVALID_PARAMS` error if any RFQ flow tries to route through one.
- See [`docs/releases/0.2.1.md`](docs/releases/0.2.1.md) for the full per-commit deep-dive, before/after migration code, and verification commands.

## 0.1.6

- Added `getAllClaimableFees()` and `claimAllFees()` helpers on `optionBook` for batch fee claiming across all collateral tokens.

## 0.1.5

- Added `getFactoryReferrerStats()` for the `/factory/referrer/:address/state` endpoint.
- Narrowed catch-block errors from `any` to `unknown` for stricter type safety.

## 0.1.4

- Added Yarn Classic (v1) and Yarn Berry (v2+) publish support.
- Fixed `numContracts` precision handling and `existingOptionAddress` parameter defaults.
- Fixed `LINEAR_CALL` max contracts calculation.
- Fixed nonce null safety in transaction encoding.
- Fixed `toBigInt` handling of scientific notation and negative numbers.
- Fixed floating-point overflow in multi-leg MM pricing calculations.
- Added support for additional underlying assets and collateral tokens in the RFQ builder.

## 0.1.3 and earlier

- Initial public release of the Thetanuts Finance SDK.
- Core modules: `optionBook`, `optionFactory`, `option`, `mmPricing`, `erc20`, `api`, `utils`.
- `buildRFQParams()` and `buildRFQRequest()` high-level builders.
- `getFullOptionInfo()` aggregated option query.
- `strikeToChain()` / `strikeFromChain()` precision-safe strike conversion.
- MM pricing filter utilities: `filterExpired()`, `filterByType()`, `filterByExpiry()`, `filterByStrikeRange()`, `sortByExpiryAndStrike()`.
- Book position PnL fields added to `Position` type.
- Indexer method renames to clarify data source (`getUserPositionsFromIndexer()`, `getUserRFQsFromRfq()`, etc.).
