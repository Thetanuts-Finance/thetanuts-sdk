import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import { createError } from '../utils/errors.js';
import { toBigInt as toBigIntSafe } from '../utils/decimals.js';

/**
 * Option payout type
 */
export type PayoutType = 'call' | 'put' | 'call_spread' | 'put_spread';

/**
 * Payout calculation parameters
 */
export interface PayoutParams {
  /** Option type */
  type: PayoutType;
  /** Strike price(s) */
  strikes: bigint[];
  /** Settlement/spot price */
  settlementPrice: bigint;
  /** Number of contracts */
  numContracts: bigint;
  /** Price decimals (default: 8) */
  priceDecimals?: number;
  /** Size decimals (default: 18) */
  sizeDecimals?: number;
  /** Collateral decimals (default: 6 for USDC) */
  collateralDecimals?: number;
}

/**
 * Collateral calculation parameters
 */
export interface CollateralParams {
  /** Option type */
  type: PayoutType;
  /** Strike price(s) */
  strikes: bigint[];
  /** Number of contracts */
  numContracts: bigint;
  /** Price decimals (default: 8) */
  priceDecimals?: number;
  /** Size decimals (default: 18) */
  sizeDecimals?: number;
  /** Collateral decimals (default: 6) */
  collateralDecimals?: number;
}

/**
 * Common decimal configurations
 */
export const DECIMALS = {
  /** USDC decimals */
  USDC: 6,
  /** WETH decimals */
  WETH: 18,
  /** cbBTC decimals */
  cbBTC: 8,
  /** Price decimals (Chainlink style) */
  PRICE: 8,
  /** Option size decimals */
  SIZE: 18,
} as const;

/**
 * Module for utility functions
 *
 * Provides methods for:
 * - Decimal conversions
 * - Payout calculations
 * - Collateral calculations
 * - Price formatting
 *
 * @example
 * ```typescript
 * // Convert to bigint
 * const amount = client.utils.toBigInt('100.5', 6);
 *
 * // Convert from bigint
 * const display = client.utils.fromBigInt(100500000n, 6);
 *
 * // Calculate payout
 * const payout = client.utils.calculatePayout({
 *   type: 'call',
 *   strikes: [2000n * 10n**8n],
 *   settlementPrice: 2500n * 10n**8n,
 *   numContracts: 10n * 10n**18n,
 * });
 * ```
 */
