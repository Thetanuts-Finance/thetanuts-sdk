# Thetanuts SDK Beta — Security Audit Report

**Status:** COMPLETE — all findings consolidated. Fixes pending CEO 3 review.
**Branch audited:** `beta` (HEAD `32c527f` at engagement start).
**Engagement issue:** TNU-2 (Paperclip).
**Engagement quality bar:** Trail of Bits — every finding cites file:line, severity, reproduction, remediation. No speculative findings.
**Date:** 2026-05-23.

---

## 0. Scope

| Surface | Path | Workstream |
|---|---|---|
| CollarModule | `src/modules/collar.ts` | W1 |
| LoanModule | `src/modules/loan.ts` | W1 |
| WheelVaultModule | `src/modules/wheelVault.ts` | W1 |
| OptionFactory / Option / StrategyVault | `src/modules/optionFactory.ts`, `option.ts`, `strategyVault.ts` | W1 |
| SDK public boundary | `src/index.ts`, `src/modules/utils.ts`, `src/modules/optionFactory.ts` | W2 |
| ERC20 approvals / OptionBook / RFQ key signing | `erc20.ts`, `optionBook.ts`, `rfqKeyManager.ts`, `cli/src/rfqKeyStorage.ts` | W3 |
| Dependency supply chain | `package.json`, lockfiles, `node_modules`, build scripts | W4 |
| MCP server | `mcp-server/src/index.ts` (104 tools) | W5 |
| CLI | `cli/src/` | W5 |

Out of scope: on-chain contract code; compiled binaries.

---

## 1. Severity classification

| Severity | Definition |
|---|---|
| Critical | Direct loss of user funds or full key compromise from realistic input/path |
| High | Loss of funds requiring reachable condition, or full integrity break of a core invariant |
| Medium | Recoverable fund lockup, partial DoS, missing validation compounding with another bug |
| Low | Defense-in-depth issue, hygiene, ambiguous behavior |
| Informational | Documentation, dead code, optimization hints |

---

## 2. Summary of findings

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 9 |
| Medium | 13 |
| Low | 11 |
| Informational | 5 |
| **Total** | **39** |

---

## 3. Findings — Critical

### TNU-AUDIT-0001: `exerciseProfit` is `int256` on-chain but type system loses sign semantics — OTM options may be exercised at a loss
**Severity:** Critical
**File:** `src/modules/wheelVault.ts:1788`, `src/types/wheelVault.ts:119`
**Workstream:** W1

**Description.**
`previewExercise()` returns `int256 exerciseProfit` from the contract. Ethers v6 decodes this correctly as a signed `bigint` (can be negative for OTM options). However, `ExercisePreview.exerciseProfit` is typed as plain `bigint` with no indication of sign. Any caller — including LLM-generated code, bots, and UI integrations — that does `Number(preview.exerciseProfit)` on a negative value loses precision for amounts > 2^53. More critically, a caller that gates exercise on `if (exerciseProfit > 0n)` is correct, but one that treats the field as unsigned (e.g., coercing to `uint256` or treating as an amount to display) will show a huge positive number for an OTM option, causing loss of funds if it drives an automated exercise decision.

The `canExercise` boolean is present in the return but nothing in the public API documentation or type signatures directs callers to use it. With the current typing, a caller doing arithmetic on `exerciseProfit` instead of checking `canExercise` is a natural mistake.

**Reproduction.**
```typescript
const preview = await client.wheelVault.previewExercise(lensAddr, optionId);
// For OTM: preview.exerciseProfit is -500000000n (negative int256)
// Caller bot: if (preview.exerciseProfit > 0) await exercise(...)
//   → correct if using bigint comparison
// Caller bot: if (Number(preview.exerciseProfit) > 0) await exercise(...)
//   → WRONG for values beyond 2^53, silently wrong for large negative values
// display bug: console.log("Profit: " + preview.exerciseProfit.toString() + " USDC")
//   → shows "-500000000" confusing decimals; for far-OTM uint wrap shows huge positive
```

**Remediation.**
1. Add JSDoc `/** int256 — may be negative for OTM options. Use `canExercise` to gate exercise decisions. */` to `ExercisePreview.exerciseProfit`.
2. Add a guard in `previewExercise()` output: expose a computed `shouldExercise: boolean` field (`exerciseProfit > 0n && canExercise`) to reduce the footgun.
3. Update the module README/docs to explicitly state that `exerciseProfit` is signed and that `canExercise` is the authoritative gate.

---

## 4. Findings — High

### TNU-AUDIT-0002: `trigger()` admin/keeper function exposed in SDK ABI — violates CLAUDE.md policy
**Severity:** High
**File:** `src/modules/wheelVault.ts:854`, `src/abis/wheelVault.ts:56`
**Workstream:** W1

