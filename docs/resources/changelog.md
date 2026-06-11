# Changelog

Version history for the Thetanuts Finance SDK.

## Current Version

**v0.3.0** — [View all releases on GitHub](https://github.com/Thetanuts-Finance/thetanuts-sdk/releases)

Companion packages: [`@thetanuts-finance/mcp`](https://www.npmjs.com/package/@thetanuts-finance/mcp) **v1.0.0** (MCP server) and [`@thetanuts-finance/agentkit`](https://www.npmjs.com/package/@thetanuts-finance/agentkit) **v0.2.x** (autonomous agents) — see [AI Agents](../guides/agents-overview.md).

This SDK follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. Patch releases contain bug fixes and non-breaking improvements. Minor releases add new functionality in a backwards-compatible manner. Major releases may contain breaking changes and will be accompanied by a migration guide.

> **Where to look for release notes:**
> - [GitHub Releases](https://github.com/Thetanuts-Finance/thetanuts-sdk/releases) — canonical per-version detail (commit log, before/after diffs, verification steps).
> - [`CHANGELOG.md`](https://github.com/Thetanuts-Finance/thetanuts-sdk/blob/main/CHANGELOG.md) in the repo — terse per-version log, ships with the npm package.
> - The summaries below are the user-facing highlights for the latest few releases.

---

## Release History

### v0.3.0 — RFQ agent helpers, multi-leg payout math, hardening

Minor release, no breaking changes.

**Added:**
- **RFQ sealed-bid agent helpers** — `optionFactory.buildOfferTypedData()` (EIP-712 `Offer` envelope with live `OFFER_TYPEHASH` verification, fails closed on drift), `api.getRequesterPublicKey(quotationId)`, and `api.getOffer(...)`. These power [`@thetanuts-finance/agentkit`](../guides/agentkit.md) and the MCP prepare service; agentkit's peer range requires `>=0.3.0`.
- **Off-chain payout + collateral math for all multi-leg structures.** `client.utils.calculatePayout()` / `calculateCollateral()` now cover `call_fly`, `put_fly`, `call_condor`, `put_condor`, `iron_condor`, and `ranger` — pure bigint, no RPC, usable for pre-trade UI previews. Previously multi-leg types threw `INVALID_PARAMS`.

**Fixed:** MCP `validate_ranger` schema matched to the SDK validator (4 strikes); `calculateMaxPayout` / `calculatePayoutAtPrice` no longer fall through to spread math for 3- and 4-strike orders.

**Security:** write methods assert the connected network before building transactions; OptionBook swap paths validate router/token addresses and swap data; MCP prepare tools tighten auth and redact URLs from errors.

### v0.2.5 — loan indexer r12 fixes

- Loan indexer URL repointed to the r12 worker — consumers were reading r12 contract state but querying the legacy v1 indexer, seeing archived loans and missing every r12 RFQ/offer/loan.
- `LoanModule` backfills the r12 indexer's missing fields (`strike`, `expiryTimestamp`, `buyer`, `seller`) from on-chain `getOptionInfo()`, so `getLendingOpportunities()` and `getUserLoans()` return complete rows.
- 9 collar types re-exported from the package barrel (they shipped in 0.2.4 but weren't reachable from the public API).

### v0.2.4 — Collar Loan module + security audit closeout

- **`client.collar`** — zero-interest, capped-upside loans via RFQ (buy put at `K_lo` + sell call at `K_hi`; MM funds an up-front USDC loan from the call premium). Pricing/read methods work today against live Deribit quotes; write methods throw `NETWORK_UNSUPPORTED` until the coordinator contract deploys.
- **Security audit closeout** — remediates the full `SECURITY_AUDIT_BETA.md` backlog (1 Critical, 24 High, 73 Medium/Low/Informational): admin-only entrypoints removed from SDK ABIs, WheelVault allowance + event-log filtering fixes, `marketFill` swap-router validation made unconditional, `splitOption`/`reclaimCollateral` fee-forwarding wrappers, and more — see the per-finding tracker in the repo.

### v0.2.3 — strategyVault rename (BREAKING)

Renames two public symbols on `client.strategyVault`. Behavior, ABIs, and contract addresses are unchanged.

> **Heads up:** despite the patch-level version bump, the two API renames below are **breaking**. Anyone using the previous config field or method names from v0.2.2 must update on upgrade. There are no deprecated aliases — old names are gone.

**Breaking renames:**

```diff
- const vault = STRATEGY_VAULT_CONFIG.<old>.vaults[0].address;
+ const vault = STRATEGY_VAULT_CONFIG.fixedStrike.vaults[0].address;

- const vaults = await client.strategyVault.<old>();
+ const vaults = await client.strategyVault.getFixedStrikeVaults();
```

All sub-fields of `STRATEGY_VAULT_CONFIG.<old>` (`vaults`, `baseAsset`, `quoteAsset`, `oracle`) move with the rename. Migration is a straight find-and-replace; return shapes are identical.

**Prose updates:** comments, JSDoc, runtime error messages, and docs use neutral terms ("fixed-strike", "wheel strategy") throughout. No symbol changes beyond the two breaking renames above.

**Test runner:** `scripts/run-mainnet-tests.ts` now retries transient `CALL_EXCEPTION` errors from public RPCs (the public Base RPC drops bursts of read calls; the test suite was failing 28/30 instead of 30/30 because of dropped responses, not contract bugs). Runner accepts a `BASE_RPC_URL` env var to override the public default.

**Unchanged:** `STRATEGY_VAULT_CONFIG.clvex`, `getClvexVaults()`, `getAllVaults()`, all on-chain contract addresses, ABIs, and module shapes.

### v0.2.2 — DX polish

Polish release with no new features and no breaking changes. Came out of a live `/devex-review` audit.

**Bug fixes:**
- `mapContractError` no longer clobbers typed `ThetanutsError` instances (e.g. `SIGNER_REQUIRED` from `requireSigner()`). Calling `client.optionBook.claimFees(token)` without a signer now reports `code: 'SIGNER_REQUIRED'` instead of generic `code: 'CONTRACT_REVERT'`.
- `NETWORK_UNSUPPORTED` error message now derives the supported-chains list dynamically from `CHAIN_CONFIGS_BY_ID`. Previous hardcoded string `"Supported chains: 8453 (Base)"` omitted Ethereum (added in v0.2.1).

**Project hygiene:**
- New `CONTRIBUTING.md` documents local setup, the four required gates, the `/codex review` + `/codex challenge` review process, and the npm publish flow.
- New `SECURITY.md` — vulnerability reporting policy and supported-versions table.
- New `.github/ISSUE_TEMPLATE/{bug_report,feature_request,question,config}.yml` and `PULL_REQUEST_TEMPLATE.md`.

**Documentation:**
- Fixed broken link in `docs/resources/migration-guide.md` (pointed at non-existent `reference/error-codes.md`; now points at `guides/error-handling.md`).
- Backfilled v0.1.x history in repo-root `CHANGELOG.md`.

### v0.2.1 — Base_r12 deployment + codex-found fixes

The first 0.2.x release published to npm. Bundles the **Base_r12 deployment cutover** with **22 fixes** that three adversarial code-review passes found in the staged surface. v0.2.0 was prepared internally but never published; everything ships in this single release.

> See the [v0.2.1 GitHub Release](https://github.com/Thetanuts-Finance/thetanuts-sdk/releases/tag/v0.2.1) for per-commit detail, before/after migration code, and verification steps.

**Base_r12 cutover:**
- All chainId-8453 contract addresses point at the r12 deployment (`optionBook`, `optionFactory`, all 13 implementations, LoanCoordinator, LoanHandler).
- `deploymentBlock` → `45601440` (deployed 2026-05-05).
- Historical reverse-lookup entries (`8453_v6`, `Base_r10`) preserved so events emitted before the cutover still decode.
- Ethereum mainnet (`chainId 1`) added as a vault-only chain.

**New surface:**
- New `client.ranger` module — RangerOption (zone-bound, 4-strike payoff). Module is chain-gated; throws `NETWORK_UNSUPPORTED` on chains where RangerOption is not deployed (Ethereum mainnet today).
- `RANGER_OPTION_ABI` exported from the package root.
- `chainConfig.twapConsumer` (HistoricalPriceConsumerV3_TWAP) surfaced as a top-level chain-config field.
- New chain-config implementation keys: `RANGER`, `LINEAR_CALL`, `INVERSE_CALL_SPREAD`, `CALL_LOAN`.
- New OptionBook surface: `cancelOrders`, `cancelOrdersExpiringBefore`, `getValidNumContracts`, `makerCancellationCutoff`, `minNumContracts`, `minPremiumAmount` + `MakerCutoffUpdated` event.
- New OptionFactory surface: `claimEscrowedFunds`, `claimableTransfers`, `totalClaimableTransfers`, `activeRfqForOption`, `baseSplitFee`, `MAX_TRANSFER_DUST`, `MAX_ORACLE_STALENESS`, `settleQuotationEarlyByOrderBook`, `historicalTWAPConsumer`, `deprecationTime`, `settlementExtension` + 10 new events.

**Production-revert fixes** (would have silently reverted once the protocol enabled non-zero fees):
- `split` and `reclaimCollateral` declared `payable`; the SDK forwards `getSplitFee()` / `getReclaimFee(ownedOption)` as `msg.value`.
- `RangerModule.reclaimCollateral` passes the option being reclaimed (not the caller's address) to `getReclaimFee`. The fee is keyed on the option, not the caller.

**ABI shape corrections** (against canonical r12 JSONs):
- `OptionBook.getValidNumContracts` returns the canonical tuple `result { validContracts, collateralRequired }`, not a single `uint256`.
- `BaseOption.optionType` is `view returns (uint256)`; `RangerOption.optionType` is `pure returns (uint256)`.
- `BaseOption.returnExcessCollateral` declares its `uint256` return.
- `LoanCoordinator.assetConfigs` returns the four-field tuple.

**Event shape corrections:**
- `OptionInitialized` (11 fields), `OptionSplit` (adds `feePaid` and `counterparty`), `TransferApproval` (field order corrected), `OptionSettlementFailed` (no inputs), and `ExcessCollateralReturned` (renamed from `CollateralReturned`) all match r12.
- `client.events.getCollateralReturnedEvents` is **`getExcessCollateralReturnedEvents`** with field shape `{ seller, collateralToken, collateralReturned }`.

**Safety upgrades:**
- All four RFQ entry points (`requestForQuotation`, `encodeRequestForQuotation`, `registerReferral`, `callStaticCreateRFQ`) reject the seven undeployed `PHYSICAL_*_SPREAD/FLY/CONDOR/IRON_CONDOR` zero-address placeholders with `INVALID_PARAMS` before any transaction is built.

**Loan changes:**
- `LOAN_COORDINATOR_ABI` updated for r12: `requestLoan` no longer carries `convertToLimitOrder`; `loanRequests` returns `loanClaimed`; new `LoanClaimed` event.
- `LoanRequest.keepOrderOpen` is `@deprecated` — the r12 contract ignores the value.
- `getLendingOpportunities` filter treats a missing `convertToLimitOrder` indexer field as eligible — only skips when explicitly `false`.

**Naming reconciliation:**
- `getOptionImplementationInfo(addr).name` for butterflies returns `'CALL_FLY'` / `'PUT_FLY'` (was `'CALL_FLYS'` / `'PUT_FLYS'`).
- `OptionImplementationInfo.type` union: `'RANGE'` replaced by `'RANGER'`.

**Breaking changes from v0.1.x:**
- `client.events.getCollateralReturnedEvents` removed; replaced by `getExcessCollateralReturnedEvents` with new fields.
- `OptionSplitEvent` adds `feePaid` and `counterparty`.
- `getOptionImplementationInfo(addr).name` for butterflies renamed (above).
- `LoanCoordinator.requestLoan` no longer accepts `convertToLimitOrder`.

### v0.1.6

- Added `getAllClaimableFees()` and `claimAllFees()` helpers on `optionBook` for batch fee claiming across all collateral tokens.

### v0.1.5

- Added `getFactoryReferrerStats()` for the `/factory/referrer/:address/state` endpoint.
- Narrowed catch-block errors from `any` to `unknown` for stricter type safety.

### v0.1.4

- Added Yarn Classic (v1) and Yarn Berry (v2+) publish support.
- Fixed `numContracts` precision handling and `existingOptionAddress` parameter defaults.
- Fixed `LINEAR_CALL` max contracts calculation.
- Fixed nonce null safety in transaction encoding.
- Fixed `toBigInt` handling of scientific notation and negative numbers.
- Fixed floating-point overflow in multi-leg MM pricing calculations.
- Added support for additional underlying assets and collateral tokens in the RFQ builder.

### v0.1.3 and earlier

- Initial public release of the Thetanuts Finance SDK.
- Core modules: `optionBook`, `optionFactory`, `option`, `mmPricing`, `erc20`, `api`, `utils`.
- `buildRFQParams()` and `buildRFQRequest()` high-level builders.
- `getFullOptionInfo()` aggregated option query.
- `strikeToChain()` / `strikeFromChain()` precision-safe strike conversion.
- MM pricing filter utilities: `filterExpired()`, `filterByType()`, `filterByExpiry()`, `filterByStrikeRange()`, `sortByExpiryAndStrike()`.
- Book position PnL fields added to `Position` type.
- Indexer method renames to clarify data source (`getUserPositionsFromIndexer()`, `getUserRFQsFromRfq()`, etc.).

---

## See Also

- [Migration Guide](./migration-guide.md) - Breaking changes and upgrade steps
- [Examples](./examples.md) - Runnable code examples
- [Quick Start](../getting-started/quick-start.md) - Installation and setup
