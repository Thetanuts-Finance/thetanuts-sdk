import type { Request, Response } from 'express';
import { z } from 'zod';
import type { JsonRpcProvider } from 'ethers';
import type { ThetanutsClient, RFQBuilderParams } from '@thetanuts-finance/thetanuts-client';
import type { PrepareResponse, PreparedTx } from '../types.js';
import { BASE_CHAIN_ID } from '../sdk.js';
import { maybeApproveTx } from '../allowance.js';
import type { SqliteKeystore } from '../keystore.js';
import { buildClient } from '../sdk.js';
import { toClientError, safeError } from '../errors.js';

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const BIG_NUM_STR = z.string().regex(/^\d+$/);

// ---------- request-rfq ----------

const PRODUCT = z.enum([
  'PUT', 'CALL',
  'CALL_SPREAD', 'PUT_SPREAD',
  'CALL_FLY', 'PUT_FLY',
  'CALL_CONDOR', 'PUT_CONDOR',
  'IRON_CONDOR',
  'RANGER',
]);

const RequestRFQBody = z.object({
  from: ADDRESS,
  product: PRODUCT,
  underlying: z.enum(['ETH', 'BTC']),
  collateral: z.enum(['USDC', 'WETH', 'cbBTC', 'aBasWETH', 'aBascbBTC', 'aBasUSDC', 'cbDOGE', 'cbXRP']),
  strikes: z.array(z.string().regex(/^[\d.]+$/)).min(1).max(4),
  numContracts: z.string().regex(/^[\d.]+$/),
  expiry: z.number().int().positive(),
  offerEndTimestamp: z.number().int().positive(),
  isRequestingLongPosition: z.boolean(),
  reservePrice: z.string().regex(/^[\d.]+$/).optional(),
});

export function requestRfqHandler(opts: { provider: JsonRpcProvider; keystore: SqliteKeystore }) {
  return async (req: Request, res: Response) => {
    const parsed = RequestRFQBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const body = parsed.data;
    // requireWalletAuth middleware guarantees this is set and matches body.from
    const authedWallet = (req as Request & { authenticatedWallet: string }).authenticatedWallet;

    const userClient = buildClient({
      provider: opts.provider,
      keyStorageProvider: opts.keystore.scopedProvider(BASE_CHAIN_ID, authedWallet),
      wallet: authedWallet,
    });

    // 1. Ensure the requester has an ECDH keypair (auto-stored in our keystore)
    const keypair = await userClient.rfqKeys.getOrCreateKeyPair();

    // 2. Map product → optionType / extras for buildRFQRequest
    const offerDeadlineMinutes = Math.max(
      1,
      Math.floor((body.offerEndTimestamp - Math.floor(Date.now() / 1000)) / 60),
    );

    const strikes = body.strikes.map(parseFloat);
    const isIronCondor = body.product === 'IRON_CONDOR';
    const isRanger = body.product === 'RANGER';
    const optionType: RFQBuilderParams['optionType'] = body.product.startsWith('PUT') ? 'PUT' : 'CALL';

    if (isRanger) {
      return res.status(400).json({
        ok: false,
        code: 'NOT_IMPLEMENTED_V1',
        error: 'RANGER RFQ requires a dedicated builder; not in v1 of the prepare service.',
      });
    }

    const rfqRequest = userClient.optionFactory.buildRFQRequest({
      requester: authedWallet as `0x${string}`,
      underlying: body.underlying,
      optionType,
      strikes: strikes.length === 1 ? strikes[0]! : strikes,
      expiry: body.expiry,
      numContracts: parseFloat(body.numContracts),
      isLong: body.isRequestingLongPosition,
      offerDeadlineMinutes,
      collateralToken: body.collateral,
      reservePrice: body.reservePrice ? parseFloat(body.reservePrice) : undefined,
      requesterPublicKey: keypair.compressedPublicKey,
      isIronCondor,
    });

    const encoded = userClient.optionFactory.encodeRequestForQuotation(rfqRequest);

    // 3. SELL positions need collateral approval to the OptionFactory.
    //    BUY positions don't (counterparty provides collateral).
    const transactions: PreparedTx[] = [];
    if (!body.isRequestingLongPosition) {
      const collateralToken = rfqRequest.params.collateral;
      const collateralRequired = computeCollateralRequired(rfqRequest.params);
      const approval = await maybeApproveTx(userClient, {
        owner: authedWallet,
        token: collateralToken,
        spender: encoded.to,
        required: collateralRequired,
      });
      transactions.push(...approval);
    }

    transactions.push({
      step: 'requestForQuotation',
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
      value: '0x0',
      chainId: BASE_CHAIN_ID,
    });

    res.json({ transactions } satisfies PrepareResponse);
  };
}

