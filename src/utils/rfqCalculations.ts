/**
 * Thetanuts RFQ — Contract, Collateral & Premium Calculations
 * ============================================================
 *
 * This module provides all calculation logic needed by the SDK for RFQ order
 * creation. It should be implemented in thetanuts-client so that dapps don't
 * need to duplicate this logic.
 *
 * All functions are pure (no side effects, no async). Prices from the SDK's
 * mmPricing module are expected as inputs.
 *
 * Terminology:
 *   - "trade amount"  = user-entered amount in collateral token units
 *   - "collateral"    = WETH/cbBTC for base-collateral products, USDC for quote
 *   - "mmPrice"       = raw MM price in underlying terms (e.g., 0.0042 ETH)
 *   - "spot"          = underlying price in USD (e.g., 2000 for ETH)
 *   - "width"         = max loss per contract for multi-leg structures
 */

// ─── Product Registry ────────────────────────────────────────────────────────

export type ProductName =
  | 'INVERSE_CALL'
  | 'PUT'
  | 'LINEAR_CALL'
  | 'CALL_SPREAD'
  | 'INVERSE_CALL_SPREAD'
  | 'PUT_SPREAD'
  | 'CALL_FLY'
  | 'PUT_FLY'
  | 'CALL_CONDOR'
  | 'PUT_CONDOR'
  | 'IRON_CONDOR'
  | 'RANGER'
  // Physical options (vanilla only)
  | 'PHYSICAL_CALL'
  | 'PHYSICAL_PUT';

/** Products that use base (underlying) collateral: WETH, cbBTC */
const BASE_COLLATERAL_PRODUCTS = new Set<ProductName>([
  'INVERSE_CALL',
  'INVERSE_CALL_SPREAD',
  // Physical call uses underlying (WETH/cbBTC) as collateral
  'PHYSICAL_CALL',
]);

