import express from 'express';
import { JsonRpcProvider } from 'ethers';
import { SqliteKeystore } from './keystore.js';
import { AuthStore, requireWalletAuth, AUTH_NONCE_TTL_MS } from './auth.js';
import { toClientError } from './errors.js';
import { buildClient, BASE_CHAIN_ID } from './sdk.js';
import { approveHandler } from './routes/erc20.js';
import { fillOrderHandler } from './routes/optionBook.js';
import {
  requestRfqHandler,
  makeOfferHandler,
  makeOfferWithSignatureHandler,
  settleRfqHandler,
  settleRfqEarlyHandler,
  cancelRfqHandler,
  cancelOfferHandler,
} from './routes/rfq.js';

const PORT = Number(process.env.PORT ?? 8787);
const RPC_URL = process.env.THETANUTS_RPC_URL ?? 'https://mainnet.base.org';
const DB_PATH = process.env.KEYSTORE_DB_PATH ?? './rfq-keystore.sqlite';
const MASTER_KEY = process.env.KEYSTORE_MASTER_KEY;

if (!MASTER_KEY) {
  console.error(
    'KEYSTORE_MASTER_KEY is required (32 bytes hex). Generate with: openssl rand -hex 32',
  );
  process.exit(1);
}

const provider = new JsonRpcProvider(RPC_URL);
const keystore = new SqliteKeystore({ dbPath: DB_PATH, masterKeyHex: MASTER_KEY });
const authStore = new AuthStore(keystore.rawDb());

// Periodic GC of expired auth nonces. Cheap (single DELETE), low frequency.
setInterval(() => {
  try {
    authStore.gc();
  } catch (e) {
    console.error('auth nonce gc failed', e);
  }
}, Math.max(60_000, AUTH_NONCE_TTL_MS)).unref();

// Stateless client (no signer) used by read-only / encode-only routes.
// Each request that touches the RFQ keystore builds its own client via
// buildClient() with a scoped KeyStorageProvider — see routes/rfq.ts.
const sharedClient = buildClient({
  provider,
  keyStorageProvider: keystore.scopedProvider(BASE_CHAIN_ID, '0x0000000000000000000000000000000000000000'),
  wallet: '0x0000000000000000000000000000000000000000',
});

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, chainId: BASE_CHAIN_ID }));

// Auth challenge — issues a nonce + signing message. No auth required to
// request a challenge; auth is enforced when the signed result is presented.
app.get('/v1/auth/challenge', (req, res) => {
  const wallet = String(req.query.wallet ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: 'wallet query param must be 0x-prefixed 40-hex address' });
  }
  res.json(authStore.issue(wallet));
});

const auth = requireWalletAuth(authStore);

// ERC20 — stateless, no keystore. No auth required.
app.post('/v1/prepare/approve', approveHandler(sharedClient));

// OptionBook — stateless. No auth required (worst case an attacker gets
// unsigned calldata they can't broadcast anyway).
app.post('/v1/prepare/fill-order', fillOrderHandler(sharedClient));

// RFQ keystore-touching routes — gated by signed-nonce auth.
app.post('/v1/prepare/request-rfq', auth, requestRfqHandler({ provider, keystore }));
app.post('/v1/prepare/make-offer', auth, makeOfferHandler({ provider, keystore }));
app.post('/v1/prepare/settle-rfq-early', auth, settleRfqEarlyHandler({ provider, keystore }));

// RFQ stateless routes (no keystore reads/writes) — open like fill-order.
app.post('/v1/prepare/make-offer-with-signature', makeOfferWithSignatureHandler(sharedClient));
app.post('/v1/prepare/settle-rfq', settleRfqHandler(sharedClient));
app.post('/v1/prepare/cancel-rfq', cancelRfqHandler(sharedClient));
app.post('/v1/prepare/cancel-offer', cancelOfferHandler(sharedClient));

// Endpoints declared in the plugin spec but not yet implemented in v1:
//   - /v1/prepare/swap-and-fill
//   - /v1/prepare/swap-and-call
// They depend on a third-party swap-quote integration (KyberSwap or 0x) and
// land in v1.1.

// Global 500 handler. Surfaces only an opaque `INTERNAL` envelope to clients;
// the actual error stays in server logs.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const { client, log } = toClientError(err);
  console.error('unhandled route error', log);
  res.status(500).json(client);
});

app.listen(PORT, () => {
  // Re-tighten perms now that WAL/SHM sidecars almost certainly exist
  // after AuthStore touched the DB during startup.
  const mode = keystore.tightenFilePerms();
  const modeStr = mode === null ? 'unknown' : '0' + mode.toString(8);
  console.log(`Thetanuts prepare service listening on http://localhost:${PORT}`);
  console.log(`  RPC: ${RPC_URL}`);
  console.log(`  Chain: Base (${BASE_CHAIN_ID})`);
  console.log(`  Keystore: ${DB_PATH} (mode ${modeStr}; target 0600)`);
});
