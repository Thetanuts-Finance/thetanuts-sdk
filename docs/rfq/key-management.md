# RFQ Key Management

Manage the ECDH keypairs used to encrypt and decrypt market maker offers in the RFQ system.

## Why Keys Matter

Every RFQ you create includes your ECDH compressed public key. Market makers use it to encrypt their offers so that only you can decrypt them (sealed-bid privacy). The corresponding private key must be available when you want to:

- **Decrypt an offer** for early settlement
- **Debug** a decryption failure by comparing stored vs on-chain public keys

If you lose your private key, you cannot decrypt any offers made against RFQs that used the corresponding public key. There is no recovery mechanism.

---

## Storage Providers

The SDK automatically selects a storage provider based on your runtime environment:

| Environment | Default Provider | Persistence | Location |
|-------------|-----------------|-------------|----------|
| **Node.js** | internal file storage | Persistent | `.thetanuts-keys/` directory (permissions 0o600) |
| **Browser** | `LocalStorageProvider` | Persistent | Browser `localStorage` |
| **Testing** | `MemoryStorageProvider` | Lost on exit | In-memory only |

---

## Automatic Key Management

The simplest usage: call `getOrCreateKeyPair()` and the SDK handles everything.

```typescript
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const client = new ThetanutsClient({ chainId: 8453, provider });

// Returns existing keypair from storage, or generates and stores a new one
const keyPair = await client.rfqKeys.getOrCreateKeyPair();
console.log('Public Key:', keyPair.compressedPublicKey);
// Keys are saved automatically and survive process restarts (Node.js)
```

---

## Custom Storage Provider

Node.js persists keys to `./.thetanuts-keys/` automatically. To use a different backend, pass any object that implements `KeyStorageProvider`:

```typescript
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

const customStorage: KeyStorageProvider = {
  async get(keyId) { return myStore.get(keyId); },
  async set(keyId, privateKey) { await myStore.set(keyId, privateKey); },
  async remove(keyId) { await myStore.delete(keyId); },
  async has(keyId) { return myStore.has(keyId); },
};

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  keyStorageProvider: customStorage,
});

const keyPair = await client.rfqKeys.getOrCreateKeyPair();
```

---

## Memory Storage (Testing Only)

Use `MemoryStorageProvider` in tests or CI environments where you don't need persistence:

```typescript
import { ThetanutsClient, MemoryStorageProvider } from '@thetanuts-finance/thetanuts-client';

// WARNING: Keys are LOST when the process exits!
const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  keyStorageProvider: new MemoryStorageProvider(),
});
```

The SDK logs a warning when `MemoryStorageProvider` is used, as a reminder that the keys will not persist.

---

## Custom Storage Provider

Implement `KeyStorageProvider` to store keys in a database, cloud secret manager, or any other backend:

```typescript
import { KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

class MyDatabaseStorage implements KeyStorageProvider {
  async get(keyId: string): Promise<string | null> {
    return await myDatabase.get(keyId);
  }

  async set(keyId: string, privateKey: string): Promise<void> {
    await myDatabase.set(keyId, privateKey);
  }

  async remove(keyId: string): Promise<void> {
    await myDatabase.delete(keyId);
  }

  async has(keyId: string): Promise<boolean> {
    return await myDatabase.exists(keyId);
  }
}

const client = new ThetanutsClient({
  chainId: 8453,
  provider,
  keyStorageProvider: new MyDatabaseStorage(),
});
```

---

## Key Backup Warning

> **CRITICAL**: Back up your RFQ private keys. If lost, you cannot decrypt offers made to your public key. There is no recovery mechanism.
>
> - **Node.js**: Keys are in `.thetanuts-keys/` with 0o600 permissions — back up this directory
> - **Browser**: Keys are in `localStorage` — cleared if the user clears browser data

### Export for Backup

```typescript
// Export private key (store this somewhere secure)
const privateKeyHex = await client.rfqKeys.exportPrivateKey();
console.log('Backup this key:', privateKeyHex);
```

### Import from Backup

```typescript
// Restore from a backed-up private key
const keyPair = await client.rfqKeys.importFromPrivateKey(
  privateKeyHex,
  true  // store = true saves it to the configured storage provider
);
console.log('Restored public key:', keyPair.compressedPublicKey);
```

---

## RFQKeyManagerModule Method Reference