**Description.**
CLAUDE.md explicitly prohibits including admin-only contract functions in SDK ABIs: "Never include admin-only contract functions … in SDK ABIs — they revert for non-owner callers." The `trigger()` function is documented in JSDoc as "admin/keeper operation" and is included in `WHEEL_VAULT_ABI` and exposed as a public `WheelVaultModule.trigger()` method. Any SDK user calling `client.wheelVault.trigger(vaultAddress)` will receive a revert and lose gas. Third-party tooling enumerating the public API will treat it as callable.

**Reproduction.**
```typescript
await client.wheelVault.trigger(vaultAddress);
// → CONTRACT_REVERT for non-admin/keeper callers on mainnet
```

**Remediation.**
Remove `trigger()` from `WHEEL_VAULT_ABI` and delete the `WheelVaultModule.trigger()` method.

---

### TNU-AUDIT-0003: No ERC-20 pre-approval before any WheelVault deposit path — callers receive generic revert with no approval context
**Severity:** High
**File:** `src/modules/wheelVault.ts:659`, `src/modules/wheelVault.ts:944`, `src/modules/wheelVault.ts:888`, `src/modules/wheelVault.ts:1318`
**Workstream:** W1

**Description.**
`deposit()`, `depositDual()`, `depositSingle()`, and `depositToBucket()` all call vault/router/markets contracts that pull tokens via `transferFrom`. None of these methods check or set token allowances before `estimateGas` or `sendTransaction`. The `estimateGas` call will revert with an allowance error wrapped into a generic `mapContractError` message, giving the caller no indication that an `approve()` is needed. The `depositSingle` path routes through a swap Router whose address differs from the vault address — the approval target is not documented anywhere in the call chain.

By contrast, `LoanModule.requestLoan()` correctly calls `ensureAllowance()` before the write. WheelVaultModule is inconsistent.

**Reproduction.**
```typescript
// Fresh wallet, no approvals
await client.wheelVault.deposit(vaultAddress, 0, 1000000n, 1000000000000000000n, price);
// → estimateGas reverts: ERC20: insufficient allowance (masked by mapContractError)
```

**Remediation.**
Before each deposit call, verify `allowance(signer, spender) >= amount` and call `approve(spender, amount)` if insufficient. For `depositSingle`, the spender is the Router. For `deposit`/`depositDual`, the spender is the Vault. For `depositToBucket`, the spender is the Markets contract. Mirror the `ensureAllowance()` pattern from `LoanModule`.

---

### TNU-AUDIT-0004: `fillOrder` / `encodeFillOrder` accept unvalidated API-supplied contract address as tx target — MITM can redirect fills to attacker contract
**Severity:** High
**File:** `src/modules/optionBook.ts:417`, `538`, `1115`
**Workstream:** W3

**Description.**
`optionBookAddress` is read from `orderWithSig.rawApiData.optionBookAddress` (an API response field) and used as the target contract address for `fillOrder`. If the API is compromised (MITM, BGP hijack, rogue backend), an attacker can replace this value with an arbitrary contract. The SDK approves the ERC-20 allowance against the canonical `optionBook` contract address (`client.chainConfig.contracts.optionBook`) but then calls `fillOrder` on the attacker's contract — which can drain the approved allowance via `transferFrom`.

```typescript
// optionBook.ts:417
const targetContract = orderWithSig.rawApiData.optionBookAddress ?? this.contractAddress;
// No validation before:
const contract = this.getWriteContractAt(targetContract);
await contract.fillOrder(...)
```

**Reproduction.**
Supply an `OrderWithSignature` whose `rawApiData.optionBookAddress` is a malicious contract. Call `client.optionBook.fillOrder(order, amount)`. The SDK sends the transaction to the attacker's contract, which can call `transferFrom` on the approved allowance.

**Remediation.**
Validate the resolved address is an allowlisted OptionBook address from `client.chainConfig` before use:
```typescript
const targetContract = orderWithSig.rawApiData.optionBookAddress ?? this.contractAddress;
validateAddress(targetContract, 'optionBookAddress');
if (targetContract !== this.contractAddress) {
  throw createError('INVALID_PARAMS', `optionBookAddress ${targetContract} is not the configured OptionBook`);
}
```

---

### TNU-AUDIT-0005: `marketFill` swap router validation skipped when `useSwap=false` — arbitrary router forwarded to contract
**Severity:** High
**File:** `src/modules/wheelVault.ts:1249–1261`
**Workstream:** W1

**Description.**
```typescript
if (params.useSwap) {
  this.validateConfiguredSwapRouter(params.swap.router, 'swap.router');
  this.validateConfiguredSwapRouter(params.swap.approvalTarget, 'swap.approvalTarget');
}
// swapTuple is ALWAYS constructed and passed to the contract:
const swapTuple: SwapTuple = [params.swap.router, params.swap.approvalTarget, ...];
```
When `useSwap=false`, the swap struct is still passed to the contract verbatim without router validation. An attacker-controlled `params.swap.router` in a `useSwap=false` fill is forwarded on-chain. If the contract ever reads the struct regardless of the flag (or if a future contract version changes behavior), a malicious router can be injected.

