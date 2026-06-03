# Manual end-to-end test — Thetanuts × Base MCP plugin

End-to-end smoke test you can run on your own machine before promoting the plugin anywhere public. Tests both the prepare service (this directory) and the markdown plugin (`../plugins/base-mcp/`).

**Read [the security audit findings](./README.md#security-status-audit-closeout) first.** This guide assumes you are testing **locally on your own laptop with your own wallet**. The five CSO findings (signed-nonce auth, per-row salt + key versioning, file perms 0600, error sanitizer, plugin onboarding) are now fixed in code — the service is suitable to expose behind a reverse proxy + TLS, but **production deploy still requires** swapping sqlite for D1 + KMS (see README).

---

## Prerequisites

| Need | How |
|---|---|
| Base mainnet RPC URL | `https://mainnet.base.org` works; better: Alchemy/Infura/QuickNode |
| Funded Base Account | https://wallet.base.org — keep this **separate from your main wallet**. Fund with ~$5 USDC + a sip of ETH for gas. |
| Node 20+ | `node -v` |
| Claude Code, Claude Desktop, or Cursor | Any MCP-aware client |
| openssl | For generating the master key |
| `jq`, `curl` | For raw API smoke tests |

---

## Part 1 — Start the prepare service locally

```bash
cd /Users/eesheng_eth/Desktop/thetanuts-sdk

# Make sure the SDK is built so the prepare service sees the new helpers
npm run build

# Move into the prepare service
cd mcp-server/prepare-service

# Generate a master key (write it down — losing it means losing every stored ECDH key)
export KEYSTORE_MASTER_KEY=$(openssl rand -hex 32)
echo "MASTER KEY: $KEYSTORE_MASTER_KEY"   # save this

# Optional overrides
# export THETANUTS_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
# export KEYSTORE_DB_PATH=./rfq-keystore.sqlite
# export PORT=8787

npm install
npm run dev
```

You should see:
```
Thetanuts prepare service listening on http://localhost:8787
  RPC: https://mainnet.base.org
  Chain: Base (8453)
  Keystore: ./rfq-keystore.sqlite
```

### Smoke test 1.1 — health check

```bash
curl -s http://localhost:8787/healthz | jq
# expected: { "ok": true, "chainId": 8453 }
```

### Smoke test 1.2 — encode an ERC20 approve (no chain state needed)

```bash
curl -s -X POST http://localhost:8787/v1/prepare/approve \
  -H 'content-type: application/json' \
  -d '{
    "from":    "0x0000000000000000000000000000000000000001",
    "token":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "spender": "0x1bDff855d6811728acaDC00989e79143a2bdfDed",
    "amount":  "1000000"
  }' | jq
```

Expected response:
```json
{
  "transactions": [
    {
      "step": "approve",
      "to":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "data": "0x095ea7b3...",
      "value": "0x0",
      "chainId": 8453
    }
  ]
}
```

If you see `0x095ea7b3` as the first 4 bytes of `data`, you've successfully encoded `approve(spender, amount)`. ✅

### Smoke test 1.3 — signed-nonce auth round-trip

Hit a keystore-touching endpoint without auth to confirm the gate is wired up:

```bash
curl -si -X POST http://localhost:8787/v1/prepare/request-rfq \
  -H 'content-type: application/json' \
  -d '{"from":"0x0000000000000000000000000000000000000001"}' | head -5
# expected: HTTP/1.1 401  with { "ok": false, "code": "AUTH_REQUIRED", ... }
```

Issue a challenge:

```bash
curl -s "http://localhost:8787/v1/auth/challenge?wallet=0xYOURADDR" | jq
# expected: { "wallet": "0x..", "nonce": "0x..", "message": "Thetanuts prepare-service auth\nWallet: ...\nNonce: ...\nExpires: ...", "expiresAt": <ms> }
```

Sign the `message` with the wallet (in a real flow this is Base MCP's `sign` tool with `type=personal_sign`; for a local test from the terminal, use whatever you have — `cast wallet sign --private-key $PK "$MESSAGE"` or a viem one-liner). Then call any keystore route:

```bash
curl -si -X POST http://localhost:8787/v1/prepare/request-rfq \
  -H "Authorization: Thetanuts wallet=0xYOURADDR,nonce=0xTHENONCE,sig=0xTHESIG" \
  -H 'content-type: application/json' \
  -d '{ "from":"0xYOURADDR", "product":"PUT", "underlying":"ETH", "collateral":"USDC", "strikes":["1850"], "numContracts":"0.01", "expiry":<unix+48h>, "offerEndTimestamp":<unix+1h>, "isRequestingLongPosition":true }'
# expected: { "transactions": [ ... ] }
```

Replay the same nonce — should fail:

```bash
# rerun the exact same curl
# expected: 401 AUTH_REPLAY
```

### Smoke test 1.4 — fetch a real orderbook order and encode a fill

```bash
# Find the cheapest order ID from the read-only MCP or the State API
curl -s https://round-snowflake-9c31.devops-118.workers.dev/api/v1/book/state | jq '.orders | keys | .[0:3]'

# Pick one — replace 0 below with an actual order index
curl -s -X POST http://localhost:8787/v1/prepare/fill-order \
  -H 'content-type: application/json' \
  -d '{
    "from":       "<your-base-account>",
    "orderId":    0,
    "usdcAmount": "1000000"
  }' | jq
```

Expected: a `transactions` array of length 1 or 2 (2 if you don't yet have USDC allowance for the OptionBook). The action's `to` should equal the OptionBook address `0x1bDff855d6811728acaDC00989e79143a2bdfDed`.

---

## Part 2 — Install the Base MCP plugin in your LLM client

The plugin is **markdown only** — no compilation, no install script. Three install paths depending on your client.

### 2A — Claude Code (recommended for testing)

Add Base MCP first (so the plugin has signing infrastructure):

```bash
claude mcp add --transport http base-mcp https://mcp.base.org
```

Confirm it loaded:

```bash
claude mcp list | grep base-mcp
```

Now load the Thetanuts skill. Two options:

**Option A — local file reference (best for iterating):**

In Claude Code, paste the absolute path:
```
Load this skill: /Users/eesheng_eth/Desktop/thetanuts-sdk/mcp-server/plugins/base-mcp/SKILL.md
```

**Option B — GitHub raw URL (best for production):**

```
Load this skill: https://raw.githubusercontent.com/Thetanuts-Finance/thetanuts-sdk/main/mcp-server/plugins/base-mcp/SKILL.md
```

Claude lazy-loads `plugins/thetanuts.md` when you actually try to trade.

### 2B — Claude Desktop / claude.ai

1. Install Base MCP as a custom connector at https://claude.ai/customize/connectors with URL `https://mcp.base.org`.
2. Zip the skill folder:
   ```bash
   cd /Users/eesheng_eth/Desktop/thetanuts-sdk/mcp-server/plugins/base-mcp
   zip -r thetanuts-skill.zip SKILL.md README.md plugins/
   ```
3. Upload `thetanuts-skill.zip` at https://claude.ai/customize/skills.

### 2C — Cursor

Add Base MCP via deeplink or by editing `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "base-mcp": { "url": "https://mcp.base.org" } } }
```

Then drag the skill folder into Cursor's "Skills" panel.

---

## Part 3 — Point the plugin at your local prepare service

The plugin's markdown references `https://api.thetanuts.finance/v1/prepare/*`, but that domain is **not yet live**. For local testing you need to override the URL so the LLM hits your `http://localhost:8787` instead.

Two approaches:

### 3A — Edit the plugin URL in-place (quickest)

```bash
cd /Users/eesheng_eth/Desktop/thetanuts-sdk/mcp-server/plugins/base-mcp
sed -i.bak 's|https://api.thetanuts.finance|http://localhost:8787|g' plugins/thetanuts.md
```

Reload the skill in your LLM client. **Revert before committing:**
```bash
mv plugins/thetanuts.md.bak plugins/thetanuts.md
```

### 3B — Tell the LLM at runtime (no file edit)

In your first message in a session:

> Use the Thetanuts plugin. **Important: every `api.thetanuts.finance` URL in the plugin spec must be replaced with `http://localhost:8787` for this session — I'm testing locally.**

The LLM will substitute as it constructs `web_request` calls.

---

## Part 4 — End-to-end RFQ lifecycle (the real test)

This walks through the full sealed-bid auction flow using two wallets — Wallet A (buyer / requester) and Wallet B (seller / offeror).

You can either control both wallets yourself, or test with a friend.

### Step 1 — Requester creates RFQ (Wallet A)

In your LLM session (connected as Wallet A):

> Request an RFQ to buy 1 ETH put option with a $1850 strike expiring in 48 hours, using USDC collateral. Use a 60-minute offer deadline.

The LLM should:
1. Call Base MCP `get_wallets` → confirms Wallet A.
2. Call your local prepare service via `web_request`:
   ```
   POST http://localhost:8787/v1/prepare/request-rfq
   { "from": "<A>", "product": "PUT", "underlying": "ETH",
     "collateral": "USDC", "strikes": ["1850"], "numContracts": "1",
     "expiry": <unix+48h>, "offerEndTimestamp": <unix+1h>,
     "isRequestingLongPosition": true }
   ```
3. Get back a `transactions[]` array (1 tx because BUY position doesn't need collateral approval).
4. Call Base MCP `send_calls` with the transactions. Base Account approval popup → you approve in Base Account.
5. Confirm via Basescan or the read-only MCP.

**Verify:** the on-chain `QuotationRequested` event should carry your wallet's ECDH public key. Check via:
```bash
curl -s https://round-snowflake-9c31.devops-118.workers.dev/api/v1/factory/rfqs/<quotationId> | jq '.requesterPublicKey'
```

### Step 2 — Maker makes an encrypted offer (Wallet B)

Switch your LLM session to Wallet B (or have a friend do this). In Claude:

> Make an offer on RFQ <quotationId> for 50 USDC.

The LLM should:
1. `POST http://localhost:8787/v1/prepare/make-offer` with `{ from: B, quotationId, offerAmount: "50000000" }`.
2. Service returns:
   ```json
   {
     "step": "sign-then-submit",
     "signingPayload": { "domain": {...}, "types": {...}, "primaryType": "Offer", "message": {...} },
     "nextEndpoint": "/v1/prepare/make-offer-with-signature",
     "submitArgs": { "from", "quotationId", "offerAmount", "nonce", "signingKey", "encryptedOffer" }
   }
   ```
3. LLM calls Base MCP `sign` with `type=typed_data` and `data=signingPayload`. Base Account shows the typed-data approval — you approve.
4. LLM gets a 65-byte signature back.
5. LLM calls `POST http://localhost:8787/v1/prepare/make-offer-with-signature` with `{ from, quotationId, signature, signingKey, encryptedOffer }` from step 3 verbatim.
6. Service returns the standard `transactions[]` envelope.
7. LLM calls `send_calls` → Base Account approval → on-chain.

**Verify:** the on-chain `OfferMade` event carries `signingKey` and `signedOfferForRequester`. Check:
```bash
curl -s https://round-snowflake-9c31.devops-118.workers.dev/api/v1/factory/rfqs/<quotationId> | jq '.offers'
```
should contain an entry keyed by Wallet B's address.

### Step 3 — Requester settles early (Wallet A)

Back to Wallet A's session. The requester wants to accept Wallet B's offer before the deadline:

> Settle quotation <quotationId> early with the offer from <Wallet B address>.

The LLM should:
1. `POST http://localhost:8787/v1/prepare/settle-rfq-early` with `{ from: A, quotationId, offerorAddress: B }`.
2. Service reads B's encrypted offer, decrypts with A's stored ECDH key (the one A created in step 1), encodes `settleQuotationEarly(quotationId, recoveredOfferAmount, recoveredNonce, B)`, and returns the tx envelope.
3. LLM calls `send_calls` → Base Account approval → on-chain.

**Verify:**
```bash
curl -s https://round-snowflake-9c31.devops-118.workers.dev/api/v1/factory/rfqs/<quotationId> | jq '.status'
# expected: "settled"
```

---

## Part 5 — Negative tests (confirm the failure modes)

### 5.1 — wrong wallet on settle-rfq-early

Try to settle Wallet A's RFQ but pass `from: <Wallet B>` (so the keystore lookup fails):

```bash
curl -s -X POST http://localhost:8787/v1/prepare/settle-rfq-early \
  -H 'content-type: application/json' \
  -d '{ "from": "<B>", "quotationId": "<A-quote>", "offerorAddress": "<B>" }' | jq
```

Expected: `{ "ok": false, "code": "DECRYPT_FAILED", ... }`. **This is the closest thing to access control we have today.** Note that the failure mode also confirms why CSO-001 is a P0 — see the audit.

### 5.2 — invalid input

```bash
# bad address
curl -s -X POST http://localhost:8787/v1/prepare/approve \
  -H 'content-type: application/json' \
  -d '{ "from": "not-an-address", "token": "0x...", "spender": "0x...", "amount": "1" }' | jq
# expected: 400 INVALID_INPUT

# missing field
curl -s -X POST http://localhost:8787/v1/prepare/fill-order \
  -H 'content-type: application/json' \
  -d '{ "from": "0x0000000000000000000000000000000000000001" }' | jq
# expected: 400 INVALID_INPUT

# nonexistent order
curl -s -X POST http://localhost:8787/v1/prepare/fill-order \
  -H 'content-type: application/json' \
  -d '{ "from": "0x0000000000000000000000000000000000000001", "orderId": 99999 }' | jq
# expected: 404 ORDER_NOT_FOUND
```

### 5.3 — typehash drift safety

The `buildOfferTypedData` helper verifies the on-chain `OFFER_TYPEHASH` against the SDK's pinned struct. To confirm it actually fires, temporarily change the struct string in `src/modules/optionFactory.ts:777` (e.g. swap field order), rebuild, and call `/v1/prepare/make-offer`. You should see:

```json
{
  "ok": false,
  "code": "TYPEHASH_MISMATCH",
  "error": "OFFER_TYPEHASH mismatch: contract returns 0x..., SDK derived 0x... from \"Offer(...)\". The Offer struct may have changed..."
}
```

Revert the change after. This proves the SDK fails closed on contract drift.

---

## Part 6 — What to check before deploying anywhere public

Audit findings (now fixed in code):

- [x] **CSO-001** — signed-nonce auth on `request-rfq` / `make-offer` / `settle-rfq-early`
- [x] **CSO-002** — per-row salt + `key_version` column; OWASP-baseline scrypt params
- [x] **CSO-003** — keystore + WAL + SHM chmod 0600 on startup, effective mode logged
- [x] **CSO-004** — `toClientError` / `safeError` sanitize all 500 paths to opaque `INTERNAL` with request id
- [x] **CSO-005** — plugin markdown + SKILL.md flag untrusted parameter sources

Production hardening still required before the api.thetanuts.finance deploy:

- [ ] **Storage port** — replace better-sqlite3 with Cloudflare D1; replace `node:crypto.scryptSync` + master-key envelope with KMS-managed DEK envelope encryption
- [ ] **Master key sourcing** — read from KMS (or Worker secret), not env var on the box
- [ ] **TLS** — terminated upstream (Cloudflare in front of Workers handles automatically)
- [ ] **Rate limiting** — Cloudflare WAF rule on `/v1/auth/challenge` and `/v1/prepare/*` (e.g. 60 req/min per IP)
- [ ] **Observability** — alert on `INTERNAL` rate, on 401 spikes, on `AUTH_REPLAY` (indicates abuse)
- [ ] **DNS** — `api.thetanuts.finance/v1/prepare/*` pointing at the Worker
- [ ] **Plugin URL flip** — `https://api.thetanuts.finance` restored in the plugin markdown (revert Part 3A's sed if you used it)
- [ ] **End-to-end** — Part 4 + Part 5 re-run against the production URL

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `KEYSTORE_MASTER_KEY is required` on start | env var not set | `export KEYSTORE_MASTER_KEY=$(openssl rand -hex 32)` |
| `Cannot find module '@thetanuts-finance/thetanuts-client'` | SDK not built | `cd /Users/eesheng_eth/Desktop/thetanuts-sdk && npm run build && cd mcp-server/prepare-service && npm install` |
| `ORDER_NOT_FOUND` for every order | State API down or RPC throttling | `curl https://round-snowflake-9c31.devops-118.workers.dev/healthz` |
| Plugin not loaded in Claude | URL still pointing at production | See Part 3 — override the URL |
| `RFQ_NOT_FOUND` on `make-offer` | RFQ created on chain but indexer hasn't caught up | Wait 10–30s, try again |
| `DECRYPT_FAILED` on `settle-rfq-early` | Different `from` than the one that created the RFQ, OR keystore was deleted | Use the same wallet; if keystore lost, the RFQ is permanently unsettleable from this service (use `/v1/prepare/settle-rfq` after offer window closes) |
| `TYPEHASH_MISMATCH` in production | Contract was upgraded with a new `Offer` struct | Update `src/modules/optionFactory.ts:777` and re-run unit tests |

---

## Where to file issues

- **SDK + prepare service bugs**: https://github.com/Thetanuts-Finance/thetanuts-sdk/issues
- **Plugin markdown clarity**: same repo, label `plugin-docs`
- **Base MCP issues** (`sign`, `send_calls` behavior): https://docs.base.org/ai-agents
