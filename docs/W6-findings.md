# W6 Findings — Property-based & Spec-compliance Verification

**Date:** 2026-05-24  
**Branch:** `beta`  
**Auditor:** Verification Lead (TNU-8 W6)  
**Test suite:** `npm run test:properties` (30 tests)  
**ABI parity:** `npm run verify:abi`

---

## Summary

| Invariant | Status | Severity |
|-----------|--------|----------|
| 1. Split fee parity | ✅ PASS | — |
| 2. Reclaim fee parity (ranger path) | ✅ PASS | — |
| 2. Reclaim fee parity (option module gap) | ⚠️ GAP | Medium |
| 3. Iron condor ordering — factory builders | ❌ VIOLATION | High |
| 3. Iron condor ordering — mmPricing path | ✅ PASS | — |
| 4. Approval ≥ transfer | ✅ PASS | — |
| 5. Address normalization | ⚠️ VIOLATION | Medium |
| 6. EIP-712 chainId binding | ✅ PASS | — |
| 7. ABI parity — admin leak (renounceOwnership) | ❌ VIOLATION | High |
| 7. ABI parity — admin leak (transferOwnership, withdrawFees) | ❌ VIOLATION | High |
| 7. ABI parity — missing-in-canonical (OptionFactory) | ❌ VIOLATION | High |
| 7. ABI parity — stateMutability drift (BaseOption) | ❌ VIOLATION | Medium |
| 7. ABI parity — missing-in-canonical (BaseOption.payout) | ❌ VIOLATION | High |
| 8. FLY naming reconciliation | ✅ PASS | — |
| 9. Physical multi-leg zero-address gate (factory) | ✅ PASS | — |
| 9. Physical multi-leg zero-address gate (optionBook gap) | ⚠️ GAP | High |

**Property tests:** 30/30 pass  
**ABI parity violations:** 8 detected (see detail below)

---

## Violations

### V-1: Iron condor ordering — builders silently sort instead of rejecting

**Invariant:** INV-3  
**Severity:** High  
**File:line:** `src/modules/optionFactory.ts:1668`  
**Repro:**
```bash
npm run test:properties
# INV-3: buildRFQParams silently sorts 4-strike iron condor ascending (VIOLATION: should reject)
```
**Description:** The spec (TNU-8 engagement invariant 3) requires that any call building iron condor parameters MUST satisfy `strike1 < strike2 < strike3 < strike4` and **reject** otherwise. The SDK `buildRFQParams` silently **sorts** rather than throwing. This masks caller mistakes — a client passing `[3000, 1000, 4000, 2000]` as iron condor strikes receives a valid response with auto-sorted strikes rather than an error indicating the invariant violation.

The mmPricing path (`src/modules/mmPricing.ts:743`) correctly throws `'Condor strikes must be in ascending order'`.

**Remediation:** Add a pre-sort check in `buildRFQParams` (around line 1642): if `isIronCondor` and strikes are not already ascending, throw `INVALID_PARAMS` with `'Iron condor strikes must be in ascending order: strike1 < strike2 < strike3 < strike4'`. Apply the same check to `buildPhysicalIronCondorRFQ` at line 2735.

---

### V-2: Address normalization — SDK passes addresses through without EIP-55 checksum

**Invariant:** INV-5  
**Severity:** Medium  
**File:line:** `src/utils/validation.ts:7`  
**Repro:**
```bash
npm run test:properties
# INV-5: ethers.isAddress accepts both checksummed and lowercase (VIOLATION: no normalization)
```
**Description:** `validateAddress` calls `ethers.isAddress()` which accepts both checksummed and lowercase addresses. It does **not** call `ethers.getAddress()` for normalization. Addresses therefore reach contract calldata in whatever case the caller provided. This is a spec violation: invariant 5 requires either rejection of unchecksummed strings OR normalization via `ethers.getAddress()`.

**Remediation:** In `src/utils/validation.ts`, change `validateAddress` to return the checksummed address (call `getAddress(address)` after the `isAddress` check) and update all callers to use the return value.

---

### V-3: Admin-only `renounceOwnership` in `OPTION_FACTORY_ABI`

**Invariant:** INV-7  
**Severity:** High  
**File:line:** `src/abis/optionFactory.ts:370`  
**Repro:**
```bash
npm run verify:abi
# [high] admin-leak: Admin-only entrypoint 'renounceOwnership' exposed in SDK ABI
```
**Description:** `renounceOwnership` is an OpenZeppelin Ownable admin function. CLAUDE.md explicitly forbids admin-only entrypoints in SDK ABIs because non-owner callers receive a revert with no SDK-level guidance.

