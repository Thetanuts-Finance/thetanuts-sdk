import path from 'node:path';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { OptionValues } from 'commander';
import { defaultConfigPath, loadConfig, type Config } from './config.js';
import { DEFAULT_CHAIN_ID, DEFAULT_RPC_URL } from './defaults.js';
import { CliFileKeyStorage } from './rfqKeyStorage.js';

/**
 * Resolution order for any setting (descending priority):
 *   1. CLI global flag (e.g. --rpc-url, --private-key, --chain, --referrer)
 *   2. Environment variable (THETANUTS_RPC_URL, THETANUTS_PRIVATE_KEY, THETANUTS_REFERRER)
 *   3. Config file at --config or ~/.config/thetanuts/config.json
 *   4. Hardcoded default (see defaults.ts — Base mainnet by default)
 *
 * `getClient` always returns a read-capable client. The signer is only attached
 * when a private key resolves; modules that need a signer should call
 * `requireSigner(client)` for a clearer error message.
 */

export interface GetClientResult {
  client: ThetanutsClient;
  /** True iff a signer was attached (a private key resolved). */
  hasSigner: boolean;
  chainId: number;
  rpcUrl: string;
  /** Absolute directory the RFQ keystore writes into. */
  rfqKeysDir: string;
  /** Filesystem-backed storage provider used for RFQ ECDH keys. */
  rfqKeyStorage: CliFileKeyStorage;
  /**
   * Resolved OptionBook referrer address, or undefined when none is
   * configured (the SDK then falls back to the zero address). Commands report
   * or warn on this instead of reaching into SDK internals.
   */
  referrer?: string;
}

function resolveChainId(opts: OptionValues, cfg: Config | null): number {
  const raw = opts.chain as string | number | undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    // The CLI is Base-only
    if (typeof raw === 'number') {
      if (raw === 8453) return 8453;
      throw new Error(`--chain only supports base (chainId 8453). Got: "${raw}"`);
    }
    const trimmed = String(raw).trim().toLowerCase();
    if (trimmed === 'base' || trimmed === '8453') return 8453;
    throw new Error(`--chain only supports base (chainId 8453). Got: "${raw}"`);
  }
  if (cfg?.chainId) return cfg.chainId;
  return DEFAULT_CHAIN_ID;
}

function resolveRpcUrl(opts: OptionValues, cfg: Config | null, _chainId: number): string {
  const fromFlag = opts.rpcUrl as string | undefined;
  let rpcUrl: string;
  if (fromFlag) {
    rpcUrl = fromFlag;
  } else {
    const fromEnv = process.env.THETANUTS_RPC_URL;
    if (fromEnv) {
      rpcUrl = fromEnv;
    } else {
      rpcUrl = cfg?.rpcUrl ?? DEFAULT_RPC_URL;
    }
  }
  // Reject non-https RPC URLs unless the host is localhost. Signed tx
  // broadcasts over plain http are vulnerable to MITM tampering of gas /
  // nonce / data. Localhost is the only sane dev escape hatch.
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new Error(`thetanuts: RPC URL is not a valid URL (got ${rpcUrl})`);
  }
  const host = parsed.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `thetanuts: RPC URL must use https:// (got ${rpcUrl}); pass an https URL or use a localhost RPC for dev`
    );
  }
  return rpcUrl;
}

// Defined inline (not imported) to avoid pulling a command module into client bootstrap
const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Best-effort wipe of `--private-key <value>` from `process.argv` so the key
 * does not persist in `/proc/PID/cmdline` for longer than necessary
 * (TNU-AUDIT-0016).
 *
 * Note: this cannot redact shell history, `ps aux` snapshots, or
 * Node-internal copies — pass the key via env, stdin, or config instead.
 */
function scrubPrivateKeyFromArgv(): void {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--private-key' || arg === '-p') {
      if (i + 1 < argv.length) {
        argv[i + 1] = '[REDACTED]';
      }
    } else if (typeof arg === 'string' && arg.startsWith('--private-key=')) {
      argv[i] = '--private-key=[REDACTED]';
    }
  }
}

