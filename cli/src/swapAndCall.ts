/**
 * Client-side rules and aggregator plumbing for `OptionFactory.swapAndCall`.
 *
 * Lives in the CLI rather than the SDK on purpose: the SDK already ships
 * `encodeSwapAndCall`, which is all the on-chain surface this needs. Everything
 * here is policy — what to reject before signing, and how to source a route —
 * and policy that would drag a third-party HTTP dependency into a published
 * library.
 *
 * ## Contract semantics encoded here
 *
 * `swapAndCall(swapRouter, swapSrcToken, swapDstToken, swapSrcAmount,
 * swapCallData, selfCallData)` has two mutually exclusive paths:
 *
 * **Wrap path** (`swapRouter == address(0)`): the factory calls
 * `swapDstToken.call{value: msg.value}("")`, hitting WETH's `receive()`. It
 * wraps `msg.value` — **not** `swapSrcAmount`, which it never reads on this
 * path. No approval, no aggregator, 1:1.
 *
 * **Swap path** (`swapRouter != address(0)`): the router must be in the
 * factory's `authorizedRouters` allowlist, `msg.value` must be 0 (else
 * `NativeTokenNotAllowedForSwap`), and the factory itself does
 * `safeTransferFrom(msg.sender -> factory, swapSrcAmount)`, approves the
 * router, and calls it.
 *
 * The consequence that trips everyone up: **the factory executes the swap, not
 * the user.** So the user approves the *factory*, and the route must be built
 * with `sender = recipient = factory`. {@link buildKyberSwapCallData} forces
 * both and will not accept them as arguments.
 *
 * ## Do not port this to `OptionBook.swapAndFillOrder`
 *
 * The book-side equivalent inverts the recipient rule, verified against
 * `thetanuts_v4:src/options/OptionBook.sol` (deployed revision `b867c01f`) and
 * confirmed by `eth_call` probes against the live contract:
 *
 * - It never names a destination token — no `swapDstToken` param, and **no
 *   destination-side balance check at all**. After the swap it fills the order,
 *   and `_createOption` pulls the premium with
 *   `safeTransferFrom(taker -> maker, ...)` — i.e. from the taker's **wallet**.
 *   So the route needs `sender = OptionBook` (the book holds and approves the
 *   source tokens) but `recipient = the taker`.
 * - It is `nonpayable`: no wrap path, no native ETH, ERC-20 sources only.
 * - Its only invariant is a one-sided floor on the *source* token
 *   (`balanceAfter >= balanceBefore`); unconsumed source tokens are refunded to
 *   `msg.sender`. It uses the same `factory.authorizedRouters` allowlist.
 *
 * The danger this creates: because the book checks nothing on the destination
 * side, a route mis-built with `recipient = OptionBook` **does not necessarily
 * revert**. If the taker's wallet independently holds enough of the premium
 * token, the fill succeeds and the swap output is stranded in the book with no
 * rescue path. The same mistake on the factory path merely reverts
 * `BalanceIncorrect`. Any port must make sender/recipient explicit parameters
 * of {@link buildKyberSwapCallData}, which hardcodes the factory for both.
 */

import { Interface, isAddress } from 'ethers';
import type { SwapAndCallParams } from '@thetanuts-finance/thetanuts-client';

/** Sentinel used by the contract for "native asset" / "no router". */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * KyberSwap MetaAggregationRouterV2 on Base.
 *
 * A default, not a source of truth: the factory's `authorizedRouters` allowlist
 * is, and callers must check it at runtime. A stale value here fails closed —
 * the contract reverts `UnauthorizedRouter`, it can never misroute funds.
 */
export const KYBER_ROUTER_BASE = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';

/** Default aggregator slippage tolerance, in basis points (1%). */
export const DEFAULT_SWAP_SLIPPAGE_BPS = 100;

/** Refuse slippage above this without an explicit override. */
export const MAX_SWAP_SLIPPAGE_BPS = 500;

