import { JsonRpcProvider } from 'ethers';
import { ThetanutsClient, type KeyStorageProvider } from '@thetanuts-finance/thetanuts-client';

const BASE_CHAIN_ID = 8453;

/**
 * Build a ThetanutsClient scoped to a specific wallet's RFQ keystore.
 *
 * No signer is attached — the prepare service NEVER signs. Every method we
 * call is `encode*` (pure calldata construction) or a read; the SDK never
 * touches a private key on our behalf. The KeyStorageProvider only stores
 * the ECDH key used for RFQ offer encryption, which is application-layer
 * crypto and unrelated to wallet signing.
 */
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

export { BASE_CHAIN_ID };
