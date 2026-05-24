import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

/**
 * Filesystem-backed RFQ key storage for the CLI
 *
 * Mirrors the SDK's internal `FileStorageProvider` byte-for-byte (atomic
 * temp-write + rename, 0o700 dir, 0o600 file). Re-implemented in the CLI
 * because the SDK's public surface only re-exports `MemoryStorageProvider`
 * and `LocalStorageProvider`; `FileStorageProvider` is not in the package exports
 */
export class CliFileKeyStorage implements KeyStorageProvider {
  constructor(private readonly basePath: string) {}

  getBasePath(): string {
    return this.basePath;
  }

  /** Absolute path of the on-disk file for `keyId` */
  getFilePath(keyId: string): string {
    const safe = keyId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.basePath, `${safe}.key`);
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await access(this.basePath);
      // Enforce 0o700 even on a pre-existing directory created by another tool
      // (e.g. mkdir with default 0o755). Without this, key files written into a
      // world-readable directory would be visible to other local users
      // (TNU-AUDIT-0023). chmod is a no-op on Windows.
      try {
        await chmod(this.basePath, 0o700);
      } catch {
        // ignore (non-POSIX FS / permission already correct / not owned by us)
      }
    } catch {
      await mkdir(this.basePath, { recursive: true, mode: 0o700 });
    }
  }

  async get(keyId: string): Promise<string | null> {
    const filePath = this.getFilePath(keyId);
    try {
      // Open with O_NOFOLLOW on POSIX so a planted symlink at this path
      // cannot redirect the read to an attacker-controlled file
      // (TNU-AUDIT-0078).
      const NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
      if (process.platform !== 'win32' && typeof NOFOLLOW === 'number') {
        const handle = await open(filePath, fsConstants.O_RDONLY | NOFOLLOW);
        try {
          const content = await handle.readFile('utf8');
          return content.trim();
        } finally {
          await handle.close();
        }
      }
      const content = await readFile(filePath, 'utf8');
      return content.trim();
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async set(keyId: string, privateKey: string): Promise<void> {
    await this.ensureDirectory();
    const filePath = this.getFilePath(keyId);
    const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(tempPath, privateKey, { mode: 0o600 });
      await rename(tempPath, filePath);
    } catch (err) {
      try {
        await unlink(tempPath);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }

  async remove(keyId: string): Promise<void> {
    try {
      await unlink(this.getFilePath(keyId));
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async has(keyId: string): Promise<boolean> {
    try {
      await access(this.getFilePath(keyId));
      return true;
    } catch {
      return false;
    }
  }

  /** Octal permission bits on the storage directory, e.g. "700". Null if dir absent */
  async getDirMode(): Promise<string | null> {
    try {
      const s = await stat(this.basePath);
      return (s.mode & 0o777).toString(8);
    } catch {
      return null;
    }
  }

  /** Octal permission bits on the keyId's file, e.g. "600". Null if file absent */
  async getFileMode(keyId: string): Promise<string | null> {
    try {
      const s = await stat(this.getFilePath(keyId));
      return (s.mode & 0o777).toString(8);
    } catch {
      return null;
    }
  }
}
