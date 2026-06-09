/**
 * SDK client factory for prepare tools — folded in from the standalone
 * prepare-service when it was merged into @thetanuts-finance/mcp v1.0.0.
 *
 * Per-wallet scoped client: each request that touches the RFQ keystore
 * builds its own ThetanutsClient with a wallet-scoped KeyStorageProvider.
 * No signer is attached — the prepare tools NEVER sign. They only produce
 * unsigned calldata for Base MCP's send_calls.
 */

import { JsonRpcProvider } from 'ethers';
import { ThetanutsClient, type KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

export const BASE_CHAIN_ID = 8453;

export function buildClient(opts: {
  provider: JsonRpcProvider;
  keyStorageProvider: KeyStorageProvider;
  wallet: string;
}): ThetanutsClient {
  return new ThetanutsClient({
    chainId: BASE_CHAIN_ID,
    provider: opts.provider,
    keyStorageProvider: opts.keyStorageProvider,
    rfqKeyPrefix: `thetanuts_rfq_${opts.wallet.toLowerCase()}`,
  });
}
