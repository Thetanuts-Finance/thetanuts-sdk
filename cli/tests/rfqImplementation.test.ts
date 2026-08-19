import assert from 'node:assert/strict';
import type { RFQRequest } from '@thetanuts-finance/thetanuts-client';
import {
  getCliRfqImplementation,
  refreshRfqOfferDeadline,
  routeCliRfqRequest,
  routeLoadedCliRfqRequest,
  type CliRfqStructure,
  type UsdcRfqStructure,
} from '../src/rfqImplementation.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';
const INVERSE_CALL = '0xE6c5756b0289e3f0994CB12eb8aB71Cd903Ed0Ea';
const LINEAR_CALL = '0x051791df68223AE173Fade5217C48875e36eef61';
const implementations: Partial<Record<CliRfqStructure | 'LINEAR_CALL', string>> = {
  PUT: '0x0000000000000000000000000000000000000011',
  INVERSE_CALL,
  LINEAR_CALL,
  PUT_SPREAD: '0x0000000000000000000000000000000000000012',
  CALL_SPREAD: '0x0000000000000000000000000000000000000013',
  PUT_FLY: '0x0000000000000000000000000000000000000014',
  CALL_FLY: '0x0000000000000000000000000000000000000015',
  PUT_CONDOR: '0x0000000000000000000000000000000000000016',
  CALL_CONDOR: '0x0000000000000000000000000000000000000017',
  IRON_CONDOR: '0x0000000000000000000000000000000000000018',
};

const request: RFQRequest = {
  params: {
    requester: '0x0000000000000000000000000000000000000001',
    existingOptionAddress: '0x0000000000000000000000000000000000000000',
    collateral: WETH,
    collateralPriceFeed: '0x0000000000000000000000000000000000000002',
    implementation: LINEAR_CALL,
    strikes: [195_000_000_000n],
    numContracts: 1_000_000_000_000_000_000n,
    requesterDeposit: 0n,
    collateralAmount: 0n,
    expiryTimestamp: 1_800_000_000n,
    offerEndTimestamp: 1_790_000_000n,
    isRequestingLongPosition: true,
    convertToLimitOrder: false,
    extraOptionData: '0x',
  },
  tracking: { referralId: 0n, eventCode: 0n },
  reservePrice: 0n,
  requesterPublicKey: '',
};

const routed = routeCliRfqRequest(request, 'INVERSE_CALL', 'WETH', implementations);
assert.equal(routed.params.implementation, INVERSE_CALL);
assert.equal(routed.params.collateral, WETH);
assert.equal(request.params.implementation, LINEAR_CALL, 'routing must not mutate the SDK request');

const refreshed = refreshRfqOfferDeadline(routed, 1_790_000_000, 45);
assert.equal(refreshed.params.offerEndTimestamp, 1_790_000_045n);
assert.equal(routed.params.offerEndTimestamp, 1_790_000_000n, 'deadline refresh must not mutate the request');
assert.equal(refreshed.reservePrice, routed.reservePrice, 'deadline refresh must not change escrow');
assert.equal(refreshed.params.numContracts, routed.params.numContracts, 'deadline refresh must not change size');
assert.throws(
  () => refreshRfqOfferDeadline(routed, 1_800_000_000, 45),
  /expiry must be after/
);

const loadedInverse = routeLoadedCliRfqRequest(
  routed,
  { USDC, WETH },
  implementations
);
assert.equal(loadedInverse.structureType, 'INVERSE_CALL');
assert.equal(loadedInverse.request.params.implementation, INVERSE_CALL);

for (const structure of Object.keys(implementations).filter(
  (name): name is UsdcRfqStructure => !['INVERSE_CALL', 'LINEAR_CALL'].includes(name)
)) {
  assert.equal(getCliRfqImplementation(structure, 'USDC', implementations), implementations[structure]);
}
assert.equal(getCliRfqImplementation('INVERSE_CALL', 'WETH', implementations), INVERSE_CALL);

assert.throws(
  () => getCliRfqImplementation('INVERSE_CALL', 'USDC', implementations),
  /requires WETH/
);
assert.throws(
  () => getCliRfqImplementation('CALL_SPREAD', 'WETH', implementations),
  /requires USDC/
);
assert.throws(
  () => getCliRfqImplementation('INVERSE_CALL', 'WETH', { INVERSE_CALL: '0x0000000000000000000000000000000000000000' }),
  /not deployed/
);

const legacyUsdcInverse: RFQRequest = {
  ...request,
  params: { ...request.params, collateral: USDC, implementation: INVERSE_CALL },
};
assert.throws(
  () => routeLoadedCliRfqRequest(legacyUsdcInverse, { USDC, WETH }, implementations),
  /rebuild with --collateral-token WETH/
);
assert.throws(
  () => routeLoadedCliRfqRequest(
    { ...request, params: { ...request.params, collateral: USDC, implementation: LINEAR_CALL } },
    { USDC, WETH },
    implementations
  ),
  /maker supports WETH INVERSE_CALL only/
);
assert.throws(
  () => routeLoadedCliRfqRequest(
    { ...routed, params: { ...routed.params, collateral: '0x0000000000000000000000000000000000000099' } },
    { USDC, WETH },
    implementations
  ),
  /canonical USDC or WETH/
);

process.stdout.write('RFQ implementation routing regression tests passed\n');
