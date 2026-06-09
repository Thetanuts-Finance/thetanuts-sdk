/**
 * Transport-agnostic core functions for every prepare action.
 *
 * Each *Core function takes (args, deps) and returns a CoreResult — a
 * discriminated union of success (with a PrepareResponse) or failure
 * (with an HTTP-style status + a SafeError). Both transports translate
 * this result to their wire format:
 *
 *   - HTTP routes (src/routes/*.ts) wrap each core in an Express adapter
 *     that pulls req.body + Authorization header, calls the core, and
 *     writes res.json(...) with the right status.
 *   - MCP tools (src/mcp.ts) wrap each core in a tool handler that takes
 *     the structured input, calls the core, and returns the MCP-shaped
 *     response.
 *
 * The Zod schemas are also re-exported from here so MCP tool registration
 * can advertise them as JSON-Schema. Every schema must validate input
 * inside the core (HTTP layer's pre-validation is convenience, not
 * correctness — the core is always the trust boundary).
 */

import { z } from 'zod';
import type { JsonRpcProvider } from 'ethers';
import type { ThetanutsClient, RFQBuilderParams } from '@thetanuts-finance/thetanuts-client';
import type { PrepareResponse, PreparedCall } from './types.js';
import { BASE_CHAIN_ID, buildClient } from './sdk.js';
import { maybeApproveCall } from './allowance.js';
import type { SqliteKeystore } from './keystore.js';
import { AuthStore, authMessage } from './auth.js';
import { verifyPersonalSign } from './viemClient.js';
import { toClientError, safeError, sanitizeForLog, type SafeError } from './errors.js';

// ============================================================================
// Public result type
// ============================================================================

export type CoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: SafeError };

export type PrepareCoreResult = CoreResult<PrepareResponse>;
export type GenericCoreResult<T> = CoreResult<T>;

// ============================================================================
// Shared deps
// ============================================================================

export interface OpenDeps {
  /** Shared read-only ThetanutsClient — fine for stateless encode-only routes. */
  sharedClient: ThetanutsClient;
}

export interface AuthedDeps {
  provider: JsonRpcProvider;
  keystore: SqliteKeystore;
  /** Validated wallet address — for keystore-touching cores. */
  authedWallet: string;
}

// ============================================================================
// Auth verification (used by MCP transport; HTTP uses the existing middleware)
// ============================================================================

const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const UINT_DECIMAL = z.string().regex(/^\d+$/).max(78);
const MAX_UINT256 = (1n << 256n) - 1n;
const HEX_STRING = z.string().regex(/^0x[0-9a-fA-F]+$/);
const SIGNATURE_HEX = HEX_STRING.max(132);
const ECDH_PUBLIC_KEY_HEX = z.string().regex(/^0x(?:02|03)[0-9a-fA-F]{64}$/);
const ENCRYPTED_OFFER_HEX = HEX_STRING.max(4096);
const MAX_UNIX_TIMESTAMP = 4_102_444_800; // 2100-01-01

const AUTH_BLOCK_SHAPE = z.object({
  wallet: ADDRESS,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{32}$/),
  sig: SIGNATURE_HEX,
});

/**
 * Verify an auth block (wallet, nonce, sig). Mirrors the HTTP middleware's
 * checks but accepts a structured object instead of an Authorization header.
 * Atomically consumes the nonce on success.
 *
 * Returns the lowercased wallet on success, or a SafeError-shaped failure.
 */
export async function verifyAuthBlock(
  authStore: AuthStore,
  input: unknown,
  expectedWallet?: string,
): Promise<
  | { ok: true; wallet: string }
  | { ok: false; status: number; error: SafeError }
