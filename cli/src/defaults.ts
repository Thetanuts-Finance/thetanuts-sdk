/**
 * Single source of truth for CLI defaults. Bump these here, not at call sites.
 *
 * The CLI is Base-only by design (chainId 8453). Keep this aligned with the
 * SDK (`@thetanuts-finance/thetanuts-client`) — see `src/chains/index.ts`
 * there for addresses and tokens.
 *
 * The default RPC is PUBLIC and shared — fine for read-only smoke and
 * onboarding, but will rate-limit under load. Users should override via
 * THETANUTS_RPC_URL or `thetanuts config set rpcUrl <url>` for any serious
 * usage.
 */
export const DEFAULT_CHAIN_ID = 8453; // Base mainnet
export const DEFAULT_RPC_URL = 'https://mainnet.base.org';