function resolvePrivateKey(opts: OptionValues, cfg: Config | null): string | undefined {
  let key: string | undefined;
  let source: string | undefined;
  const fromFlag = opts.privateKey as string | undefined;
  if (fromFlag) {
    key = fromFlag;
    source = '--private-key flag';
    // Emit one-time warning so users see this risk surface — argv is visible
    // via `ps aux` and persists in shell history (TNU-AUDIT-0016).
    if (!process.env.THETANUTS_SUPPRESS_PRIVATE_KEY_WARNING) {
      process.stderr.write(
        'thetanuts: warning — passing --private-key on the command line exposes ' +
          'the key in shell history and process listings. Prefer THETANUTS_PRIVATE_KEY ' +
          'env var or `thetanuts wallet import` for persistent storage.\n',
      );
    }
    scrubPrivateKeyFromArgv();
  } else {
    const fromEnv = process.env.THETANUTS_PRIVATE_KEY;
    if (fromEnv) {
      key = fromEnv;
      source = 'THETANUTS_PRIVATE_KEY env var';
    } else if (cfg?.privateKey) {
      key = cfg.privateKey;
      source = 'config file';
    }
  }
  if (key === undefined) return undefined;
  // Validate BEFORE handing to ethers — a malformed key would otherwise be echoed verbatim in ethers' "invalid BytesLike value" error message
  if (!PRIVATE_KEY_REGEX.test(key)) {
    throw new Error(`Invalid private key from ${source}. Expected 0x-prefixed 64-char hex string.`);
  }
  return key;
}

/**
 * Resolve the OptionBook referrer address that fills are attributed to.
 * Returns undefined when none is configured; the SDK then uses the zero
 * address (no referral credit).
 *
 * Exported (unlike the other resolvers) so tests can exercise the precedence
 * chain directly.
 */
export function resolveReferrer(opts: OptionValues, cfg: Config | null): string | undefined {
  let referrer: string | undefined;
  let source: string | undefined;
  const fromFlag = opts.referrer as string | undefined;
  if (fromFlag) {
    referrer = fromFlag;
    source = '--referrer flag';
  } else {
    const fromEnv = process.env.THETANUTS_REFERRER;
    if (fromEnv) {
      referrer = fromEnv;
      source = 'THETANUTS_REFERRER env var';
    } else if (cfg?.referrer) {
      referrer = cfg.referrer;
      source = 'config file';
    }
  }
  if (referrer === undefined) return undefined;
  // The SDK re-validates, but fail early so the error names the source the
  // bad value came from.
  if (!ethers.isAddress(referrer)) {
    throw new Error(
      `Invalid referrer address from ${source}: "${referrer}". Expected a 0x-prefixed 40-char hex address.`
    );
  }
  return referrer;
}

/**
 * Resolve the directory the RFQ key manager should persist into.
 * Precedence:
 *   1. cfg.rfqKeysDir  (explicit override in config.json)
 *   2. <dirname of resolved config path>/rfq-keys  (e.g. ~/.config/thetanuts/rfq-keys)
 *
 */
function resolveRfqKeysDir(opts: OptionValues, cfg: Config | null): string {
  if (cfg?.rfqKeysDir && cfg.rfqKeysDir.length > 0) return cfg.rfqKeysDir;
  const configPath = (opts.config as string | undefined) ?? defaultConfigPath();
  return path.join(path.dirname(configPath), 'rfq-keys');
}


/**
 * Build a `ThetanutsClient` from the merged CLI options object.
 *
 * Pass `opts` from `getGlobalOpts(cmd)`. The function does not touch the
 * network; it constructs an ethers `JsonRpcProvider` (which is lazy) and
 * returns immediately.
 */
export function getClient(opts: OptionValues): GetClientResult {
  const configPath = opts.config as string | undefined;
  const cfg = loadConfig(configPath);

  const chainId = resolveChainId(opts, cfg);
  const rpcUrl = resolveRpcUrl(opts, cfg, chainId);
  const privateKey = resolvePrivateKey(opts, cfg);
  const referrer = resolveReferrer(opts, cfg);
  const rfqKeysDir = resolveRfqKeysDir(opts, cfg);
  const rfqKeyStorage = new CliFileKeyStorage(rfqKeysDir);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = privateKey ? new ethers.Wallet(privateKey, provider) : undefined;

  const client = new ThetanutsClient({
    chainId: chainId as 8453,
    provider,
    signer,
    referrer,
    keyStorageProvider: rfqKeyStorage,
  });

  return {
    client,
    hasSigner: Boolean(signer),
    chainId,
    rpcUrl,
    rfqKeysDir,
    rfqKeyStorage,
    referrer,
  };
}

/**
 * Throw a friendly error when a command needs a signer but none was supplied.
 * Implementer agents call this at the top of any write-op action.
 */
export function requireSigner(result: GetClientResult): void {
  if (!result.hasSigner) {
    throw new Error(
      'This command requires a signer. Provide --private-key, set THETANUTS_PRIVATE_KEY, or run `thetanuts setup`.'
    );
  }
}