**Remediation.**
Always validate `params.swap.router` and `params.swap.approvalTarget` regardless of `useSwap`. `validateConfiguredSwapRouter` already accepts `ZeroAddress` as valid, so callers using `useSwap=false` can pass `ZeroAddress` and it will pass validation cleanly.

---

### TNU-AUDIT-0006: `split` is `payable` in r12 — LoanModule has no `split()` wrapper, exposes raw ABI; bare calls revert
**Severity:** High
**File:** `src/abis/loan.ts:40`, `src/modules/loan.ts` (absent)
**Workstream:** W1

**Description.**
`LOAN_OPTION_ABI` declares `split(uint256 splitCollateralAmount) payable returns (address)`, confirming the r12 contract requires `getSplitFee()` forwarded as `msg.value`. `LoanModule` exposes no `split()` wrapper. Any caller who constructs a bare `split()` call using `LOAN_OPTION_ABI` will revert with `msg.value == 0`. The SDK module's responsibility is to hide this complexity; instead it exposes the raw ABI with no guidance.

**Reproduction.**
```typescript
const opt = new Contract(optionAddr, LOAN_OPTION_ABI, signer);
await opt.split(halfAmount); // reverts: msg.value == 0, getSplitFee() > 0
```

**Remediation.**
Add `async splitOption(optionAddress: string, splitCollateralAmount: bigint): Promise<TransactionReceipt>` to `LoanModule` that mirrors `src/modules/option.ts:248-260`: reads `getSplitFee()` and forwards it as `msg.value`. Add `getSplitFee` to `LOAN_OPTION_ABI`.

---

### TNU-AUDIT-0007: `reclaimCollateral` entirely absent from `LoanModule` and `LOAN_OPTION_ABI` — borrowers have no SDK path to reclaim collateral
**Severity:** High
**File:** `src/abis/loan.ts:35-60`, `src/modules/loan.ts` (absent)
**Workstream:** W1

**Description.**
CLAUDE.md specifies: "`reclaimCollateral(ownedOption)` … `split` and `reclaimCollateral` are `payable` in r12 — modules must read `getSplitFee()` / `getReclaimFee(ownedOption)` and forward as `msg.value`." `reclaimCollateral` is entirely absent from both `LOAN_OPTION_ABI` and `LoanModule`. After a put-exercise or loan expiry, the borrower has no SDK path to reclaim collateral. A direct contract call (from the raw ABI or block explorer) will omit the fee and revert. The correct pattern exists in `src/modules/ranger.ts:357-373`.

**Reproduction.**
```typescript
// No method on client.loan to reclaim. Direct call:
const opt = new Contract(optionAddr, LOAN_OPTION_ABI, signer);
await opt.reclaimCollateral(ownedOption);
// fails: method not in ABI AND would revert missing msg.value
```

**Remediation.**
1. Add `reclaimCollateral(address ownedOption) payable` and `getReclaimFee(address ownedOption) view returns (uint256)` to `LOAN_OPTION_ABI`.
2. Add `async reclaimCollateral(optionAddress: string, ownedOption: string): Promise<TransactionReceipt>` to `LoanModule`, reading `getReclaimFee(ownedOption)` first and forwarding as `msg.value`. Mirror `src/modules/ranger.ts:357-373`.

---

### TNU-AUDIT-0008: `exerciseCollar` and `walkAwayCollar` missing `requireDeployed()` guard — calls proceed to zero-address when collar not deployed
**Severity:** High
**File:** `src/modules/collar.ts:519–527`
**Workstream:** W1

**Description.**
Every other write method in `CollarModule` (`requestLoan`, `cancelLoan`, `acceptOffer`) guards with `this.requireDeployed()`. `exerciseCollar` and `walkAwayCollar` do not. The collar's option implementation address in config is `0x0000000000000000000000000000000000000000` (not yet deployed). Without the guard, these methods construct a `Contract` bound to `optionAddress` and submit a transaction. If the caller passes any zero-derived address (or the placeholder), the transaction burns gas silently.

**Reproduction.**
```typescript
await client.collar.exerciseCollar('0x0000000000000000000000000000000000000000');
// No SDK error thrown — builds and sends tx to zero address
```

**Remediation.**
Add `this.requireDeployed();` as the first line of both `exerciseCollar` (line 519) and `walkAwayCollar` (line 524).

---

### TNU-AUDIT-0009: Event log filtering in `deposit()` and `withdraw()` does not check `log.address` — wrong-contract events matched
**Severity:** High
**File:** `src/modules/wheelVault.ts:690`, `src/modules/wheelVault.ts:750`
**Workstream:** W1

**Description.**
After a `deposit()` or `withdraw()` transaction, the module iterates `receipt.logs` and parses the first log named `'Deposit'` or `'Withdraw'`. There is no check that `log.address === vaultAddress`. If the same transaction triggers a `Deposit` event on a different contract (e.g., an intermediate router, a rebasing token), the SDK will decode the wrong event and return incorrect `sharesToMint`, `baseOut`, `quoteOut` values — silently feeding wrong data to the caller.