/**
 * Approximate collateral required for a SELL RFQ. Used only to gate the
 * approval step; the contract pulls the exact amount at settlement.
 * Formula matches the SDK's encodeRequestForQuotation docstring:
 *  - CALL/inverse: numContracts (1:1 with underlying)
 *  - PUT:          strike[max] * numContracts / 10^8
 * For spreads/condors we use the max-loss strike as a conservative bound.
 */
function computeCollateralRequired(params: {
  strikes: bigint[];
  numContracts: bigint;
  isRequestingLongPosition: boolean;
}): bigint {
  if (params.isRequestingLongPosition) return 0n;
  const maxStrike = params.strikes.reduce((a, b) => (a > b ? a : b), 0n);
  // PUT-like fallback: strike * size / 1e8. Overshoots CALL but MAX_UINT256
  // approval handles that anyway.
  return (maxStrike * params.numContracts) / 100_000_000n;
}

// ---------- make-offer (step 1: return EIP-712 payload to sign) ----------

const MakeOfferBody = z.object({
  from: ADDRESS,
  quotationId: BIG_NUM_STR,
  offerAmount: BIG_NUM_STR, // in collateral token base units
});

export function makeOfferHandler(opts: { provider: JsonRpcProvider; keystore: SqliteKeystore }) {
  return async (req: Request, res: Response) => {
    const parsed = MakeOfferBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const { from, quotationId, offerAmount } = parsed.data;
    const authedWallet = (req as Request & { authenticatedWallet: string }).authenticatedWallet;

    const userClient = buildClient({
      provider: opts.provider,
      keyStorageProvider: opts.keystore.scopedProvider(BASE_CHAIN_ID, authedWallet),
      wallet: authedWallet,
    });

    // 1. Read the requester's ECDH public key from the State API
    //    (hydrated from the QuotationRequested event).
    let requesterPubKey: string;
    try {
      requesterPubKey = await userClient.api.getRequesterPublicKey(quotationId);
    } catch (err) {
      console.error('RFQ_NOT_FOUND lookup failure', { err });
      return res.status(404).json(safeError('RFQ_NOT_FOUND', `RFQ ${quotationId} not found or has no public key`));
    }

    // 2. Ensure this offeror has an ECDH keypair (auto-stored in our keystore).
    await userClient.rfqKeys.getOrCreateKeyPair();

    // 3. Generate nonce + encrypt the offer for the requester.
    const nonce = userClient.rfqKeys.generateNonce();
    const encrypted = await userClient.rfqKeys.encryptOffer(
      BigInt(offerAmount),
      nonce,
      requesterPubKey,
    );

    // 4. Build the EIP-712 envelope. The builder verifies the on-chain
    //    OFFER_TYPEHASH and throws if the struct has drifted.
    let signingPayload;
    try {
      signingPayload = await userClient.optionFactory.buildOfferTypedData({
        quotationId: BigInt(quotationId),
        offerAmount: BigInt(offerAmount),
        offeror: from,
        nonce,
      });
    } catch (err) {
      const { client, log } = toClientError(err);
      console.error('TYPEHASH_MISMATCH or build failure', log);
      // Override the generic INTERNAL code with the more specific safe code
      // when the ThetanutsError carried a recognizable message.
      if (client.code === 'CONTRACT_REVERT' || /OFFER_TYPEHASH/.test(client.error)) {
        return res.status(500).json(safeError('TYPEHASH_MISMATCH', client.error));
      }
      return res.status(500).json(client);
    }

    // 5. Hand the signing payload + encrypted offer back. The LLM passes
    //    `signingPayload` to Base MCP's `sign` tool with `type: "typed_data"`,
    //    then calls /v1/prepare/make-offer-with-signature with the result.
    res.json({
      step: 'sign-then-submit',
      signingPayload,
      nextEndpoint: '/v1/prepare/make-offer-with-signature',
      // These values must be echoed back to step 2 verbatim — they're
      // baked into the encrypted blob the contract will store.
      submitArgs: {
        from,
        quotationId,
        offerAmount,
        nonce: nonce.toString(),
        signingKey: encrypted.signingKey,
        encryptedOffer: encrypted.ciphertext,
      },
    });
  };
}

// ---------- make-offer-with-signature (step 2: submit signed offer) ----------