> {
  const parsed = AUTH_BLOCK_SHAPE.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: 401,
      error: safeError('AUTH_MALFORMED', 'auth must be { wallet, nonce, sig } with hex-encoded fields'),
    };
  }
  const { wallet, nonce, sig } = parsed.data;

  if (expectedWallet && expectedWallet.toLowerCase() !== wallet.toLowerCase()) {
    return {
      ok: false,
      status: 401,
      error: safeError('AUTH_WALLET_MISMATCH', 'auth wallet does not match request body.from'),
    };
  }

  const expiresAt = authStore.lookupExpiresAt(wallet, nonce);
  if (expiresAt === null) {
    return { ok: false, status: 401, error: safeError('AUTH_INVALID', 'Nonce not recognized') };
  }
  const signedMessage = authMessage(wallet, nonce, expiresAt);

  // viem handles EOA (ECDSA) AND smart-wallet (ERC-1271 / ERC-6492) sigs.
  // Base Account's WebAuthn-wrapped sigs are recovered transparently.
  const isValid = await verifyPersonalSign(
    wallet as `0x${string}`,
    signedMessage,
    sig as `0x${string}`,
  );
  if (!isValid) {
    return { ok: false, status: 401, error: safeError('AUTH_BAD_SIGNATURE', 'Signature does not verify against wallet') };
  }
  if (!authStore.consumeOnce(wallet, nonce)) {
    return { ok: false, status: 401, error: safeError('AUTH_REPLAY', 'Nonce already consumed or expired') };
  }
  return { ok: true, wallet: wallet.toLowerCase() };
}

// ============================================================================
// auth_challenge (open — no auth required to mint a nonce)
// ============================================================================

export const AuthChallengeArgs = z.object({
  wallet: ADDRESS,
});
export type AuthChallengeArgs = z.infer<typeof AuthChallengeArgs>;

export function authChallengeCore(args: AuthChallengeArgs, authStore: AuthStore) {
  return { ok: true as const, data: authStore.issue(args.wallet) };
}

// ============================================================================
// erc20: approve (auth-gated, constrained calldata)
// ============================================================================

export const ApproveArgs = z.object({
  auth: z.object({
    wallet: ADDRESS,
    nonce: z.string().regex(/^0x[0-9a-fA-F]{32}$/),
    sig: SIGNATURE_HEX,
  }),
  from: ADDRESS,
  token: ADDRESS,
  spender: ADDRESS,
  amount: UINT_DECIMAL,
});
export type ApproveArgs = z.infer<typeof ApproveArgs>;

export function approveCore(args: ApproveArgs, deps: OpenDeps): PrepareCoreResult {
  const amount = BigInt(args.amount);
  if (amount <= 0n || amount >= MAX_UINT256) {
    return {
      ok: false,
      status: 400,
      error: safeError('INVALID_PARAMS', 'prepare_approve requires a positive finite allowance amount; max/infinite approvals are not supported'),
    };
  }

  const factory = deps.sharedClient.chainConfig.contracts.optionFactory?.toLowerCase();
  if (!factory || args.spender.toLowerCase() !== factory) {
    return {
      ok: false,
      status: 400,
      error: safeError('INVALID_SPENDER', 'prepare_approve only supports the current OptionFactory spender'),
    };
  }

  const configuredToken = Object.values(deps.sharedClient.chainConfig.tokens).some(
    (token) => token.address.toLowerCase() === args.token.toLowerCase(),
  );
  if (!configuredToken) {
    return {
      ok: false,
      status: 400,
      error: safeError('INVALID_TOKEN', 'prepare_approve only supports configured Thetanuts collateral tokens'),
    };
  }

  const encoded = deps.sharedClient.erc20.encodeApprove(
    args.token,
    args.spender,
    amount,
  );
  return {
    ok: true,
    data: {
      chain: 'base',
      calls: [
        {
          step: 'approve',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
        },
      ],
    },
  };
}

// ============================================================================
// rfq: request_rfq (auth-gated, keystore-touching)
// ============================================================================

const PRODUCT = z.enum([
  'PUT', 'CALL',
  'CALL_SPREAD', 'PUT_SPREAD',
  'CALL_FLY', 'PUT_FLY',
  'CALL_CONDOR', 'PUT_CONDOR',
  'IRON_CONDOR',
]);
type Product = z.infer<typeof PRODUCT>;
const POSITIVE_DECIMAL_STRING = z.string()
  .regex(/^\d+(\.\d+)?$/)
  .max(32)
  .refine((value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
  }, 'must be a positive decimal string');
const PRICE_SCALE = 100_000_000n;
const PRODUCT_STRIKE_COUNT: Record<Product, number> = {
  PUT: 1,
  CALL: 1,
  CALL_SPREAD: 2,
  PUT_SPREAD: 2,
  CALL_FLY: 3,
  PUT_FLY: 3,
  CALL_CONDOR: 4,
  PUT_CONDOR: 4,
  IRON_CONDOR: 4,
};