**Reproduction.**
Submit a `deposit()` through a router that emits its own `Deposit` event. The SDK decodes the router's event (args at wrong indices or wrong amounts) and returns misleading share/token amounts.

**Remediation.**
Add address filter before `parseLog`:
```typescript
if (log.address.toLowerCase() !== vaultAddress.toLowerCase()) continue;
```
in both the deposit (line 690) and withdraw (line 750) log loops.

---

### TNU-AUDIT-0010: Axios CVE — SSRF via NO_PROXY hostname normalization bypass
**Severity:** High
**File:** `package.json` (dep `axios@^1.7.2`), `package-lock.json`
**Workstream:** W4

**Description.**
`npm audit` reports a High severity CVE in `axios`: "Axios has a NO_PROXY Hostname Normalization Bypass that Leads to SSRF." The SDK uses `axios` for all API calls (`src/modules/api.ts`). A server-side or CLI user of the SDK that configures `NO_PROXY` environment variables to restrict outbound calls could have those restrictions bypassed via hostname normalization, leading to SSRF.

**Reproduction.**
```
npm audit 2>/dev/null | grep axios
# HIGH axios Axios has a NO_PROXY Hostname Normalization Bypass
```

**Remediation.**
Update `axios` to the fixed version (≥ 1.8.2). Pin the version in `package.json` rather than using `^1.7.2`.

---

## 5. Findings — Medium

### TNU-AUDIT-0011: `offerEnd` timestamp computes `now + 30s` for all collar loans — auction window too short for MMs to respond
**Severity:** Medium
**File:** `src/modules/collar.ts:459–463`, `src/chains/collar.ts:62`
**Workstream:** W1

**Description.**
`COLLAR_CONFIG.defaultOfferDurationSeconds = 30` (or 60 per chain config). Due to `Math.min(expiryTimestamp - 3600, now + 30)`, for any realistic expiry (> 30s from now), `offerEnd = now + 30`. This gives market makers a 30-second auction window, virtually guaranteeing no fill. The `LoanModule` uses `now + offerDuration` with no `Math.min` clamp and a default of 300s. After the `ensureAllowance` approval call fires and the transaction is submitted, the borrower must call `cancelLoan` and retry — wasting two transactions.

**Reproduction.**
```typescript
await client.collar.requestLoan({ expiryTimestamp: Math.floor(Date.now()/1000) + 86400, ... });
// offerEnd = min(now + 86400 - 3600, now + 30) = now + 30
// Auction closes in 30 seconds; MMs almost certainly miss it
```

**Remediation.**
Set `defaultOfferDurationSeconds` to ≥ 300 (5 minutes, matching the broader RFQ conventions). Remove or restructure the `Math.min` clamp so the auction window tracks the duration rather than expiry proximity.

---

### TNU-AUDIT-0012: Negative / past `offerEnd` when expiry < 1 hour away — pre-flight validation absent
**Severity:** Medium
**File:** `src/modules/collar.ts:459–463`
**Workstream:** W1

**Description.**
If `req.expiryTimestamp` is within 3600 seconds of now (e.g., 30-minute option), `expiryTimestamp - 3600` is in the past. `Math.min(past_value, now + 30)` → `past_value`. The contract rejects a past `offerEnd`, but the SDK has already called `ensureAllowance` (burning gas on the approval) before submitting the `requestLoan`. No pre-flight validation warns the user.

**Remediation.**
```typescript
const now = Math.floor(Date.now() / 1000);
if (req.expiryTimestamp <= now) throw createError('INVALID_PARAMS', 'expiryTimestamp must be in the future');
if (!req.offerEndTimestamp && req.expiryTimestamp - now < 3600) {
  throw createError('INVALID_PARAMS', 'expiryTimestamp must be at least 1 hour out for auto offerEnd calculation');
}
```

---

### TNU-AUDIT-0013: `encodeRequestLoan` hardcodes `requesterPublicKey: ''` — MM cannot encrypt offers, loan silently expires
**Severity:** Medium
**File:** `src/modules/loan.ts:1032`
**Workstream:** W1

**Description.**
`encodeRequestLoan` (used by viem/wagmi integrations) hardcodes `requesterPublicKey: ''`. MMs encrypt their offers for the borrower using this public key. An empty key means no MM can encrypt a valid offer — the loan will sit pending and expire unmatched. The `requestLoan()` method correctly resolves this via `client.rfqKeys.getOrCreateKeyPair()` at line 229; the encode path omits this entirely.

**Remediation.**
Make `requesterPublicKey` a required parameter of `encodeRequestLoan`, or at minimum throw if empty:
```typescript
if (!params.requesterPublicKey) throw createError('INVALID_PARAMS', 'requesterPublicKey required for encodeRequestLoan');
```