**Remediation:** Remove the `renounceOwnership` entry from `src/abis/optionFactory.ts`.

---

### V-4: Admin-only `transferOwnership` and `withdrawFees` in `OPTION_FACTORY_ABI`

**Invariant:** INV-7  
**Severity:** High  
**File:line:** `src/abis/optionFactory.ts:468` (`transferOwnership`), `src/abis/optionFactory.ts:477` (`withdrawFees`)  
**Repro:**
```bash
npm run test:properties
# INV-7: transferOwnership in OPTION_FACTORY_ABI — KNOWN VIOLATION
# INV-7: withdrawFees in OPTION_FACTORY_ABI — KNOWN VIOLATION
```
**Description:** CLAUDE.md explicitly lists `transferOwnership` and `withdrawFees` as admin-only functions that must be omitted from SDK ABIs.

**Remediation:** Remove both entries from `src/abis/optionFactory.ts`.

---

### V-5: `offerSignatures`, `pendingFees`, `referralOwner` absent from canonical `OptionFactory.json`

**Invariant:** INV-7  
**Severity:** High  
**File:line:** `src/abis/optionFactory.ts:170`, `189`, `228`  
**Repro:**
```bash
npm run verify:abi
# function offerSignatures(uint256,address) view returns (bytes) — missing-in-canonical
# function pendingFees(address) view returns (uint256) — missing-in-canonical
# function referralOwner(uint256) view returns (address) — missing-in-canonical
```
**Description:** These three public view functions are declared in the SDK ABI but do not exist in `thetaverse/abis/OptionFactory.json`. They were likely renamed or removed in the r12 deployment. Having them in the SDK ABI means the SDK generates valid-looking calldata for functions that don't exist on-chain, causing silent reverts.

**Remediation:** Verify against the deployed r12 bytecode (`base-main_v4_r12_deployment.json`). If the functions were removed, delete the three entries from `OPTION_FACTORY_ABI`. If they were renamed, update the name to match the canonical.

---

### V-6: `payout()` in `BASE_OPTION_ABI` absent from canonical `BaseOption.json`

**Invariant:** INV-7  
**Severity:** High  
**File:line:** `src/abis/option.ts:321`  
**Repro:**
```bash
npm run verify:abi
# function payout() — missing-in-canonical
```
**Description:** The zero-argument `payout()` function is declared in `BASE_OPTION_ABI` but the canonical `BaseOption.json` only has `calculatePayout(uint256)` (view) and `simulatePayout(uint256,uint256[],uint256)` (pure). The settlement-trigger function may have a different name in r12.

**Remediation:** Confirm the correct function name for triggering option settlement in r12. Update `BASE_OPTION_ABI` accordingly.

---

### V-7: `stateMutability` drift — `pure` vs `view` in `BASE_OPTION_ABI`

**Invariant:** INV-7  
**Severity:** Medium  
**File:line:** `src/abis/option.ts` — `calculateRequiredCollateral` (line ~196), `calculateNumContractsForCollateral` (line ~285), `validateParams` (line ~386)  
**Repro:**
```bash
npm run verify:abi
# calculateRequiredCollateral: SDK pure, canonical view
# calculateNumContractsForCollateral: SDK pure, canonical view
# validateParams: SDK pure, canonical view
```
**Description:** These three functions are declared as `pure` in the SDK ABI but are `view` in the canonical Foundry artifact. While functionally a `view` function can be called in a `pure` context in most tooling, this is a parity violation — the ABI must exactly match the deployed bytecode's declared mutability.

**Remediation:** Change `stateMutability: 'pure'` to `stateMutability: 'view'` for these three functions in `src/abis/option.ts`.

---

### GAP-1: `OptionModule` has no `reclaimCollateral` write wrapper

**Invariant:** INV-2  
**Severity:** Medium  
**File:line:** `src/modules/option.ts` (no `reclaimCollateral` method)  
**Description:** The ABI correctly exposes `reclaimCollateral(ownedOption)` as payable. The `RangerModule` correctly implements the fee-forwarding pattern. However, `OptionModule` has no `reclaimCollateral` write wrapper — callers must construct the call manually via the ABI. The spec says "for every option type" both `getSplitFee()→split()` and `getReclaimFee()→reclaimCollateral()` must be parity-guarded. The OptionModule gap means the fee-forwarding invariant is only enforced by convention.

**Remediation:** Add `async reclaimCollateral(optionAddress, ownedOption)` to `OptionModule` following the same pattern as `RangerModule.reclaimCollateral` (read fee, forward as `value`).

---

### GAP-2: `OptionBook.fillOrder` lacks zero-address implementation guard

