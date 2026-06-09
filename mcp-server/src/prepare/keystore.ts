import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, statSync } from 'node:fs';
import type { KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

/**
 * Per-wallet, AES-256-GCM-encrypted sqlite keystore for RFQ ECDH private keys.
 *
 * The SDK's RFQKeyManagerModule scopes keys by chainId only — fine for a
 * single-user CLI but not for a multi-wallet MCP process. Each request to
 * the MCP prepare layer is on behalf of a different wallet, so we wrap a fresh
 * provider per request that scopes by `${chainId}:${wallet}`.
 *
 * Master key (32 bytes hex) is supplied via KEYSTORE_MASTER_KEY env var. In
 * production it should come from KMS; this reference impl reads it from env.
 */

/**
 * Schema notes (versioning):
 *   v1 was: scrypt(masterKey, fixed-salt) → single AES-256-GCM wrapping key
 *           for every row. Removed for CSO-002.
 *   v2 (current): each row carries its own random 16-byte salt. Wrapping
 *           key = scrypt(masterKey, row.salt, 32). Stored `key_version`
 *           tags the row so future migrations can read+rewrap selectively.
 *
 * The migration block below upgrades existing v1 deployments by adding the
 * missing columns; existing rows can't be auto-migrated (wrapping key was
 * deterministic, but each row needs a fresh salt). They stay readable under
 * the legacy code path until the operator runs a rotation script.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rfq_keys (
  key_id TEXT PRIMARY KEY,
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  salt BLOB,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const MIGRATIONS: ReadonlyArray<string> = [
  // Defensive: if the table was created under the old schema, add the new
  // columns. These ALTERs are no-ops on fresh databases (column already
  // exists from CREATE above).
  'ALTER TABLE rfq_keys ADD COLUMN salt BLOB',
  'ALTER TABLE rfq_keys ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1',
];

const CURRENT_KEY_VERSION = 2;
// scrypt params: N=2^14, r=8, p=1 is the OWASP-recommended baseline as of
// the audit date. Adjust together with the version bump if you raise N.
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface KeystoreConfig {
  dbPath: string;
  masterKeyHex: string;
}

export class SqliteKeystore {
  private readonly db: Database.Database;
  private readonly masterKey: Buffer;
  private readonly dbPath: string;

  constructor(config: KeystoreConfig) {
    if (!/^[0-9a-fA-F]{64}$/.test(config.masterKeyHex)) {
      throw new Error(
        'KEYSTORE_MASTER_KEY must be 32 bytes hex (64 chars). Generate with: openssl rand -hex 32',
      );
    }
    this.dbPath = config.dbPath;
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Lock down the on-disk keystore files. WAL/SHM sidecars are created
    // lazily on first write; we re-chmod them defensively on a few common
    // entry points. Skipped silently on platforms where chmod is a no-op
    // (e.g. Windows or fs that doesn't support POSIX modes).
    this.tightenFilePerms();
    // Apply additive migrations on existing databases. SQLite has no
    // IF NOT EXISTS for ALTER ADD COLUMN, so we tolerate the duplicate-
    // column error.
    for (const stmt of MIGRATIONS) {
      try { this.db.exec(stmt); } catch (e) {
        if (!/duplicate column/i.test((e as Error).message)) throw e;
      }
    }
    this.masterKey = Buffer.from(config.masterKeyHex, 'hex');
  }

  /**
   * Return a KeyStorageProvider scoped to a specific (chainId, wallet) pair.
   * Pass into `new ThetanutsClient({ ..., keyStorageProvider: provider })`.
   */
  scopedProvider(chainId: number, wallet: string): KeyStorageProvider {
    const prefix = `${chainId}:${wallet.toLowerCase()}:`;
    const get = this.db.prepare<
      [string],
      { iv: Buffer; ciphertext: Buffer; auth_tag: Buffer; salt: Buffer | null; key_version: number }
    >('SELECT iv, ciphertext, auth_tag, salt, key_version FROM rfq_keys WHERE key_id = ?');
    const has = this.db.prepare<[string], { c: number }>(
      'SELECT 1 AS c FROM rfq_keys WHERE key_id = ?',
    );
    const upsert = this.db.prepare<[string, Buffer, Buffer, Buffer, Buffer, number, number, number]>(
      `INSERT INTO rfq_keys(key_id, iv, ciphertext, auth_tag, salt, key_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET
         iv=excluded.iv, ciphertext=excluded.ciphertext, auth_tag=excluded.auth_tag,
         salt=excluded.salt, key_version=excluded.key_version,
         updated_at=excluded.updated_at`,
    );
    const del = this.db.prepare<[string]>('DELETE FROM rfq_keys WHERE key_id = ?');

    const masterKey = this.masterKey;

    return {
      get(keyId: string): string | null {
        const row = get.get(prefix + keyId);
        if (!row) return null;
        if (row.key_version !== CURRENT_KEY_VERSION || !row.salt) {
          // v1 row (legacy scrypt-fixed-salt) — refuse to silently decrypt
          // under a different scheme than was used to encrypt.
          throw new Error(
            `Row uses key_version=${row.key_version}; only version ${CURRENT_KEY_VERSION} ` +
              'is supported. Run the rotation script to re-encrypt under v2.',
          );
        }
        const wrappingKey = scryptSync(masterKey, row.salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
        const decipher = createDecipheriv('aes-256-gcm', wrappingKey, row.iv);
        decipher.setAuthTag(row.auth_tag);
        const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
        return plaintext.toString('utf8');
      },
      set(keyId: string, privateKey: string): void {
        const salt = randomBytes(16);
        const wrappingKey = scryptSync(masterKey, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
        const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        const now = Date.now();
        upsert.run(prefix + keyId, iv, ciphertext, authTag, salt, CURRENT_KEY_VERSION, now, now);
      },
      remove(keyId: string): void {
        del.run(prefix + keyId);
      },
      has(keyId: string): boolean {
        return has.get(prefix + keyId) !== undefined;
      },
    };
  }

  close(): void {
    this.db.close();
  }

  /**
   * Expose the underlying sqlite handle so adjacent stores (e.g. AuthStore)
   * can reuse the same DB connection instead of opening a second one.
   * Treat as read/write — callers must respect their own schema namespacing.
   */
  rawDb(): Database.Database {
    return this.db;
  }

  /**
   * Apply 0600 to the main DB plus its `-wal` and `-shm` sidecars if they
   * exist. Returns the mode actually observed (post-chmod) on the main file
   * for logging; silent on missing sidecars and on EPERM (caller may not
   * own the file, common in container deploys).
   */
  tightenFilePerms(): number | null {
    const targets = [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`];
    for (const path of targets) {
      try {
        chmodSync(path, 0o600);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'ENOTSUP') throw e;
      }
    }
    try {
      return statSync(this.dbPath).mode & 0o777;
    } catch {
      return null;
    }
  }
}
