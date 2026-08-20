/**
 * `--pay-with` support for `rfq request`: fund an RFQ's collateral from a token
 * the user actually holds, atomically, via `OptionFactory.swapAndCall`.
 *
 * Two paths, chosen by the contract on `swapRouter == address(0)`:
 *
 * - **native** — send ETH, the factory wraps it to WETH 1:1. No approval, no
 *   aggregator. Only valid when the collateral *is* WETH.
 * - **erc20** — the factory pulls the token, swaps it through KyberSwap, and
 *   keeps the output as collateral. The user approves the **OptionFactory**,
 *   not the router, because the factory is what calls the router.
 *
 * A CLI quotes and broadcasts seconds apart, so the route is always fetched
 * fresh at the broadcast boundary rather than being carried through the
 * confirmation prompt. See {@link buildPayWithTransaction}.
 */

import { formatUnits } from 'ethers';
import type { ThetanutsClient, RFQRequest } from '@thetanuts-finance/thetanuts-client';
import {
  ZERO_ADDRESS,
  KYBER_ROUTER_BASE,
  DEFAULT_SWAP_SLIPPAGE_BPS,
  MAX_SWAP_SLIPPAGE_BPS,
  MAX_QUOTE_DRIFT_BPS,
  fetchKyberRoute,
  buildKyberSwapCallData,
  validateSwapAndCallParams,
  type KyberRoute,
} from './swapAndCall.js';

/** Default ceiling on aggregator price impact before we refuse to broadcast. */
export const DEFAULT_MAX_PRICE_IMPACT_BPS = 200;

export interface PayWithFlags {
  payWith?: string;
  payAmount?: string;
  slippageBps?: string;
  maxPriceImpactBps?: string;
  forceSlippage?: boolean;
}

/** The pay-with token, resolved against chain config. */
export interface ResolvedPayToken {
  kind: 'native' | 'erc20';
  /** Zero address for native ETH, else the ERC-20 address. */
  address: string;
  symbol: string;
  decimals: number;
}

/**
 * Resolve `--pay-with` (`eth`, a chain-config symbol like `USDC`, or a raw
 * 0x address) against the active chain.
 */
export function resolvePayToken(client: ThetanutsClient, spec: string): ResolvedPayToken {
  const raw = spec.trim();
  const lower = raw.toLowerCase();
  const cfg = client.chainConfig;

  if (lower === 'eth' || lower === 'native') {
    return { kind: 'native', address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 };
  }

  for (const token of Object.values(cfg.tokens)) {
    if (
      token.symbol.toLowerCase() === lower ||
      token.address.toLowerCase() === lower
    ) {
      return {
        kind: 'erc20',
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
      };
    }
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    // Unknown-but-valid address: decimals are read on-chain by the caller.
    return { kind: 'erc20', address: raw, symbol: raw, decimals: -1 };
  }

  const known = Object.values(cfg.tokens)
    .map((t) => t.symbol)
    .join(', ');
  throw new Error(
    `--pay-with "${spec}" is not recognised. Use "eth", a token address, or one of: ${known}.`
  );
}

/**
 * The amount the factory escrows from the requester *at request time*.
 *
 * Only a long (BUY) request escrows anything: the contract takes
 * `reservePrice` as the maximum total payment. A short (SELL) request escrows
 * nothing — its collateral is pulled from the seller at **settlement**, after a
 * maker fills. That is why {@link planPayWith} refuses the short side: there is
 * no request-time deposit for a swap to fund. Returns 0n there so the advisory
 * hint stays silent too.
 */
export async function requiredRequesterDeposit(
  _client: ThetanutsClient,
  req: RFQRequest
): Promise<bigint> {
  if (req.params.isRequestingLongPosition) return req.reservePrice;
  return 0n;
}

/**
 * Gate a route on aggregator price impact.
 *
 * Shared because it runs twice: once in {@link planPayWith} so the prompt is
 * honest, and again in {@link buildPayWithTransaction} against the refreshed
 * quote. Liquidity can drain while the confirmation prompt is open, and the
 * min-out re-check alone would not catch it.
 *
 * A `null` impact means the aggregator returned no USD pricing, not that the
 * impact was zero. That is treated as a refusal rather than a pass: it happens
 * on thin, unpriced tokens, which is precisely when the rail matters.
 */