/**
 * Extra deterioration tolerated between the quote the user confirmed and the
 * route actually broadcast.
 *
 * The CLI re-quotes after the confirmation prompt, so the broadcast route is
 * never the previewed one. Without a floor carried across that boundary the
 * only remaining check is "does it cover the deposit", which a refreshed quote
 * can satisfy at a far worse rate than the user approved.
 *
 * A floor of exactly the previewed minimum would abort on any downward tick —
 * roughly half of all runs — so the previewed minimum is quoted this much
 * lower than the slippage tolerance alone would imply, and that single figure
 * is both what the preview displays and what the broadcast enforces.
 */
export const MAX_QUOTE_DRIFT_BPS = 50;

/**
 * Default route deadline. Deliberately short: unlike a browser form, the CLI
 * broadcasts seconds after quoting, so a long window only widens the
 * staleness/MEV surface for no benefit.
 */
export const DEFAULT_SWAP_DEADLINE_SECONDS = 300;

/**
 * Ceiling on a single aggregator round-trip. Without it a stalled connection
 * hangs the CLI indefinitely — including on the broadcast path, after the
 * approval has already mined.
 */
const KYBER_TIMEOUT_MS = 15_000;

const KYBER_API_BY_CHAIN: Record<number, string> = {
  8453: 'https://aggregator-api.kyberswap.com/base/api/v1',
};

/** Aggregator failure, carrying enough detail to tell a 429 from a 500. */
export class KyberError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KyberError';
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Facts about the self-call that the contract cross-checks against the swap. */
export interface SwapAndCallContext {
  /**
   * The collateral token the self-call requires (`params.collateral` for an
   * RFQ). `swapDstToken` must equal this or the contract reverts
   * `TokenMismatch`.
   */
  collateral: string;
  /**
   * `existingOptionAddress` from the RFQ params. Must be zero — the contract
   * reverts `SwapAndRFQNotAllowedForExistingOptions` otherwise.
   */
  existingOptionAddress?: string;
  /**
   * The chain's wrapped-native token (WETH). When set, the wrap path
   * additionally requires `swapDstToken` to equal it: the factory funds that
   * path with `swapDstToken.call{value: msg.value}("")`, which only succeeds
   * against a contract with a payable `receive()`. A USDC or cbBTC destination
   * passes every other check and then reverts `WrapperTransferFailed`.
   */
  wrapToken?: string;
}

