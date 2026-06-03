# Thetanuts Prepare Service

HTTP service that returns unsigned calldata for the [Thetanuts × Base MCP plugin](../plugins/base-mcp/). Reference implementation; the production deployment lives behind `https://api.thetanuts.finance/v1/prepare/*`.

## What it does

For every Thetanuts write action (fill order, request RFQ, settle, etc.), the LLM hits this service, gets `{ transactions: [{ to, data, value, chainId }, ...] }`, and passes it to Base MCP's `send_calls`. Base Account approves and broadcasts. **The service never signs, never broadcasts, never holds wallet keys.**

It does hold one piece of state: per-wallet ECDH keypairs for RFQ offer encryption. These are AES-256-GCM-encrypted at rest with a master key supplied via env var.

## Run

```bash
# Generate a master key once and persist it securely
export KEYSTORE_MASTER_KEY=$(openssl rand -hex 32)

# Optional overrides
export THETANUTS_RPC_URL=https://mainnet.base.org  # default
export KEYSTORE_DB_PATH=./rfq-keystore.sqlite      # default
export PORT=8787                                   # default

npm install
npm run dev   # tsx watch
# or
npm run build && npm start
```

Smoke test:

```bash
curl -s http://localhost:8787/healthz
# { "ok": true, "chainId": 8453 }

curl -s -X POST http://localhost:8787/v1/prepare/approve \
  -H "content-type: application/json" \
  -d '{
    "from": "0xabc...",
    "token": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "spender": "0x1bDff855d6811728acaDC00989e79143a2bdfDed",
    "amount": "1000000"
  }'
```

## Implemented endpoints (v1)

| Endpoint | Status | Notes |
|---|---|---|
| `POST /v1/prepare/approve` | ✅ | Standalone ERC20 approve |
| `POST /v1/prepare/fill-order` | ✅ | Bundles approve + fillOrder |
| `POST /v1/prepare/request-rfq` | ✅ | Derives + stores ECDH key, bundles collateral approve for SELL |
| `POST /v1/prepare/settle-rfq` | ✅ | Single tx |
| `POST /v1/prepare/cancel-rfq` | ✅ | Single tx |
| `POST /v1/prepare/cancel-offer` | ✅ | Single tx |
| `POST /v1/prepare/make-offer` | ✅ | Step 1 of two-step signed flow — returns EIP-712 payload |
| `POST /v1/prepare/make-offer-with-signature` | ✅ | Step 2 — wraps signed payload into send_calls envelope |
| `POST /v1/prepare/settle-rfq-early` | ✅ | Server-side decrypt; requester-only |
| `POST /v1/prepare/swap-and-fill` | ⏳ v1.1 | Needs KyberSwap/0x integration |
| `POST /v1/prepare/swap-and-call` | ⏳ v1.1 | Same |

## Two-step `make-offer` flow

The contract's `makeOfferForQuotation` expects an **EIP-712 signature** from the offeror over `Offer(uint256 quotationId, uint256 offerAmount, address offeror, uint64 nonce)`. The flow:

1. `POST /v1/prepare/make-offer` — server reads the requester's ECDH public key via `client.api.getRequesterPublicKey`, encrypts the offer, and returns `{ signingPayload, submitArgs }`. `signingPayload` is the EIP-712 envelope ready for any `signTypedData_v4`-compatible signer.
2. LLM hands `signingPayload` to Base MCP's `sign` tool with `type: "typed_data"` → gets a 65-byte signature.
3. `POST /v1/prepare/make-offer-with-signature` with the signature + verbatim `submitArgs` → returns the standard ordered-batch `transactions[]` ready for `send_calls`.

The SDK's `optionFactory.buildOfferTypedData(...)` verifies the live on-chain `OFFER_TYPEHASH` and refuses to produce an envelope if the struct has drifted — so a contract upgrade can't silently lead to bad signatures.

## `settle-rfq-early` flow

Server-side: reads the encrypted offer via `client.api.getOffer(quotationId, offeror)` (hydrated by the indexer from the `OfferMade` event), decrypts with the requester's stored ECDH key via `client.rfqKeys.decryptOffer`, and embeds `(offerAmount, nonce)` in the calldata. Only the original requester (whose key is in the keystore) can call this successfully — other callers get `DECRYPT_FAILED`.

## Security status (audit closeout)

The CSO audit findings from the previous session are now addressed in code:

| # | Finding | Status |
|---|---|---|
| CSO-001 | Unauthenticated keystore writes | ✅ Fixed — signed-nonce challenge enforced on `request-rfq`, `make-offer`, `settle-rfq-early`. See "Authentication" below. |
| CSO-002 | Single master key + static scrypt salt | ✅ Fixed — per-row 16-byte salt, `key_version` column tags rows under the current scheme so future migrations can be selective. |
| CSO-003 | sqlite file permissions not enforced | ✅ Fixed — `chmod 0600` applied to the keystore + WAL + SHM sidecars on startup; effective mode logged. |
| CSO-004 | Upstream error leakage in 500 paths | ✅ Fixed — shared `toClientError` / `safeError` helpers in `src/errors.ts` route only allowlisted codes through; everything else becomes opaque `INTERNAL` with a request id. |
| CSO-005 | Plugin trusts `quotationId` from LLM context | ✅ Fixed — onboarding guidance added to `SKILL.md` and the plugin spec. |
| CSO-006 | Transitive `ws` advisory via ethers | Tracked upstream. |