function assertPriceImpactWithinLimit(
  route: KyberRoute,
  maxPriceImpactBps: number,
  forceSlippage: boolean,
  symbol: string
): void {
  if (forceSlippage) return;
  if (route.priceImpactBps === null) {
    throw new Error(
      `KyberSwap returned no USD pricing for ${symbol}, so price impact cannot be verified. ` +
        'This usually means the token is thinly traded. Pass --force-slippage to accept the ' +
        'route unchecked, or pay with a more liquid asset.'
    );
  }
  if (route.priceImpactBps > maxPriceImpactBps) {
    throw new Error(
      `Price impact ${(route.priceImpactBps / 100).toFixed(2)}% exceeds the ` +
        `${(maxPriceImpactBps / 100).toFixed(2)}% limit. Lower --pay-amount, raise ` +
        '--max-price-impact-bps, or pass --force-slippage to accept it.'
    );
  }
}

function parseBpsFlag(
  value: string | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10_000) {
    throw new Error(`${label} must be an integer between 0 and 10000 (got "${value}").`);
  }
  return n;
}

/** Everything the caller needs to preview, confirm, and then broadcast. */
export interface PayWithPlan {
  token: ResolvedPayToken;
  collateral: string;
  /** Chain-config symbol for {@link collateral}, when it maps to a known token. */
  collateralSymbol: string | null;
  collateralDecimals: number;
  /** What the factory must hold after the swap/wrap. */
  requiredDeposit: bigint;
  /** What the user spends, in pay-token decimals. */
  payAmount: bigint;
  /**
   * The floor the user is shown and agrees to at the confirmation prompt.
   *
   * The broadcast route is re-quoted after that prompt, so this is what makes
   * the confirmation mean something: {@link buildPayWithTransaction} refuses
   * any refreshed route whose on-chain minimum falls below it. Covering
   * {@link requiredDeposit} is necessary but not sufficient — the deposit can
   * sit far below the swap's expected output, and the contract refunds the
   * difference, so a much worse rate would still clear that bar alone.
   *
   * On the native path this is `payAmount` and nothing enforces it: the wrap is
   * 1:1 with no route and no re-quote, so there is no second price to compare
   * against. It is set for consistency, not as a live check.
   */
  confirmedMinOut: bigint;
  slippageBps: number;
  maxPriceImpactBps: number;
  forceSlippage: boolean;
  /** Non-null only on the erc20 path. */
  route: KyberRoute | null;
  /** Router the route will target (erc20 path only). */
  routerAddress: string | null;
  /** True once `authorizedRouters` has confirmed the router on-chain. */
  routerAuthorized: boolean;
}

/**
 * Quote the swap and check it against the RFQ's actual collateral requirement.
 *
 * This runs *before* the confirmation prompt so the user sees real numbers. The
 * route it returns is used for the preview only — {@link buildPayWithTransaction}
 * re-quotes at broadcast time.
 */