export const RequestRfqArgs = z.object({
  from: ADDRESS,
  product: PRODUCT,
  underlying: z.enum(['ETH', 'BTC']),
  collateral: z.enum(['USDC', 'WETH', 'cbBTC', 'aBasWETH', 'aBascbBTC', 'aBasUSDC', 'cbDOGE', 'cbXRP']),
  strikes: z.array(POSITIVE_DECIMAL_STRING).min(1).max(4),
  numContracts: POSITIVE_DECIMAL_STRING,
  expiry: z.number().int().positive().max(MAX_UNIX_TIMESTAMP),
  /**
   * Offer window end as Unix timestamp seconds. Default (when caller omits) is
   * 120 seconds in the future. The earlier 30s default (Phase A.7) lost too
   * many first-time RFQs to MM watcher polling cycles — by the time a quoting
   * bot saw the new event, the window had closed. 120s is short enough to
   * keep the "find out quickly" UX intact, long enough for any realistic MM
   * latency. Callers can still override.
   */
  offerEndTimestamp: z.number().int().positive().max(MAX_UNIX_TIMESTAMP).optional(),
  isRequestingLongPosition: z.boolean(),
  reservePrice: POSITIVE_DECIMAL_STRING.optional(),
  isIronCondor: z.boolean().optional(),
}).superRefine((args, ctx) => {
  const expected = PRODUCT_STRIKE_COUNT[args.product];
  if (args.strikes.length !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['strikes'],
      message: `${args.product} requires exactly ${expected} strike${expected === 1 ? '' : 's'}`,
    });
  }
  if (args.product !== 'IRON_CONDOR' && args.isIronCondor === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['isIronCondor'],
      message: 'isIronCondor may only be true when product is IRON_CONDOR',
    });
  }
  if (args.product === 'IRON_CONDOR' && args.isIronCondor === false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['isIronCondor'],
      message: 'IRON_CONDOR always uses the iron-condor implementation',
    });
  }
  if (args.isRequestingLongPosition && args.reservePrice === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reservePrice'],
      message: 'BUY RFQs require a positive reservePrice',
    });
  }
});
export type RequestRfqArgs = z.infer<typeof RequestRfqArgs>;

export async function requestRfqCore(
  args: RequestRfqArgs,
  deps: AuthedDeps,
): Promise<PrepareCoreResult> {
  const userClient = buildClient({
    provider: deps.provider,
    keyStorageProvider: deps.keystore.scopedProvider(BASE_CHAIN_ID, deps.authedWallet),
    wallet: deps.authedWallet,
  });

  const keypair = await userClient.rfqKeys.getOrCreateKeyPair();

  // 120-second default offer window. Allow caller override.
  const nowSec = Math.floor(Date.now() / 1000);
  const offerEndTimestamp = args.offerEndTimestamp ?? nowSec + 120;
  const offerDeadlineMinutes = Math.max(
    0.1, // 6 seconds minimum to avoid degenerate "already expired" RFQs
    (offerEndTimestamp - nowSec) / 60,
  );

  const strikes = args.strikes.map(parseFloat);
  const optionType: RFQBuilderParams['optionType'] = args.product.startsWith('PUT') ? 'PUT' : 'CALL';
  const isIronCondor = args.product === 'IRON_CONDOR';

  const rfqRequest = userClient.optionFactory.buildRFQRequest({
    requester: deps.authedWallet as `0x${string}`,
    underlying: args.underlying,
    optionType,
    strikes: strikes.length === 1 ? strikes[0]! : strikes,
    expiry: args.expiry,
    numContracts: parseFloat(args.numContracts),
    isLong: args.isRequestingLongPosition,
    offerDeadlineMinutes,
    collateralToken: args.collateral,
    reservePrice: args.reservePrice ? parseFloat(args.reservePrice) : undefined,
    requesterPublicKey: keypair.compressedPublicKey,
    isIronCondor,
  });

  const encoded = userClient.optionFactory.encodeRequestForQuotation(rfqRequest);

  const calls: PreparedCall[] = [];
  // Auto-prepend the right ERC-20 approve for both SELL and BUY paths.
  // SELL: product max loss. BUY: total reserve price plus a small buffer so
  // low-precision decimal input does not under-approve after builder rounding.
  const collateralToken = rfqRequest.params.collateral;
  const required = args.isRequestingLongPosition
    ? withBuffer(rfqRequest.reservePrice, 5)
    : computeCollateralRequired(rfqRequest.params, args.product);
  if (required > 0n) {
    const approval = await maybeApproveCall(userClient, {
      owner: deps.authedWallet,
      token: collateralToken,
      spender: encoded.to,
      required,
    });
    calls.push(...approval);
  }

  calls.push({
    step: 'requestForQuotation',
    to: encoded.to as `0x${string}`,
    data: encoded.data as `0x${string}`,
    value: '0x0',
  });

  return { ok: true, data: { chain: 'base', calls } };
}

