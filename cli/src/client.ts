import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { OptionValues } from 'commander';
import { loadConfig, type Config } from './config.js';
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_ETHEREUM_RPC_URL,
  DEFAULT_RPC_URL,
} from './defaults.js';

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
}

function resolveChainId(opts: OptionValues, cfg: Config | null): number {
  const raw = opts.chain as string | number | undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw === 'number') return raw;
    const trimmed = String(raw).trim().toLowerCase();
    if (trimmed === 'base') return 8453;
    if (trimmed === 'ethereum' || trimmed === 'mainnet') return 1;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isNaN(parsed)) return parsed;
    throw new Error(`Unrecognized --chain value: ${raw}`);
  }
  if (cfg?.chainId) return cfg.chainId;
  return DEFAULT_CHAIN_ID;
}

function resolveRpcUrl(opts: OptionValues, cfg: Config | null, chainId: number): string {
  const fromFlag = opts.rpcUrl as string | undefined;
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.THETANUTS_RPC_URL;
  if (fromEnv) return fromEnv;
  // Per-chain fallback. The SDK supports chainId 1 (Ethereum, vault-only) and
  // chainId 8453 (Base, full trading surface). If the user selects Ethereum
  // without setting an Ethereum RPC, we MUST NOT fall through to the Base RPC
  // — that would route Ethereum-chainId queries to Base infrastructure and
  // produce garbage data (or, for writes, broadcast on the wrong chain).
  if (chainId === 1) {
    return cfg?.ethereumRpcUrl ?? DEFAULT_ETHEREUM_RPC_URL;
  }
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

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = privateKey ? new ethers.Wallet(privateKey, provider) : undefined;

  const client = new ThetanutsClient({
    chainId: chainId as 1 | 8453,
    provider,
    signer,
  });

  return {
    client,
    hasSigner: Boolean(signer),
    chainId,
    rpcUrl,
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
