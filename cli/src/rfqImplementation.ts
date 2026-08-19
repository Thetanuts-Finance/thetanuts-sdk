import type { RFQRequest } from '@thetanuts-finance/thetanuts-client';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type UsdcRfqStructure =
  | 'PUT'
  | 'PUT_SPREAD'
  | 'CALL_SPREAD'
  | 'PUT_FLY'
  | 'CALL_FLY'
  | 'PUT_CONDOR'
  | 'CALL_CONDOR'
  | 'IRON_CONDOR';

export type CliRfqStructure = UsdcRfqStructure | 'INVERSE_CALL';

type ImplementationName = CliRfqStructure | 'LINEAR_CALL';
type ImplementationConfig = Partial<Record<ImplementationName, string>>;

const STRIKE_COUNTS: Record<CliRfqStructure, number> = {
  PUT: 1,
  INVERSE_CALL: 1,
  PUT_SPREAD: 2,
  CALL_SPREAD: 2,
  PUT_FLY: 3,
  CALL_FLY: 3,
  PUT_CONDOR: 4,
  CALL_CONDOR: 4,
  IRON_CONDOR: 4,
};

function deployedImplementation(
  structureType: CliRfqStructure,
  implementations: ImplementationConfig
): string {
  const implementation = implementations[structureType];
  if (!implementation || implementation.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${structureType} implementation is not deployed on this network`);
  }
  return implementation;
}

/**
 * Resolve an implementation only when its collateral pairing is valid.
 *
 * Vanilla ETH calls use WETH + INVERSE_CALL because the current maker does
 * not support LINEAR_CALL. All other CLI RFQ structures stay cash-settled in
 * USDC. Keeping this check at the final CLI boundary prevents the SDK's
 * collateral-agnostic vanilla-CALL selection from creating USDC inverse calls.
 */
export function getCliRfqImplementation(
  structureType: CliRfqStructure,
  collateralToken: string,
  implementations: ImplementationConfig
): string {
  const collateral = collateralToken.toUpperCase();
  if (structureType === 'INVERSE_CALL') {
    if (collateral !== 'WETH') {
      throw new Error('INVERSE_CALL requires WETH collateral; USDC inverse calls are invalid');
    }
  } else if (collateral !== 'USDC') {
    throw new Error(`${structureType} requires USDC collateral in the CLI`);
  }

  return deployedImplementation(structureType, implementations);
}

/** Replace the SDK-selected implementation before the unsigned RFQ is encoded. */
export function routeCliRfqRequest(
  request: RFQRequest,
  structureType: CliRfqStructure,
  collateralToken: string,
  implementations: ImplementationConfig
): RFQRequest {
  const implementation = getCliRfqImplementation(
    structureType,
    collateralToken,
    implementations
  );

  return {
    ...request,
    params: {
      ...request.params,
      implementation,
    },
  };
}

/**
 * Move the offer deadline to a fresh window immediately before broadcast.
 * RFQs are often built before an ERC-20 approval and two confirmation prompts;
 * retaining the original absolute timestamp can make the mined RFQ dead on
 * arrival even though it passed the SDK's local preflight check.
 */
export function refreshRfqOfferDeadline(
  request: RFQRequest,
  nowSeconds: number,
  windowSeconds: number
): RFQRequest {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error(`Invalid current timestamp ${nowSeconds}`);
  }
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
    throw new Error(`RFQ offer window must be a positive whole number of seconds (got ${windowSeconds})`);
  }
  const offerEndTimestamp = BigInt(nowSeconds + windowSeconds);
  if (request.params.expiryTimestamp <= offerEndTimestamp) {
    throw new Error('Option expiry must be after the refreshed RFQ offer deadline');
  }
  return {
    ...request,
    params: {
      ...request.params,
      offerEndTimestamp,
    },
  };
}

/**
 * Revalidate a saved build artifact immediately before broadcast.
 *
 * Legacy USDC vanilla-call artifacts are rejected rather than migrated to a
 * maker-unsupported LINEAR_CALL. Users must rebuild them explicitly with WETH.
 */
export function routeLoadedCliRfqRequest(
  request: RFQRequest,
  tokenAddresses: { USDC: string; WETH: string },
  implementations: ImplementationConfig
): { request: RFQRequest; structureType: CliRfqStructure } {
  const collateral = request.params.collateral.toLowerCase();
  const current = request.params.implementation.toLowerCase();
  const usdc = tokenAddresses.USDC.toLowerCase();
  const weth = tokenAddresses.WETH.toLowerCase();
  const inverseCall = implementations.INVERSE_CALL?.toLowerCase();
  const linearCall = implementations.LINEAR_CALL?.toLowerCase();
  let structureType: CliRfqStructure | undefined;
  let collateralToken: 'USDC' | 'WETH';

  if (collateral === weth) {
    collateralToken = 'WETH';
    if (request.params.strikes.length !== 1 || !inverseCall || current !== inverseCall) {
      throw new Error('Saved WETH RFQ is not a supported vanilla INVERSE_CALL; refusing to submit it');
    }
    structureType = 'INVERSE_CALL';
  } else if (collateral === usdc) {
    collateralToken = 'USDC';
    if (
      request.params.strikes.length === 1 &&
      ((inverseCall && current === inverseCall) || (linearCall && current === linearCall))
    ) {
      throw new Error(
        'Saved vanilla CALL uses USDC collateral, but the maker supports WETH INVERSE_CALL only; ' +
        'rebuild with --collateral-token WETH'
      );
    }

    for (const candidate of Object.keys(STRIKE_COUNTS) as CliRfqStructure[]) {
      if (candidate === 'INVERSE_CALL') continue;
      if (implementations[candidate]?.toLowerCase() === current) {
        structureType = candidate;
        break;
      }
    }
  } else {
    throw new Error('Saved RFQ does not use canonical USDC or WETH collateral; refusing to submit it');
  }

  if (!structureType) {
    throw new Error('Saved RFQ uses an unsupported implementation/collateral pairing');
  }
  if (request.params.strikes.length !== STRIKE_COUNTS[structureType]) {
    throw new Error(
      `Saved RFQ implementation ${structureType} expects ${STRIKE_COUNTS[structureType]} strike(s), ` +
      `but the request contains ${request.params.strikes.length}`
    );
  }

  return {
    request: routeCliRfqRequest(request, structureType, collateralToken, implementations),
    structureType,
  };
}