function withBuffer(value: bigint, percent: number): bigint {
  return value + (value * BigInt(percent)) / 100n;
}

function computeCollateralRequired(params: {
  strikes: bigint[];
  numContracts: bigint;
  isRequestingLongPosition: boolean;
}, product: Product): bigint {
  if (params.isRequestingLongPosition) return 0n;

  const strike = (index: number): bigint => {
    const value = params.strikes[index];
    if (value === undefined) {
      throw new Error(`${product} requires strike index ${index}`);
    }
    return value;
  };
  const width = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
  const priceCollateral = (priceWidth: bigint): bigint => (priceWidth * params.numContracts) / PRICE_SCALE;

  switch (product) {
    case 'CALL':
      // Inverse call collateral is the underlying amount itself.
      return params.numContracts;
    case 'PUT':
      return priceCollateral(strike(0));
    case 'CALL_SPREAD':
    case 'PUT_SPREAD':
    case 'CALL_FLY':
    case 'PUT_FLY':
      return priceCollateral(width(strike(1), strike(0)));
    case 'CALL_CONDOR':
    case 'PUT_CONDOR':
      return priceCollateral(width(strike(1), strike(0)));
    case 'IRON_CONDOR': {
      const putWidth = width(strike(1), strike(0));
      const callWidth = width(strike(3), strike(2));
      return priceCollateral(putWidth > callWidth ? putWidth : callWidth);
    }
  }
}

// ============================================================================
// rfq: make_offer (auth-gated — step 1, returns EIP-712 payload to sign)
// ============================================================================

export const MakeOfferArgs = z.object({
  from: ADDRESS,
  quotationId: UINT_DECIMAL,
  offerAmount: UINT_DECIMAL,
});
export type MakeOfferArgs = z.infer<typeof MakeOfferArgs>;

export interface MakeOfferStep1Result {
  step: 'sign-then-submit';
  signingPayload: unknown;
  /** Tool name to call after signing. */
  nextTool: 'prepare_make_offer_with_signature';
  submitArgs: {
    from: string;
    quotationId: string;
    offerAmount: string;
    nonce: string;
    signingKey: string;
    encryptedOffer: string;
  };
}