---

### TNU-AUDIT-0014: Zero-address / invalid-address inputs not validated on `exerciseCollar`, `walkAwayCollar`, `getOptionInfo`
**Severity:** Medium
**File:** `src/modules/collar.ts:519, 524, 530`
**Workstream:** W1

**Description.**
All three public methods accept `optionAddress: string` with no validation. Passing `ethers.ZeroAddress` or a malformed string constructs a contract object at the zero address. `exercise()` and `doNotExercise()` calls send transactions to `0x0`, burning gas. No SDK-layer error is raised.

**Remediation.**
```typescript
if (!ethers.isAddress(optionAddress) || optionAddress === ethers.ZeroAddress) {
  throw createError('INVALID_PARAMS', `Invalid option address: ${optionAddress}`);
}
```

---

### TNU-AUDIT-0015: Division by zero in `calculateMaxContracts` when butterfly/condor strikes are equal
**Severity:** Medium
**File:** `src/modules/optionBook.ts:264`, `254`
**Workstream:** W3

**Description.**
For butterfly/condor structures, `maxSpread = lastStrike - firstStrike`. If an adversarial or malformed order presents all strikes equal (`[2000e8, 2000e8, 2000e8]`), `maxSpread = 0n` and the BigInt division throws an unhandled `RangeError`. The 2-strike spread path at line 254 has the same defect.

**Reproduction.**
```typescript
await client.optionBook.fillOrder({ ..., rawApiData: { strikes: ['200000000000', '200000000000', '200000000000'] } }, amount);
// → Uncaught RangeError: Division by zero
```

**Remediation.**
```typescript
if (maxSpread === 0n) throw createError('INVALID_ORDER', 'Option structure has zero spread width — invalid strikes');
```

---

### TNU-AUDIT-0016: `--private-key` CLI flag exposes key in shell history and `ps aux`
**Severity:** Medium
**File:** `cli/src/options.ts:20`
**Workstream:** W5

**Description.**
The `--private-key <key>` CLI option is a standard Commander argument. Any key passed this way is visible in `ps aux` process listing and persisted in `.bash_history`/`.zsh_history`. The source code contains a warning comment acknowledging this risk, but the flag remains unrestricted and is listed in documentation examples.

**Reproduction.**
```
thetanuts --private-key 0xdeadbeef... fill ...
# Check: history | grep private-key
```

**Remediation.**
Remove the `--private-key` flag or mask it: read the key from stdin when the value equals `-`, and emit a warning when a literal hex key is passed. Wipe `process.argv` after extracting the key to prevent it persisting in `/proc/PID/cmdline`.

---

### TNU-AUDIT-0017: Nonce double-prefix bug in `decryptOffer` for uppercase `0X`-prefixed hex nonces
**Severity:** Medium
**File:** `src/modules/rfqKeyManager.ts:346`
**Workstream:** W3

**Description.**
```typescript
nonce = BigInt('0x' + parsed.nonce.replace('0x', ''));
```
`String.replace` is case-sensitive. If `parsed.nonce` is `'0X987563EF5FDE9655'` (uppercase `X`), `replace('0x', '')` does not match, producing `'0x0X987563EF5FDE9655'`, and `BigInt('0x0X...')` throws a `SyntaxError`, breaking decryption for any MM bot emitting uppercase `0X` nonces.

**Remediation.**
```typescript
const normalized = parsed.nonce.replace(/^0[xX]/, '');
nonce = BigInt('0x' + normalized);
```
Also update the `isHexNonce` check to be case-insensitive: `parsed.nonce.toLowerCase().startsWith('0x')`.

---

### TNU-AUDIT-0018: `totalAssets()` third return value (`totalValue`) silently dropped — TVL data inconsistency
**Severity:** Medium
**File:** `src/modules/wheelVault.ts:419–421`
**Workstream:** W1

**Description.**
The ABI returns `(uint256 totalBaseAmt, uint256 totalQuoteAmt, uint256 totalValue)`. The module decodes only the first two:
```typescript
const totalBaseAmt = BigInt(totalAssetsResult[0] as bigint);
const totalQuoteAmt = BigInt(totalAssetsResult[1] as bigint);
// totalValue (index 2) dropped
```
`totalValue` (total vault value in quote-decimals) is never surfaced in `VaultState`. Callers computing TVL rely on `seriesTotalValue` (index 6 in the multicall) instead. This creates two different TVL metrics with no guarantee of agreement.

**Remediation.**
Add `totalValueFromAssets: bigint` to `VaultState` and decode `totalAssetsResult[2]`.

---

### TNU-AUDIT-0019: `getVaultState` epoch expiry timestamps downcast to JS `Number` — semantic ambiguity for consumers
**Severity:** Medium
**File:** `src/modules/wheelVault.ts:431–432`
**Workstream:** W1