/** All other products use quote (USDC) collateral */
export function isBaseCollateral(product: ProductName): boolean {
  return BASE_COLLATERAL_PRODUCTS.has(product);
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** Result of a validation check */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** Tolerance for floating-point comparisons */
const FLOAT_TOLERANCE = 0.0001;

/**
 * Validate butterfly strikes are equidistant.
 *
 * On-chain requirement: middleStrike - lowerStrike === upperStrike - middleStrike
 *
 * @param strikes  Array of 3 strikes [lower, middle, upper] (any order)
 * @returns ValidationResult with valid=true or error message
 */
export function validateButterfly(strikes: number[]): ValidationResult {
  if (strikes.length !== 3) {
    return { valid: false, error: 'Butterfly requires exactly 3 strikes' };
  }

  const sorted = [...strikes].sort((a, b) => a - b);
  const s0 = sorted[0];
  const s1 = sorted[1];
  const s2 = sorted[2];
  if (s0 === undefined || s1 === undefined || s2 === undefined) {
    return { valid: false, error: 'Invalid strikes array' };
  }

  const wing1 = s1 - s0;
  const wing2 = s2 - s1;

  if (Math.abs(wing1 - wing2) > FLOAT_TOLERANCE) {
    return { valid: false, error: 'Butterfly strikes must be equidistant' };
  }

  return { valid: true };
}

/**
 * Validate condor spread widths are equal.
 *
 * On-chain requirement: strikes[1] - strikes[0] === strikes[3] - strikes[2]
 *
 * @param strikes  Array of 4 strikes [s0, s1, s2, s3] (any order)
 * @returns ValidationResult with valid=true or error message
 */
export function validateCondor(strikes: number[]): ValidationResult {
  if (strikes.length !== 4) {
    return { valid: false, error: 'Condor requires exactly 4 strikes' };
  }

  const sorted = [...strikes].sort((a, b) => a - b);
  const s0 = sorted[0];
  const s1 = sorted[1];
  const s2 = sorted[2];
  const s3 = sorted[3];
  if (s0 === undefined || s1 === undefined || s2 === undefined || s3 === undefined) {
    return { valid: false, error: 'Invalid strikes array' };
  }

  const spread1 = s1 - s0;
  const spread2 = s3 - s2;

  if (Math.abs(spread1 - spread2) > FLOAT_TOLERANCE) {
    return { valid: false, error: 'Condor spread widths must be equal' };
  }

  return { valid: true };
}

/**
 * Validate iron condor spreads don't overlap.
 *
 * On-chain requirement: putUpper <= callLower (strikes[1] <= strikes[2])
 *
 * @param strikes  Array of 4 strikes [putLower, putUpper, callLower, callUpper]
 * @returns ValidationResult with valid=true or error message
 */
export function validateIronCondor(strikes: number[]): ValidationResult {
  if (strikes.length !== 4) {
    return { valid: false, error: 'Iron condor requires exactly 4 strikes' };
  }

  // strikes: [putLower, putUpper, callLower, callUpper]
  const putUpper = strikes[1];
  const callLower = strikes[2];
  if (putUpper === undefined || callLower === undefined) {
    return { valid: false, error: 'Invalid strikes array' };
  }

  if (putUpper > callLower) {
    return { valid: false, error: 'Iron condor spreads must not overlap (putUpper must be <= callLower)' };
  }

  return { valid: true };
}

/**
 * Validate ranger strikes have equal spread widths.
 *
 * On-chain requirement: Both spreads must have equal width k
 * strikes: [callLower, callUpper, putLower, putUpper]
 * Call spread width: callUpper - callLower = k
 * Put spread width: putUpper - putLower = k
 *
 * @param strikes  Array of 4 strikes [callLower, callUpper, putLower, putUpper]
 * @returns ValidationResult with valid=true or error message
 */
export function validateRanger(strikes: number[]): ValidationResult {
  if (strikes.length !== 4) {
    return { valid: false, error: 'Ranger requires exactly 4 strikes' };
  }

  // strikes: [callLower, callUpper, putLower, putUpper]
  const s0 = strikes[0];
  const s1 = strikes[1];
  const s2 = strikes[2];
  const s3 = strikes[3];
  if (s0 === undefined || s1 === undefined || s2 === undefined || s3 === undefined) {
    return { valid: false, error: 'Invalid strikes array' };
  }

  const callSpread = s1 - s0;
  const putSpread = s3 - s2;

  if (Math.abs(callSpread - putSpread) > FLOAT_TOLERANCE) {
    return { valid: false, error: 'Ranger spread widths must be equal' };
  }

  // Also check that callUpper < putLower (zone between spreads)
  if (s1 >= s2) {
    return { valid: false, error: 'Ranger requires callUpper < putLower (zone gap)' };
  }

  return { valid: true };
}

// ─── Premium Per Contract ────────────────────────────────────────────────────

/**
 * Convert raw MM price (in underlying terms) to collateral units.
 *
 * Base collateral (WETH/cbBTC): mmPrice is already in underlying → return as-is.
 * Quote collateral (USDC):      mmPrice × spot → USD value.
 *
 * @param mmPrice  Raw MM price from SDK (fraction of underlying, e.g., 0.0042)
 * @param spot     Underlying price in USD (e.g., 2000)
 * @param product  Product name (determines collateral type)
 */
export function premiumPerContract(
  mmPrice: number,
  spot: number,
  product: ProductName
): number {
  return isBaseCollateral(product) ? mmPrice : mmPrice * spot;
}

// ─── Num Contracts ───────────────────────────────────────────────────────────

/**
 * Calculate number of contracts from a trade amount.
 *
 * Trade amount is always in collateral token units:
 *   - WETH for INVERSE_CALL, INVERSE_CALL_SPREAD
 *   - USDC for everything else
 *
 * SELL formulas:
 *   INVERSE_CALL:          tradeAmount              (1:1, each contract = 1 unit)
 *   INVERSE_CALL_SPREAD:   tradeAmount / (1 - K_min/K_max)
 *   PUT:                   tradeAmount / strike
 *   CALL_SPREAD:           tradeAmount / (K_max - K_min)
 *   PUT_SPREAD:            tradeAmount / |K1 - K2|
 *   CALL_FLY/PUT_FLY:    tradeAmount / wingWidth
 *   CALL_CONDOR/PUT_CONDOR/IRON_CONDOR: tradeAmount / wingWidth
 *
 * BUY formulas:
 *   Base collateral:  tradeAmount / mmPrice
 *   Quote collateral: tradeAmount / (mmPrice × spot)
 *
 * @param tradeAmount  Amount in collateral units (e.g., 1.5 WETH or 3000 USDC)
 * @param product      Product name
 * @param strikes      All strikes as floats (USD)
 * @param isBuy        True for buy (long), false for sell (short)
 * @param mmPrice      (buy only) Raw MM ask price from SDK
 * @param spot         (buy only) Underlying price in USD
 */
export function calculateNumContracts(params: {
  tradeAmount: number;
  product: ProductName;
  strikes: number[];
  isBuy: boolean;
  mmPrice?: number;
  spot?: number;
}): number {
  const { tradeAmount, product, strikes, isBuy } = params;
  if (tradeAmount <= 0) return 0;

  // Buy: tradeAmount / premium per contract (in collateral units)
  if (isBuy) {
    const mmPrice = params.mmPrice ?? 0;
    const spot = params.spot ?? 0;
    if (mmPrice <= 0) return 0;
    const premium = premiumPerContract(mmPrice, spot, product);
    return premium > 0 ? tradeAmount / premium : 0;
  }

  // Sell: tradeAmount / max-loss-per-contract
  switch (product) {
    case 'INVERSE_CALL':
    case 'PHYSICAL_CALL':
      // 1:1 with underlying
      return tradeAmount;

    case 'INVERSE_CALL_SPREAD': {
      // 1 - K_min/K_max (in underlying terms)
      const sorted = strikes.filter((s) => s > 0).sort((a, b) => a - b);
      const kMin = sorted[0];
      const kMax = sorted[1];
      if (kMin === undefined || kMax === undefined) return 0;
      const width = 1 - kMin / kMax;
      return width > 0 ? tradeAmount / width : 0;
    }

    case 'PUT':
    case 'LINEAR_CALL':
    case 'PHYSICAL_PUT': {
      // tradeAmount (USDC) / strike (USD)
      // LINEAR_CALL is a capped call at 2x strike, same collateral formula as PUT
      // PHYSICAL_PUT uses USDC collateral, same formula as PUT
      const strike = strikes[0];
      return strike !== undefined && strike > 0 ? tradeAmount / strike : 0;
    }

    case 'RANGER': {
      // RANGER: zone-bound strategy, width = 2 * k where k = strikes[1] - strikes[0]
      // strikes: [callLower, callUpper, putLower, putUpper]
      if (strikes.length < 4) return 0;
      const rs0 = strikes[0];
      const rs1 = strikes[1];
      if (rs0 === undefined || rs1 === undefined) return 0;
      const k = rs1 - rs0; // first spread width
      const width = 2 * k;
      return width > 0 ? tradeAmount / width : 0;
    }

    case 'IRON_CONDOR': {
      // IRON_CONDOR: max(putSpread, callSpread)
      // strikes: [putLower, putUpper, callLower, callUpper]
      if (strikes.length < 4) return 0;
      const ic0 = strikes[0];
      const ic1 = strikes[1];
      const ic2 = strikes[2];
      const ic3 = strikes[3];
      if (ic0 === undefined || ic1 === undefined || ic2 === undefined || ic3 === undefined) return 0;
      const putSpread = ic1 - ic0;
      const callSpread = ic3 - ic2;
      const width = Math.max(putSpread, callSpread);
      return width > 0 ? tradeAmount / width : 0;
    }

    default: {
      // All other multi-leg USD products: tradeAmount / (width between the two smallest strikes)
      // Covers CALL_SPREAD, PUT_SPREAD, CALL_FLY, PUT_FLY,
      //         CALL_CONDOR, PUT_CONDOR
      const sorted = strikes.filter((s) => s > 0).sort((a, b) => a - b);
      const k0 = sorted[0];
      const k1 = sorted[1];
      if (k0 === undefined || k1 === undefined) return 0;
      const width = k1 - k0;
      return width > 0 ? tradeAmount / width : 0;
    }
  }
}

// ─── Reserve Price ───────────────────────────────────────────────────────────

/**
 * Calculate total reserve price (total premium for all contracts).
 *
 * reservePrice = numContracts × premiumPerContract
 *
 * For buy orders:  this is the max the requester will pay.
 * For sell orders:  this is the min the requester will accept.
 *
 * @param numContracts  Number of contracts
 * @param mmPrice       Raw MM price from SDK (bid for sell, ask for buy)
 * @param spot          Underlying price in USD
 * @param product       Product name
 */
export function calculateReservePrice(
  numContracts: number,
  mmPrice: number,
  spot: number,
  product: ProductName
): number {
  return numContracts * premiumPerContract(mmPrice, spot, product);
}

// ─── Collateral Required ─────────────────────────────────────────────────────

/**
 * Calculate collateral required for a SELL position.
 *
 * This is the amount of collateral that must be deposited when selling options.
 *
 * @param numContracts  Number of contracts
 * @param product       Product name
 * @param strikes       All strikes as floats (USD)
 * @returns Collateral required in collateral token units
 */
export function calculateCollateralRequired(
  numContracts: number,
  product: ProductName,
  strikes: number[]
): number {
  if (numContracts <= 0) return 0;

  switch (product) {
    case 'INVERSE_CALL':
    case 'PHYSICAL_CALL':
      // 1:1 with underlying
      return numContracts;

    case 'INVERSE_CALL_SPREAD': {
      // (1 - K_min/K_max) per contract
      const sorted = strikes.filter((s) => s > 0).sort((a, b) => a - b);
      const kMin = sorted[0];
      const kMax = sorted[1];
      if (kMin === undefined || kMax === undefined) return 0;
      const width = 1 - kMin / kMax;
      return numContracts * width;
    }

    case 'PUT':
    case 'LINEAR_CALL':
    case 'PHYSICAL_PUT': {
      // strike × numContracts (USDC)
      // LINEAR_CALL is a capped call at 2x strike, same collateral formula as PUT
      // PHYSICAL_PUT uses USDC collateral at strike × numContracts
      const strike = strikes[0];
      return strike !== undefined && strike > 0 ? numContracts * strike : 0;
    }

    case 'RANGER': {
      // RANGER: 2 * k × numContracts where k = strikes[1] - strikes[0]
      // strikes: [callLower, callUpper, putLower, putUpper]
      if (strikes.length < 4) return 0;
      const rs0 = strikes[0];
      const rs1 = strikes[1];
      if (rs0 === undefined || rs1 === undefined) return 0;
      const k = rs1 - rs0;
      return numContracts * 2 * k;
    }

    case 'IRON_CONDOR': {
      // IRON_CONDOR: max(putSpread, callSpread) × numContracts
      // strikes: [putLower, putUpper, callLower, callUpper]
      if (strikes.length < 4) return 0;
      const ic0 = strikes[0];
      const ic1 = strikes[1];
      const ic2 = strikes[2];
      const ic3 = strikes[3];
      if (ic0 === undefined || ic1 === undefined || ic2 === undefined || ic3 === undefined) return 0;
      const putSpread = ic1 - ic0;
      const callSpread = ic3 - ic2;
      const width = Math.max(putSpread, callSpread);
      return numContracts * width;
    }

    default: {
      // All other multi-leg USD products: width × numContracts
      // Covers CALL_SPREAD, PUT_SPREAD, CALL_FLY, PUT_FLY,
      //         CALL_CONDOR, PUT_CONDOR
      const sorted = strikes.filter((s) => s > 0).sort((a, b) => a - b);
      const k0 = sorted[0];
      const k1 = sorted[1];
      if (k0 === undefined || k1 === undefined) return 0;
      const width = k1 - k0;
      return numContracts * width;
    }
  }
}

// ─── Physical Option Helpers ─────────────────────────────────────────────────

/**
 * Check if a product is physically settled.
 *
 * Physical options involve actual delivery of the underlying asset at expiry,
 * as opposed to cash settlement.
 *
 * @param product  Product name
 * @returns True if the product is physically settled
 */
export function isPhysicalProduct(product: ProductName): boolean {
  return product.startsWith('PHYSICAL_');
}

// ─── Delivery Amount Calculation ─────────────────────────────────────────────

/**
 * Result of delivery amount calculation.
 */
export interface DeliveryResult {
  /** Amount buyer must deliver at exercise */
  deliveryAmount: number;
  /** Token symbol for delivery (USDC, WETH, cbBTC, or empty string for non-physical) */
  deliveryToken: string;
}

/**
 * Calculate delivery amount for physical options.
 *
 * Physical options require the buyer to deliver assets at exercise:
 * - PHYSICAL_CALL: Buyer delivers strike × numContracts in USDC
 * - PHYSICAL_PUT: Buyer delivers numContracts in underlying (WETH/cbBTC)
 *
 * @param numContracts  Number of contracts
 * @param product       Physical product name
 * @param strikes       Strike prices
 * @param underlying    Underlying asset symbol (ETH, BTC) - defaults to ETH
 * @returns Object with deliveryAmount and deliveryToken
 */
export function calculateDeliveryAmount(
  numContracts: number,
  product: ProductName,
  strikes: number[],
  underlying: 'ETH' | 'BTC' = 'ETH'
): DeliveryResult {
  if (numContracts <= 0) {
    return { deliveryAmount: 0, deliveryToken: 'USDC' };
  }

  const strike = strikes[0] ?? 0;
  const underlyingToken = underlying === 'BTC' ? 'cbBTC' : 'WETH';

  switch (product) {
    case 'PHYSICAL_CALL':
      // Buyer delivers strike × numContracts in USDC
      return {
        deliveryAmount: strike * numContracts,
        deliveryToken: 'USDC',
      };

    case 'PHYSICAL_PUT':
      // Buyer delivers numContracts in underlying
      return {
        deliveryAmount: numContracts,
        deliveryToken: underlyingToken,
      };

    default:
      // Non-physical products don't have delivery
      return { deliveryAmount: 0, deliveryToken: '' };
  }
}

// ─── Verification Examples ───────────────────────────────────────────────────

/**
 * Expected results for verification:
 *
 * 1. INVERSE_CALL sell, 1 WETH trade
 *    → numContracts = 1
 *
 * 2. PUT sell, 2000 USDC trade, strike 2000
 *    → numContracts = 1
 *
 * 3. CALL_SPREAD sell, 500 USDC, strikes [2000, 2500]
 *    → width = 500, numContracts = 1
 *
 * 4. INVERSE_CALL_SPREAD sell, 0.2 WETH, strikes [2000, 2500]
 *    → width = 1 - 2000/2500 = 0.2, numContracts = 1
 *
 * 5. PUT_SPREAD sell, 500 USDC, strikes [2000, 2500]
 *    → width = 500, numContracts = 1
 *
 * 6. CALL_FLY sell, 100 USDC, strikes [1900, 2000, 2100]
 *    → width = 100, numContracts = 1
 *
 * 7. CALL_CONDOR sell, 100 USDC, strikes [1800, 1900, 2100, 2200]
 *    → width = 100, numContracts = 1
 *
 * 8. INVERSE_CALL buy, 1 WETH, mmPrice = 0.05 ETH
 *    → premium = 0.05 (base), numContracts = 20
 *
 * 9. PUT buy, 200 USDC, mmPrice = 0.05 ETH, spot = $2000
 *    → premium = 0.05 × 2000 = $100, numContracts = 2
 */