function isZeroAddress(addr: string | undefined): boolean {
  return !addr || addr.toLowerCase() === ZERO_ADDRESS;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function requireAddress(value: string, field: string): void {
  if (!isAddress(value)) throw new Error(`${field} is not a valid address: ${value}`);
}

/**
 * Validate `swapAndCall` parameters against the contract's branch rules before
 * spending gas on a revert.
 *
 * Each check corresponds to a `revert` in `OptionFactory.swapAndCall` or
 * `routeSelfCall`, surfacing a named, readable error instead of an opaque
 * `BalanceIncorrect` from the node. Two checks are deliberately stricter than
 * the contract, rejecting encodings that are legal but always a caller mistake:
 * a wrap-path `swapSrcAmount` that is neither 0 nor `value`, and a wrap-path
 * destination other than `context.wrapToken`.
 *
 * It cannot check amounts: the contract requires the swap output to cover the
 * self-call's deposit, and nothing in {@link SwapAndCallContext} carries that
 * figure. See {@link buildKyberSwapCallData} for who owns that check.
 */
export function validateSwapAndCallParams(
  params: SwapAndCallParams,
  context: SwapAndCallContext
): void {
  requireAddress(params.swapRouter, 'swapRouter');
  requireAddress(params.swapSrcToken, 'swapSrcToken');
  requireAddress(params.swapDstToken, 'swapDstToken');
  requireAddress(context.collateral, 'collateral');

  const value = params.value ?? 0n;

  // routeSelfCall slices selfCallData[:4]; anything shorter reverts on the slice
  // itself, before any readable error is produced.
  if (!params.selfCallData || params.selfCallData.replace(/^0x/, '').length < 8) {
    throw new Error('selfCallData must carry at least a 4-byte function selector.');
  }

  // routeSelfCall checks `swapDstToken != params.collateral` on every supported
  // selector.
  if (!sameAddress(params.swapDstToken, context.collateral)) {
    throw new Error(
      `swapDstToken (${params.swapDstToken}) must equal the self-call collateral ` +
        `(${context.collateral}). The contract reverts TokenMismatch otherwise.`
    );
  }

  if (!isZeroAddress(context.existingOptionAddress)) {
    throw new Error(
      'swapAndCall cannot be used to close an existing option: existingOptionAddress ' +
        'must be zero (contract reverts SwapAndRFQNotAllowedForExistingOptions).'
    );
  }

  if (isZeroAddress(params.swapRouter)) {
    // ---- Wrap path -------------------------------------------------------
    if (context.wrapToken && !sameAddress(params.swapDstToken, context.wrapToken)) {
      throw new Error(
        `Native ETH can only be wrapped into ${context.wrapToken}, not ${params.swapDstToken}. ` +
          'The factory wraps by calling the destination token with msg.value, which reverts ' +
          'WrapperTransferFailed on a token without a payable receive(). Pay with an ERC-20 instead.'
      );
    }
    if (!isZeroAddress(params.swapSrcToken)) {
      throw new Error('Wrap path (swapRouter = 0x0) requires swapSrcToken = 0x0 (native asset).');
    }
    if (params.swapCallData && params.swapCallData !== '0x') {
      throw new Error('Wrap path (swapRouter = 0x0) takes no swap calldata; pass "0x".');
    }
    if (value <= 0n) {
      throw new Error(
        'Wrap path requires a non-zero `value`. The contract wraps msg.value, not ' +
          'swapSrcAmount — a zero value wraps nothing and reverts BalanceIncorrect.'
      );
    }
    // The contract never reads swapSrcAmount on this path, so 0 (the natural
    // "unused" encoding) and `value` (the mirrored encoding) are both fine. Any
    // other number is a caller mistake worth surfacing rather than honouring.
    if (params.swapSrcAmount !== 0n && params.swapSrcAmount !== value) {
      throw new Error(
        `Wrap path: swapSrcAmount (${params.swapSrcAmount}) must be 0 or equal value (${value}). ` +
          'The contract wraps msg.value and ignores swapSrcAmount.'
      );
    }
    return;
  }

  // ---- Swap path ---------------------------------------------------------
  if (value > 0n) {
    throw new Error(
      'Native ETH cannot be used on the swap path — the contract reverts ' +
        'NativeTokenNotAllowedForSwap when msg.value > 0 and a router is set. Native ETH ' +
        'only works when the collateral is WETH (wrap path).'
    );
  }
  if (isZeroAddress(params.swapSrcToken)) {
    throw new Error(
      'Swap path requires an ERC-20 swapSrcToken; 0x0 is the native sentinel and is ' +
        'only valid on the wrap path.'
    );
  }
  if (!params.swapCallData || params.swapCallData === '0x') {
    throw new Error('Swap path requires non-empty swapCallData.');
  }
  if (params.swapSrcAmount <= 0n) {
    throw new Error('Swap path requires swapSrcAmount > 0.');
  }
  if (sameAddress(params.swapSrcToken, params.swapDstToken)) {
    // The retained deposit means the source balance cannot return to its
    // starting value, so the closing invariant always reverts BalanceIncorrect.
    throw new Error(
      'swapSrcToken and swapDstToken are identical — no swap is needed, and the ' +
        "contract's closing balance invariant would revert BalanceIncorrect."
    );
  }
}

// ---------------------------------------------------------------------------
// KyberSwap aggregator
// ---------------------------------------------------------------------------

/**
 * A quote from the aggregator. `routeSummary` is opaque and must be handed back
 * to {@link buildKyberSwapCallData} verbatim.
 */
export interface KyberRoute {
  /** Opaque route payload — pass verbatim to the build step. */
  routeSummary: unknown;
  /** Source amount, in source-token decimals. */
  amountIn: bigint;
  /** Expected destination amount, in destination-token decimals. */
  amountOut: bigint;
  /** USD value of the input, per the aggregator (0 if unpriced). */
  amountInUsd: number;
  /** USD value of the output, per the aggregator (0 if unpriced). */
  amountOutUsd: number;
  /**
   * Implied price impact in basis points, floored at 0, or `null` when the
   * aggregator returned no USD pricing for the input.
   *
   * The distinction matters: `null` is *unknown*, not *zero*. Collapsing the
   * two would silently disable the price-impact rail on exactly the illiquid
   * tokens it exists to catch. Callers must treat `null` as "cannot verify"
   * and refuse rather than pass.
   */
  priceImpactBps: number | null;
}

/** Built swap calldata, ready to hand to `swapAndCall`. */
export interface KyberSwapCallData {
  /** Calldata for `swapAndCall`'s `swapCallData`. */
  swapCallData: string;
  /** Router the calldata targets. Must be in `authorizedRouters`. */
  routerAddress: string;
  /** Expected destination amount at build time. */
  amountOut: bigint;
  /**
   * The minimum the router will actually enforce, **read out of
   * `swapCallData`** rather than derived from the response's plaintext
   * `amountOut`.
   *
   * `swapAndCall` has no minimum-output parameter, so this floor is the only
   * one that exists on-chain. Taking it from the decoded calldata rather than
   * the plaintext figure is the difference between a number the aggregator
   * claims and a number it is bound to.
   */
  minAmountOut: bigint;
  /** Unix seconds after which the route is no longer valid. */
  deadline: number;
}

/**
 * Parse a token amount from an aggregator response.
 *
 * `BigInt()` alone accepts far more than the API is allowed to return, and
 * throws a bare `SyntaxError` on the rest. Requiring a plain non-negative
 * integer string rejects negatives, decimals, hex, and whitespace with a
 * message that names the aggregator as the source.
 */
function parseKyberAmount(value: string | undefined, field: string): bigint {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    throw new KyberError(`KyberSwap returned a malformed ${field}: ${String(value)}`);
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Router calldata decoding
// ---------------------------------------------------------------------------

/**
 * `SwapDescriptionV2`, the argument every MetaAggregationRouterV2 entrypoint
 * carries and the only part of the calldata this needs to read.
 */
const KYBER_SWAP_DESCRIPTION =
  '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, ' +
  'address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, ' +
  'uint256 minReturnAmount, uint256 flags, bytes permit)';

const KYBER_EXECUTION_PARAMS =
  `(address callTarget, address approveTarget, bytes targetData, ${KYBER_SWAP_DESCRIPTION} desc, ` +
  'bytes clientData)';

/**
 * The router entrypoints the aggregator is allowed to return.
 *
 * Selectors, pinned against the verified Base deployment: `swap` `0xe21fd0e9`,
 * `swapGeneric` `0x59e50fed`, `swapSimpleMode` `0x8af033fb`. Anything else
 * fails closed — an unknown encoding cannot be bound to the trade the user
 * approved, and refusing costs a re-run rather than funds.
 */
const KYBER_ROUTER_INTERFACE = new Interface([
  `function swap(${KYBER_EXECUTION_PARAMS} execution) returns (uint256 returnAmount, uint256 gasUsed)`,
  `function swapGeneric(${KYBER_EXECUTION_PARAMS} execution) returns (uint256 returnAmount, uint256 gasUsed)`,
  `function swapSimpleMode(address caller, ${KYBER_SWAP_DESCRIPTION} desc, bytes executorData, ` +
    'bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)',
]);

/** The fields of a decoded router call that this CLI checks. */
export interface DecodedKyberSwap {
  /** Router entrypoint name, e.g. `swap`. */
  functionName: string;
  srcToken: string;
  dstToken: string;
  /** Where the router sends the output — must be the OptionFactory. */
  dstReceiver: string;
  /** Source amount the router will pull. */
  amount: bigint;
  /** The minimum the router enforces on-chain. The only real guarantee. */
  minReturnAmount: bigint;
  feeReceivers: string[];
  feeAmounts: bigint[];
}

/**
 * Decode the executable calldata the aggregator returned.
 *
 * `/route/build` returns both a plaintext `amountOut` and the bytes that
 * actually run. Only the bytes bind: the plaintext figure is a claim, and
 * nothing on-chain checks it. This reads the claim's counterpart out of the
 * calldata so {@link buildKyberSwapCallData} can compare the two.
 */
export function decodeKyberSwapCallData(swapCallData: string): DecodedKyberSwap {
  let parsed;
  try {
    parsed = KYBER_ROUTER_INTERFACE.parseTransaction({ data: swapCallData });
  } catch (err) {
    throw new KyberError('KyberSwap returned calldata that could not be decoded.', { cause: err });
  }
  if (!parsed) {
    throw new KyberError(
      `KyberSwap returned an unsupported router selector (${swapCallData.slice(0, 10)}). ` +
        'Only swap, swapGeneric and swapSimpleMode can be verified before signing.'
    );
  }

  // swap/swapGeneric wrap the descriptor in SwapExecutionParams; swapSimpleMode
  // passes it as its second argument. Same struct either way.
  const desc = parsed.name === 'swapSimpleMode' ? parsed.args[1] : parsed.args[0].desc;

  return {
    functionName: parsed.name,
    srcToken: desc.srcToken as string,
    dstToken: desc.dstToken as string,
    dstReceiver: desc.dstReceiver as string,
    amount: desc.amount as bigint,
    minReturnAmount: desc.minReturnAmount as bigint,
    feeReceivers: [...(desc.feeReceivers as string[])],
    feeAmounts: [...(desc.feeAmounts as bigint[])],
  };
}

function kyberBaseUrl(chainId: number): string {
  const base = KYBER_API_BY_CHAIN[chainId];
  if (!base) throw new Error(`No KyberSwap aggregator configured for chain ${chainId}.`);
  return base;
}

/**
 * Errors that must survive the network catch untouched: our own typed errors,
 * plus caller-driven cancellation. `AbortSignal.timeout()` rejects with
 * `TimeoutError`, not `AbortError`, so both names are needed.
 */
function isPassthroughError(err: unknown): boolean {
  if (err instanceof KyberError) return true;
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Fetch a swap route for funding collateral.
 *
 * Best-effort by design: this calls a third-party HTTP API, so treat failures as
 * recoverable. Nothing here touches the chain.
 */
export async function fetchKyberRoute(args: {
  chainId: number;
  /** ERC-20 being spent (never the native sentinel — use the wrap path). */
  tokenIn: string;
  /** The option's collateral token. */
  tokenOut: string;
  /** Amount to spend, in `tokenIn` decimals. */
  amountIn: bigint;
  /** Optional AbortSignal. Abort and timeout rejections propagate unwrapped. */
  signal?: AbortSignal;
}): Promise<KyberRoute> {
  requireAddress(args.tokenIn, 'tokenIn');
  requireAddress(args.tokenOut, 'tokenOut');
  if (args.amountIn <= 0n) throw new Error('amountIn must be greater than zero.');
  if (sameAddress(args.tokenIn, args.tokenOut)) {
    throw new Error('tokenIn and tokenOut are identical — no swap is needed.');
  }

  const url =
    `${kyberBaseUrl(args.chainId)}/routes` +
    `?tokenIn=${args.tokenIn}&tokenOut=${args.tokenOut}&amountIn=${args.amountIn.toString()}`;

  let json: {
    code?: number;
    message?: string;
    data?: {
      routeSummary?: {
        amountIn?: string;
        amountOut?: string;
        amountInUsd?: string;
        amountOutUsd?: string;
      };
    };
  };
  try {
    const res = await fetch(url, { signal: args.signal ?? AbortSignal.timeout(KYBER_TIMEOUT_MS) });
    if (!res.ok) throw new KyberError(`KyberSwap /routes returned HTTP ${res.status}.`);
    json = (await res.json()) as typeof json;
  } catch (err) {
    // Rethrow our own typed errors (the !res.ok branch above) and abort/timeout
    // signals untouched — re-wrapping them would erase the HTTP status and make
    // a 429 indistinguishable from a 500.
    if (isPassthroughError(err)) throw err;
    throw new KyberError('KyberSwap /routes request failed.', { cause: err });
  }

  if (json.code !== 0 || !json.data?.routeSummary?.amountOut) {
    throw new KyberError(json.message ?? 'KyberSwap found no route for this pair and amount.');
  }

  const rs = json.data.routeSummary;

  // The aggregator echoes the amount it actually routed. A mismatch means the
  // quote describes a different trade than the one requested, so every check
  // downstream of it — deposit coverage, price impact, the confirmed floor —
  // would be measuring the wrong thing.
  const routedAmountIn = parseKyberAmount(rs.amountIn, 'amountIn');
  if (routedAmountIn !== args.amountIn) {
    throw new KyberError(
      `KyberSwap quoted a route for ${routedAmountIn} but ${args.amountIn} was requested.`
    );
  }

  const amountInUsd = Number(rs.amountInUsd ?? 0);
  const amountOutUsd = Number(rs.amountOutUsd ?? 0);
  // Unusable pricing -> null, never 0. See KyberRoute.priceImpactBps.
  //
  // Both sides must be finite and non-negative, not just the input: a `NaN`
  // output makes the impact itself `NaN`, and every comparison against `NaN`
  // is false, so the rail would pass the route instead of rejecting it. An
  // `Infinity` output floors to a 0% impact and passes just as quietly.
  const pricingUsable =
    Number.isFinite(amountInUsd) &&
    amountInUsd > 0 &&
    Number.isFinite(amountOutUsd) &&
    amountOutUsd >= 0;
  const priceImpactBps = pricingUsable
    ? Math.max(0, Math.round(((amountInUsd - amountOutUsd) / amountInUsd) * 10_000))
    : null;

  return {
    routeSummary: rs,
    amountIn: routedAmountIn,
    amountOut: parseKyberAmount(rs.amountOut, 'amountOut'),
    amountInUsd,
    amountOutUsd,
    priceImpactBps,
  };
}

/**
 * Turn a route into swap calldata for `swapAndCall`.
 *
 * `sender` and `recipient` are both forced to the OptionFactory and are
 * deliberately **not** parameters. The factory executes the router call and
 * checks its own destination-token balance before and after, so a route built
 * for the user's wallet would deliver the output to the wrong address and trip
 * the closing balance invariant.
 *
 * **The caller owns the amount check.** The contract requires the swap output to
 * cover the self-call's deposit — an RFQ's `requesterDeposit`, or the shortfall
 * on an early settlement — and reverts `BalanceIncorrect` after the swap has
 * already run if it does not. Compare {@link KyberSwapCallData.minAmountOut}
 * against that figure before signing; nothing here can do it for you.
 *
 * Pass `expectedRouter` to assert the aggregator returned the router you expect.
 * That is a sanity check, not a security boundary — the real guarantee is the
 * factory's `authorizedRouters` allowlist, which fails closed.
 *
 * **The returned calldata is decoded and bound before it is handed back.** The
 * allowlist proves the bytes go to the right router; it says nothing about what
 * they instruct that router to do. `srcToken`, `dstToken` and `route.amountIn`
 * are checked against the descriptor the router will read, along with the
 * destination receiver and the fee arrays, so a response cannot quietly
 * describe a different trade than the one that was quoted.
 */
export async function buildKyberSwapCallData(args: {
  chainId: number;
  /** Route from {@link fetchKyberRoute}, passed through verbatim. */
  route: KyberRoute;
  /** OptionFactory address — becomes both sender and recipient. */
  optionFactory: string;
  /** Token being spent. Bound against the decoded calldata. */
  srcToken: string;
  /** Token being received. Bound against the decoded calldata. */
  dstToken: string;
  /** Slippage tolerance in bps. Defaults to {@link DEFAULT_SWAP_SLIPPAGE_BPS}. */
  slippageBps?: number;
  /** Route lifetime in seconds. Defaults to {@link DEFAULT_SWAP_DEADLINE_SECONDS}. */
  deadlineSeconds?: number;
  /** Set to allow slippage above {@link MAX_SWAP_SLIPPAGE_BPS}. */
  allowHighSlippage?: boolean;
  /** Assert the aggregator returns this router. */
  expectedRouter?: string;
  signal?: AbortSignal;
}): Promise<KyberSwapCallData> {
  requireAddress(args.optionFactory, 'optionFactory');

  const slippageBps = args.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS;
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('slippageBps must be between 0 and 10000.');
  }
  if (slippageBps > MAX_SWAP_SLIPPAGE_BPS && !args.allowHighSlippage) {
    throw new Error(
      `slippageBps ${slippageBps} exceeds the ${MAX_SWAP_SLIPPAGE_BPS} bps safety cap. ` +
        'Pass --force-slippage to override.'
    );
  }

  const deadline =
    Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? DEFAULT_SWAP_DEADLINE_SECONDS);

  let json: {
    code?: number;
    message?: string;
    data?: { data?: string; routerAddress?: string; amountOut?: string };
  };
  try {
    const res = await fetch(`${kyberBaseUrl(args.chainId)}/route/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeSummary: args.route.routeSummary,
        // Both forced to the factory — see the doc comment above.
        sender: args.optionFactory,
        recipient: args.optionFactory,
        slippageTolerance: slippageBps,
        deadline,
        source: 'thetanuts-cli',
      }),
      signal: args.signal ?? AbortSignal.timeout(KYBER_TIMEOUT_MS),
    });
    if (!res.ok) throw new KyberError(`KyberSwap /route/build returned HTTP ${res.status}.`);
    json = (await res.json()) as typeof json;
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    throw new KyberError('KyberSwap /route/build request failed.', { cause: err });
  }

  if (json.code !== 0 || !json.data?.data || !json.data.routerAddress) {
    throw new KyberError(json.message ?? 'KyberSwap route build failed.');
  }

  if (args.expectedRouter && !sameAddress(json.data.routerAddress, args.expectedRouter)) {
    throw new Error(
      `KyberSwap returned router ${json.data.routerAddress} but ${args.expectedRouter} was ` +
        'expected. Verify it against OptionFactory.authorizedRouters before using it.'
    );
  }

  const amountOut = parseKyberAmount(json.data.amountOut, 'amountOut');
  const decoded = decodeKyberSwapCallData(json.data.data);

  // Bind the executable bytes to the trade that was quoted. Everything above
  // this point trusts the response's plaintext fields; from here nothing does.
  if (!sameAddress(decoded.srcToken, args.srcToken)) {
    throw new KyberError(
      `KyberSwap calldata spends ${decoded.srcToken} but ${args.srcToken} was requested.`
    );
  }
  if (!sameAddress(decoded.dstToken, args.dstToken)) {
    throw new KyberError(
      `KyberSwap calldata buys ${decoded.dstToken} but ${args.dstToken} was requested.`
    );
  }
  if (!sameAddress(decoded.dstReceiver, args.optionFactory)) {
    // The factory checks its own balance before and after, so output sent
    // anywhere else reverts BalanceIncorrect — after the swap has run.
    throw new KyberError(
      `KyberSwap calldata sends the output to ${decoded.dstReceiver}, not the OptionFactory ` +
        `(${args.optionFactory}).`
    );
  }
  if (decoded.amount !== args.route.amountIn) {
    throw new KyberError(
      `KyberSwap calldata swaps ${decoded.amount} but the quote was for ${args.route.amountIn}.`
    );
  }
  // Fee receivers are the one field that can divert value while every other
  // check still passes. This CLI has no way to display or cap a fee, so the
  // only safe policy is to refuse routes that carry one.
  if (decoded.feeReceivers.length > 0 || decoded.feeAmounts.some((fee) => fee > 0n)) {
    throw new KyberError(
      'KyberSwap calldata carries a router-level fee, which this CLI cannot display or cap. ' +
        'Refusing to sign it.'
    );
  }

  return {
    swapCallData: json.data.data,
    routerAddress: json.data.routerAddress,
    amountOut,
    // The decoded floor, not `amountOut * (1 - slippage)`. Those two agree on
    // an honest response and diverge on exactly the one that matters.
    minAmountOut: decoded.minReturnAmount,
    deadline,
  };
}