export async function makeOfferCore(
  args: MakeOfferArgs,
  deps: AuthedDeps,
): Promise<GenericCoreResult<MakeOfferStep1Result>> {
  const userClient = buildClient({
    provider: deps.provider,
    keyStorageProvider: deps.keystore.scopedProvider(BASE_CHAIN_ID, deps.authedWallet),
    wallet: deps.authedWallet,
  });

  let requesterPubKey: string;
  try {
    requesterPubKey = await userClient.api.getRequesterPublicKey(args.quotationId);
  } catch (err) {
    // Distinguish the multi-factory indexer bug from a genuine "not found".
    // Both come up the catch path but the LLM-facing remediation differs:
    // mismatches mean the indexer returned a wrong-factory row and the
    // caller should be told the id is from a stale deployment.
    const code = (err as { code?: string })?.code;
    if (code === 'RFQ_FACTORY_MISMATCH') {
      console.error('RFQ_FACTORY_MISMATCH on getRequesterPublicKey', sanitizeForLog(err));
      return {
        ok: false,
        status: 409,
        error: safeError(
          'RFQ_FACTORY_MISMATCH',
          `RFQ ${args.quotationId} is on a predecessor factory, not the current one. The indexer returned a stale row. Confirm the id was created on the current factory before retrying.`,
        ),
      };
    }
    console.error('RFQ_NOT_FOUND lookup failure', sanitizeForLog(err));
    return {
      ok: false,
      status: 404,
      error: safeError('RFQ_NOT_FOUND', `RFQ ${args.quotationId} not found or has no public key`),
    };
  }

  await userClient.rfqKeys.getOrCreateKeyPair();

  const nonce = userClient.rfqKeys.generateNonce();
  const encrypted = await userClient.rfqKeys.encryptOffer(
    BigInt(args.offerAmount),
    nonce,
    requesterPubKey,
  );

  let signingPayload;
  try {
    signingPayload = await userClient.optionFactory.buildOfferTypedData({
      quotationId: BigInt(args.quotationId),
      offerAmount: BigInt(args.offerAmount),
      offeror: args.from,
      nonce,
    });
  } catch (err) {
    const { client, log } = toClientError(err);
    console.error('TYPEHASH_MISMATCH or build failure', sanitizeForLog(log));
    if (client.code === 'CONTRACT_REVERT' || /OFFER_TYPEHASH/.test(client.error)) {
      return { ok: false, status: 500, error: safeError('TYPEHASH_MISMATCH', client.error) };
    }
    return { ok: false, status: 500, error: client };
  }

  return {
    ok: true,
    data: {
      step: 'sign-then-submit',
      signingPayload,
      nextTool: 'prepare_make_offer_with_signature',
      submitArgs: {
        from: args.from,
        quotationId: args.quotationId,
        offerAmount: args.offerAmount,
        nonce: nonce.toString(),
        signingKey: encrypted.signingKey,
        encryptedOffer: encrypted.ciphertext,
      },
    },
  };
}

// ============================================================================
// rfq: make_offer_with_signature (open — step 2, just encodes calldata)
// ============================================================================

export const MakeOfferWithSignatureArgs = z.object({
  from: ADDRESS,
  quotationId: UINT_DECIMAL,
  signature: SIGNATURE_HEX,
  signingKey: ECDH_PUBLIC_KEY_HEX,
  encryptedOffer: ENCRYPTED_OFFER_HEX,
});
export type MakeOfferWithSignatureArgs = z.infer<typeof MakeOfferWithSignatureArgs>;

export function makeOfferWithSignatureCore(
  args: MakeOfferWithSignatureArgs,
  deps: OpenDeps,
): PrepareCoreResult {
  const encoded = deps.sharedClient.optionFactory.encodeMakeOfferForQuotation({
    quotationId: BigInt(args.quotationId),
    signature: args.signature,
    signingKey: args.signingKey,
    encryptedOffer: args.encryptedOffer,
  });
  return {
    ok: true,
    data: {
      chain: 'base',
      calls: [
        {
          step: 'makeOfferForQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
        },
      ],
    },
  };
}

// ============================================================================
// rfq: settle_rfq (open — single tx, no decryption)
// ============================================================================

export const SettleRfqArgs = z.object({
  from: ADDRESS,
  quotationId: UINT_DECIMAL,
});
export type SettleRfqArgs = z.infer<typeof SettleRfqArgs>;

export function settleRfqCore(args: SettleRfqArgs, deps: OpenDeps): PrepareCoreResult {
  const encoded = deps.sharedClient.optionFactory.encodeSettleQuotation(BigInt(args.quotationId));
  return {
    ok: true,
    data: {
      chain: 'base',
      calls: [
        {
          step: 'settleQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
        },
      ],
    },
  };
}

// ============================================================================
// rfq: settle_rfq_early (auth-gated — decrypts requester's stored ECDH key)
// ============================================================================

export const SettleRfqEarlyArgs = z.object({
  from: ADDRESS,
  quotationId: UINT_DECIMAL,
  offerorAddress: ADDRESS,
});
export type SettleRfqEarlyArgs = z.infer<typeof SettleRfqEarlyArgs>;

