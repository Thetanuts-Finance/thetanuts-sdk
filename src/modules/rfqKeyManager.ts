import { SigningKey, randomBytes, hexlify, getBytes } from 'ethers';
import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import type {
  RFQKeyPair,
  EncryptedOffer,
  DecryptedOffer,
  KeyStorageProvider,
} from '../types/rfqKeyManager.js';
import {
  MemoryStorageProvider,
  LocalStorageProvider,
  FileStorageProvider,
} from '../types/rfqKeyManager.js';
import {
  KeyNotFoundError,
  InvalidKeyError,
  EncryptionError,
  DecryptionError,
} from '../types/errors.js';

/** Default key prefix for storage */
const DEFAULT_KEY_PREFIX = 'thetanuts_rfq_key';

/**
 * Get the default storage provider based on environment.
 * - Browser: localStorage (persists across sessions)
 * - Node.js: File storage (persists to .thetanuts-keys/ directory)
 */
function getDefaultStorageProvider(): KeyStorageProvider {
  // Browser environment: use localStorage
  if (typeof window !== 'undefined' && window.localStorage) {
    return new LocalStorageProvider();
  }

  // Node.js environment: use file storage for persistence
  return new FileStorageProvider();
}

/**
 * RFQ Key Manager Module
 *
 * Provides ECDH keypair generation, secure storage, and encryption/decryption
 * utilities for the sealed-bid auction RFQ workflow.
 *
 * @example
 * ```typescript
 * // Get or create a keypair (stored automatically)
 * const keyPair = await client.rfqKeys.getOrCreateKeyPair();
 *
 * // Encrypt an offer for a requester
 * const nonce = client.rfqKeys.generateNonce();
 * const encrypted = await client.rfqKeys.encryptOffer(
 *   offerAmount,
 *   nonce,
 *   quotation.requesterPublicKey
 * );
 *
 * // Use in makeOfferForQuotation
 * await client.optionFactory.makeOfferForQuotation({
 *   quotationId,
 *   signature,
 *   signingKey: encrypted.signingKey,
 *   encryptedOffer: encrypted.ciphertext,
 * });
 * ```
 */
export class RFQKeyManagerModule {
  private readonly client: ThetanutsClient;
  private readonly storageProvider: KeyStorageProvider;
  private readonly keyPrefix: string;

  constructor(client: ThetanutsClient, storageProvider?: KeyStorageProvider, keyPrefix?: string) {
    this.client = client;
    this.storageProvider = storageProvider ?? getDefaultStorageProvider();
    this.keyPrefix = keyPrefix ?? DEFAULT_KEY_PREFIX;

    // Warn if using non-persistent memory storage
    if (this.storageProvider instanceof MemoryStorageProvider) {
      this.client.logger.warn(
        'RFQ keys are using MemoryStorageProvider - keys will be LOST when the process exits. ' +
        'Consider using FileStorageProvider or providing a custom keyStorageProvider in ThetanutsClientConfig.'
      );
    }
  }

  // ============ Key Generation ============

  /**
   * Generate a new ECDH keypair.
   * Does NOT automatically store - call storeKeyPair() to persist.
   *
   * @returns A new keypair with private key, compressed public key, and uncompressed public key
   */
  generateKeyPair(): RFQKeyPair {
    const privateKeyBytes = randomBytes(32);
    const privateKey = hexlify(privateKeyBytes);
    const signingKey = new SigningKey(privateKey);

    return {
      privateKey,
      compressedPublicKey: signingKey.compressedPublicKey,
      publicKey: signingKey.publicKey,
    };
  }

  /**
   * Get or create a keypair for the current chain.
   * If a key exists in storage, loads it.
   * If not, generates a new one and stores it.
   *
   * @returns The keypair (loaded or newly generated)
   */
  async getOrCreateKeyPair(): Promise<RFQKeyPair> {
    const hasKey = await this.hasStoredKey();
    if (hasKey) {
      return this.loadKeyPair();
    }

    const keyPair = this.generateKeyPair();
    await this.storeKeyPair(keyPair);

    // Log info about the new key for backup purposes
    this.client.logger.info(
      'Generated new RFQ keypair. Public key: ' + keyPair.compressedPublicKey
    );
    this.client.logger.warn(
      'IMPORTANT: Back up your RFQ private key to avoid losing access to encrypted offers. ' +
      'Key storage location: ' + this.getStorageKeyId()
    );

    return keyPair;
  }

