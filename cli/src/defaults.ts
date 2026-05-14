/**
 * Single source of truth for CLI defaults. Bump these here, not at call sites.
 *
 * Chain IDs are aligned with the SDK (`@thetanuts-finance/thetanuts-client`):
 * Base mainnet is the primary trading chain; Ethereum is supported for vault
 * reads only. Keep this list in sync with `src/chains/index.ts` in the SDK.
 *
 * Default RPCs are PUBLIC and shared — fine for read-only smoke and
 * onboarding, but will rate-limit under load. Users should override via
 * THETANUTS_RPC_URL or `thetanuts config set rpcUrl <url>` for any serious
 * usage.
 */
export const DEFAULT_CHAIN_ID = 8453; // Base mainnet
export const DEFAULT_RPC_URL = 'https://mainnet.base.org';
export const DEFAULT_ETHEREUM_RPC_URL = 'https://ethereum-rpc.publicnode.com';