export class UtilsModule {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_client: ThetanutsClient) {}

  /**
   * Convert a human-readable number to bigint with specified decimals
   *
   * @param value - Value to convert (number or string)
   * @param decimals - Number of decimals
   * @returns BigInt representation
   *
   * @example
   * ```typescript
   * const amount = client.utils.toBigInt('100.5', 6);
   * // Returns 100500000n
   * ```
   */
  toBigInt(value: number | string, decimals: number): bigint {
    if (decimals < 0 || decimals > 77) {
      throw createError('INVALID_PARAMS', 'Decimals must be between 0 and 77');
    }
    try {
      return toBigIntSafe(value, decimals);
    } catch (err) {
      throw createError(
        'INVALID_PARAMS',
        `Invalid numeric value for toBigInt: ${String(value)}`,
        err
      );
    }
  }

  /**
   * Convert a bigint to a human-readable string with specified decimals
   *
   * @param value - BigInt value to convert
   * @param decimals - Number of decimals
   * @returns String representation
   *
   * @example
   * ```typescript
   * const display = client.utils.fromBigInt(100500000n, 6);
   * // Returns '100.5'
   * ```
   */
  fromBigInt(value: bigint, decimals: number): string {
    if (decimals < 0 || decimals > 77) {
      throw createError('INVALID_PARAMS', 'Decimals must be between 0 and 77');
    }

    if (decimals === 0) {
      return value.toString();
    }

    const str = value.toString().padStart(decimals + 1, '0');
    const whole = str.slice(0, -decimals) || '0';
    const fraction = str.slice(-decimals);
    const trimmedFraction = fraction.replace(/0+$/, '');
    return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
  }

  /**
   * Scale a value from one decimal precision to another
   *
   * @param value - Value to scale
   * @param fromDecimals - Current decimals
   * @param toDecimals - Target decimals
   * @returns Scaled value
   *
   * @example
   * ```typescript
   * // Convert from USDC (6) to internal (18) decimals
   * const scaled = client.utils.scaleDecimals(100000000n, 6, 18);
   * ```
   */
  scaleDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
    if (fromDecimals === toDecimals) {
      return value;
    }

    if (fromDecimals < toDecimals) {
      return value * 10n ** BigInt(toDecimals - fromDecimals);
    }

    return value / 10n ** BigInt(fromDecimals - toDecimals);
  }

  /**
   * Format a bigint value for display
   *
   * @param value - Value to format
   * @param decimals - Value's decimals
   * @param displayDecimals - Number of decimals to show (optional)
   * @returns Formatted string
   *
   * @example
   * ```typescript
   * const formatted = client.utils.formatAmount(123456789012n, 8, 2);
   * // Returns '1234.56'
   * ```
   */
  formatAmount(value: bigint, decimals: number, displayDecimals?: number): string {
    const str = this.fromBigInt(value, decimals);

    if (displayDecimals === undefined) {
      return str;
    }

    const parts = str.split('.');
    const whole = parts[0] ?? '0';
    const fraction = parts[1] ?? '';
    const trimmedFraction = fraction.slice(0, displayDecimals);
    return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
  }

  /**
   * Parse an amount string into bigint
   *
   * @param amount - Amount string (may include commas)
   * @param decimals - Target decimals
   * @returns BigInt value
   *
   * @example
   * ```typescript
   * const amount = client.utils.parseAmount('1,000.50', 6);
   * // Returns 1000500000n
   * ```
   */
  parseAmount(amount: string, decimals: number): bigint {
    const cleaned = amount.replace(/,/g, '');
    return this.toBigInt(cleaned, decimals);
  }

  /**
   * Calculate payout for an option at settlement
   *
   * @param params - Payout calculation parameters
   * @returns Payout amount in collateral decimals
   *
   * @example
   * ```typescript
   * // Call option payout
   * const payout = client.utils.calculatePayout({
   *   type: 'call',
   *   strikes: [2000n * 10n**8n], // $2000 strike
   *   settlementPrice: 2500n * 10n**8n, // $2500 settlement
   *   numContracts: 10n * 10n**18n, // 10 contracts
   * });
   * // Payout = (2500 - 2000) * 10 = $5000
   * ```
   */
  calculatePayout(params: PayoutParams): bigint {
    const { type, strikes, settlementPrice, numContracts } = params;
    const priceDecimals = params.priceDecimals ?? DECIMALS.PRICE;
    const sizeDecimals = params.sizeDecimals ?? DECIMALS.SIZE;
    const collateralDecimals = params.collateralDecimals ?? DECIMALS.USDC;

    const scaleFactor = 10n ** BigInt(priceDecimals);

    let intrinsicValue = 0n;

    switch (type) {
      case 'call': {
        if (strikes.length !== 1 || strikes[0] === undefined) {
          throw createError('INVALID_PARAMS', 'Call option requires exactly one strike');
        }
        const strike = strikes[0];
        if (settlementPrice > strike) {
          intrinsicValue = settlementPrice - strike;
        }
        break;
      }

      case 'put': {
        if (strikes.length !== 1 || strikes[0] === undefined) {
          throw createError('INVALID_PARAMS', 'Put option requires exactly one strike');
        }
        const strike = strikes[0];
        if (settlementPrice < strike) {
          intrinsicValue = strike - settlementPrice;
        }
        break;
      }

      case 'call_spread': {
        if (strikes.length !== 2 || strikes[0] === undefined || strikes[1] === undefined) {
          throw createError('INVALID_PARAMS', 'Call spread requires exactly two strikes');
        }
        const lowerStrike = strikes[0];
        const upperStrike = strikes[1];
        if (settlementPrice > lowerStrike) {
          const effectivePrice = settlementPrice > upperStrike ? upperStrike : settlementPrice;
          intrinsicValue = effectivePrice - lowerStrike;
        }
        break;
      }

      case 'put_spread': {
        if (strikes.length !== 2 || strikes[0] === undefined || strikes[1] === undefined) {
          throw createError('INVALID_PARAMS', 'Put spread requires exactly two strikes');
        }
        const lowerStrike = strikes[0];
        const upperStrike = strikes[1];
        if (settlementPrice < upperStrike) {
          const effectivePrice = settlementPrice < lowerStrike ? lowerStrike : settlementPrice;
          intrinsicValue = upperStrike - effectivePrice;
        }
        break;
      }

      default:
        throw createError('INVALID_PARAMS', `Unknown option type: ${String(type)}`);
    }

    // Calculate total payout: (intrinsic value * num contracts) / scale factor
    // Scale from size decimals to collateral decimals
    const payout = (intrinsicValue * numContracts) / scaleFactor / (10n ** BigInt(sizeDecimals - collateralDecimals));

    return payout;
  }

  /**
   * Calculate maximum collateral required for an option position
   *
   * @param params - Collateral calculation parameters
   * @returns Maximum collateral required
   *
   * @example
   * ```typescript
   * // Call spread collateral (max loss is width of spread)
   * const collateral = client.utils.calculateCollateral({
   *   type: 'call_spread',
   *   strikes: [2000n * 10n**8n, 2200n * 10n**8n],
   *   numContracts: 10n * 10n**18n,
   * });
   * ```
   */
  calculateCollateral(params: CollateralParams): bigint {
    const { type, strikes, numContracts } = params;
    const priceDecimals = params.priceDecimals ?? DECIMALS.PRICE;
    const sizeDecimals = params.sizeDecimals ?? DECIMALS.SIZE;
    const collateralDecimals = params.collateralDecimals ?? DECIMALS.USDC;

    const scaleFactor = 10n ** BigInt(priceDecimals);

    let maxPayout = 0n;

    switch (type) {
      case 'call': {
        // Call seller: theoretically unlimited, but for ERC20 options typically
        // capped at a maximum price. We return strike as a placeholder.
        if (strikes.length !== 1 || strikes[0] === undefined) {
          throw createError('INVALID_PARAMS', 'Call option requires exactly one strike');
        }
        maxPayout = strikes[0]; // This would need to be adjusted based on cap
        break;
      }

      case 'put': {
        // Put seller: max payout is the strike price
        if (strikes.length !== 1 || strikes[0] === undefined) {
          throw createError('INVALID_PARAMS', 'Put option requires exactly one strike');
        }
        maxPayout = strikes[0];
        break;
      }

      case 'call_spread': {
        // Call spread: max payout is width of spread
        if (strikes.length !== 2 || strikes[0] === undefined || strikes[1] === undefined) {
          throw createError('INVALID_PARAMS', 'Call spread requires exactly two strikes');
        }
        const lowerStrike = strikes[0];
        const upperStrike = strikes[1];
        maxPayout = upperStrike - lowerStrike;
        break;
      }

      case 'put_spread': {
        // Put spread: max payout is width of spread
        if (strikes.length !== 2 || strikes[0] === undefined || strikes[1] === undefined) {
          throw createError('INVALID_PARAMS', 'Put spread requires exactly two strikes');
        }
        const lowerStrike = strikes[0];
        const upperStrike = strikes[1];
        maxPayout = upperStrike - lowerStrike;
        break;
      }

      default:
        throw createError('INVALID_PARAMS', `Unknown option type: ${String(type)}`);
    }

    // Calculate collateral: (max payout * num contracts) / scale factor
    // Then scale to collateral decimals
    const collateral = (maxPayout * numContracts) / scaleFactor / (10n ** BigInt(sizeDecimals - collateralDecimals));

    return collateral;
  }

  /**
   * Calculate premium amount from price and size
   *
   * @param pricePerContract - Price per contract
   * @param numContracts - Number of contracts
   * @param priceDecimals - Price decimals
   * @param sizeDecimals - Size decimals
   * @param collateralDecimals - Collateral decimals
   * @returns Premium amount in collateral decimals
   */
  calculatePremium(
    pricePerContract: bigint,
    numContracts: bigint,
    priceDecimals = DECIMALS.PRICE,
    sizeDecimals = DECIMALS.SIZE,
    collateralDecimals = DECIMALS.USDC
  ): bigint {
    // Premium = (price * contracts) / (10^(priceDecimals + sizeDecimals - collateralDecimals))
    const divisor = 10n ** BigInt(priceDecimals + sizeDecimals - collateralDecimals);
    return (pricePerContract * numContracts) / divisor;
  }

  /**
   * Calculate moneyness (ITM/ATM/OTM) for an option
   *
   * @param type - Option type ('call' or 'put')
   * @param strike - Strike price
   * @param spotPrice - Current spot price
   * @returns Moneyness value (positive = ITM, 0 = ATM, negative = OTM)
   */
  calculateMoneyness(
    type: 'call' | 'put',
    strike: bigint,
    spotPrice: bigint
  ): { value: bigint; status: 'ITM' | 'ATM' | 'OTM' } {
    const diff = type === 'call' ? spotPrice - strike : strike - spotPrice;

    let status: 'ITM' | 'ATM' | 'OTM';
    if (diff > 0n) {
      status = 'ITM';
    } else if (diff < 0n) {
      status = 'OTM';
    } else {
      status = 'ATM';
    }

    return { value: diff, status };
  }

  /**
   * Calculate time to expiry in various units
   *
   * @param expiry - Expiry timestamp (seconds)
   * @returns Time to expiry in different units
   */
  calculateTimeToExpiry(expiry: number | bigint): {
    seconds: number;
    minutes: number;
    hours: number;
    days: number;
    years: number;
    isExpired: boolean;
  } {
    const expirySeconds = typeof expiry === 'bigint' ? Number(expiry) : expiry;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const secondsRemaining = expirySeconds - nowSeconds;

    return {
      seconds: secondsRemaining,
      minutes: secondsRemaining / 60,
      hours: secondsRemaining / 3600,
      days: secondsRemaining / 86400,
      years: secondsRemaining / (365.25 * 86400),
      isExpired: secondsRemaining <= 0,
    };
  }

  /**
   * Format a price for display with proper decimal places
   *
   * @param price - Price as bigint
   * @param decimals - Price decimals
   * @param symbol - Currency symbol (optional)
   * @returns Formatted price string
   */
  formatPrice(price: bigint, decimals = DECIMALS.PRICE, symbol = '$'): string {
    const value = this.fromBigInt(price, decimals);
    const [whole, fraction = ''] = value.split('.');
    const formattedWhole = Number(whole).toLocaleString();
    const trimmedFraction = fraction.slice(0, 2);
    const formattedValue = trimmedFraction ? `${formattedWhole}.${trimmedFraction}` : formattedWhole;
    return `${symbol}${formattedValue}`;
  }

  /**
   * Format a percentage for display
   *
   * @param value - Percentage as decimal (e.g., 0.5 for 50%)
   * @param displayDecimals - Number of decimals to show
   * @returns Formatted percentage string
   */
  formatPercentage(value: number, displayDecimals = 2): string {
    return `${(value * 100).toFixed(displayDecimals)}%`;
  }

  /**
   * Get decimals configuration
   */
  get decimals() {
    return DECIMALS;
  }

  // ============================================
  // Strike conversion utilities (precision-safe)
  // ============================================

  /**
   * Convert strike price (number) to bigint with 8 decimals.
   * Uses string-based parsing to avoid floating-point precision errors.
   *
   * This method is specifically designed for strike prices and avoids
   * the floating-point precision issues that can occur with toBigInt().
   *
   * @param strike - Strike price as number (e.g., 1850.5)
   * @returns BigInt with 8 decimal places
   *
   * @example
   * ```typescript
   * const strike = client.utils.strikeToChain(1850.5);
   * // Returns 185050000000n (1850.5 with 8 decimals)
   *
   * // Handles edge cases without floating-point errors
   * const precise = client.utils.strikeToChain(2499.99);
   * // Returns 249999000000n (not 249998999999n from float errors)
   * ```
   */
  strikeToChain(strike: number): bigint {
    // Use toFixed(8) to get consistent string representation
    const strikeStr = strike.toFixed(8);
    const [whole, frac = ''] = strikeStr.split('.');
    // Pad/slice fractional part to exactly 8 digits
    const paddedFrac = frac.padEnd(8, '0').slice(0, 8);
    return BigInt(whole || '0') * BigInt(1e8) + BigInt(paddedFrac);
  }

  /**
   * Convert on-chain strike (bigint with 8 decimals) to number.
   *
   * @param strike - Strike as bigint with 8 decimals
   * @returns Strike as number
   *
   * @example
   * ```typescript
   * const strike = client.utils.strikeFromChain(185050000000n);
   * // Returns 1850.5
   * ```
   */
  strikeFromChain(strike: bigint): number {
    return Number(strike) / 1e8;
  }

  // ============================================
  // Convenience decimal conversion methods
  // ============================================

  /**
   * Convert a value to strike decimals (8 decimals)
   *
   * @param value - Value to convert (number or string)
   * @returns BigInt with 8 decimal places
   *
   * @example
   * ```typescript
   * const strike = client.utils.toStrikeDecimals('2500.50');
   * // Returns 250050000000n (2500.50 with 8 decimals)
   * ```
   */
  toStrikeDecimals(value: number | string): bigint {
    return this.toBigInt(value, DECIMALS.PRICE);
  }

  /**
   * Convert a strike value from 8 decimals to human-readable string
   *
   * @param value - BigInt value with 8 decimals
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const display = client.utils.fromStrikeDecimals(250050000000n);
   * // Returns '2500.5'
   * ```
   */
  fromStrikeDecimals(value: bigint): string {
    return this.fromBigInt(value, DECIMALS.PRICE);
  }

  /**
   * Convert a value to USDC decimals (6 decimals)
   *
   * @param value - Value to convert (number or string)
   * @returns BigInt with 6 decimal places
   *
   * @example
   * ```typescript
   * const amount = client.utils.toUsdcDecimals('100.50');
   * // Returns 100500000n (100.50 with 6 decimals)
   * ```
   */
  toUsdcDecimals(value: number | string): bigint {
    return this.toBigInt(value, DECIMALS.USDC);
  }

  /**
   * Convert a USDC value from 6 decimals to human-readable string
   *
   * @param value - BigInt value with 6 decimals
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const display = client.utils.fromUsdcDecimals(100500000n);
   * // Returns '100.5'
   * ```
   */
  fromUsdcDecimals(value: bigint): string {
    return this.fromBigInt(value, DECIMALS.USDC);
  }

  /**
   * Convert a value to price decimals (8 decimals)
   *
   * @param value - Value to convert (number or string)
   * @returns BigInt with 8 decimal places
   *
   * @example
   * ```typescript
   * const price = client.utils.toPriceDecimals('2500.50');
   * // Returns 250050000000n (2500.50 with 8 decimals)
   * ```
   */
  toPriceDecimals(value: number | string): bigint {
    return this.toBigInt(value, DECIMALS.PRICE);
  }

  /**
   * Convert a price value from 8 decimals to human-readable string
   *
   * @param value - BigInt value with 8 decimals
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const display = client.utils.fromPriceDecimals(250050000000n);
   * // Returns '2500.5'
   * ```
   */
  fromPriceDecimals(value: bigint): string {
    return this.fromBigInt(value, DECIMALS.PRICE);
  }

  // ============================================
  // Order analysis helper methods
  // ============================================

  /**
   * Calculate maximum payout for an order
   *
   * @param order - Order object with optionType and strikes
   * @param numContracts - Number of contracts
   * @returns Maximum possible payout
   *
   * @example
   * ```typescript
   * const maxPayout = client.utils.calculateMaxPayout(order, 5n * 10n**18n);
   * ```
   */
  calculateMaxPayout(
    order: { optionType: number; strikes?: bigint[] },
    numContracts: bigint
  ): bigint {
    const strikes = order.strikes ?? [];
    const type = this.getPayoutTypeFromOptionType(order.optionType, strikes.length);

    return this.calculateCollateral({
      type,
      strikes,
      numContracts,
    });
  }

  /**
   * Calculate payout at a specific settlement price
   *
   * @param order - Order object with optionType and strikes
   * @param numContracts - Number of contracts
   * @param settlementPrice - Settlement price (8 decimals)
   * @returns Payout at that price
   *
   * @example
   * ```typescript
   * const payout = client.utils.calculatePayoutAtPrice(
   *   order,
   *   5n * 10n**18n,
   *   2500n * 10n**8n
   * );
   * ```
   */
  calculatePayoutAtPrice(
    order: { optionType: number; strikes?: bigint[] },
    numContracts: bigint,
    settlementPrice: bigint
  ): bigint {
    const strikes = order.strikes ?? [];
    const type = this.getPayoutTypeFromOptionType(order.optionType, strikes.length);

    return this.calculatePayout({
      type,
      strikes,
      numContracts,
      settlementPrice,
    });
  }

  /**
   * Get the strike width for a spread order
   *
   * @param order - Order object with strikes
   * @returns Strike width (difference between strikes)
   *
   * @example
   * ```typescript
   * const width = client.utils.getStrikeWidth(order);
   * // For strikes [2000, 2200], returns 200 * 10^8
   * ```
   */
  getStrikeWidth(order: { strikes?: bigint[] }): bigint {
    const strikes = order.strikes ?? [];

    if (strikes.length < 2) {
      return 0n;
    }

    // Sort strikes and return difference between highest and lowest
    const sortedStrikes = [...strikes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const lowest = sortedStrikes[0];
    const highest = sortedStrikes[sortedStrikes.length - 1];

    if (lowest === undefined || highest === undefined) {
      return 0n;
    }

    return highest - lowest;
  }

  /**
   * Get the product type for an order
   *
   * @param order - Order object with optionType and strikes
   * @returns Product type: 'vanilla' | 'spread' | 'butterfly' | 'condor'
   *
   * @example
   * ```typescript
   * const productType = client.utils.getProductType(order);
   * // Returns 'spread' for a 2-strike order
   * ```
   */
  getProductType(order: { optionType: number; strikes?: bigint[] }): 'vanilla' | 'spread' | 'butterfly' | 'condor' {
    const strikes = order.strikes ?? [];
    const numStrikes = strikes.length;

    if (numStrikes <= 1) {
      return 'vanilla';
    }

    if (numStrikes === 2) {
      return 'spread';
    }

    if (numStrikes === 3) {
      return 'butterfly';
    }

    if (numStrikes >= 4) {
      return 'condor';
    }

    return 'vanilla';
  }

  /**
   * Check if an order is a call option
   *
   * @param order - Order object with optionType
   * @returns True if the order is a call option
   *
   * @example
   * ```typescript
   * if (client.utils.isCall(order)) {
   *   console.log('This is a call option');
   * }
   * ```
   */
  isCall(order: { optionType: number }): boolean {
    // optionType 0 = Call, 1 = Put (convention)
    return order.optionType === 0;
  }

  /**
   * Check if an order is a put option
   *
   * @param order - Order object with optionType
   * @returns True if the order is a put option
   *
   * @example
   * ```typescript
   * if (client.utils.isPut(order)) {
   *   console.log('This is a put option');
   * }
   * ```
   */
  isPut(order: { optionType: number }): boolean {
    return order.optionType === 1;
  }

  /**
   * Check if an order represents a long position (buyer)
   *
   * @param order - Order object with side or isBuyer property
   * @returns True if the order is a long position
   *
   * @example
   * ```typescript
   * if (client.utils.isLong(order)) {
   *   console.log('This is a long position');
   * }
   * ```
   */
  isLong(order: { side?: 'buy' | 'sell'; isBuyer?: boolean }): boolean {
    if (order.isBuyer !== undefined) {
      return order.isBuyer;
    }
    return order.side === 'buy';
  }

  /**
   * Check if an order represents a short position (seller)
   *
   * @param order - Order object with side or isBuyer property
   * @returns True if the order is a short position
   *
   * @example
   * ```typescript
   * if (client.utils.isShort(order)) {
   *   console.log('This is a short position');
   * }
   * ```
   */
  isShort(order: { side?: 'buy' | 'sell'; isBuyer?: boolean }): boolean {
    return !this.isLong(order);
  }

  /**
   * Convert optionType number to PayoutType string
   * @internal
   */
  private getPayoutTypeFromOptionType(optionType: number, numStrikes: number): PayoutType {
    const isCall = optionType === 0;

    if (numStrikes <= 1) {
      return isCall ? 'call' : 'put';
    }

    // For spreads (2 strikes)
    return isCall ? 'call_spread' : 'put_spread';
  }
}