**Invariant:** INV-9  
**Severity:** High  
**File:line:** `src/modules/optionBook.ts:368` (`fillOrder`)  
**Description:** The factory path (`requestForQuotation`, `encodeRequestForQuotation`) guards against zero-address implementations via `assertImplementationDeployed`. However, `OptionBook.fillOrder` passes the implementation from the API response directly into `buildContractOrder` without a zero-address check. If a rogue or misconfigured API returns `0x000...000` as the implementation, the SDK would generate calldata targeting the zero address.

**Remediation:** Add an `assertImplementationDeployed`-equivalent check in `fillOrder` and `encodeFillOrder` before building the contract order.

---

## Spec Compliance Method Map

One-line per module public method. `ABI` = has canonical ABI entry. `SDK-only` = no on-chain counterpart (pure helper).

### OptionFactoryModule (`src/modules/optionFactory.ts`)

| Method | ABI Entry | Status |
|--------|-----------|--------|
| `requestForQuotation` | `OptionFactory.requestForQuotation` | ✅ |
| `cancelQuotation` | `OptionFactory.cancelQuotation` | ✅ |
| `makeOfferForQuotation` | `OptionFactory.makeOfferForQuotation` | ✅ |
| `cancelOfferForQuotation` | `OptionFactory.cancelOfferForQuotation` | ✅ |
| `revealOffer` | `OptionFactory.revealOffer` | ✅ |
| `settleQuotation` | `OptionFactory.settleQuotation` | ✅ |
| `settleQuotationEarly` | `OptionFactory.settleQuotationEarly` | ✅ |
| `settleQuotationEarlyByOrderBook` | `OptionFactory.settleQuotationEarlyByOrderBook` | ✅ |
| `claimEscrowedFunds` | `OptionFactory.claimEscrowedFunds` | ✅ |
| `registerReferral` | `OptionFactory.registerReferral` | ✅ |
| `swapAndCall` | `OptionFactory.swapAndCall` | ✅ |
| `getQuotations` | `OptionFactory.quotations` | ✅ |
| `getEip712Domain` | `OptionFactory.eip712Domain` | ✅ |
| `buildRFQParams` | — | SDK-only builder |
| `buildRFQRequest` | — | SDK-only builder |
| `buildSpreadRFQ` | — | SDK-only builder |
| `buildButterflyRFQ` | — | SDK-only builder |
| `buildCondorRFQ` | — | SDK-only builder |
| `buildIronCondorRFQ` | — | SDK-only builder |
| `buildPhysicalOptionRFQ` | — | SDK-only builder |
| `encodeRequestForQuotation` | — | SDK-only encoder |

### OptionBookModule (`src/modules/optionBook.ts`)

| Method | ABI Entry | Status |
|--------|-----------|--------|
| `fillOrder` | `OptionBook.fillOrder` | ✅ |
| `swapAndFillOrder` | `OptionBook.swapAndFillOrder` | ✅ |
| `cancelOrder` | `OptionBook.cancelOrder` | ✅ |
| `cancelOrders` | `OptionBook.cancelOrders` | ✅ |
| `cancelOrdersExpiringBefore` | `OptionBook.cancelOrdersExpiringBefore` | ✅ |
| `claimFees` | `OptionBook.claimFees` | ✅ |
| `setReferrerFeeSplit` | `OptionBook.setReferrerFeeSplit` | ✅ |
| `getEip712Domain` | `OptionBook.eip712Domain` | ✅ |
| `getAmountFilled` | `OptionBook.amountFilled` | ✅ |
| `calculateNumContracts` | — | SDK-only helper |
| `previewFillOrder` | — | SDK-only helper |
| `encodeFillOrder` | — | SDK-only encoder |

### OptionModule (`src/modules/option.ts`)

| Method | ABI Entry | Status |
|--------|-----------|--------|
| `split` | `BaseOption.split` | ✅ (payable, fee-forwarded) |
| `close` | `BaseOption.close` | ✅ |
| `transfer` | `BaseOption.transfer` | ✅ |
| `approveTransfer` | `BaseOption.approveTransfer` | ✅ |
| `rescueERC20` | `BaseOption.rescueERC20` | ✅ |
| `getSplitFee` | `BaseOption.getSplitFee` | ✅ |
| `getReclaimFee` | `BaseOption.getReclaimFee` | ✅ |
| `reclaimCollateral` | `BaseOption.reclaimCollateral` | ⚠️ ABI only (no write wrapper — GAP-1) |

---

## Test File Index

| File | Command |
|------|---------|
| `tests/properties/invariants.test.ts` | `npm run test:properties` |
| `scripts/verify-abi-parity.ts` | `npm run verify:abi` |
