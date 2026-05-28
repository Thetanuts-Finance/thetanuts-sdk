/**
 * Zendfi-namespaced typed error union for the collar + loan surface.
 *
 * Layered additively on top of `ThetanutsError`: every `ZendfiError` is
 * still a `ThetanutsError`, so existing `instanceof ThetanutsError` and
 * `error.code === 'CONTRACT_REVERT'` consumers keep working unchanged.
 * New consumers gain exhaustive `switch (err.code)` over the Zendfi
 * surface plus `humanMessage` / `actionable` / `docsUrl` for UI surfacing.
 *
 * Locked in [TNU-21](/TNU/issues/TNU-21#document-plan) §1.1.
 */

import { ThetanutsError, type ThetanutsErrorCode } from './errors.js';

/**
 * String literal union of every recoverable Zendfi error code.
 *
 * Codes are split into two groups:
 * - **Zendfi-specific** (e.g. `PRICING_ONLY_MODE`, `NO_MATCHING_STRIKE`):
 *   surface area introduced by the collar / loan integrator flow.
 * - **Reused from `ThetanutsErrorCode`**: `CONTRACT_REVERT`,
 *   `SIGNER_REQUIRED`, `INSUFFICIENT_ALLOWANCE`, `INSUFFICIENT_BALANCE`.
 *   For these, `ZendfiError` still writes the same string into
 *   `ThetanutsError.code`, so `error.code === 'CONTRACT_REVERT'` keeps
 *   matching both base-class and Zendfi consumers.
 */
export type ZendfiErrorCode =
  | 'PRICING_ONLY_MODE'
  | 'PRICING_UNAVAILABLE'
  | 'NO_MATCHING_STRIKE'
  | 'CAP_ABOVE_MAX'
  | 'EXPIRY_IN_PAST'
  | 'EXPIRY_TOO_SOON'
  | 'INVALID_CAP'
  | 'INVALID_PARAM'
  | 'INSUFFICIENT_COLLATERAL'
  | 'INSUFFICIENT_LOAN_BUDGET'
  | 'OFFER_DECRYPTION_FAILED'
  | 'QUOTATION_NOT_FOUND'
  | 'QUOTATION_ALREADY_SETTLED'
  | 'INDEXER_UNAVAILABLE'
  | 'CONTRACT_REVERT'
  | 'SIGNER_REQUIRED'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'INSUFFICIENT_BALANCE';

/**
 * Constructor options for `ZendfiError`.
 *
 * `cause`, `meta`, and `docsUrl` are optional. Pass `undefined` only
 * by omission — the field is typed for an absent key, not a present
 * `undefined` (project runs with `exactOptionalPropertyTypes: true`).
 */
export interface ZendfiErrorOptions {
  readonly cause?: unknown;
  readonly meta?: Record<string, unknown>;
  readonly docsUrl?: string;
}

/**
 * Structural shape every `ZendfiError` exposes. Useful as a `readonly`
 * view when you want to log or render the error without holding the
 * full `Error` instance.
 */