export async function planPayWith(
  client: ThetanutsClient,
  req: RFQRequest,
  flags: PayWithFlags
): Promise<PayWithPlan> {
  // Short requests escrow nothing at request time — the factory pulls
  // collateral at settlement — so there is no deposit for a swap to fund, and
  // swapping now would spend fees on a round-trip the contract refuses.
  if (!req.params.isRequestingLongPosition) {
    throw new Error(
      '--pay-with supports BUY requests only. A SELL request escrows no collateral when it is ' +
        'submitted — the factory pulls it at settlement, after a maker fills — so there is ' +
        'nothing to fund now.\n' +
        'Approve the collateral token before settlement instead (see --ensure-allowance), or ' +
        'acquire it separately.'
    );
  }

  const token = resolvePayToken(client, flags.payWith as string);
  const collateral = req.params.collateral;
  const collateralSymbol =
    Object.values(client.chainConfig.tokens).find(
      (t) => t.address.toLowerCase() === collateral.toLowerCase()
    )?.symbol ?? null;
  const collateralDecimals = Number(await client.erc20.getDecimals(collateral));
  const requiredDeposit = await requiredRequesterDeposit(client, req);

  if (requiredDeposit <= 0n) {
    throw new Error(
      'This request has a zero requester deposit, so there is nothing to fund. ' +
        'Drop --pay-with and submit it directly.'
    );
  }

  const slippageBps = parseBpsFlag(flags.slippageBps, DEFAULT_SWAP_SLIPPAGE_BPS, '--slippage-bps');
  const maxPriceImpactBps = parseBpsFlag(
    flags.maxPriceImpactBps,
    DEFAULT_MAX_PRICE_IMPACT_BPS,
    '--max-price-impact-bps'
  );
  const forceSlippage = Boolean(flags.forceSlippage);
  // buildKyberSwapCallData enforces this too, but only at the broadcast
  // boundary — by then the approval has already mined. Fail here instead.
  if (slippageBps > MAX_SWAP_SLIPPAGE_BPS && !forceSlippage) {
    throw new Error(
      `--slippage-bps ${slippageBps} exceeds the ${MAX_SWAP_SLIPPAGE_BPS} bps safety cap. ` +
        'Pass --force-slippage to override.'
    );
  }

  // ---- native ETH -> WETH wrap ------------------------------------------
  if (token.kind === 'native') {
    if (collateral.toLowerCase() !== (client.chainConfig.tokens.WETH?.address ?? '').toLowerCase()) {
      // Native ETH has exactly one destination. The contract's two paths are
      // mutually exclusive: the wrap path only reaches a token with a payable
      // receive(), and the swap path reverts NativeTokenNotAllowedForSwap the
      // moment msg.value > 0. So there is no ETH -> USDC route through
      // swapAndCall at all — wrap to WETH first, then pay with that.
      throw new Error(
        `--pay-with eth only works when the collateral is WETH (this request uses ${collateral}).\n` +
          'Native ETH cannot be swapped by swapAndCall: the wrap path only produces WETH, and the ' +
          'swap path reverts NativeTokenNotAllowedForSwap when msg.value > 0.\n' +
          'Wrap your ETH to WETH first, then re-run with --pay-with weth --pay-amount <n>.'
      );
    }
    // The wrap is exactly 1:1, so the amount is fully determined. Honour an
    // explicit --pay-amount only if it covers the deposit; excess is refunded.
    let payAmount = requiredDeposit;
    if (flags.payAmount !== undefined && flags.payAmount !== '') {
      payAmount = client.utils.toBigInt(flags.payAmount, 18);
      if (payAmount < requiredDeposit) {
        throw new Error(
          `--pay-amount ${flags.payAmount} ETH is below the ${formatUnits(requiredDeposit, 18)} ` +
            'WETH this request must deposit. Raise it or omit the flag to size it automatically.'
        );
      }
    }
    // The wrap path sends msg.value, so a short balance fails at broadcast with
    // whatever the node chooses to say. Check it here instead.
    const ethBalance = await client.provider.getBalance(await client.getSignerAddress());
    if (ethBalance < payAmount) {
      throw new Error(
        `Insufficient ETH: this needs ${formatUnits(payAmount, 18)} ETH for the wrap but the ` +
          `wallet holds ${formatUnits(ethBalance, 18)} (gas is on top of that).`
      );
    }

    return {
      token,
      collateral,
      collateralSymbol,
      collateralDecimals,
      requiredDeposit,
      payAmount,
      // The wrap is exactly 1:1 and has no route, so the floor is the amount
      // itself — there is nothing to drift.
      confirmedMinOut: payAmount,
      slippageBps,
      maxPriceImpactBps,
      forceSlippage,
      route: null,
      routerAddress: null,
      routerAuthorized: true,
    };
  }

  // ---- ERC-20 -> collateral swap ----------------------------------------
  if (token.address.toLowerCase() === collateral.toLowerCase()) {
    const alternatives = Object.values(client.chainConfig.tokens)
      .filter((t) => t.address.toLowerCase() !== collateral.toLowerCase())
      .map((t) => t.symbol.toLowerCase())
      .join(', ');
    throw new Error(
      `--pay-with ${token.symbol} is already this request's collateral, so there is nothing ` +
        'to swap. Drop --pay-with and submit it directly.\n' +
        `To fund it from something else, pay with one of: ${alternatives}.`
    );
  }
  if (flags.payAmount === undefined || flags.payAmount === '') {
    throw new Error(
      `--pay-amount is required with --pay-with ${token.symbol}: the CLI needs to know how much ` +
        'to spend before it can quote a route. Any excess is refunded by the contract.'
    );
  }

  // Guard before any network call: fetchKyberRoute would otherwise throw first
  // with a message about the aggregator rather than about --pay-with.
  if (client.chainConfig.chainId !== 8453) {
    throw new Error(
      `No KyberSwap router configured for chain ${client.chainConfig.chainId}; ` +
        '--pay-with with an ERC-20 is unavailable here.'
    );
  }

  const decimals =
    token.decimals >= 0 ? token.decimals : Number(await client.erc20.getDecimals(token.address));
  const payAmount = client.utils.toBigInt(flags.payAmount, decimals);
  if (payAmount <= 0n) throw new Error('--pay-amount must be greater than zero.');

  // Mirrors the native path's ETH check. Without it a short balance only
  // surfaces as an opaque safeTransferFrom revert — after the approval has
  // already mined and cost gas.
  const heldPayToken = await client.erc20.getBalance(token.address);
  if (heldPayToken < payAmount) {
    throw new Error(
      `Insufficient ${token.symbol}: this needs ${formatUnits(payAmount, decimals)} but the ` +
        `wallet holds ${formatUnits(heldPayToken, decimals)}.`
    );
  }

  const route = await fetchKyberRoute({
    chainId: client.chainConfig.chainId,
    tokenIn: token.address,
    tokenOut: collateral,
    amountIn: payAmount,
  });

  // The floor the user is asked to approve, and the one the broadcast path
  // enforces. It is quoted below the slippage tolerance alone by
  // MAX_QUOTE_DRIFT_BPS so that the re-quote after the prompt has somewhere to
  // move: a floor set at exactly the previewed minimum would abort on any
  // downward tick. Clamped because --force-slippage allows the two together to
  // exceed 100%.
  const floorBps = Math.max(0, 10_000 - slippageBps - MAX_QUOTE_DRIFT_BPS);
  const worstCaseOut = (route.amountOut * BigInt(floorBps)) / 10_000n;

  // The swap must cover the deposit *after* slippage, or the self-call reverts
  // once the gas is already spent.
  if (worstCaseOut < requiredDeposit) {
    const shortfall = requiredDeposit - worstCaseOut;
    // A zero worst case (100% slippage, or a route that quoted nothing) would
    // divide by zero here, so the suggestion is dropped rather than computed.
    const suggestion =
      worstCaseOut > 0n
        ? `Try --pay-amount ${formatUnits(
            (payAmount * requiredDeposit * 10_100n) / (worstCaseOut * 10_000n),
            decimals
          )} or higher. Excess is refunded.`
        : 'Raise --pay-amount, or lower --slippage-bps. Excess is refunded.';
    throw new Error(
      `Quote is short: spending ${flags.payAmount} ${token.symbol} yields at worst ` +
        `${formatUnits(worstCaseOut, collateralDecimals)} but this request must deposit ` +
        `${formatUnits(requiredDeposit, collateralDecimals)} ` +
        `(short by ${formatUnits(shortfall, collateralDecimals)}).\n${suggestion}`
    );
  }

  assertPriceImpactWithinLimit(route, maxPriceImpactBps, forceSlippage, token.symbol);

  const expectedRouter = KYBER_ROUTER_BASE;
  // The allowlist on the factory is the real gate — check it before we let the
  // user sign anything, so a delisted router fails here instead of on-chain.
  const routerAuthorized = await client.optionFactory.isRouterAuthorized(expectedRouter);
  if (!routerAuthorized) {
    throw new Error(
      `Router ${expectedRouter} is not in OptionFactory.authorizedRouters. ` +
        'swapAndCall would revert UnauthorizedRouter. This usually means the SDK ' +
        'chain config is out of date.'
    );
  }

  return {
    token: { ...token, decimals },
    collateral,
    collateralSymbol,
    collateralDecimals,
    requiredDeposit,
    payAmount,
    confirmedMinOut: worstCaseOut,
    slippageBps,
    maxPriceImpactBps,
    forceSlippage,
    route,
    routerAddress: expectedRouter,
    routerAuthorized,
  };
}

