/**
 * Coverage for the two external trust boundaries in the `--pay-with` flow: the
 * aggregator's JSON, and the executable router calldata it returns.
 *
 * Both are stubbed rather than fetched. The point of these assertions is the
 * behaviour on responses a live API will not produce on request — an inflated
 * plaintext `amountOut`, a redirected recipient, a smuggled fee — so a network
 * round-trip would test the wrong thing.
 */

import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import {
  decodeKyberSwapCallData,
  fetchKyberRoute,
  buildKyberSwapCallData,
  KyberError,
} from '../src/swapAndCall.js';

const FACTORY = '0x8118daD971dEbffB49B9280047659174128A8B94';
const ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const ELSEWHERE = '0x000000000000000000000000000000000000dEaD';

// The same layout the CLI decodes with, declared independently here so a typo
// in the production fragments cannot make these tests agree with themselves.
const DESC =
  '(address srcToken, address dstToken, address[] srcReceivers, uint256[] srcAmounts, ' +
  'address[] feeReceivers, uint256[] feeAmounts, address dstReceiver, uint256 amount, ' +
  'uint256 minReturnAmount, uint256 flags, bytes permit)';
const ROUTER_IFACE = new Interface([
  `function swap((address callTarget, address approveTarget, bytes targetData, ${DESC} desc, bytes clientData) execution)`,
  `function swapSimpleMode(address caller, ${DESC} desc, bytes executorData, bytes clientData)`,
]);

// Selectors pinned against the verified Base MetaAggregationRouterV2. If these
// drift, the decoder is looking at a different contract than the one deployed.
assert.equal(ROUTER_IFACE.getFunction('swap')?.selector, '0xe21fd0e9');
assert.equal(ROUTER_IFACE.getFunction('swapSimpleMode')?.selector, '0x8af033fb');

interface DescOverrides {
  srcToken?: string;
  dstToken?: string;
  dstReceiver?: string;
  amount?: bigint;
  minReturnAmount?: bigint;
  feeReceivers?: string[];
  feeAmounts?: bigint[];
}

function desc(o: DescOverrides = {}) {
  return {
    srcToken: o.srcToken ?? USDC,
    dstToken: o.dstToken ?? WETH,
    srcReceivers: [],
    srcAmounts: [],
    feeReceivers: o.feeReceivers ?? [],
    feeAmounts: o.feeAmounts ?? [],
    dstReceiver: o.dstReceiver ?? FACTORY,
    amount: o.amount ?? 500_000_000n,
    minReturnAmount: o.minReturnAmount ?? 990n,
    flags: 0n,
    permit: '0x',
  };
}

function encodeSwap(o: DescOverrides = {}): string {
  return ROUTER_IFACE.encodeFunctionData('swap', [
    { callTarget: ROUTER, approveTarget: ROUTER, targetData: '0x', desc: desc(o), clientData: '0x' },
  ]);
}

// ---------------------------------------------------------------------------
// decodeKyberSwapCallData
// ---------------------------------------------------------------------------

const decoded = decodeKyberSwapCallData(encodeSwap());
assert.equal(decoded.functionName, 'swap');
assert.equal(decoded.srcToken, USDC);
assert.equal(decoded.dstToken, WETH);
assert.equal(decoded.dstReceiver, FACTORY);
assert.equal(decoded.amount, 500_000_000n);
assert.equal(decoded.minReturnAmount, 990n);
assert.deepEqual(decoded.feeReceivers, []);

// swapSimpleMode carries the same descriptor as its second argument.
const simple = ROUTER_IFACE.encodeFunctionData('swapSimpleMode', [ROUTER, desc(), '0x', '0x']);
const decodedSimple = decodeKyberSwapCallData(simple);
assert.equal(decodedSimple.functionName, 'swapSimpleMode');
assert.equal(decodedSimple.minReturnAmount, 990n);
assert.equal(decodedSimple.dstReceiver, FACTORY);

assert.throws(
  () => decodeKyberSwapCallData('0xdeadbeef'),
  /unsupported router selector|could not be decoded/,
  'an encoding this CLI cannot read cannot be bound to the trade the user approved'
);
assert.throws(
  () => decodeKyberSwapCallData('0x'),
  /unsupported router selector/,
  'empty calldata has no selector to match either'
);

// ---------------------------------------------------------------------------
// fetch stubbing
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
type Json = Record<string, unknown>;