| Method | Description | Requires Signer |
|--------|-------------|-----------------|
| `generateKeyPair()` | Generate a new ECDH keypair (not stored) | No |
| `getOrCreateKeyPair()` | Get from storage, or generate and store a new one | No |
| `loadKeyPair()` | Load existing keypair from storage | No |
| `hasStoredKey()` | Check whether a key exists in storage | No |
| `storeKeyPair(keypair)` | Explicitly save a keypair to storage | No |
| `removeStoredKey()` | Delete the stored keypair | No |
| `exportPrivateKey()` | Export private key hex string for backup | No |
| `importFromPrivateKey(key, store?)` | Import a keypair from a private key hex | No |
| `encryptOffer(amount, nonce, pubKey)` | Encrypt an offer for a given public key | No |
| `decryptOffer(data, pubKey)` | Decrypt an incoming offer using stored private key | No |
| `generateNonce()` | Generate a random nonce | No |
| `getPublicKeyFromPrivate(key)` | Derive compressed public key from private key | No |
| `isValidPublicKey(key)` | Validate a compressed public key format | No |
| `getStorageKeyId()` | Get the storage identifier for the current key | No |

---

## Encryption Technical Details

### ECDH Key Exchange

The SDK uses secp256k1 ECDH for secure key exchange between requester and market maker:

```
1. Requester generates keypair:
   - Private key: 32 random bytes
   - Public key: Compressed (33 bytes, 0x02/0x03 prefix)

2. Market Maker generates ephemeral keypair per offer:
   - New keypair for each offer (forward secrecy)

3. Shared secret computation:
   ECDH produces: 0x04 || x-coordinate (32 bytes) || y-coordinate (32 bytes)

4. AES key derivation:
   AES-256 key = x-coordinate (first 32 bytes after 0x04 prefix)
   Note: raw x-coordinate, NOT a SHA256 hash — matches MM bot behavior

5. Encryption:
   Algorithm: AES-256-GCM
   IV: 12 random bytes
   Plaintext: JSON { "offerAmount": "...", "nonce": "..." }
   Output: IV (12 bytes) + ciphertext + auth tag (16 bytes)
```

### Nonce Format

The `nonce` field in decrypted offers can be in two formats depending on the source:

| Source | Format | Example |
|--------|--------|---------|
| MM Bot | 16-char hex string | `"987563ef5fde9655"` |
| SDK | Decimal string | `"391788778684598574"` |

The SDK automatically detects and handles both formats during decryption.

---

## Key Mismatch Prevention

Common mistakes that cause "Authentication failed" or "KeyNotFoundError":

1. **Regenerating keys between RFQ creation and decryption** — Always use `getOrCreateKeyPair()`, never `generateKeyPair()`, for production flows
2. **Running on a different machine** without copying `.thetanuts-keys/`
3. **Using `MemoryStorageProvider`** in a long-running process that restarts

Best practices:
- Use `getOrCreateKeyPair()` for all production RFQ flows
- Back up `.thetanuts-keys/` before deploying to new infrastructure
- Verify the stored key matches the on-chain key before attempting decryption:

```typescript
// Verify key matches the RFQ before decrypting
const keyPair = await client.rfqKeys.loadKeyPair();
const quotation = await client.optionFactory.getQuotation(rfqId);

if (keyPair.compressedPublicKey !== quotation.params.requesterPublicKey) {
  throw new Error('Key mismatch — cannot decrypt offers for this RFQ');
}
```

---

## Decryption Troubleshooting

### "KeyNotFoundError: RFQ key not found"

- No key in storage for the current `keyStorageProvider`
- Check that `.thetanuts-keys/` exists (Node.js)
- If lost: create a new RFQ with a freshly generated key; old RFQ offers cannot be recovered

### "DecryptionError: Invalid ciphertext"

- Wrong private key, or the encrypted offer data is truncated
- Verify `encryptedOffer` is complete (from the event log, not truncated)

### "DecryptionError: Authentication failed"

- AES-GCM auth tag verification failed — shared secret is wrong
- Confirm the stored keypair was used when creating the RFQ (compare public keys)

---

## See Also

- [Create an RFQ](create-rfq.md) — Where `getOrCreateKeyPair()` is used in context
- [Early Settlement](early-settlement.md) — Decrypting an offer to accept it before the deadline
- [RFQ Lifecycle](lifecycle.md) — How the sealed-bid auction uses ECDH encryption