export interface ZendfiErrorShape<C extends ZendfiErrorCode = ZendfiErrorCode> {
  readonly namespace: 'zendfi';
  readonly code: C;
  readonly humanMessage: string;
  readonly actionable: string;
  readonly docsUrl?: string;
  readonly meta?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Typed error class for the Zendfi collar + loan surface.
 *
 * Extends `ThetanutsError`, so existing base-class `instanceof` and
 * `error.code` checks keep working. The `code` field is narrowed to
 * `ZendfiErrorCode` so consumers can exhaustively `switch (err.code)`
 * after a `isZendfiError(err)` guard.
 *
 * Prefer the typed factories in `zendfiErr` over calling this
 * constructor directly — they enforce a non-empty `humanMessage`
 * and `actionable` at the call site.
 *
 * @example
 * ```ts
 * try {
 *   await client.collar.requestLoan(req);
 * } catch (err) {
 *   if (isZendfiError(err)) {
 *     switch (err.code) {
 *       case 'PRICING_ONLY_MODE':
 *         showBanner(err.humanMessage, err.actionable);
 *         break;
 *       case 'NO_MATCHING_STRIKE':
 *         pickAnotherCap(err.actionable);
 *         break;
 *       // ... exhaustive
 *     }
 *   }
 * }
 * ```
 */
export class ZendfiError<C extends ZendfiErrorCode = ZendfiErrorCode>
  extends ThetanutsError
  implements ZendfiErrorShape<C>
{
  readonly namespace = 'zendfi' as const;
  // `code` is narrowed to `C` (a subset of `ZendfiErrorCode`). The base class
  // types `code` as `ThetanutsErrorCode`, which is a different union: the four
  // reused codes overlap, the rest are Zendfi-only strings the base type does
  // not list. We still write the same string into `ThetanutsError.code` via
  // `super(...)`, so `error.code === 'CONTRACT_REVERT'` keeps matching for
  // both base-class and Zendfi consumers. The structural override below is
  // safe and intentional.
  // @ts-expect-error TS2416: see comment above — additive narrowing.
  declare readonly code: C;
  readonly humanMessage: string;
  readonly actionable: string;
  readonly docsUrl?: string;

  constructor(code: C, humanMessage: string, actionable: string, opts?: ZendfiErrorOptions) {
    super(code as ThetanutsErrorCode, humanMessage, opts?.cause, opts?.meta);
    this.name = 'ZendfiError';
    this.humanMessage = humanMessage;
    this.actionable = actionable;
    if (opts?.docsUrl !== undefined) {
      this.docsUrl = opts.docsUrl;
    }
  }
}

/**
 * Type guard: returns true when `e` is a `ZendfiError`.
 *
 * Narrows to the generic `ZendfiError` (any code). Inside the guard
 * you can further narrow on `err.code` with an exhaustive switch.
 */
export function isZendfiError(e: unknown): e is ZendfiError {
  return e instanceof ZendfiError;
}

const DOCS_BASE = '/zendfi/errors';

function docsAnchor(code: ZendfiErrorCode): string {
  return `${DOCS_BASE}#${code.toLowerCase()}`;
}

/**
 * Typed factories for every `ZendfiErrorCode`. Each factory writes a
 * non-empty `humanMessage` and `actionable` so call sites get product-
 * copy quality errors without composing strings themselves.
 *
 * Use these instead of `new ZendfiError(...)` so the code string can't
 * be typoed at the call site.
 *
 * @example
 * ```ts
 * if (capUsd <= 0) throw zendfiErr.invalidCap(capUsd);
 * ```
 */
export const zendfiErr = {
  pricingOnlyMode: (operation: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'PRICING_ONLY_MODE',
      "Collar contract isn't deployed on this chain yet; pricing-only mode active.",
      `Use client.collar.quickQuote() for quotes, or wait for the collar-v12 deploy before calling ${operation}.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('PRICING_ONLY_MODE'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { operation, ...(opts?.meta ?? {}) },
      },
    ),

  pricingUnavailable: (asset: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'PRICING_UNAVAILABLE',
      `No live pricing data for ${asset}.`,
      'Retry shortly — the Deribit feed is empty or stale for this asset. Persistent failures usually mean the upstream pricing service is down.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('PRICING_UNAVAILABLE'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { asset, ...(opts?.meta ?? {}) },
      },
    ),

  noMatchingStrike: (
    capUsd: number,
    availableStrikes: readonly number[],
    opts?: ZendfiErrorOptions,
  ) =>
    new ZendfiError(
      'NO_MATCHING_STRIKE',
      `No OTM put strike matches a cap of $${capUsd}.`,
      availableStrikes.length === 0
        ? 'No strikes available in the current Deribit chain — try a different expiry.'
        : `Pick a cap from the available strikes (closest: ${availableStrikes.slice(0, 5).join(', ')}) or choose a later expiry.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('NO_MATCHING_STRIKE'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { capUsd, availableStrikes, ...(opts?.meta ?? {}) },
      },
    ),

  capAboveMax: (capUsd: number, maxCapUsd: number, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'CAP_ABOVE_MAX',
      `Cap $${capUsd} exceeds the maximum supported cap of $${maxCapUsd}.`,
      `Lower the cap to at most $${maxCapUsd}, or call client.collar.getMaxCapStrike() to discover the current ceiling before quoting.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('CAP_ABOVE_MAX'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { capUsd, maxCapUsd, ...(opts?.meta ?? {}) },
      },
    ),

  expiryInPast: (expiryUnixSeconds: number, nowUnixSeconds: number, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'EXPIRY_IN_PAST',
      'Requested expiry is in the past.',
      'Pick an expiry at least one hour after the current block timestamp.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('EXPIRY_IN_PAST'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { expiryUnixSeconds, nowUnixSeconds, ...(opts?.meta ?? {}) },
      },
    ),

  expiryTooSoon: (expiryUnixSeconds: number, minOfferEndSeconds: number, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'EXPIRY_TOO_SOON',
      'Requested expiry is too close to the default offer window.',
      `Either push the expiry past ${new Date(minOfferEndSeconds * 1000).toISOString()}, or pass an explicit shorter offerEnd.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('EXPIRY_TOO_SOON'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { expiryUnixSeconds, minOfferEndSeconds, ...(opts?.meta ?? {}) },
      },
    ),

  invalidCap: (capUsd: number, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'INVALID_CAP',
      `Cap value $${capUsd} is invalid (must be > 0).`,
      'Pass a positive USD cap. For pricing-only flows you can sweep multiple caps via client.collar.getCapStrikeOptions().',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INVALID_CAP'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { capUsd, ...(opts?.meta ?? {}) },
      },
    ),