  /**
   * Load an existing keypair from storage.
   *
   * @throws KeyNotFoundError if no key found in storage
   * @returns The stored keypair
   */
  async loadKeyPair(): Promise<RFQKeyPair> {
    const keyId = this.getStorageKeyId();
    const privateKey = await this.storageProvider.get(keyId);

    if (!privateKey) {
      throw new KeyNotFoundError();
    }

    try {
      const signingKey = new SigningKey(privateKey);
      return {
        privateKey,
        compressedPublicKey: signingKey.compressedPublicKey,
        publicKey: signingKey.publicKey,
      };
    } catch (error) {
      throw new InvalidKeyError('Stored key is invalid or corrupted.', error);
    }
  }

  /**
   * Check if a keypair exists in storage.
   */
  async hasStoredKey(): Promise<boolean> {
    const keyId = this.getStorageKeyId();
    return this.storageProvider.has(keyId);
  }

  // ============ Key Storage ============

  /**
   * Store a keypair in the configured storage provider.
   *
   * @param keyPair - The keypair to store
   */
  async storeKeyPair(keyPair: RFQKeyPair): Promise<void> {
    const keyId = this.getStorageKeyId();
    await this.storageProvider.set(keyId, keyPair.privateKey);
  }

  /**
   * Remove the stored keypair.
   *
   * WARNING: This will prevent decryption of any offers
   * encrypted with the corresponding public key.
   */
  async removeStoredKey(): Promise<void> {
    const keyId = this.getStorageKeyId();
    await this.storageProvider.remove(keyId);
  }

  /**
   * Export the current keypair's private key (for backup).
   * Returns the private key - handle with care!
   *
   * @throws KeyNotFoundError if no key found in storage
   * @returns The private key as hex string
   */
  async exportPrivateKey(): Promise<string> {
    const keyPair = await this.loadKeyPair();
    // Emit a warning so silent leak via accidental logging/exfiltration of the
    // return value is visible in observability streams. We do NOT log the key
    // value itself (TNU-AUDIT-0029).
    this.client.logger.warn(
      'RFQ private key exported via exportPrivateKey() — handle with care; ' +
        'do not log or transmit this value over insecure channels.',
    );
    return keyPair.privateKey;
  }

  /**
   * Import a keypair from a private key.
   *
   * @param privateKey - 32-byte private key as hex string (0x-prefixed)
   * @param store - Whether to persist to storage (default: true)
   * @throws InvalidKeyError if the private key is invalid
   * @returns The derived keypair
   */
  async importFromPrivateKey(privateKey: string, store = true): Promise<RFQKeyPair> {
    try {
      // Validate by attempting to create a SigningKey
      const signingKey = new SigningKey(privateKey);
      const keyPair: RFQKeyPair = {
        privateKey,
        compressedPublicKey: signingKey.compressedPublicKey,
        publicKey: signingKey.publicKey,
      };

      if (store) {
        await this.storeKeyPair(keyPair);
      }

      return keyPair;
    } catch (_error) {
      // Drop the original cause — ethers' SigningKey error may carry the
      // offending private key value in nested `info`, and downstream error
      // reporters (Sentry/Datadog/Bugsnag) serialize `cause` chains. Do not
      // give them the chance to exfiltrate the raw key (TNU-AUDIT-0076).
      throw new InvalidKeyError('Invalid private key format. Expected 32-byte hex string.');
    }
  }

  // ============ Encryption ============

