import path from 'node:path';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { OptionValues } from 'commander';
import { defaultConfigPath, loadConfig, type Config } from './config.js';
import { DEFAULT_CHAIN_ID, DEFAULT_RPC_URL } from './defaults.js';
import { CliFileKeyStorage } from './rfqKeyStorage.js';

/**
 * Resolution order for any setting (descending priority):
 *   1. CLI global flag (e.g. --rpc-url, --private-key, --chain)
 *   2. Environment variable (THETANUTS_RPC_URL, THETANUTS_PRIVATE_KEY)
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
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.THETANUTS_RPC_URL;
  if (fromEnv) return fromEnv;
  return cfg?.rpcUrl ?? DEFAULT_RPC_URL;
}

function resolvePrivateKey(opts: OptionValues, cfg: Config | null): string | undefined {
  const fromFlag = opts.privateKey as string | undefined;
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.THETANUTS_PRIVATE_KEY;
  if (fromEnv) return fromEnv;
  return cfg?.privateKey;
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
  const rfqKeysDir = resolveRfqKeysDir(opts, cfg);
  const rfqKeyStorage = new CliFileKeyStorage(rfqKeysDir);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = privateKey ? new ethers.Wallet(privateKey, provider) : undefined;

  const client = new ThetanutsClient({
    chainId: chainId as 8453,
    provider,
    signer,
    keyStorageProvider: rfqKeyStorage,
  });

  return {
    client,
    hasSigner: Boolean(signer),
    chainId,
    rpcUrl,
    rfqKeysDir,
    rfqKeyStorage,
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
