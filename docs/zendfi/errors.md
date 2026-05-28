# Zendfi error reference

Every recoverable error thrown by `client.loan` and `client.collar` is a typed [`ZendfiError`](../../src/types/zendfi-errors.ts) carrying a stable `code`, a user-facing `humanMessage`, an `actionable` recovery hint, optional `docsUrl` and `meta`, and the underlying `cause` (when one exists).

Narrow with the `isZendfiError` guard, then `switch` on `err.code`:

```typescript
import { isZendfiError } from '@thetanuts-finance/thetanuts-client';

try {
  await client.collar.requestLoan(req);
} catch (err) {
  if (!isZendfiError(err)) throw err;
  switch (err.code) {
    case 'PRICING_ONLY_MODE': /* ... */ break;
    // ... exhaustive
  }
}
```

The sections below are ordered by the `ZendfiErrorCode` union in `src/types/zendfi-errors.ts`. Field names match `ZendfiErrorShape`.

---

## PRICING_ONLY_MODE

- **Code:** `PRICING_ONLY_MODE`
- **`humanMessage`:** *Collar contract isn't deployed on this chain yet; pricing-only mode active.*
- **`actionable`:** *Use `client.collar.quickQuote()` for quotes, or wait for the collar-v12 deploy before calling `<operation>`.*

**Common causes**
- Calling a collar write method (`requestLoan`, `cancelLoan`, `acceptOffer`, `exerciseCollar`, `walkAwayCollar`, `getLoanRequest`) on a chain where `COLLAR_CONFIG.contracts.collarCoordinator` is still the zero placeholder.

**Recovery snippet**

```typescript
if (client.collar.isWriteEnabled()) {
  await client.collar.requestLoan(req);
} else {
  const cap = client.collar.capability();
  showBanner(`Collar not yet live on chain ${cap.chainId}`, { missing: cap.missingContracts });
}
```

See [pricing-only-mode.md](./pricing-only-mode.md) for the full deployment-gate story.

---

## PRICING_UNAVAILABLE

- **Code:** `PRICING_UNAVAILABLE`
- **`humanMessage`:** *No live pricing data for `<asset>`.*
- **`actionable`:** *Retry shortly — the Deribit feed is empty or stale for this asset. Persistent failures usually mean the upstream pricing service is down.*

**Common causes**
- Transient outage of `pricing.thetanuts.finance/all`.
- Network errors from the SDK's `fetch` call (DNS, TLS, captive portal).
- The feed returned an unexpected shape (no `data` field).

**Recovery snippet**

```typescript
async function safeQuickQuote(client, underlying, n, cap, expiry) {
  for (let i = 0; i < 3; i++) {
    try { return await client.collar.quickQuote(underlying, n, cap, expiry); }
    catch (err) {
      if (isZendfiError(err) && err.code === 'PRICING_UNAVAILABLE') {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        continue;
      }
      throw err;
    }
  }
  throw new Error('pricing unavailable after 3 retries');
}
```

---

## NO_MATCHING_STRIKE

- **Code:** `NO_MATCHING_STRIKE`
- **`humanMessage`:** *No OTM put strike matches a cap of `$<capUsd>`.*
- **`actionable`:** *Pick a cap from the available strikes (closest: `<list>`) or choose a later expiry.*

**Common causes**
- The Deribit chain has no OTM put listing at the requested expiry.
- The call premium at `capUsd` is too small to cover any available put ask.
- Very deep OTM caps with no matching put on the book.

**Recovery snippet**

```typescript
try {
  return await client.collar.quickQuote('BTC', 0.5, 200000, '26DEC25');
} catch (err) {
  if (isZendfiError(err) && err.code === 'NO_MATCHING_STRIKE') {
    const candidates = err.meta?.availableStrikes as number[] | undefined;
    return client.collar.quickQuote('BTC', 0.5, candidates?.[0] ?? 150000, '26DEC25');
  }
  throw err;
}
```

---

## CAP_ABOVE_MAX

- **Code:** `CAP_ABOVE_MAX`
- **`humanMessage`:** *Cap `$<capUsd>` exceeds the maximum supported cap of `$<maxCapUsd>`.*
- **`actionable`:** *Lower the cap to at most `$<maxCapUsd>`, or call `client.collar.getMaxCapStrike()` to discover the current ceiling before quoting.*

**Common causes**
- Caller built a UI off cached config that doesn't reflect the coordinator's latest ceiling.
- A power user typed a cap above the on-chain max directly into a free-form input.

**Recovery snippet**

```typescript
const max = await client.collar.getMaxCapStrike('BTC');
if (max !== null) {
  const ceiling = Number(max) / 10n ** BigInt(client.collar.config.strikeDecimals);
  setMaxCapInUi(ceiling);
}
```

---

## EXPIRY_IN_PAST

- **Code:** `EXPIRY_IN_PAST`
- **`humanMessage`:** *Requested expiry is in the past.*
- **`actionable`:** *Pick an expiry at least one hour after the current block timestamp.*