  /**
   * Encrypt offer details for the requester.
   * Uses ECDH shared secret + SHA-256 key derivation + AES-256-GCM.
   *
   * @param offerAmount - The offer amount (as bigint)
   * @param nonce - Random nonce for EIP-712 signature
   * @param requesterPublicKey - Requester's compressed public key
   * @param keyPair - Our keypair (loads from storage if not provided)
   * @returns Encrypted payload and our public key
   */
  async encryptOffer(
    offerAmount: bigint,
    nonce: bigint,
    requesterPublicKey: string,
    keyPair?: RFQKeyPair
  ): Promise<EncryptedOffer> {
    const kp = keyPair ?? (await this.loadKeyPair());

    try {
      const signingKey = new SigningKey(kp.privateKey);

      // Compute ECDH shared secret
      const sharedSecret = signingKey.computeSharedSecret(requesterPublicKey);

      // Extract x-coordinate from shared secret (bytes 1-33, skip 0x04 prefix)
      // This matches the MM bot's key derivation: shared_secret[:32]
      const secretBytes = getBytes(sharedSecret);
      const xCoordinate = secretBytes.slice(1, 33);
      const aesKey = await this.importAesKey(xCoordinate.buffer.slice(xCoordinate.byteOffset, xCoordinate.byteOffset + xCoordinate.byteLength));

      // Generate random 12-byte IV
      const iv = this.getRandomBytes(12);

      // Encode payload
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          offerAmount: offerAmount.toString(),
          nonce: nonce.toString(),
        })
      );

      // Encrypt with AES-256-GCM
      const ciphertext = await this.aesGcmEncrypt(aesKey, iv, plaintext);

      // Concatenate IV + ciphertext
      const result = new Uint8Array(iv.length + ciphertext.byteLength);
      result.set(iv);
      result.set(new Uint8Array(ciphertext), iv.length);

      return {
        ciphertext: hexlify(result),
        signingKey: kp.compressedPublicKey,
      };
    } catch (error) {
      if (error instanceof KeyNotFoundError || error instanceof InvalidKeyError) {
        throw error;
      }
      throw new EncryptionError('Failed to encrypt offer.', error);
    }
  }

  /**
   * Decrypt an offer (for requesters viewing incoming offers).
   *
   * @param encryptedData - The encrypted payload (IV + ciphertext as hex)
   * @param offerorPublicKey - The offeror's public key (signingKey from event)
   * @param keyPair - Our keypair (loads from storage if not provided)
   * @returns Decrypted offer amount and nonce
   */
  async decryptOffer(
    encryptedData: string,
    offerorPublicKey: string,
    keyPair?: RFQKeyPair
  ): Promise<DecryptedOffer> {
    const kp = keyPair ?? (await this.loadKeyPair());

    try {
      const signingKey = new SigningKey(kp.privateKey);

      // Compute ECDH shared secret
      const sharedSecret = signingKey.computeSharedSecret(offerorPublicKey);

      // Extract x-coordinate from shared secret (bytes 1-33, skip 0x04 prefix)
      // This matches the MM bot's key derivation: shared_secret[:32]
      const secretBytes = getBytes(sharedSecret);
      const xCoordinate = secretBytes.slice(1, 33);

      const aesKey = await this.importAesKey(xCoordinate.buffer.slice(xCoordinate.byteOffset, xCoordinate.byteOffset + xCoordinate.byteLength));

      // Extract IV (first 12 bytes) and ciphertext
      const data = getBytes(encryptedData);
      const iv = data.slice(0, 12);
      const ciphertext = data.slice(12);

      // Decrypt with AES-256-GCM
      const plaintext = await this.aesGcmDecrypt(aesKey, iv, ciphertext);

      // Parse JSON payload
      const decoded = new TextDecoder().decode(plaintext);
      const parsed = JSON.parse(decoded) as { offerAmount: string; nonce: string };

      // Convert to BigInt - nonce might be hex string (MM bot) or decimal string (SDK).
      // Cap input lengths first so adversarial payloads can't DoS via huge-string
      // BigInt parsing (TNU-AUDIT-0074). uint256 max is 78 decimal digits / 64 hex digits.
      if (typeof parsed.offerAmount !== 'string' || parsed.offerAmount.length > 80) {
        throw new DecryptionError('offerAmount exceeds maximum allowed length');
      }
      if (typeof parsed.nonce !== 'string' || parsed.nonce.length > 80) {
        throw new DecryptionError('nonce exceeds maximum allowed length');
      }
      const offerAmount = BigInt(parsed.offerAmount);
      let nonce: bigint;

      // MM bot sends hex nonces (16 chars hex like "987563ef5fde9655")
      // SDK sends decimal nonces (large numeric strings)
      // Normalize both `0x` and `0X` prefixes; otherwise uppercase `0X` produces
      // a malformed `0x0X…` literal that throws (TNU-AUDIT-0017).
      const nonceLower = parsed.nonce.toLowerCase();
      const isHexNonce = nonceLower.startsWith('0x') ||
        (parsed.nonce.length === 16 && /^[0-9a-fA-F]+$/.test(parsed.nonce) && /[a-fA-F]/.test(parsed.nonce));

      if (isHexNonce) {
        // Strip any leading 0x/0X (case-insensitive) and reparse from hex.
        const stripped = parsed.nonce.replace(/^0[xX]/, '');
        nonce = BigInt('0x' + stripped);
      } else {
        // Decimal nonce (SDK format)
        nonce = BigInt(parsed.nonce);
      }

      return {
        offerAmount,
        nonce,
      };
    } catch (error) {
      if (error instanceof KeyNotFoundError || error instanceof InvalidKeyError) {
        throw error;
      }
      throw new DecryptionError('Failed to decrypt offer. Key mismatch or corrupted data.', error);
    }
  }

  // ============ Utilities ============

  /**
   * Derive a compressed public key from a private key.
   *
   * @param privateKey - Private key as hex string
   * @returns Compressed public key as hex string
   */
  getPublicKeyFromPrivate(privateKey: string): string {
    try {
      const signingKey = new SigningKey(privateKey);
      return signingKey.compressedPublicKey;
    } catch (error) {
      throw new InvalidKeyError('Invalid private key format.', error);
    }
  }

  /**
   * Validate a public key format.
   * Checks if the key is a valid compressed ECDH public key.
   *
   * @param publicKey - Public key as hex string
   * @returns true if valid, false otherwise
   */
  isValidPublicKey(publicKey: string): boolean {
    try {
      // Compressed public keys are 33 bytes (66 hex chars + 0x prefix)
      if (!publicKey.startsWith('0x')) {
        return false;
      }

      const bytes = getBytes(publicKey);
      if (bytes.length !== 33) {
        return false;
      }

      // First byte must be 0x02 or 0x03 for compressed keys
      if (bytes[0] !== 0x02 && bytes[0] !== 0x03) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Generate a random nonce for offer encryption.
   * Returns a 128-bit random bigint.
   */
  generateNonce(): bigint {
    const bytes = this.getRandomBytes(16);
    return BigInt(hexlify(bytes));
  }

  /**
   * Get the storage key ID for the current chain.
   */
  getStorageKeyId(): string {
    return `${this.keyPrefix}_${this.client.chainId}`;
  }

  // ============ Private Helpers ============

  /**
   * Get cryptographically secure random bytes.
   * Works in both browser and Node.js environments.
   */
  private getRandomBytes(length: number): Uint8Array {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint8Array(length));
    }
    // Fallback to ethers randomBytes
    return getBytes(randomBytes(length));
  }

  /**
   * Import a key for AES-256-GCM.
   */
  private async importAesKey(keyData: ArrayBuffer): Promise<CryptoKey> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      return crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
    }
    // For Node.js without Web Crypto, throw an error
    // (Node.js 15+ has crypto.subtle, older versions need polyfill)
    throw new Error('Web Crypto API not available. Please use Node.js 15+ or a polyfill.');
  }

  /**
   * Encrypt data with AES-256-GCM.
   */
  private async aesGcmEncrypt(
    key: CryptoKey,
    iv: Uint8Array,
    plaintext: Uint8Array
  ): Promise<ArrayBuffer> {
    return crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      plaintext as unknown as BufferSource
    );
  }

  /**
   * Decrypt data with AES-256-GCM.
   */
  private async aesGcmDecrypt(
    key: CryptoKey,
    iv: Uint8Array,
    ciphertext: Uint8Array
  ): Promise<ArrayBuffer> {
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
  }
}
