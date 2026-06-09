import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

/**
 * Single viem PublicClient instance reused by every signature-verifying
 * code path (HTTP middleware + MCP transport). Phase A.8 — we use viem
 * specifically because its `verifyMessage` transparently handles:
 *
 *   - plain ECDSA from EOAs
 *   - ERC-1271 contract signatures (smart wallets)
 *   - ERC-6492 wrapped signatures (counterfactual smart wallets — the shape
 *     Base Account / Coinbase Smart Wallet produces, which is a wrapped
 *     WebAuthn passkey payload that ethers v6 cannot recover)
 *
 * One instance is fine — the verify method is stateless and the RPC pool
 * inside viem is happy to be shared across requests.
 */

const RPC_URL = process.env.THETANUTS_RPC_URL ?? 'https://mainnet.base.org';

// `any` cast: viem's createPublicClient returns a deeply-inferred type that
// exceeds tsc's serializer limit when consumed across dist boundaries. The
// client is only used via verifyPersonalSign below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const publicClient: any = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

/**
 * Verify a personal_sign signature against the wallet that produced it.
 * Returns true for EOAs (ECDSA recovery) AND smart wallets (ERC-1271 +
 * ERC-6492 unwrapping handled by viem internally).
 *
 * Throws nothing — returns false on any verification path failure. Callers
 * translate to whatever transport-shaped error they need.
 */
export async function verifyPersonalSign(
  wallet: `0x${string}`,
  message: string,
  signature: `0x${string}`,
): Promise<boolean> {
  try {
    return await publicClient.verifyMessage({
      address: wallet,
      message,
      signature,
    });
  } catch {
    return false;
  }
}