export async function settleRfqEarlyCore(
  args: SettleRfqEarlyArgs,
  deps: AuthedDeps,
): Promise<PrepareCoreResult> {
  const userClient = buildClient({
    provider: deps.provider,
    keyStorageProvider: deps.keystore.scopedProvider(BASE_CHAIN_ID, deps.authedWallet),
    wallet: deps.authedWallet,
  });

  let offer;
  try {
    offer = await userClient.api.getOffer(args.quotationId, args.offerorAddress);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'RFQ_FACTORY_MISMATCH') {
      console.error('RFQ_FACTORY_MISMATCH on getOffer', sanitizeForLog(err));
      return {
        ok: false,
        status: 409,
        error: safeError(
          'RFQ_FACTORY_MISMATCH',
          `RFQ ${args.quotationId} is on a predecessor factory, not the current one. The indexer returned a stale row.`,
        ),
      };
    }
    console.error('OFFER_NOT_FOUND lookup failure', sanitizeForLog(err));
    return {
      ok: false,
      status: 404,
      error: safeError(
        'OFFER_NOT_FOUND',
        `No offer from ${args.offerorAddress} on RFQ ${args.quotationId}`,
      ),
    };
  }

  let decrypted;
  try {
    decrypted = await userClient.rfqKeys.decryptOffer(
      offer.signedOfferForRequester,
      offer.signingKey,
    );
  } catch (err) {
    console.error('DECRYPT_FAILED', sanitizeForLog(err));
    return {
      ok: false,
      status: 500,
      error: safeError(
        'DECRYPT_FAILED',
        'Could not decrypt the offer. The requester key in the keystore may not match the public key used at RFQ creation.',
      ),
    };
  }

  const encoded = userClient.optionFactory.encodeSettleQuotationEarly(
    BigInt(args.quotationId),
    decrypted.offerAmount,
    decrypted.nonce,
    args.offerorAddress,
  );

  return {
    ok: true,
    data: {
      chain: 'base',
      calls: [
        {
          step: 'settleQuotationEarly',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
        },
      ],
    },
  };
}

// ============================================================================
// rfq: cancel_rfq and cancel_offer (open — single tx)
// ============================================================================

export const CancelRfqArgs = z.object({
  from: ADDRESS,
  quotationId: UINT_DECIMAL,
});
export type CancelRfqArgs = z.infer<typeof CancelRfqArgs>;

export function cancelRfqCore(args: CancelRfqArgs, deps: OpenDeps): PrepareCoreResult {
  const encoded = deps.sharedClient.optionFactory.encodeCancelQuotation(BigInt(args.quotationId));
  return {
    ok: true,
    data: {
      chain: 'base',
      calls: [
        {
          step: 'cancelQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
        },
      ],
    },
  };
}

// ============================================================================
// rfq: suggest_reserve_price (open — pricing oracle)
// ============================================================================

export const SuggestReservePriceArgs = z.object({
  product: z.enum([
    'PUT', 'CALL',
    'CALL_SPREAD', 'PUT_SPREAD',
    'CALL_FLY', 'PUT_FLY',
    'CALL_CONDOR', 'PUT_CONDOR',
    'IRON_CONDOR',
  ]),
  underlying: z.enum(['ETH', 'BTC']),
  strikes: z.array(POSITIVE_DECIMAL_STRING).min(1).max(4),
  expiry: z.number().int().positive().max(MAX_UNIX_TIMESTAMP),
  isRequestingLongPosition: z.boolean(),
});
export type SuggestReservePriceArgs = z.infer<typeof SuggestReservePriceArgs>;

export interface SuggestReservePriceResult {
  suggested: string | null;
  /** Per-contract IV-implied fair-value mid in collateral units. */
  midPerContract: string | null;
  /** Multiplier applied to mid: 1.5 for BUY (you pay more), 0.5 for SELL. */
  bias: number;
  /** Underlying-symbol ticker the mid was derived from, when applicable. */
  ticker?: string;
  notes: string;
}