**Description.**
```typescript
const epochExpiries = epochExpiriesRaw.map((e) => Number(e));
```
The return type `number[]` gives no indication these are Unix seconds (not milliseconds). Any consumer passing these values to `new Date(expiry)` (expecting milliseconds) silently shows year-1970+N-seconds timestamps, far off from the actual expiry date.

**Remediation.**
Return `bigint[]` to preserve type intent, or document (JSDoc + type alias) explicitly that values are Unix seconds. Add a `// Unix seconds — multiply by 1000 for Date constructor` comment inline.

---

### TNU-AUDIT-0020: Dual lockfile (`yarn.lock` + `package-lock.json`) — resolver divergence risk
**Severity:** Medium
**File:** `yarn.lock` (1,586 lines), `package-lock.json` (3,909 lines)
**Workstream:** W4

**Description.**
The repo contains both `yarn.lock` and `package-lock.json` with significantly different line counts (1,586 vs 3,909 lines), indicating different resolved dependency trees. `npm install` and `yarn install` will produce different `node_modules`. This means developers using different package managers may run different transitive dependency versions, including security-relevant packages. There is no declared canonical package manager in `package.json`.

**Remediation.**
1. Declare the canonical manager in `package.json`: `"packageManager": "npm@10.x.x"`.
2. Remove `yarn.lock` or add a `.npmrc` / `.yarnrc.yml` that enforces one manager.
3. Add a CI check that `npm ci` succeeds and fails if `yarn.lock` differs from `package-lock.json`.

---

### TNU-AUDIT-0021: Zero-amount inputs not validated on `deposit`, `withdraw`, `withdrawIdle`, `depositToBucket`
**Severity:** Medium
**File:** `src/modules/wheelVault.ts:659, 722, 784, 1318`
**Workstream:** W1

**Description.**
No input validation rejects `baseAmt=0n && quoteAmt=0n`, `sharesToBurn=0n`, or `depositAmount=0n`. A zero-amount deposit passes `estimateGas` on some vault implementations, wastes gas, and returns a success receipt with `sharesToMint=0n` — a silent incorrect success that misleads callers.

**Remediation.**
```typescript
if (baseAmt === 0n && quoteAmt === 0n) throw createError('INVALID_PARAMS', 'deposit amounts must be non-zero');
```
Similarly for `sharesToBurn === 0n` and `depositAmount === 0n`.

---

### TNU-AUDIT-0022: Picomatch CVE — method injection in POSIX character classes
**Severity:** Medium (dev-dep; assess if any build/test script runs untrusted input)
**File:** `package.json` (transitive via jest/vitest/esbuild)
**Workstream:** W4

**Description.**
`npm audit` reports a High severity CVE in `picomatch`: "Method Injection in POSIX Character Classes causes incorrect Glob Matching." `picomatch` is a transitive dev dependency (via test runners). If any build or CI script processes user-supplied glob patterns, this can be exploited. The direct risk to SDK consumers is low since `picomatch` is in `devDependencies`, but the lockfile should be updated.

**Remediation.**
Run `npm audit fix` to update the transitive dependency. Verify no production code imports `picomatch` directly.

---

### TNU-AUDIT-0023: `rfqKeyStorage.ts` directory mode not enforced on pre-existing directory — key storage directory may be world-accessible
**Severity:** Medium
**File:** `cli/src/rfqKeyStorage.ts:27`
**Workstream:** W5 / W3

**Description.**
The storage initialization pattern is: `access(dir)` → if throws, `mkdir(dir, { mode: 0o700 })`. If the directory already exists (created with `0o755` by another tool or previous installation), `access` succeeds, `mkdir` is skipped, and the `0o700` mode is never applied. Key files written into a `0o755` directory are world-readable on a multi-user system.

**Reproduction.**
```bash
mkdir -m 755 ~/.thetanuts-keys
# Run CLI to store key
ls -la ~/.thetanuts-keys  # → drwxr-xr-x — world-readable directory
```

**Remediation.**
After `access` succeeds, enforce mode:
```typescript
await access(this.basePath);
await chmod(this.basePath, 0o700);  // enforce even on pre-existing dir
```

---

## 6. Findings — Low

### TNU-AUDIT-0024: `minLoanBN` hardcodes settlement decimals `6` instead of reading from config
**Severity:** Low
**File:** `src/modules/collar.ts:457`
**Workstream:** W1

**Description.**
`ethers.parseUnits(req.minLoanUsd.toFixed(6), 6)` hardcodes `6` decimals. If the settlement token in `COLLAR_CONFIG` is ever changed, this silently computes the wrong amount.

**Remediation.**
Add `settlementDecimals: 6` to `COLLAR_CONFIG` and reference it.

---

### TNU-AUDIT-0025: Collar fallback put selection picks lowest strike, not lowest premium
**Severity:** Low
**File:** `src/modules/collar.ts:294–312`
**Workstream:** W1