The service is still **not authenticated against the underlying Base RPC**, and the production deploy path (Cloudflare D1 + KMS envelope encryption, instead of sqlite + scrypt) is unchanged. The local sqlite reference impl is now safe to run on a personal laptop **and** suitable as a deploy blueprint for the api.thetanuts.finance Worker.

## Authentication (CSO-001 fix)

Three endpoints touch the per-wallet ECDH keystore: `request-rfq`, `make-offer`, `settle-rfq-early`. Each requires an `Authorization` header proving the caller controls the wallet they claim:

```
1. GET /v1/auth/challenge?wallet=0xYOURADDR
   → { wallet, nonce, message, expiresAt }

2. Sign `message` via Base MCP's `sign` tool (personal_sign / EIP-191).
   The message is human-readable so Base Account can render it.

3. POST /v1/prepare/<endpoint>
   Authorization: Thetanuts wallet=0x..,nonce=0x..,sig=0x..
   Content-Type: application/json
   { ...body, "from": "0x.." }
```

Rules:
- Nonces are single-use and expire 5 minutes after issuance.
- The body's `from` must equal the `Authorization` header's `wallet` (otherwise 401).
- Routes that touch the keystore use the **authenticated wallet**, not `body.from`, when scoping the keystore — even though they must match, the dispatch is on the proven value.
- `approve`, `fill-order`, `settle-rfq`, `cancel-rfq`, `cancel-offer`, `make-offer-with-signature` remain unauthenticated: at worst, an attacker gets unsigned calldata they can't broadcast.

## Multi-tenant key storage

Each `(chainId, wallet)` pair gets its own scoped `KeyStorageProvider` against the same sqlite DB. The master key is a single env var. In production:

- Replace the master key env with a KMS-backed read.
- Use Cloudflare D1 + Workers KV (with the same AES-GCM envelope) instead of sqlite for the canonical `api.thetanuts.finance` deployment.
- Add per-wallet authentication (signed nonce challenge) before any keystore write — currently any caller can claim any wallet's keypair slot because the service trusts `from`.

## Deploy notes for `api.thetanuts.finance`

The user picked deployment onto the existing Cloudflare Worker that already serves the Indexer/State API. Porting this Node/Express reference impl to a Worker:

- **Routing**: trivial — the route handlers in `src/routes/` are pure functions of `(req.body, client)`.
- **SDK**: `@thetanuts-finance/thetanuts-client` runs in Workers with the `nodejs_compat` flag (uses `ethers` v6 which is isomorphic).
- **Keystore**: swap `better-sqlite3` for D1 (`env.DB.prepare(...)`). The AES-GCM logic in `src/keystore.ts` uses `node:crypto` — port to `crypto.subtle` for Workers. Same envelope structure; same master key from `env.KEYSTORE_MASTER_KEY` (or Cloudflare Secrets).
- **Authentication**: add a signed-nonce challenge on the keystore-touching endpoints (`request-rfq`, `make-offer-with-signature`, `settle-rfq-early`) before the prepare service goes public. Without this, anyone can grief a wallet by spawning a different ECDH key into its slot.

## How this fits into the plugin

Plugin `mcp-server/plugins/base-mcp/plugins/thetanuts.md` references these endpoints as `https://api.thetanuts.finance/v1/prepare/*`. For local testing, point the plugin at `http://localhost:8787` by editing the URL in the plugin markdown (or by using a Base MCP `web_request` allowlist override).

## Source crosswalk

Every route wraps one SDK helper — no duplicated logic:

| Route | SDK method | File:line |
|---|---|---|
| `/v1/prepare/approve` | `erc20.encodeApprove` | `src/modules/erc20.ts:408` |
| `/v1/prepare/fill-order` | `optionBook.encodeFillOrder` (+ `erc20.getAllowance`) | `src/modules/optionBook.ts:545` |
| `/v1/prepare/request-rfq` | `optionFactory.buildRFQRequest` + `encodeRequestForQuotation` + `rfqKeys.getOrCreateKeyPair` | `src/modules/optionFactory.ts:1030,1719` |
| `/v1/prepare/make-offer` (step 1) | `api.getRequesterPublicKey` + `rfqKeys.encryptOffer` + `optionFactory.buildOfferTypedData` | `src/modules/api.ts` (new), `src/modules/optionFactory.ts` (new) |
| `/v1/prepare/make-offer-with-signature` (step 2) | `optionFactory.encodeMakeOfferForQuotation` | `src/modules/optionFactory.ts:1080` |
| `/v1/prepare/settle-rfq` | `optionFactory.encodeSettleQuotation` | `src/modules/optionFactory.ts:1098` |
| `/v1/prepare/settle-rfq-early` | `api.getOffer` + `rfqKeys.decryptOffer` + `optionFactory.encodeSettleQuotationEarly` | `src/modules/api.ts` (new), `src/modules/rfqKeyManager.ts:313`, `src/modules/optionFactory.ts:1145` |
| `/v1/prepare/cancel-rfq` | `optionFactory.encodeCancelQuotation` | `src/modules/optionFactory.ts:1111` |
| `/v1/prepare/cancel-offer` | `optionFactory.encodeCancelOfferForQuotation` | `src/modules/optionFactory.ts:1171` |