**Common causes**
- Stale UI state — a user picked an expiry that ticked into the past while the page sat idle.
- Time-zone bug at the caller: passing milliseconds instead of seconds, or local time instead of UTC.

**Recovery snippet**

```typescript
const safeExpiry = Math.max(req.expiryTimestamp, Math.floor(Date.now() / 1000) + 3600);
```

---

## EXPIRY_TOO_SOON

- **Code:** `EXPIRY_TOO_SOON`
- **`humanMessage`:** *Requested expiry is too close to the default offer window.*
- **`actionable`:** *Either push the expiry past `<minOfferEnd ISO>`, or pass an explicit shorter `offerEnd`.*

**Common causes**
- `expiryTimestamp - now < 3600s` and the caller didn't pass an explicit `offerEndTimestamp`.

**Recovery snippet**

```typescript
const offerEnd = req.expiryTimestamp - 60; // one-minute window before expiry
await client.collar.requestLoan({ ...req, offerEndTimestamp: offerEnd });
```

---

## INVALID_CAP

- **Code:** `INVALID_CAP`
- **`humanMessage`:** *Cap value `$<capUsd>` is invalid (must be > 0).*
- **`actionable`:** *Pass a positive USD cap. For pricing-only flows you can sweep multiple caps via `client.collar.getCapStrikeOptions()`.*

**Common causes**
- Empty/zero input passed straight from a form without validation.
- Sentinel values (e.g. `-1`) leaking into the call site.

**Recovery snippet**

```typescript
if (capUsd <= 0) {
  const groups = await client.collar.getCapStrikeOptions('BTC', settings);
  capUsd = groups[0]?.caps[0]?.cap ?? 150000;
}
```

---

## INVALID_PARAM

- **Code:** `INVALID_PARAM`
- **`humanMessage`:** *Invalid `<fieldName>`: `<reason>`.*
- **`actionable`:** *Fix the `<fieldName>` argument and retry. See the JSDoc on the calling method for accepted values.* (Some call sites override `actionable` with a more specific hint, e.g. `encodeRequestLoan` points to `client.rfqKeys.getOrCreateKeyPair()`.)

**Common causes**
- Address args that fail `ethers.isAddress` or equal the zero address.
- Encoding helpers that need a non-empty `requesterPublicKey`.
- Non-positive `splitCollateralAmount` passed to `splitOption`.

**Recovery snippet**

```typescript
const keys = await client.rfqKeys.getOrCreateKeyPair();
const tx = client.loan.encodeRequestLoan({ ...req, requesterPublicKey: keys.compressedPublicKey });
```

---

## INSUFFICIENT_COLLATERAL

- **Code:** `INSUFFICIENT_COLLATERAL`
- **`humanMessage`:** *Wallet holds `<have>` `<token>` but needs `<need>` to open this loan.*
- **`actionable`:** *Top up the connected wallet with at least `<need - have>` more `<token>` before retrying.*

**Common causes**
- User connected a wallet without the requested collateral amount.
- A WETH auto-wrap step couldn't cover the gap because the underlying ETH balance was also short.

**Recovery snippet**

```typescript
showTopUpBanner({
  token: err.meta?.token as string,
  shortBy: BigInt(err.meta?.need as string) - BigInt(err.meta?.have as string),
});
```

---

## INSUFFICIENT_LOAN_BUDGET

- **Code:** `INSUFFICIENT_LOAN_BUDGET`
- **`humanMessage`:** *Requested minimum loan `$<minLoanUsd>` is above the achievable loan `$<achievableLoanUsd>` at current pricing.*
- **`actionable`:** *Lower `minLoan`, increase collateral, or pick a deeper-OTM cap. Wider caps generally raise the achievable loan amount.*

**Common causes**
- The caller hard-coded `minLoanUsd` and current pricing dropped the achievable loan below it.
- A UI input that doesn't react to the cap-strike picker yet.

**Recovery snippet**

```typescript
const est = await client.collar.quickQuote('BTC', n, cap, expiry);
const minLoanUsd = Math.floor(est.loanUsd * 0.98); // 2% slippage tolerance
await client.collar.requestLoan({ ...req, minLoanUsd });
```

---

## OFFER_DECRYPTION_FAILED

- **Code:** `OFFER_DECRYPTION_FAILED`
- **`humanMessage`:** *Failed to decrypt the maker offer for this quotation.*
- **`actionable`:** *The ECDH key on this client does not match the key used when the quotation was requested. Reuse the original key via the RFQ key manager, or request a new quotation.*

**Common causes**
- The keypair was regenerated between `requestLoan` and offer decryption (e.g. a fresh browser tab).
- The caller passed the wrong signing key into `decryptOffer`.

**Recovery snippet**

```typescript
const keys = await client.rfqKeys.getOrCreateKeyPair(); // restores from storage if present
const decrypted = await client.rfqKeys.decryptOffer(encrypted, keys.signingKey);
```

