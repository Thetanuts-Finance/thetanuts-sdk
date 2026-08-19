import assert from 'node:assert/strict';
import { JsonRpcProvider } from 'ethers';
import {
  ThetanutsClient,
  type OrderWithSignature,
} from '@thetanuts-finance/thetanuts-client';
import {
  ORDER_PRICE_DECIMALS,
  bookOrderIneligibility,
  cashSettledImplementationSet,
  isEligibleBookOrder,
  type BookEligibilityPolicy,
} from '../src/bookEligibility.js';
import { withActualBookPremium } from '../src/bookPreview.js';
import { findSignedOrder } from '../src/bookOrderIdentity.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ABAS_WETH = '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7';
const CASH_PUT = '0x7355EB92dfb0503DB558a70c10843618932ab290';
const PHYSICAL_PUT = '0x6aD53DD058bea004829cCf58a282C21a7Df02DcA';
const NOW = 1_787_100_000;

function order(overrides: {
  collateral?: string;
  implementation?: string;
  isLong?: boolean;
  optionExpiry?: bigint;
  orderExpiry?: number;
  price?: bigint;
  availableAmount?: bigint;
  nonce?: bigint;
  signature?: string;
} = {}): OrderWithSignature {
  return {
    order: {
      maker: '0x0000000000000000000000000000000000000001',
      taker: '0x0000000000000000000000000000000000000000',
      option: '',
      isBuyer: overrides.isLong ?? false,
      numContracts: 0n,
      price: overrides.price ?? 800_000_000n,
      expiry: overrides.optionExpiry ?? BigInt(NOW + 86_400),
      nonce: overrides.nonce ?? 1n,
    },
    signature: overrides.signature ?? '0x01',
    availableAmount: overrides.availableAmount ?? 10_000_000_000n,
    makerAddress: '0x0000000000000000000000000000000000000001',
    rawApiData: {
      collateral: overrides.collateral ?? USDC,
      priceFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
      implementation: overrides.implementation ?? CASH_PUT,
      strikes: ['184000000000'],
      isCall: false,
      isLong: overrides.isLong ?? false,
      orderExpiryTimestamp: overrides.orderExpiry ?? NOW + 3_600,
      extraOptionData: '0x',
      maxCollateralUsable: '10000000000',
    },
  };
}

const accepted = cashSettledImplementationSet({
  PUT: CASH_PUT,
  PHYSICAL_PUT,
  PHYSICAL_CALL: '0x0000000000000000000000000000000000000002',
  PHYSICAL_CALL_SPREAD: '0x0000000000000000000000000000000000000000',
});

const buyPolicy: BookEligibilityPolicy = {
  usdcAddress: USDC,
  cashSettledImplementations: accepted,
  now: NOW,
  direction: 'buy',
};

assert.equal(ORDER_PRICE_DECIMALS, 8);
assert.equal(accepted.has(CASH_PUT.toLowerCase()), true);
assert.equal(accepted.has(PHYSICAL_PUT.toLowerCase()), false);

assert.equal(isEligibleBookOrder(order(), buyPolicy), true);

// USDC alone is insufficient: a physical PUT must still be excluded.
assert.equal(
  bookOrderIneligibility(order({ implementation: PHYSICAL_PUT }), buyPolicy),
  'unsupported-implementation'
);

// The duplicate aBasWETH maker bid seen live is neither the right token nor side.
assert.equal(
  bookOrderIneligibility(
    order({ collateral: ABAS_WETH, isLong: true }),
    buyPolicy
  ),
  'wrong-collateral'
);

assert.equal(
  bookOrderIneligibility(order({ isLong: true }), buyPolicy),
  'wrong-side'
);

const sellPolicy: BookEligibilityPolicy = { ...buyPolicy, direction: 'sell' };
assert.equal(isEligibleBookOrder(order({ isLong: true }), sellPolicy), true);

assert.equal(
  bookOrderIneligibility(order({ optionExpiry: BigInt(NOW) }), buyPolicy),
  'expired-option'
);
assert.equal(
  bookOrderIneligibility(order({ orderExpiry: NOW }), buyPolicy),
  'expired-order'
);
assert.equal(
  bookOrderIneligibility(order({ price: 0n }), buyPolicy),
  'invalid-price'
);
assert.equal(
  bookOrderIneligibility(order({ availableAmount: 0n }), buyPolicy),
  'no-liquidity'
);

// Tech-lead reproduction: $25 / $4.94475721 = 5.055859 contracts. Prices use
// 8 decimals, while USDC contract quantities use 6 decimals.
const client = new ThetanutsClient({
  chainId: 8453,
  provider: new JsonRpcProvider('http://127.0.0.1:8545'),
});
const reportedPreview = withActualBookPremium(
  client.optionBook.previewFillOrder(
    order({ price: 494_475_721n }),
    25_000_000n
  )
);
assert.equal(reportedPreview.numContracts, 5_055_859n);
assert.equal(Number(reportedPreview.numContracts) / 1e6, 5.055859);
assert.equal(Number(reportedPreview.pricePerContract) / 1e8, 4.94475721);
assert.equal(
  reportedPreview.totalCollateral,
  (reportedPreview.numContracts * reportedPreview.pricePerContract) / 100_000_000n
);

// A spend ceiling above live liquidity must report the capped fill premium,
// not echo the original requested budget.
const cappedPreview = withActualBookPremium(
  client.optionBook.previewFillOrder(
    order({ price: 494_475_721n, availableAmount: 1_000_000n }),
    25_000_000n
  )
);
assert.equal(cappedPreview.numContracts, cappedPreview.maxContracts);
assert.equal(cappedPreview.totalCollateral < 25_000_000n, true);
assert.equal(
  cappedPreview.totalCollateral,
  (cappedPreview.numContracts * cappedPreview.pricePerContract) / 100_000_000n
);

// Odette reuses a nonce for multiple signed products. A fresh-book recheck
// must resolve the exact signature, not the first order sharing maker+nonce.
const approvedOrder = order({
  nonce: 42n,
  signature: '0xaaaa',
  price: 900_000_000n,
});
const nonceCollision = order({
  nonce: 42n,
  signature: '0xbbbb',
  price: 1_300_000_000n,
});
assert.equal(
  findSignedOrder([nonceCollision, approvedOrder], approvedOrder),
  approvedOrder
);
assert.equal(findSignedOrder([nonceCollision], approvedOrder), undefined);

process.stdout.write('book eligibility regression tests passed\n');
