import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import type Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';

/**
 * Signed-nonce challenge auth.
 *
 * Flow:
 *   1. Caller hits `GET /v1/auth/challenge?wallet=0x...` → server returns
 *      `{ nonce, expiresAt, message }`.
 *   2. Caller signs `message` via Base MCP's `sign` tool (personal_sign /
 *      EIP-191) — the message format is human-readable so Base Account can
 *      surface it intelligibly.
 *   3. Caller resends the original request with header
 *      `Authorization: Thetanuts wallet=0x...,nonce=<hex>,sig=<0x..>`.
 *   4. `requireWalletAuth` middleware verifies the signature recovers to
 *      `wallet`, that the nonce exists, hasn't expired, hasn't been used.
 *      On success it marks the nonce consumed and lets the request through.
 *
 * Why personal_sign and not typed_data: Base MCP supports both, and the
 * payload here is just an opaque nonce. EIP-191 is simpler, fewer moving
 * parts, no schema to drift. The actual *offer* signing (which the contract
 * verifies) still uses typed_data — that's a different signature path.
 *
 * Nonces are single-use, expire after AUTH_NONCE_TTL_MS, and live in sqlite
 * alongside the keystore so a server restart doesn't invalidate active flows.
 */

const NONCE_TTL_MS = 5 * 60 * 1000;
const MESSAGE_PREFIX = 'Thetanuts prepare-service auth\nWallet: ';
const HEADER_RE = /^Thetanuts\s+wallet=(0x[0-9a-fA-F]{40}),\s*nonce=(0x[0-9a-fA-F]{32}),\s*sig=(0x[0-9a-fA-F]+)$/;

const NONCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_wallet ON auth_nonces(wallet);
`;

export interface AuthChallenge {
  wallet: string;
  nonce: string;
  message: string;
  expiresAt: number;
}

export class AuthStore {
  private readonly insert;
  private readonly consume;
  private readonly cleanup;
  private readonly lookupExpiry;

  constructor(private readonly db: Database.Database) {
    db.exec(NONCE_SCHEMA);
    this.insert = db.prepare<[string, string, number, number]>(
      'INSERT INTO auth_nonces(nonce, wallet, issued_at, expires_at) VALUES (?, ?, ?, ?)',
    );
    this.lookupExpiry = db.prepare<[string, string], { expires_at: number }>(
      'SELECT expires_at FROM auth_nonces WHERE nonce = ? AND wallet = ?',
    );
    // Atomic check-and-consume: only one request can ever consume a given
    // nonce. `UPDATE ... WHERE consumed_at IS NULL` is the lock.
    this.consume = db.prepare<[number, string, string, number]>(
      `UPDATE auth_nonces
         SET consumed_at = ?
       WHERE nonce = ?
         AND wallet = ?
         AND expires_at >= ?
         AND consumed_at IS NULL`,
    );
    this.cleanup = db.prepare<[number]>(
      'DELETE FROM auth_nonces WHERE expires_at < ? OR consumed_at IS NOT NULL',
    );
  }

  /** Issue a fresh nonce for a wallet. */
  issue(wallet: string): AuthChallenge {
    const nonceBytes = randomBytes(16);
    const nonce = '0x' + nonceBytes.toString('hex');
    const now = Date.now();
    const expiresAt = now + NONCE_TTL_MS;
    this.insert.run(nonce, wallet.toLowerCase(), now, expiresAt);
    return {
      wallet,
      nonce,
      message: `${MESSAGE_PREFIX}${wallet}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`,
      expiresAt,
    };
  }

  /**
   * Atomically check-and-consume. Returns true if the (wallet, nonce) pair
   * was valid and is now marked consumed. False on any failure — caller
   * should treat as 401 without distinguishing why (avoids oracle for
   * attackers probing nonce existence).
   */
  consumeOnce(wallet: string, nonce: string): boolean {
    const result = this.consume.run(Date.now(), nonce, wallet.toLowerCase(), Date.now());
    return result.changes === 1;
  }

  /** Drop expired and consumed rows. Call from a periodic timer. */
  gc(): number {
    return this.cleanup.run(Date.now()).changes;
  }

  /**
   * Return the recorded `expires_at` for a (wallet, nonce) pair, or null if
   * unknown. Does NOT consume. Used by middleware to reconstruct the exact
   * message the client should have signed.
   */
  lookupExpiresAt(wallet: string, nonce: string): number | null {
    const row = this.lookupExpiry.get(nonce, wallet.toLowerCase());
    return row ? row.expires_at : null;
  }
}

/**
 * Build the canonical message a wallet must sign. Same shape as `issue()`
 * returns so the client doesn't have to reconstruct anything.
 */
export function authMessage(wallet: string, nonce: string, expiresAt: number): string {
  return `${MESSAGE_PREFIX}${wallet}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}`;
}

/**
 * Express middleware enforcing Authorization on routes that touch the
 * keystore. Mount BEFORE the route handler. On failure responds 401 and
 * does NOT call next().
 *
 * On success, attaches `req.authenticatedWallet` so downstream handlers
 * can trust it instead of the body's `from` field.
 */
export function requireWalletAuth(authStore: AuthStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    if (!header) {
      return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', error: 'Authorization header missing. Call GET /v1/auth/challenge first.' });
    }
    const match = HEADER_RE.exec(header);
    if (!match) {
      return res.status(401).json({ ok: false, code: 'AUTH_MALFORMED', error: 'Authorization header malformed. Expected: Thetanuts wallet=0x..,nonce=0x..,sig=0x..' });
    }
    const [, wallet, nonce, sig] = match;

    // Body's `from` must match the authenticated wallet — otherwise an
    // attacker who somehow obtained Alice's signature could use it on a
    // request whose `from` says Bob, bypassing the per-wallet scoping in
    // routes that still consult `req.body.from`.
    const bodyFrom = (req.body as { from?: string } | undefined)?.from;
    if (bodyFrom && bodyFrom.toLowerCase() !== wallet!.toLowerCase()) {
      return res.status(401).json({ ok: false, code: 'AUTH_WALLET_MISMATCH', error: 'Authorization wallet does not match body.from' });
    }

    // We don't know the expiresAt the message used here — recover the
    // signer and require they signed *some* valid message under this
    // wallet+nonce. To do that without storing the message verbatim, we
    // accept either {expiresAt = issued+TTL} (canonical) by reconstructing
    // it from the stored row. Look up the row first.
    const expiresAt = authStore.lookupExpiresAt(wallet!, nonce!);
    if (expiresAt === null) {
      return res.status(401).json({ ok: false, code: 'AUTH_INVALID', error: 'Nonce not recognized' });
    }
    const signedMessage = authMessage(wallet!, nonce!, expiresAt);

    let recovered: string;
    try {
      recovered = verifyMessage(signedMessage, sig!);
    } catch {
      return res.status(401).json({ ok: false, code: 'AUTH_BAD_SIGNATURE', error: 'Signature could not be recovered' });
    }
    if (recovered.toLowerCase() !== wallet!.toLowerCase()) {
      return res.status(401).json({ ok: false, code: 'AUTH_BAD_SIGNATURE', error: 'Signature does not match wallet' });
    }

    // All checks passed — atomically burn the nonce. If burn fails (someone
    // raced us), the request loses.
    if (!authStore.consumeOnce(wallet!, nonce!)) {
      return res.status(401).json({ ok: false, code: 'AUTH_REPLAY', error: 'Nonce already consumed or expired' });
    }

    (req as Request & { authenticatedWallet: string }).authenticatedWallet = wallet!.toLowerCase();
    next();
  };
}

export const AUTH_NONCE_TTL_MS = NONCE_TTL_MS;