export async function suggestReservePriceCore(
  args: SuggestReservePriceArgs,
  deps: OpenDeps,
): Promise<GenericCoreResult<SuggestReservePriceResult>> {
  // Multi-leg products: bail with a useful note. (Spread/condor mids are
  // structure-specific; supporting them properly means wiring
  // getSpreadPricing/getCondorPricing/getButterflyPricing, which is a
  // larger surface — out of scope for this fix.)
  if (args.product !== 'PUT' && args.product !== 'CALL') {
    return {
      ok: true,
      data: {
        suggested: null,
        midPerContract: null,
        bias: args.isRequestingLongPosition ? 1.5 : 0.5,
        notes:
          'Multi-leg structures need structure-specific pricing — call mmPricing.getSpreadPricing / getCondorPricing / getButterflyPricing manually and pass the per-contract result × 1.5 (BUY) or × 0.5 (SELL) as reservePrice.',
      },
    };
  }

  const strike = parseFloat(args.strikes[0]!);
  if (!isFinite(strike) || strike <= 0) {
    return { ok: false, status: 400, error: safeError('INVALID_PARAMS', 'strike must be a positive number') };
  }

  const isCall = args.product === 'CALL';
  // Vanilla-leg ticker. mmPricing builds the same shape internally.
  const ticker = buildTickerLocal(args.underlying, args.expiry, strike, isCall);

  let pricing;
  try {
    pricing = await deps.sharedClient.mmPricing.getTickerPricing(ticker);
  } catch (err) {
    console.error('NO_IV_POINT', { ticker, err: sanitizeForLog(err) });
    return {
      ok: true,
      data: {
        suggested: null,
        midPerContract: null,
        bias: args.isRequestingLongPosition ? 1.5 : 0.5,
        ticker,
        notes: `IV surface has no point for ${ticker}. Refuse the RFQ and tell the user MMs are not quoting this strike/expiry. Pick a strike closer to spot or a more standard expiry (next Friday 8 UTC).`,
      },
    };
  }

  // Per-contract mid in *USD*. feeAdjustedAsk/Bid are dimensionless fractions
  // of underlying, so multiply by spot to get USD per contract. The downstream
  // collateral-token conversion (USDC vs WETH) is handled inside the RFQ
  // builder — we surface the suggestion in USD-per-contract which is the same
  // unit the LLM passes back as `reservePrice`.
  const spot = pricing.underlyingPrice;
  const askUsd = pricing.feeAdjustedAsk * spot;
  const bidUsd = pricing.feeAdjustedBid * spot;
  const midUsd = (askUsd + bidUsd) / 2;

  if (!isFinite(midUsd) || midUsd <= 0) {
    return {
      ok: true,
      data: {
        suggested: null,
        midPerContract: null,
        bias: args.isRequestingLongPosition ? 1.5 : 0.5,
        ticker,
        notes: 'IV surface returned a zero or non-finite mid. Refuse the RFQ at this strike.',
      },
    };
  }

  const bias = args.isRequestingLongPosition ? 1.5 : 0.5;
  const suggested = midUsd * bias;
  // 4 decimal places — enough resolution for sub-dollar premiums without
  // tripping the SDK's float→bigint precision floor.
  const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

  return {
    ok: true,
    data: {
      suggested: round4(suggested).toString(),
      midPerContract: round4(midUsd).toString(),
      bias,
      ticker,
      notes: args.isRequestingLongPosition
        ? `BUY (long): reserve set 50% above the IV mid (${round4(midUsd)} USD per contract). Total escrow when you call prepare_request_rfq with this reservePrice will be ${round4(suggested)} × numContracts USD.`
        : `SELL (short): reserve set at 50% of the IV mid (${round4(midUsd)} USD per contract) so MMs have room to bid up. Total minimum premium you'd accept = ${round4(suggested)} × numContracts USD.`,
    },
  };
}

function buildTickerLocal(underlying: string, expiry: number, strike: number, isCall: boolean): string {
  const date = new Date(expiry * 1000);
  const day = date.getUTCDate().toString();
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = monthNames[date.getUTCMonth()];
  const year = (date.getUTCFullYear() % 100).toString();
  return `${underlying}-${day}${month}${year}-${strike}-${isCall ? 'C' : 'P'}`;
}

export function cancelOfferCore(args: CancelRfqArgs, deps: OpenDeps): PrepareCoreResult {
  const encoded = deps.sharedClient.optionFactory.encodeCancelOfferForQuotation(
    BigInt(args.quotationId),
  );
  return {
    ok: true,
    data: {
      chain: 'base',
      calls: [
        {
          step: 'cancelOfferForQuotation',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
        },
      ],
    },
  };
}