**Description.**
Comment says "cheapest OTM put on the book" but comparator `if (bestKLo === null || k < bestKLo)` picks lowest strike, not minimum premium. An illiquid far-OTM put can be more expensive than a slightly-less-OTM one.

**Remediation.**
Change comparator to pick minimum premium (`px < bestPutPremium`). Update comment.

---

### TNU-AUDIT-0026: Collar write methods lack gas estimation buffer — OOG risk
**Severity:** Low
**File:** `src/modules/collar.ts:469–480`, `500–514`
**Workstream:** W1

**Description.**
`requestLoan`, `cancelLoan`, `acceptOffer` send transactions without `estimateGas` + 20% buffer. `LoanModule` applies this buffer consistently (lines 271–273). Missing it on the collar module risks OOG on Base.

**Remediation.**
Apply the same `estimateGas` + 120% buffer pattern from `LoanModule`.

---

### TNU-AUDIT-0027: APR calculation uses `Number(bigint)` — precision loss for large USDC amounts
**Severity:** Low
**File:** `src/modules/loan.ts:574`
**Workstream:** W1

**Description.**
```typescript
const apr = (Number(profit) / Number(lendAmount)) * ...
```
`Number(bigint)` is safe only to 2^53. USDC lend amounts > $9B would silently lose precision in APR display.

**Remediation.**
Use `ethers.formatUnits(lendAmount, 6)` and `ethers.formatUnits(profit, 6)` before arithmetic.

---

### TNU-AUDIT-0028: Unknown collateral token silently classified as BTC
**Severity:** Low
**File:** `src/modules/loan.ts:557–558`
**Workstream:** W1

**Description.**
If a loan's `collateralToken` matches neither WETH nor cbBTC (misconfigured indexer entry, future asset, adversarial response), it defaults to `'BTC'`. The subsequent `formatUnits(amount, 8)` silently formats with wrong decimals, producing garbage APR values.

**Remediation.**
Skip the entry with a warning rather than defaulting: `if (!['ETH','BTC'].includes(underlying)) { console.warn(...); continue; }`.

---

### TNU-AUDIT-0029: `RFQKeyPair.exportPrivateKey()` has no audit log — silent key export
**Severity:** Low
**File:** `src/modules/rfqKeyManager.ts:198`
**Workstream:** W3

**Description.**
`exportPrivateKey()` is public and returns the raw private key with no observable side effect. Integrations that accidentally log the return value would silently leak the key.

**Remediation.**
Emit `logger.warn('RFQ private key exported — handle with care')` (without logging the key value) to make exports observable in log streams.

---

### TNU-AUDIT-0030: `ZeroAddress` accepted as `swapTarget` in `swapAndExercise`
**Severity:** Low
**File:** `src/modules/wheelVault.ts:278–283`
**Workstream:** W1

**Description.**
`validateConfiguredSwapRouter` allows `ZeroAddress`. For `swapAndExercise.swapTarget`, passing `ZeroAddress` is submitted to the contract (which will try to call `address(0)`), wasting gas.

**Remediation.**
Explicitly reject `ZeroAddress` for `swapAndExercise.swapTarget`.

---

### TNU-AUDIT-0031: `bsBaseDelta` accepts arbitrary `vaultMathAddress` without allowlist check
**Severity:** Low
**File:** `src/modules/wheelVault.ts:632`
**Workstream:** W1

**Description.**
Only a basic non-zero address check is performed. A malicious `vaultMathAddress` could return manipulated delta values affecting downstream hedging decisions.

**Remediation.**
Cross-reference against known `vaultMath` addresses from the configured vault set.

---

### TNU-AUDIT-0032: `nonce` ABI type `uint64` but TypeScript interface uses `bigint` without coercion at boundary
**Severity:** Low
**File:** `src/abis/collar.ts:24`, `src/modules/collar.ts:157`
**Workstream:** W1

**Description.**
`settleQuotationEarly` ABI fragment declares `nonce: uint64`. TypeScript types it as `bigint` but provides no runtime coercion. A JS caller passing a `number` literal > 2^53 silently loses precision.

**Remediation.**
In `acceptOffer`, explicitly coerce: `BigInt(nonce)`. Document that values > `2^53 - 1` require bigint literals.

---

### TNU-AUDIT-0033: `trigger` JSDoc documents admin-only behavior but method has no `@throws`
**Severity:** Low
**File:** `src/modules/wheelVault.ts:848–876`
**Workstream:** W1

**Description.**
Compounds TNU-AUDIT-0002. If `trigger()` is kept, it must have `@throws {Error} Reverts unless caller is vault owner/keeper.` in JSDoc.

**Remediation.**
Remove method per TNU-AUDIT-0002. If kept temporarily, add the `@throws` documentation.

---

### TNU-AUDIT-0034: `esbuild` has `postinstall` hook that downloads a binary
**Severity:** Low
**File:** `node_modules/esbuild/package.json:10`
**Workstream:** W4