---

## QUOTATION_NOT_FOUND

- **Code:** `QUOTATION_NOT_FOUND`
- **`humanMessage`:** *Quotation `<quotationId>` was not found on the coordinator.*
- **`actionable`:** *Confirm the id was returned by `requestLoan()` on this chain, and that the coordinator address matches the chain config.*

**Common causes**
- Cross-chain confusion: a quotation id from Base looked up on a different chain.
- Stringly-typed ids: passing a `string` instead of `bigint` so the on-chain read resolves to the zero record.

**Recovery snippet**

```typescript
const state = await client.loan.getLoanRequest(BigInt(quotationId));
if (state.requester === ethers.ZeroAddress) throw new Error('not on this chain');
```

---

## QUOTATION_ALREADY_SETTLED

- **Code:** `QUOTATION_ALREADY_SETTLED`
- **`humanMessage`:** *Quotation `<quotationId>` is already settled and cannot be modified.*
- **`actionable`:** *Use `client.collar.getLoanState()` to inspect the settled loan, or request a new quotation if you need a fresh offer.*

**Common causes**
- A second attempt to `acceptOffer` / `cancelLoan` after the quotation already settled.
- UI duplicated a click while the first tx was in flight.

**Recovery snippet**

```typescript
const rec = await client.collar.getLoanRequest(qid);
if (rec.isSettled) navigateToOption(rec.settledOptionContract);
```

---

## INDEXER_UNAVAILABLE

- **Code:** `INDEXER_UNAVAILABLE`
- **`humanMessage`:** *Indexer at `<endpoint>` returned a non-OK response or an unexpected schema.*
- **`actionable`:** *Retry shortly. Persistent failures usually mean the indexer is redeploying — check the status page or fall back to on-chain reads.*

**Common causes**
- Transient downtime on the loan indexer.
- Network failures from the SDK's `fetch` call.

**Recovery snippet**

```typescript
try {
  return await client.loan.getUserLoans(address);
} catch (err) {
  if (isZendfiError(err) && err.code === 'INDEXER_UNAVAILABLE') {
    return fallbackToOnChainScan(address);
  }
  throw err;
}
```

---

## CONTRACT_REVERT

- **Code:** `CONTRACT_REVERT`
- **`humanMessage`:** *Contract call `<operation>` reverted: `<reason>`.* (Or `…reverted.` when no reason string is available.)
- **`actionable`:** *Inspect the cause for the raw revert data. Common causes: stale price feed, expired option, or a competing fill consuming the order.*

**Common causes**
- Stale price feed or TWAP not yet ready.
- Option settlement window mismatch.
- A different filler consumed the order between simulation and submission.

**Recovery snippet**

```typescript
if (isZendfiError(err) && err.code === 'CONTRACT_REVERT') {
  console.error('revert reason:', err.meta?.reason ?? '(none)');
  console.error('raw cause:', err.cause);
}
```

---

## SIGNER_REQUIRED

- **Code:** `SIGNER_REQUIRED`
- **`humanMessage`:** *`<operation>` needs a connected signer.*
- **`actionable`:** *Construct the SDK with a wallet-backed signer (e.g. wagmi connector) before calling write methods. Read-only RPCs can use a `JsonRpcProvider` instead.*

**Common causes**
- Calling a write method on a client built provider-only.
- The user disconnected their wallet between page load and the action.

**Recovery snippet**

```typescript
if (!signer) {
  await connectWallet();
  return;
}
const client = new ThetanutsClient({ chainId: 8453, provider, signer });
```

---

## INSUFFICIENT_ALLOWANCE

- **Code:** `INSUFFICIENT_ALLOWANCE`
- **`humanMessage`:** *Allowance for `<token>` → `<spender>` is below the required `<need>`.*
- **`actionable`:** *Call `client.erc20.approve({ token, spender, amount: <need>n })` and wait for the tx to land before retrying.*

**Common causes**
- Skipping the allowance step before `lend` or `exerciseOption`.
- An allowance that decayed below the new requirement after pricing moved.

**Recovery snippet**

```typescript
await client.erc20.ensureAllowance(
  err.meta?.token as string,
  err.meta?.spender as string,
  BigInt(err.meta?.need as string),
);
await retry();
```

---

## INSUFFICIENT_BALANCE

- **Code:** `INSUFFICIENT_BALANCE`
- **`humanMessage`:** *Wallet holds `<have>` `<token>` but needs `<need>`.*
- **`actionable`:** *Top up the connected wallet with at least `<need - have>` more `<token>` before retrying.*

**Common causes**
- The user's wallet doesn't hold enough of the asset.
- Gas / fee buffer not accounted for at the UI layer.

**Recovery snippet**

```typescript
const have = BigInt(err.meta?.have as string);
const need = BigInt(err.meta?.need as string);
showTopUpBanner({ token: err.meta?.token as string, shortBy: need - have });
```