/** Serve one canned response per endpoint, ignoring the request body. */
function stubFetch(routes: Json, build: Json): void {
  globalThis.fetch = (async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/route/build') ? build : routes),
  })) as unknown as typeof fetch;
}

function routesResponse(over: Record<string, string> = {}): Json {
  return {
    code: 0,
    data: {
      routeSummary: {
        amountIn: '500000000',
        amountOut: '1000',
        amountInUsd: '500',
        amountOutUsd: '499',
        ...over,
      },
    },
  };
}

const ROUTE_ARGS = {
  chainId: 8453,
  tokenIn: USDC,
  tokenOut: WETH,
  amountIn: 500_000_000n,
};

try {
  // ---- fetchKyberRoute: USD pricing must fail closed, not open ----------

  stubFetch(routesResponse(), {});
  const okRoute = await fetchKyberRoute(ROUTE_ARGS);
  assert.equal(okRoute.amountOut, 1000n);
  assert.equal(okRoute.priceImpactBps, 20, '(500 - 499) / 500 = 20 bps');

  for (const bad of ['NaN', 'Infinity', '-1']) {
    stubFetch(routesResponse({ amountOutUsd: bad }), {});
    const route = await fetchKyberRoute(ROUTE_ARGS);
    assert.equal(
      route.priceImpactBps,
      null,
      `amountOutUsd "${bad}" must read as unverifiable, not as a passing impact — ` +
        'NaN makes every comparison false and Infinity floors to 0%'
    );
  }

  stubFetch(routesResponse({ amountIn: '400000000' }), {});
  await assert.rejects(
    () => fetchKyberRoute(ROUTE_ARGS),
    /quoted a route for 400000000/,
    'a quote for a different size describes a different trade'
  );

  stubFetch(routesResponse({ amountOut: '10.5' }), {});
  await assert.rejects(() => fetchKyberRoute(ROUTE_ARGS), /malformed amountOut/);

  // ---- buildKyberSwapCallData: the calldata binds, the plaintext does not

  stubFetch(routesResponse(), {});
  const route = await fetchKyberRoute(ROUTE_ARGS);

  const buildArgs = {
    chainId: 8453,
    route,
    optionFactory: FACTORY,
    srcToken: USDC,
    dstToken: WETH,
    slippageBps: 100,
    expectedRouter: ROUTER,
  };

  function buildResponse(o: DescOverrides = {}, amountOut = '1000'): Json {
    return { code: 0, data: { data: encodeSwap(o), routerAddress: ROUTER, amountOut } };
  }

  stubFetch(routesResponse(), buildResponse());
  const built = await buildKyberSwapCallData(buildArgs);
  assert.equal(built.minAmountOut, 990n, 'the enforced minimum comes out of the calldata');
  assert.equal(built.routerAddress, ROUTER);

  // The SWAP-002 case: a plaintext amountOut of 1,000 implies a 990 floor, but
  // the bytes that actually run enforce 1. The reported minimum must follow the
  // bytes, so the caller's floor check sees the real number.
  stubFetch(routesResponse(), buildResponse({ minReturnAmount: 1n }));
  const lying = await buildKyberSwapCallData(buildArgs);
  assert.equal(
    lying.minAmountOut,
    1n,
    'a plaintext amountOut the calldata does not honour must not become the reported minimum'
  );

  const rejects: Array<[string, DescOverrides, RegExp]> = [
    ['output redirected away from the factory', { dstReceiver: ELSEWHERE }, /not the OptionFactory/],
    ['a different token spent', { srcToken: WETH }, /spends/],
    ['a different token bought', { dstToken: USDC }, /buys/],
    ['a different size swapped', { amount: 1n }, /swaps 1 /],
    [
      'a smuggled router fee',
      { feeReceivers: [ELSEWHERE], feeAmounts: [1n] },
      /router-level fee/,
    ],
  ];
  for (const [why, over, pattern] of rejects) {
    stubFetch(routesResponse(), buildResponse(over));
    await assert.rejects(() => buildKyberSwapCallData(buildArgs), pattern, why);
  }

  stubFetch(routesResponse(), {
    code: 0,
    data: { data: '0xdeadbeef', routerAddress: ROUTER, amountOut: '1000' },
  });
  await assert.rejects(
    () => buildKyberSwapCallData(buildArgs),
    (err: unknown) => err instanceof KyberError,
    'undecodable calldata is refused before it can be signed'
  );
} finally {
  globalThis.fetch = realFetch;
}

console.log('swapCallData: all assertions passed');
