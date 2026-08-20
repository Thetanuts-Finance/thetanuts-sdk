import assert from 'node:assert/strict';
import { CHAIN_CONFIGS_BY_ID } from '@thetanuts-finance/thetanuts-client';
import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import {
  ZERO_ADDRESS,
  KYBER_ROUTER_BASE,
  validateSwapAndCallParams,
} from '../src/swapAndCall.js';
import {
  resolvePayToken,
  planPayWith,
  requiredRequesterDeposit,
  buildPayWithTransaction,
} from '../src/payWith.js';
import { Interface } from 'ethers';

/** The router layout the aggregator's calldata is decoded against. */
const DESC =
  '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, ' +
  'address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, ' +
  'uint256 minReturnAmount, uint256 flags, bytes permit)';
const ROUTER_IFACE = new Interface([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${DESC} desc, bytes clientData) execution)`,
]);

const base = CHAIN_CONFIGS_BY_ID[8453];
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const ROUTER = KYBER_ROUTER_BASE;

// resolvePayToken only reads chainConfig, so a stub is enough.
const client = { chainConfig: base } as unknown as ThetanutsClient;

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

assert.equal(
  ROUTER,
  '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  'KyberSwap MetaAggregationRouterV2, verified authorizedRouters(...) == true on the live factory'
);
assert.equal(
  base.contracts.optionFactory,
  '0x8118daD971dEbffB49B9280047659174128A8B94',
  'the router allowlist that gates swapAndCall lives on this factory'
);

// ---------------------------------------------------------------------------
// resolvePayToken
// ---------------------------------------------------------------------------

const eth = resolvePayToken(client, 'eth');
assert.equal(eth.kind, 'native');
assert.equal(eth.address, ZERO_ADDRESS);
assert.equal(eth.decimals, 18);
assert.equal(resolvePayToken(client, 'NATIVE').kind, 'native', 'case-insensitive');

const usdc = resolvePayToken(client, 'usdc');
assert.equal(usdc.kind, 'erc20');
assert.equal(usdc.address, USDC);
assert.equal(usdc.decimals, 6, 'decimals come from chain config, not a guess');

assert.equal(
  resolvePayToken(client, USDC.toUpperCase()).address,
  USDC,
  'a known address resolves to its config entry regardless of case'
);

const unknown = resolvePayToken(client, '0x1111111111111111111111111111111111111111');
assert.equal(unknown.kind, 'erc20');
assert.equal(unknown.decimals, -1, 'unknown token defers decimals to an on-chain read');

assert.throws(() => resolvePayToken(client, 'DOGECOIN'), /not recognised/);

// ---------------------------------------------------------------------------
// validateSwapAndCallParams — wrap path
// ---------------------------------------------------------------------------

const wrap = {
  swapRouter: ZERO_ADDRESS,
  swapSrcToken: ZERO_ADDRESS,
  swapDstToken: WETH,
  swapSrcAmount: 10n ** 18n,
  swapCallData: '0x',
  selfCallData: '0xdeadbeef',
  value: 10n ** 18n,
};
assert.doesNotThrow(() => validateSwapAndCallParams(wrap, { collateral: WETH }));

assert.throws(
  () => validateSwapAndCallParams({ ...wrap, value: 0n }, { collateral: WETH }),
  /non-zero `value`/,
  'the contract wraps msg.value; zero wraps nothing and reverts BalanceIncorrect'
);
assert.doesNotThrow(
  () => validateSwapAndCallParams({ ...wrap, swapSrcAmount: 0n }, { collateral: WETH }),
  'the contract never reads swapSrcAmount on the wrap path, so 0 is legitimate'
);
assert.throws(
  () => validateSwapAndCallParams({ ...wrap, swapSrcAmount: 5n }, { collateral: WETH }),
  /must be 0 or equal value/,
  'any other swapSrcAmount is a caller mistake worth surfacing'
);
assert.throws(
  () =>
    validateSwapAndCallParams(
      { ...wrap, swapDstToken: USDC },
      { collateral: USDC, wrapToken: WETH }
    ),
  /can only be wrapped into/,
  'wrapping into a token without a payable receive() reverts WrapperTransferFailed'
);
assert.doesNotThrow(
  () => validateSwapAndCallParams(wrap, { collateral: WETH, wrapToken: WETH }),
  'WETH is the wrappable destination'
);
assert.throws(
  () => validateSwapAndCallParams({ ...wrap, selfCallData: '0xdead' }, { collateral: WETH }),
  /4-byte function selector/,
  'routeSelfCall slices selfCallData[:4] and reverts on the slice itself'
);
assert.throws(
  () => validateSwapAndCallParams({ ...wrap, swapSrcToken: USDC }, { collateral: WETH }),
  /requires swapSrcToken = 0x0/
);
assert.throws(
  () => validateSwapAndCallParams({ ...wrap, swapCallData: '0xabcd' }, { collateral: WETH }),
  /takes no swap calldata/
);
assert.throws(
  () => validateSwapAndCallParams(wrap, { collateral: CBBTC }),
  /must equal the self-call collateral/,
  'routeSelfCall reverts TokenMismatch when swapDstToken != params.collateral'
);
assert.throws(
  () =>
    validateSwapAndCallParams(wrap, {
      collateral: WETH,
      existingOptionAddress: '0x000000000000000000000000000000000000dEaD',
    }),
  /cannot be used to close an existing option/
);

// ---------------------------------------------------------------------------
// validateSwapAndCallParams — swap path
// ---------------------------------------------------------------------------

const swap = {
  swapRouter: ROUTER,
  swapSrcToken: USDC,
  swapDstToken: WETH,
  swapSrcAmount: 5_000_000n,
  swapCallData: '0xe21fd0e9',
  selfCallData: '0xdeadbeef',
  value: 0n,
};
assert.doesNotThrow(() => validateSwapAndCallParams(swap, { collateral: WETH }));
assert.doesNotThrow(
  () => validateSwapAndCallParams({ ...swap, value: undefined }, { collateral: WETH }),
  'an omitted value is the same as zero'
);

assert.throws(
  () => validateSwapAndCallParams({ ...swap, value: 1n }, { collateral: WETH }),
  /NativeTokenNotAllowedForSwap/,
  'native ETH is forbidden on the swap path'
);
assert.throws(
  () => validateSwapAndCallParams({ ...swap, swapSrcToken: ZERO_ADDRESS }, { collateral: WETH }),
  /requires an ERC-20 swapSrcToken/
);
assert.throws(
  () => validateSwapAndCallParams({ ...swap, swapCallData: '0x' }, { collateral: WETH }),
  /requires non-empty swapCallData/
);
assert.throws(
  () => validateSwapAndCallParams({ ...swap, swapSrcAmount: 0n }, { collateral: WETH }),
  /requires swapSrcAmount > 0/
);

assert.throws(
  () => validateSwapAndCallParams({ ...swap, swapSrcToken: WETH }, { collateral: WETH }),
  /identical/,
  'a same-token swap always trips the closing balance invariant'
);

// cbBTC collateral with USDC in is a legitimate combination — make sure the
// validator does not over-reject it.
assert.doesNotThrow(() =>
  validateSwapAndCallParams({ ...swap, swapDstToken: CBBTC }, { collateral: CBBTC })
);

// ---------------------------------------------------------------------------
// Native ETH has exactly one destination
// ---------------------------------------------------------------------------

// Both contract paths refuse to take native ETH anywhere but WETH: the wrap
// path can only reach a token with a payable receive(), and the swap path
// reverts NativeTokenNotAllowedForSwap the moment msg.value > 0. There is no
// ETH -> USDC route through swapAndCall, so both encodings must be rejected.
assert.throws(
  () =>
    validateSwapAndCallParams(
      { ...wrap, swapDstToken: USDC },
      { collateral: USDC, wrapToken: WETH }
    ),
  /can only be wrapped into/,
  'wrap path: ETH -> USDC is unreachable'
);
assert.throws(
  () =>
    validateSwapAndCallParams(
      { ...swap, swapSrcToken: ZERO_ADDRESS, swapDstToken: USDC, value: 10n ** 18n },
      { collateral: USDC }
    ),
  /NativeTokenNotAllowedForSwap/,
  'swap path: ETH -> USDC is unreachable too — wrap to WETH first'
);

// ---------------------------------------------------------------------------
// Only BUY requests have a request-time deposit to fund
// ---------------------------------------------------------------------------

// A SELL request escrows nothing when it is submitted — the factory pulls
// collateral at settlement — so a swap now would spend fees funding nothing.
// The refusal happens before any network or chain call, so a bare stub is
// enough to reach it.
const sellRequest = {
  params: {
    collateral: USDC,
    isRequestingLongPosition: false,
    existingOptionAddress: ZERO_ADDRESS,
    implementation: ZERO_ADDRESS,
    strikes: [],
    numContracts: 0n,
  },
  reservePrice: 0n,
} as unknown as Parameters<typeof planPayWith>[1];

await assert.rejects(
  () => planPayWith(client, sellRequest, { payWith: 'weth', payAmount: '1' }),
  /BUY requests only/,
  'SELL requests are refused before any quote is fetched'
);

assert.equal(
  await requiredRequesterDeposit(client, sellRequest),
  0n,
  'a SELL request escrows nothing at request time, so the hint stays silent'
);

// ---------------------------------------------------------------------------
// The confirmed floor survives the re-quote
// ---------------------------------------------------------------------------

// buildPayWithTransaction re-quotes after the user has already confirmed, so
// the floor shown at the prompt is the only thing tying the broadcast to what
// was approved. Covering requiredDeposit is not enough on its own: the deposit
// can sit far below the swap's output and the contract refunds the difference,
// so a much worse rate still clears that bar.

const realFetch = globalThis.fetch;

/** Minimal client surface buildPayWithTransaction actually touches. */
const txClient = {
  chainConfig: base,
  optionFactory: {
    contractAddress: base.contracts.optionFactory,
    encodeRequestForQuotation: () => ({ to: base.contracts.optionFactory, data: '0xdeadbeef' }),
    encodeSwapAndCall: (params: { value?: bigint }) => ({
      to: base.contracts.optionFactory,
      data: '0xfeedface',
      value: params.value,
    }),
  },
} as unknown as ThetanutsClient;

const buyRequest = {
  params: {
    collateral: WETH,
    isRequestingLongPosition: true,
    existingOptionAddress: ZERO_ADDRESS,
  },
  reservePrice: 100n,
} as unknown as Parameters<typeof buildPayWithTransaction>[1];

// A route quoting 1000 out, of which only 100 is needed as the deposit.
function stubQuote(encodedMin: bigint): void {
  const routeSummary = {
    amountIn: '500000000',
    amountOut: '1000',
    amountInUsd: '500',
    amountOutUsd: '499',
  };
  const swapCallData = ROUTER_IFACE.encodeFunctionData('swap', [
    {
      callTarget: ROUTER,
      approveTarget: ROUTER,
      targetData: '0x',
      desc: {
        srcToken: USDC,
        dstToken: WETH,
        srcReceivers: [],
        srcAmounts: [],
        feeReceivers: [],
        feeAmounts: [],
        dstReceiver: base.contracts.optionFactory,
        amount: 500_000_000n,
        minReturnAmount: encodedMin,
        flags: 0n,
        permit: '0x',
      },
      clientData: '0x',
    },
  ]);
  globalThis.fetch = (async (url: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/route/build')
        ? { code: 0, data: { data: swapCallData, routerAddress: ROUTER, amountOut: '1000' } }
        : { code: 0, data: { routeSummary } },
  })) as unknown as typeof fetch;
}

// Preview floor of 990, as a 1% slippage tolerance on a 1000 quote would give.
const confirmedPlan = {
  token: { kind: 'erc20' as const, address: USDC, symbol: 'USDC', decimals: 6 },
  collateral: WETH,
  collateralSymbol: 'WETH',
  collateralDecimals: 18,
  requiredDeposit: 100n,
  payAmount: 500_000_000n,
  confirmedMinOut: 990n,
  slippageBps: 100,
  maxPriceImpactBps: 200,
  forceSlippage: false,
  route: null,
  routerAddress: ROUTER,
  routerAuthorized: true,
};

try {
  stubQuote(990n);
  const held = await buildPayWithTransaction(txClient, buyRequest, confirmedPlan);
  assert.equal(held.minAmountOut, 990n, 'a route that still honours the floor proceeds');

  stubQuote(1200n);
  const better = await buildPayWithTransaction(txClient, buyRequest, confirmedPlan);
  assert.equal(better.minAmountOut, 1200n, 'an improved quote is never rejected');

  stubQuote(989n);
  await assert.rejects(
    () => buildPayWithTransaction(txClient, buyRequest, confirmedPlan),
    /past the quote you approved/,
    'one unit below the confirmed floor is still below it'
  );

  // The case the deposit check alone lets through: 198 covers the 100 deposit
  // several times over, and is a fifth of the price the user agreed to.
  stubQuote(198n);
  await assert.rejects(
    () => buildPayWithTransaction(txClient, buyRequest, confirmedPlan),
    /past the quote you approved/,
    'covering the deposit is not consent to the rate'
  );

  stubQuote(1n);
  await assert.rejects(
    () => buildPayWithTransaction(txClient, { ...buyRequest, reservePrice: 1n } as typeof buyRequest, {
      ...confirmedPlan,
      requiredDeposit: 1n,
    }),
    /past the quote you approved/,
    'a deposit small enough to be covered by anything must not disarm the floor'
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log('payWith: all assertions passed');