/**
 * Build the final `swapAndCall` transaction.
 *
 * Call this at the broadcast boundary, never before the confirmation prompt:
 * the ERC-20 path re-quotes so the route carries a fresh deadline and a
 * current price, and the plan's preview route is deliberately discarded.
 *
 * What is *not* discarded is {@link PayWithPlan.confirmedMinOut}. Re-quoting
 * refreshes the route's internals; it must never loosen the economics the user
 * agreed to, so a refreshed route that guarantees less than that floor is
 * refused rather than broadcast.
 */
export async function buildPayWithTransaction(
  client: ThetanutsClient,
  req: RFQRequest,
  plan: PayWithPlan
): Promise<{ to: string; data: string; value: bigint; minAmountOut: bigint | null }> {
  const factory = client.optionFactory.contractAddress;
  const selfCallData = client.optionFactory.encodeRequestForQuotation(req).data;

  if (plan.token.kind === 'native') {
    const params = {
      swapRouter: ZERO_ADDRESS,
      swapSrcToken: ZERO_ADDRESS,
      swapDstToken: plan.collateral,
      // The contract wraps msg.value and ignores swapSrcAmount; keep them equal
      // so the two never drift apart.
      swapSrcAmount: plan.payAmount,
      swapCallData: '0x',
      selfCallData,
      value: plan.payAmount,
    };
    validateSwapAndCallParams(params, {
      collateral: plan.collateral,
      existingOptionAddress: req.params.existingOptionAddress,
      ...(client.chainConfig.tokens.WETH
        ? { wrapToken: client.chainConfig.tokens.WETH.address }
        : {}),
    });
    const encoded = client.optionFactory.encodeSwapAndCall(params);
    return { to: encoded.to, data: encoded.data, value: encoded.value ?? 0n, minAmountOut: null };
  }

  // Re-quote: the plan's route was fetched before the prompt and may be stale.
  const fresh = await fetchKyberRoute({
    chainId: client.chainConfig.chainId,
    tokenIn: plan.token.address,
    tokenOut: plan.collateral,
    amountIn: plan.payAmount,
  });

  // The min-out re-check below catches a worse price, but not a route that got
  // thinner: liquidity can drain while the prompt is open. Re-run the same gate
  // the plan passed.
  assertPriceImpactWithinLimit(
    fresh,
    plan.maxPriceImpactBps,
    plan.forceSlippage,
    plan.token.symbol
  );

  const built = await buildKyberSwapCallData({
    chainId: client.chainConfig.chainId,
    route: fresh,
    optionFactory: factory,
    srcToken: plan.token.address,
    dstToken: plan.collateral,
    slippageBps: plan.slippageBps,
    allowHighSlippage: plan.forceSlippage,
    ...(plan.routerAddress ? { expectedRouter: plan.routerAddress } : {}),
  });

  // `built.minAmountOut` is decoded out of the router calldata, so both checks
  // below are against the floor the chain will actually enforce.

  // The price the user approved. Covering the deposit is not a substitute:
  // the deposit can be a fraction of the swap's output, and the contract
  // refunds the excess, so a materially worse rate clears that bar untouched.
  if (built.minAmountOut < plan.confirmedMinOut) {
    throw new Error(
      `Price moved past the quote you approved: it guaranteed at worst ` +
        `${formatUnits(plan.confirmedMinOut, plan.collateralDecimals)} but the refreshed route ` +
        `guarantees only ${formatUnits(built.minAmountOut, plan.collateralDecimals)}. ` +
        'Nothing was broadcast — re-run to quote again at the current price.'
    );
  }

  // Re-check against the refreshed quote — the price may have moved while the
  // user was reading the prompt.
  if (built.minAmountOut < plan.requiredDeposit) {
    throw new Error(
      `Price moved while confirming: the refreshed quote guarantees at worst ` +
        `${formatUnits(built.minAmountOut, plan.collateralDecimals)} but ` +
        `${formatUnits(plan.requiredDeposit, plan.collateralDecimals)} is required. ` +
        'Re-run with a higher --pay-amount.'
    );
  }

  const params = {
    swapRouter: built.routerAddress,
    swapSrcToken: plan.token.address,
    swapDstToken: plan.collateral,
    swapSrcAmount: plan.payAmount,
    swapCallData: built.swapCallData,
    selfCallData,
    value: 0n,
  };
  validateSwapAndCallParams(params, {
    collateral: plan.collateral,
    existingOptionAddress: req.params.existingOptionAddress,
  });
  const encoded = client.optionFactory.encodeSwapAndCall(params);
  return {
    to: encoded.to,
    data: encoded.data,
    value: 0n,
    minAmountOut: built.minAmountOut,
  };
}

