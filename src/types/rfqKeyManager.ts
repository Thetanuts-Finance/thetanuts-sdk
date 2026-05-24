/**
 * ECDH keypair for RFQ operations
 */
export interface RFQKeyPair {
  /** Private key as hex string (0x-prefixed, 32 bytes) */
  privateKey: string;
  /** Compressed public key as hex string (0x-prefixed, 33 bytes) */
  compressedPublicKey: string;
  /** Uncompressed public key as hex string (0x-prefixed, 65 bytes) */
  publicKey: string;
}

/**
 * Result of encrypting an offer
 */
export interface EncryptedOffer {
  /** IV (12 bytes) + AES-GCM ciphertext as hex string */
  ciphertext: string;
  /** Offeror's compressed public key (to share with requester) */
  signingKey: string;
}

/**
 * Result of decrypting an offer
 */
export interface DecryptedOffer {
  /** Decrypted offer amount */
  offerAmount: bigint;
  /** Decrypted nonce */
  nonce: bigint;
}

/**
 * Storage provider interface for persisting ECDH private keys.
 * Implementations can use localStorage, file system, databases, etc.
 * Methods can be sync or async to support various backends.
 */
export interface KeyStorageProvider {
  /**
   * Get the stored private key for a given key ID
   * @param keyId - Unique identifier (typically includes chainId)
   * @returns Private key as hex string, or null if not found
   */
  get(keyId: string): Promise<string | null> | string | null;

  /**
   * Store a private key
   * @param keyId - Unique identifier (typically includes chainId)
   * @param privateKey - Private key as hex string (32 bytes)
   */
  set(keyId: string, privateKey: string): Promise<void> | void;

  /**
   * Remove a stored key
   * @param keyId - Unique identifier
   */
  remove(keyId: string): Promise<void> | void;

  /**
   * Check if a key exists
   * @param keyId - Unique identifier
   */
  has(keyId: string): Promise<boolean> | boolean;
}

/**
 * In-memory storage provider for Node.js and testing.
 * Keys are lost when the process exits.
 */
export class MemoryStorageProvider implements KeyStorageProvider {
  private storage = new Map<string, string>();

  get(keyId: string): string | null {
    return this.storage.get(keyId) ?? null;
  }

  set(keyId: string, privateKey: string): void {
    this.storage.set(keyId, privateKey);
  }

  remove(keyId: string): void {
    this.storage.delete(keyId);
  }

  has(keyId: string): boolean {
    return this.storage.has(keyId);
  }

  /** Clear all stored keys (useful for testing) */
  clear(): void {
    this.storage.clear();
  }
}

/**
 * File system storage provider for Node.js.
 * Keys persist to disk across process restarts.
 *
 * @example
 * ```typescript
 * const storage = new FileStorageProvider('./.my-keys');
 * const client = new ThetanutsClient({
 *   chainId: 8453,
 *   provider,
 *   rfqKeyStorage: storage,
 * });
 * ```
 */
export class FileStorageProvider implements KeyStorageProvider {
  private basePath: string;

  /**
   * Create a file-based key storage provider.
   * @param basePath - Directory to store key files (default: './.thetanuts-keys')
   */
  constructor(basePath = './.thetanuts-keys') {
    this.basePath = basePath;
  }

  /**
   * Get the file path for a key ID.
   */
  private getFilePath(keyId: string): string {
    // Sanitize keyId to prevent path traversal
    const safeKeyId = keyId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${this.basePath}/${safeKeyId}.key`;
  }

  /**
   * Ensure the storage directory exists with secure permissions.
   */
  private async ensureDirectory(): Promise<void> {
    // Dynamic import to avoid issues in browser environments
    const fs = await import('fs/promises');

    try {
      await fs.access(this.basePath);
    } catch {
      // Directory doesn't exist, create it with restricted permissions
      await fs.mkdir(this.basePath, { recursive: true, mode: 0o700 });
    }
  }

  async get(keyId: string): Promise<string | null> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(keyId);
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim();
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null; // File doesn't exist
      }
      throw error;
    }
  }

  async set(keyId: string, privateKey: string): Promise<void> {
    const fs = await import('fs/promises');
    const crypto = await import('crypto');

    await this.ensureDirectory();

    const filePath = this.getFilePath(keyId);

    // Atomic write: write to temp file, then rename
    const tempPath = `${filePath}.${crypto.randomBytes(8).toString('hex')}.tmp`;

    try {
      // Write to temp file with restricted permissions (owner read/write only)
      await fs.writeFile(tempPath, privateKey, { mode: 0o600 });

      // Atomic rename
      await fs.rename(tempPath, filePath);
    } catch (error) {
      // Clean up temp file if rename failed
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async remove(keyId: string): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(keyId);
      await fs.unlink(filePath);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error; // Re-throw if not "file not found"
      }
    }
  }

  async has(keyId: string): Promise<boolean> {
    try {
      const fs = await import('fs/promises');
      const filePath = this.getFilePath(keyId);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the base path where keys are stored.
   */
  getBasePath(): string {
    return this.basePath;
  }
}

/**
 * Browser localStorage provider.
 * Keys persist across sessions.
 *
 * SECURITY (TNU-AUDIT-0063): keys are stored in PLAINTEXT and are accessible
 * to any same-origin script. A single XSS sink or compromised transitive
 * dependency exfiltrates every key the user has ever generated. Prefer one
 * of the following for production browser deployments:
 *
 *   1. Encrypt at rest with WebCrypto + passphrase (PBKDF2/scrypt → AES-GCM).
 *   2. Store non-extractable WebCrypto `CryptoKey` in IndexedDB (`extractable: false`).
 *
 * A one-time `console.warn` is emitted on construction so the risk is visible
 * to integrators that opt-in to this provider explicitly.
 */
export class LocalStorageProvider implements KeyStorageProvider {
  constructor() {
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console -- intentional one-time security warning at construction
      console.warn(
        'LocalStorageProvider stores RFQ private keys in plaintext localStorage. ' +
          'This is accessible to any same-origin script and is not recommended for ' +
          'production browser deployments — see TNU-AUDIT-0063 for safer alternatives.',
      );
    }
  }

  get(keyId: string): string | null {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage.getItem(keyId);
  }

  set(keyId: string, privateKey: string): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      throw new Error('localStorage is not available in this environment');
    }
    window.localStorage.setItem(keyId, privateKey);
  }

  remove(keyId: string): void {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    window.localStorage.removeItem(keyId);
  }

  has(keyId: string): boolean {
    if (typeof window === 'undefined' || !window.localStorage) {
      return false;
    }
    return window.localStorage.getItem(keyId) !== null;
  }
}
