import { access, chmod, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Command } from 'commander';
import {
  InvalidKeyError,
  KeyNotFoundError,
} from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, type GetClientResult } from '../client.js';
import { render, renderError } from '../output.js';
import { confirm } from '../confirm.js';

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

/** Resolve the on-disk file path of the active chain's keystore entry */
function storageFilePath(result: GetClientResult): string {
  const id = result.client.rfqKeys.getStorageKeyId();
  return result.rfqKeyStorage.getFilePath(id);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic write of `content` to `dest` with the requested mode. Writes to a
 * temp file in the same directory and renames into place, so partial writes
 * never produce a half-corrupted key file at `dest`
 */
async function atomicWriteFile(dest: string, content: string, mode: number): Promise<void> {
  const tmp = `${dest}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await rename(tmp, dest);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

export function register(program: Command): void {
  const grp = program
    .command('keys')
    .description(
      'ECDH keypair management for sealed-bid RFQ. One keypair per chain, ' +
        'persisted under <config-dir>/rfq-keys/ with chmod 700/600. The private ' +
        'key is NEVER printed to stdout — export only writes to a file.'
    );

  // ----------------------------------------------------------------------
  // keys generate — in-memory only, never persists
  // ----------------------------------------------------------------------
  grp
    .command('generate')
    .description(
      'Generate a fresh ECDH keypair in memory and print the public key. ' +
        'Does NOT persist — use `keys ensure` to generate and store.'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const result = getClient(opts);
        const kp = result.client.rfqKeys.generateKeyPair();
        render(
          {
            publicKey: kp.compressedPublicKey,
            chainId: result.chainId,
            stored: false,
          },
          { output: opts.output, noColor: !opts.color }
        );
        process.stderr.write(
          'Private key was generated in memory and discarded. Run `thetanuts keys ensure` to persist a key.\n'
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------------------
  // keys show — print stored public key + storage path. Never prints private.
  // ----------------------------------------------------------------------
  grp
    .command('show')
    .description('Print the stored public key + storage path. Exits 1 if no key is stored. Never echoes the private key.')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const result = getClient(opts);
        try {
          const kp = await result.client.rfqKeys.loadKeyPair();
          const file = storageFilePath(result);
          render(
            {
              publicKey: kp.compressedPublicKey,
              chainId: result.chainId,
              storageFile: file,
              storageDir: result.rfqKeysDir,
            },
            { output: opts.output, noColor: !opts.color }
          );
        } catch (err) {
          if (err instanceof KeyNotFoundError) {
            renderError(
              new Error(
                `No RFQ key stored for chain ${result.chainId}. Run \`thetanuts keys generate\` to generate one.`
              ),
              { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color }
            );
            process.exit(1);
          }
          if (err instanceof InvalidKeyError) {
            renderError(
              new Error(
                `Stored RFQ key is invalid for chain ${result.chainId}. Restore from backup or run \`thetanuts keys remove --force && thetanuts keys generate\` (will lose access to existing encrypted offers).`
              ),
              { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color }
            );
            process.exit(6);
          }
          throw err;
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });


  // ----------------------------------------------------------------------
  // keys export --out <file>  — backup the private key to a file (0o600)
  // ----------------------------------------------------------------------
  grp
    .command('export')
    .description(
      'Backup the stored private key to a file (chmod 600). Refuses --out -. ' +
        'Double-gated by a confirm prompt that warns about the backup responsibility.'
    )
    .requiredOption('--out <path>', 'destination file path (must be a real path, not -)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ out: string }>();
      try {
        if (local.out === '-' || local.out === '/dev/stdout' || local.out === '/dev/stderr') {
          throw new Error(
            '--out cannot be stdout or stderr. Pass a real file path; the private key must never land in scrollback or pipe targets.'
          );
        }
        const result = getClient(opts);
        const hasKey = await result.client.rfqKeys.hasStoredKey();
        if (!hasKey) {
          renderError(
            new Error(
              `No RFQ key stored for chain ${result.chainId}. Run \`thetanuts keys ensure\` to generate one.`
            ),
            { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color }
          );
          process.exit(6);
        }

        const destAbs = path.resolve(local.out);
        const destExists = await fileExists(destAbs);

        const ok = await confirm(
          `About to write the RFQ private key for chain ${result.chainId} to:\n  ${destAbs}\n` +
            (destExists ? '  (file already exists — will be overwritten)\n' : '') +
            'Anyone who reads this file controls every RFQ encrypted to your public key. Continue?',
          { yes: Boolean(opts.yes), dryRun: Boolean(opts.dryRun) }
        );
        if (!ok) process.exit(3);

        const privateKey = await result.client.rfqKeys.exportPrivateKey();
        await atomicWriteFile(destAbs, privateKey + '\n', 0o600);
        // Defensive: ensure the perms stick even if rename copied a stricter umask.
        await chmod(destAbs, 0o600);

        render(
          {
            exported: true,
            destination: destAbs,
            chainId: result.chainId,
            fileMode: '600',
          },
          { output: opts.output, noColor: !opts.color }
        );
        process.stderr.write(
          '\n⚠ Private key written to disk in plaintext.\n' +
            '  Move this file to offline backup, then `shred -u` (Linux) / `srm` (macOS) the working copy.\n' +
            '  Anyone with this file can decrypt every prior + future offer addressed to your public key.\n\n'
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------------------
  // keys import --in <file>  — restore from a backup file
  // ----------------------------------------------------------------------
  grp
    .command('import')
    .description(
      'Restore an RFQ private key from a file (created by `keys export`). ' +
        'Refuses --in -. Refuses to overwrite an existing key without --force.'
    )
    .requiredOption('--in <path>', 'source file path containing a 0x-prefixed 64-hex-char private key')
    .option('--force', 'overwrite an existing key for this chain', false)
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ in: string; force?: boolean }>();
      try {
        if (local.in === '-' || local.in === '/dev/stdin') {
          throw new Error(
            '--in cannot be stdin. Pass a real file path; CLI flags must not require interactive piping of secrets.'
          );
        }
        const srcAbs = path.resolve(local.in);
        let raw: string;
        try {
          raw = (await readFile(srcAbs, 'utf8')).trim();
        } catch (err) {
          renderError(
            new Error(`Failed to read --in file at ${srcAbs}: ${(err as Error).message ?? String(err)}`),
            { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color }
          );
          process.exit(4);
          return;
        }
        if (!PRIVATE_KEY_REGEX.test(raw)) {
          renderError(
            new Error(
              `File at ${srcAbs} does not contain a 0x-prefixed 64-hex-char private key (got ${raw.length} chars).`
            ),
            { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color }
          );
          process.exit(4);
          return;
        }

        const result = getClient(opts);
        const hasKey = await result.client.rfqKeys.hasStoredKey();
        if (hasKey && !local.force) {
          const ok = await confirm(
            `Chain ${result.chainId} already has a stored RFQ key. ` +
              'Importing will overwrite it permanently — any encrypted offers addressed to the previous public key will become undecryptable. Continue?',
            { yes: Boolean(opts.yes), dryRun: Boolean(opts.dryRun) }
          );
          if (!ok) process.exit(3);
        }

        try {
          const kp = await result.client.rfqKeys.importFromPrivateKey(raw, true);
          render(
            {
              imported: true,
              publicKey: kp.compressedPublicKey,
              chainId: result.chainId,
              storageFile: storageFilePath(result),
            },
            { output: opts.output, noColor: !opts.color }
          );
          process.stderr.write(
            `\nImported key for chain ${result.chainId}. Other chains' keystores are unaffected.\n\n`
          );
        } catch (err) {
          if (err instanceof InvalidKeyError) {
            renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
            process.exit(4);
            return;
          }
          throw err;
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ----------------------------------------------------------------------
  // keys remove [--force]  — destroy the stored key
  // ----------------------------------------------------------------------
  grp
    .command('remove')
    .description(
      'Delete the stored RFQ key for the active chain. Refuses without --force unless you confirm interactively. ' +
        'Losing the key strands every prior RFQ for the wallet — back up first with `keys export`.'
    )
    .option('--force', 'do not prompt for confirmation', false)
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ force?: boolean }>();
      try {
        const result = getClient(opts);
        const hasKey = await result.client.rfqKeys.hasStoredKey();
        if (!hasKey) {
          render(
            {
              removed: false,
              reason: 'no key stored',
              chainId: result.chainId,
            },
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }

        if (!local.force) {
          const ok = await confirm(
            `Delete the stored RFQ key for chain ${result.chainId}? ` +
              'Every offer encrypted to your public key will become undecryptable. ' +
              'Run `keys export` first if you have not backed it up.',
            { yes: Boolean(opts.yes), dryRun: Boolean(opts.dryRun) }
          );
          if (!ok) process.exit(3);
        }

        await result.client.rfqKeys.removeStoredKey();
        render(
          {
            removed: true,
            chainId: result.chainId,
            storageFile: storageFilePath(result),
          },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