const MakeOfferWithSigBody = z.object({
  from: ADDRESS,
  quotationId: BIG_NUM_STR,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  signingKey: z.string().regex(/^0x[0-9a-fA-F]+$/),
  encryptedOffer: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export function makeOfferWithSignatureHandler(client: ThetanutsClient) {
  return (req: Request, res: Response) => {
    const parsed = MakeOfferWithSigBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const { quotationId, signature, signingKey, encryptedOffer } = parsed.data;

    const encoded = client.optionFactory.encodeMakeOfferForQuotation({
      quotationId: BigInt(quotationId),
      signature,
      signingKey,
      encryptedOffer,
    });

    res.json({
      transactions: [
        {
          step: 'makeOfferForQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
          chainId: BASE_CHAIN_ID,
        },
      ],
    } satisfies PrepareResponse);
  };
}

// ---------- settle-rfq ----------

const SettleRfqBody = z.object({
  from: ADDRESS,
  quotationId: BIG_NUM_STR,
});

export function settleRfqHandler(client: ThetanutsClient) {
  return (req: Request, res: Response) => {
    const parsed = SettleRfqBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const { quotationId } = parsed.data;
    const encoded = client.optionFactory.encodeSettleQuotation(BigInt(quotationId));
    res.json({
      transactions: [
        {
          step: 'settleQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
          chainId: BASE_CHAIN_ID,
        },
      ],
    } satisfies PrepareResponse);
  };
}

// ---------- settle-rfq-early ----------

const SettleEarlyBody = z.object({
  from: ADDRESS,
  quotationId: BIG_NUM_STR,
  offerorAddress: ADDRESS,
});

export function settleRfqEarlyHandler(opts: { provider: JsonRpcProvider; keystore: SqliteKeystore }) {
  return async (req: Request, res: Response) => {
    const parsed = SettleEarlyBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const { from: _from, quotationId, offerorAddress } = parsed.data;
    const authedWallet = (req as Request & { authenticatedWallet: string }).authenticatedWallet;

    const userClient = buildClient({
      provider: opts.provider,
      keyStorageProvider: opts.keystore.scopedProvider(BASE_CHAIN_ID, authedWallet),
      wallet: authedWallet,
    });

    // 1. Fetch the offeror's encrypted offer (and their ephemeral signing
    //    key) from the State API — hydrated from the OfferMade event.
    let offer;
    try {
      offer = await userClient.api.getOffer(quotationId, offerorAddress);
    } catch (err) {
      console.error('OFFER_NOT_FOUND lookup failure', { err });
      return res.status(404).json(safeError('OFFER_NOT_FOUND', `No offer from ${offerorAddress} on RFQ ${quotationId}`));
    }

    // 2. Decrypt with the requester's stored ECDH key. Recovers
    //    `{ offerAmount, nonce }` — both needed by settleQuotationEarly.
    let decrypted;
    try {
      decrypted = await userClient.rfqKeys.decryptOffer(
        offer.signedOfferForRequester,
        offer.signingKey,
      );
    } catch (err) {
      console.error('DECRYPT_FAILED', { err });
      return res.status(500).json(safeError(
        'DECRYPT_FAILED',
        'Could not decrypt the offer. The requester key in the keystore may not match the public key used at RFQ creation.',
      ));
    }

    // 3. Encode settleQuotationEarly with the recovered values.
    const encoded = userClient.optionFactory.encodeSettleQuotationEarly(
      BigInt(quotationId),
      decrypted.offerAmount,
      decrypted.nonce,
      offerorAddress,
    );

    res.json({
      transactions: [
        {
          step: 'settleQuotationEarly',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
          chainId: BASE_CHAIN_ID,
        },
      ],
    } satisfies PrepareResponse);
  };
}

// ---------- cancel-rfq ----------

const CancelRfqBody = z.object({
  from: ADDRESS,
  quotationId: BIG_NUM_STR,
});

export function cancelRfqHandler(client: ThetanutsClient) {
  return (req: Request, res: Response) => {
    const parsed = CancelRfqBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const encoded = client.optionFactory.encodeCancelQuotation(BigInt(parsed.data.quotationId));
    res.json({
      transactions: [
        {
          step: 'cancelQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
          chainId: BASE_CHAIN_ID,
        },
      ],
    } satisfies PrepareResponse);
  };
}

// ---------- cancel-offer ----------

export function cancelOfferHandler(client: ThetanutsClient) {
  return (req: Request, res: Response) => {
    const parsed = CancelRfqBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const encoded = client.optionFactory.encodeCancelOfferForQuotation(BigInt(parsed.data.quotationId));
    res.json({
      transactions: [
        {
          step: 'cancelOfferForQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
          chainId: BASE_CHAIN_ID,
        },
      ],
    } satisfies PrepareResponse);
  };
}