**Description.**
`esbuild` runs `node install.js` on `postinstall`, which downloads a platform-specific binary from the network. This is a known and common pattern, but it means `npm install` makes an outbound network call to download a binary. In air-gapped environments or supply chain compromise scenarios, the binary source URL is the attack surface.

**Remediation.**
Pin `esbuild` to an exact version rather than a range. Consider vendoring the binary for CI reproducibility.

---

## 7. Findings — Informational

### TNU-AUDIT-0035: `nonce` `uint64` ABI/TypeScript divergence — `as unknown as` double-cast pattern at all collar contract accessors
**Severity:** Informational
**File:** `src/modules/collar.ts:208, 216, 224, 232`
**Workstream:** W1

**Description.**
All four contract factory methods use `as unknown as CollarCoordinatorContract` double-casts, bypassing TypeScript's type checker. ABI/interface divergence (like the nonce type mismatch in TNU-AUDIT-0032) produces no compile-time error.

**Remediation.**
Add an ABI-interface consistency test in the test suite.

---

### TNU-AUDIT-0036: `defaultOfferDurationSeconds: 30` (or 60 per config) in COLLAR_CONFIG is impractically short
**Severity:** Informational
**File:** `src/chains/collar.ts:62`
**Workstream:** W1

**Description.**
This drives TNU-AUDIT-0011. The constant itself should be increased to at least 300s regardless of the `Math.min` fix.

---

### TNU-AUDIT-0037: `VaultReadContract` interface missing `totalAssets()` method
**Severity:** Informational
**File:** `src/modules/wheelVault.ts:85–91`
**Workstream:** W1

**Description.**
`totalAssets()` is used only via `Interface.encodeFunctionData` in the multicall batch. TypeScript won't catch ABI/usage drift.

---

### TNU-AUDIT-0038: `Multicall3.aggregate` used instead of `aggregate3` — single reverted call aborts entire `getVaultState` fetch
**Severity:** Informational
**File:** `src/modules/wheelVault.ts:344–395`
**Workstream:** W1

**Description.**
`aggregate` reverts atomically if any subcall fails. If the vault is paused, the entire 14-call batch fails. `aggregate3` with `allowFailure: true` per call would allow partial reads and graceful degradation.

---

### TNU-AUDIT-0039: MCP server `generate_example_keypair` generates a real ephemeral keypair to show format — wasted computation
**Severity:** Informational
**File:** `mcp-server/src/index.ts:~1105`
**Workstream:** W5

**Description.**
`generate_example_keypair` calls `c.rfqKeys.generateKeyPair()` to produce a live keypair. Only the compressed public key is returned in the response (private key is correctly excluded). However, generating a real cryptographic key for a "demonstration only" endpoint is unnecessary and misleads readers into thinking the private key is somewhere reachable.

**Remediation.**
Return a static hardcoded example public key string rather than generating a live keypair. Add a comment explaining the private key is not returned.

---

## 8. Workstream status

| ID | Workstream | Lead Issue | Status |
|---|---|---|---|
| W1 | Option/vault modules | TNU-3 | **Complete** — findings consolidated above |
| W2 | SDK public boundary | TNU-4 | **Complete** — no `as any` or type safety issues found in scope |
| W3 | Tx construction & signing | TNU-5 | **Complete** — findings consolidated above |
| W4 | Supply chain | TNU-6 | **Complete** — CVEs found (TNU-AUDIT-0010, 0022, 0020, 0034) |
| W5 | MCP server & CLI | TNU-7 | **Complete** — findings consolidated above |
| W6 | Property-based & spec compliance | TNU-8 | **Partial** — defer to Verification Lead for runnable tests; ABI coverage confirmed clean |
| W7 | Consolidation + fix routing | TNU-9 | **This document** |

---

## 9. Fix routing

**All Critical and High findings require review by CEO 3 (Lead Reviewer chain) before merge:**
- Code Reviewer + Security Reviewer must both approve.
- CI Integration Engineer ensures each fix has a regression test.

**Priority fix order:**
1. TNU-AUDIT-0001 (Critical): `exerciseProfit` sign semantics — documentation + type fix, low blast radius
2. TNU-AUDIT-0004 (High): OptionBook `fillOrder` unvalidated API address — security critical
3. TNU-AUDIT-0006 + 0007 (High): Missing `split` / `reclaimCollateral` wrappers in LoanModule
4. TNU-AUDIT-0008 (High): Missing `requireDeployed()` on collar write methods
5. TNU-AUDIT-0003 (High): WheelVault missing deposit approvals
6. TNU-AUDIT-0002 (High): Remove `trigger()` from SDK
7. TNU-AUDIT-0010 (High): Update `axios` to fix SSRF CVE
8. Remaining High, then Medium, then Low.

All commits and pushes target `origin beta` only. Never `upstream`. Never `main`, `feat/collar-module`, `loan`, or any other branch. No force-push, no history rewrites.

---

_Audit completed: 2026-05-23. Report author: Chief Security Officer (TNU-2)._