/**
 * One-line nudge shown when `--pay-with` was not used.
 *
 * Which collateral an RFQ takes is decided by its structure, not by the user
 * (single-strike ETH CALL is WETH, everything else is USDC), so a user holding
 * the other asset has no way to see that funding it atomically is an option.
 * Returns null when the wallet already holds enough collateral to submit
 * directly, so the hint only appears where it would actually help.
 */
export async function payWithHint(
  client: ThetanutsClient,
  req: RFQRequest
): Promise<string | null> {
  try {
    const collateral = req.params.collateral;
    const required = await requiredRequesterDeposit(client, req);
    if (required <= 0n) return null;

    const held = await client.erc20.getBalance(collateral);
    if (held >= required) return null;

    const decimals = Number(await client.erc20.getDecimals(collateral));
    const wethAddr = client.chainConfig.tokens.WETH?.address ?? '';
    const isWeth = collateral.toLowerCase() === wethAddr.toLowerCase();
    const symbol =
      Object.values(client.chainConfig.tokens).find(
        (t) => t.address.toLowerCase() === collateral.toLowerCase()
      )?.symbol ?? 'the collateral token';
    const suggestion = isWeth
      ? '--pay-with eth (wraps 1:1, no approval) or --pay-with usdc --pay-amount <n>'
      : '--pay-with weth --pay-amount <n> (or cbbtc, cbdoge, cbxrp)';

    return (
      `Wallet holds ${formatUnits(held, decimals)} of the ${formatUnits(required, decimals)} ` +
      `${symbol} this request must deposit. Fund it in the same transaction with ${suggestion}.`
    );
  } catch {
    // Advisory only — a balance read failing must never block the request.
    return null;
  }
}