  // Generic parameter-validation factory for call sites that don't fit a more
  // specific code (e.g. `invalidCap`). Pass an `actionable` override in `opts`
  // when the default canned text doesn't carry enough remediation detail.
  invalidParam: (
    fieldName: string,
    reason: string,
    opts?: ZendfiErrorOptions & { actionable?: string },
  ) =>
    new ZendfiError(
      'INVALID_PARAM',
      `Invalid ${fieldName}: ${reason}.`,
      opts?.actionable ?? `Fix the ${fieldName} argument and retry. See the JSDoc on the calling method for accepted values.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INVALID_PARAM'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { fieldName, reason, ...(opts?.meta ?? {}) },
      },
    ),

  insufficientCollateral: (
    have: bigint,
    need: bigint,
    token: string,
    opts?: ZendfiErrorOptions,
  ) =>
    new ZendfiError(
      'INSUFFICIENT_COLLATERAL',
      `Wallet holds ${have.toString()} ${token} but needs ${need.toString()} to open this loan.`,
      `Top up the connected wallet with at least ${(need - have).toString()} more ${token} before retrying.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INSUFFICIENT_COLLATERAL'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { have: have.toString(), need: need.toString(), token, ...(opts?.meta ?? {}) },
      },
    ),

  insufficientLoanBudget: (
    minLoanUsd: number,
    achievableLoanUsd: number,
    opts?: ZendfiErrorOptions,
  ) =>
    new ZendfiError(
      'INSUFFICIENT_LOAN_BUDGET',
      `Requested minimum loan $${minLoanUsd} is above the achievable loan $${achievableLoanUsd} at current pricing.`,
      'Lower minLoan, increase collateral, or pick a deeper-OTM cap. Wider caps generally raise the achievable loan amount.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INSUFFICIENT_LOAN_BUDGET'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { minLoanUsd, achievableLoanUsd, ...(opts?.meta ?? {}) },
      },
    ),

  offerDecryptionFailed: (quotationId: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'OFFER_DECRYPTION_FAILED',
      'Failed to decrypt the maker offer for this quotation.',
      'The ECDH key on this client does not match the key used when the quotation was requested. Reuse the original key via the RFQ key manager, or request a new quotation.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('OFFER_DECRYPTION_FAILED'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { quotationId, ...(opts?.meta ?? {}) },
      },
    ),

  quotationNotFound: (quotationId: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'QUOTATION_NOT_FOUND',
      `Quotation ${quotationId} was not found on the coordinator.`,
      'Confirm the id was returned by requestLoan() on this chain, and that the coordinator address matches the chain config.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('QUOTATION_NOT_FOUND'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { quotationId, ...(opts?.meta ?? {}) },
      },
    ),

  quotationAlreadySettled: (quotationId: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'QUOTATION_ALREADY_SETTLED',
      `Quotation ${quotationId} is already settled and cannot be modified.`,
      'Use client.collar.getLoanState() to inspect the settled loan, or request a new quotation if you need a fresh offer.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('QUOTATION_ALREADY_SETTLED'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { quotationId, ...(opts?.meta ?? {}) },
      },
    ),

  indexerUnavailable: (endpoint: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'INDEXER_UNAVAILABLE',
      `Indexer at ${endpoint} returned a non-OK response or an unexpected schema.`,
      'Retry shortly. Persistent failures usually mean the indexer is redeploying — check the status page or fall back to on-chain reads.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INDEXER_UNAVAILABLE'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { endpoint, ...(opts?.meta ?? {}) },
      },
    ),

  contractRevert: (operation: string, reason?: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'CONTRACT_REVERT',
      reason !== undefined && reason.length > 0
        ? `Contract call ${operation} reverted: ${reason}`
        : `Contract call ${operation} reverted.`,
      'Inspect the cause for the raw revert data. Common causes: stale price feed, expired option, or a competing fill consuming the order.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('CONTRACT_REVERT'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { operation, ...(reason !== undefined ? { reason } : {}), ...(opts?.meta ?? {}) },
      },
    ),

  signerRequired: (operation: string, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'SIGNER_REQUIRED',
      `${operation} needs a connected signer.`,
      'Construct the SDK with a wallet-backed signer (e.g. wagmi connector) before calling write methods. Read-only RPCs can use a JsonRpcProvider instead.',
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('SIGNER_REQUIRED'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { operation, ...(opts?.meta ?? {}) },
      },
    ),

  insufficientAllowance: (
    token: string,
    spender: string,
    need: bigint,
    opts?: ZendfiErrorOptions,
  ) =>
    new ZendfiError(
      'INSUFFICIENT_ALLOWANCE',
      `Allowance for ${token} → ${spender} is below the required ${need.toString()}.`,
      `Call client.erc20.approve({ token: '${token}', spender: '${spender}', amount: ${need.toString()}n }) and wait for the tx to land before retrying.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INSUFFICIENT_ALLOWANCE'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { token, spender, need: need.toString(), ...(opts?.meta ?? {}) },
      },
    ),

  insufficientBalance: (token: string, have: bigint, need: bigint, opts?: ZendfiErrorOptions) =>
    new ZendfiError(
      'INSUFFICIENT_BALANCE',
      `Wallet holds ${have.toString()} ${token} but needs ${need.toString()}.`,
      `Top up the connected wallet with at least ${(need - have).toString()} more ${token} before retrying.`,
      {
        docsUrl: opts?.docsUrl ?? docsAnchor('INSUFFICIENT_BALANCE'),
        ...(opts?.cause !== undefined ? { cause: opts.cause } : {}),
        meta: { token, have: have.toString(), need: need.toString(), ...(opts?.meta ?? {}) },
      },
    ),
} as const;

/**
 * Compile-time check that `zendfiErr` covers every `ZendfiErrorCode`.
 *
 * `zendfiErr` is keyed by camelCase factory names rather than by code,
 * so we verify coverage by mapping factory return-types back to the
 * code union and asserting equality. If a code is added to
 * `ZendfiErrorCode` without a matching factory, this line fails to
 * type-check.
 */
type FactoryCodes = ReturnType<(typeof zendfiErr)[keyof typeof zendfiErr]>['code'];
type _AssertCoverage = [FactoryCodes] extends [ZendfiErrorCode]
  ? [ZendfiErrorCode] extends [FactoryCodes]
    ? true
    : ['MISSING_FACTORY_FOR', Exclude<ZendfiErrorCode, FactoryCodes>]
  : ['UNKNOWN_FACTORY_CODE', Exclude<FactoryCodes, ZendfiErrorCode>];
const _zendfiErrCoversAllCodes: _AssertCoverage = true;
void _zendfiErrCoversAllCodes;