/** Human-readable preview rows for `--dry-run` and the confirmation prompt. */
export function payWithPreview(plan: PayWithPlan): Record<string, string> {
  const coll = plan.collateralSymbol;
  const rows: Record<string, string> = {
    payWith: plan.token.symbol,
    payAmount: `${formatUnits(plan.payAmount, plan.token.decimals)} ${plan.token.symbol}`,
    collateral: coll ? `${coll} (${plan.collateral})` : plan.collateral,
    requiredDeposit: `${formatUnits(plan.requiredDeposit, plan.collateralDecimals)}${
      coll ? ` ${coll}` : ''
    }`,
    path: plan.token.kind === 'native' ? 'wrap (ETH → WETH, 1:1)' : 'swap (KyberSwap)',
  };

  if (plan.token.kind === 'native') {
    rows.approvalNeeded = 'none (native ETH is sent as msg.value)';
    return rows;
  }

  const unit = coll ? ` ${coll}` : '';
  rows.expectedOut = plan.route
    ? `${formatUnits(plan.route.amountOut, plan.collateralDecimals)}${unit}`
    : 'n/a';
  // Displayed and enforced are the same figure by construction — the broadcast
  // path refuses any refreshed route that guarantees less than this.
  rows.minReceived = `${formatUnits(plan.confirmedMinOut, plan.collateralDecimals)}${unit}`;
  // minReceived is the slippage tolerance plus the re-quote allowance, so
  // spell out both rather than leaving the gap between the two rows unexplained.
  rows.slippage =
    `${(plan.slippageBps / 100).toFixed(2)}% ` +
    `(+${(MAX_QUOTE_DRIFT_BPS / 100).toFixed(2)}% re-quote allowance)`;
  rows.priceImpact =
    plan.route?.priceImpactBps != null
      ? `${(plan.route.priceImpactBps / 100).toFixed(2)}%`
      : 'unpriced (accepted via --force-slippage)';
  rows.router = `${plan.routerAddress ?? 'n/a'} (authorizedRouters: ${plan.routerAuthorized})`;
  // Called out explicitly: approving the router instead of the factory is the
  // single most common way this flow is mis-wired.
  rows.approvalNeeded = `${plan.token.symbol} → OptionFactory (NOT the router)`;
  return rows;
}
