import { getAddress, isAddress } from 'ethers';
import { createError } from './errors.js';

/**
 * Validate that a value is a valid Ethereum address. Returns the EIP-55
 * checksummed form so callers can normalize at the boundary (TNU-AUDIT-0055).
 *
 * Existing callsites that ignore the return value remain correct — they
 * just keep using their lowercase/mixed-case input. New code should consume
 * the return value to ensure consistent checksum casing in calldata and
 * round-trip equality with checksummed config strings.
 */
export function validateAddress(address: string, fieldName: string): string {
  if (!isAddress(address)) {
    const invalidAddress = address as string;
    throw createError(
      'INVALID_PARAMS',
      `Invalid ${fieldName}: ${invalidAddress} is not a valid Ethereum address`
    );
  }
  return getAddress(address);
}

/**
 * Validate that a string is `0x`-prefixed hex of the expected byte length.
 * Catches malformed signatures (and any other fixed-width hex inputs) at the
 * SDK boundary so callers do not pay gas for a guaranteed on-chain revert
 * (TNU-AUDIT-0082).
 *
 * @param value - The candidate hex string
 * @param byteLength - Expected length in bytes (e.g. 65 for a vrs signature)
 * @param fieldName - Field name surfaced in the error message
 */
export function validateHexBytes(value: string, byteLength: number, fieldName: string): void {
  if (typeof value !== 'string') {
    throw createError('INVALID_PARAMS', `${fieldName} must be a hex string`);
  }
  const expectedLen = 2 + byteLength * 2; // "0x" + 2 hex chars per byte
  const hexPattern = new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`);
  if (value.length !== expectedLen || !hexPattern.test(value)) {
    throw createError(
      'INVALID_PARAMS',
      `${fieldName} must be a 0x-prefixed ${byteLength}-byte hex string (got length ${value.length})`,
    );
  }
}

/**
 * Validate that an order has not expired and is not absurdly far in the future.
 * A 5-year upper bound catches the common off-by-1000 milliseconds-vs-seconds
 * bug that would otherwise sign a 50,000-year-future order (TNU-AUDIT-0073).
 */
export function validateOrderExpiry(expiry: number, bufferSeconds = 60): void {
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now + bufferSeconds) {
    throw createError(
      'ORDER_EXPIRED',
      `Order has expired or will expire within ${bufferSeconds} seconds`,
      undefined,
      { expiry, now, bufferSeconds }
    );
  }
  const maxFutureSeconds = 86400 * 365 * 5; // 5 years
  if (expiry - now > maxFutureSeconds) {
    throw createError(
      'INVALID_PARAMS',
      `Order expiry is too far in the future (${expiry - now} seconds). ` +
        'Did you accidentally pass milliseconds instead of seconds?',
      undefined,
      { expiry, now, maxFutureSeconds },
    );
  }
}

/**
 * Validate that requested fill size is within available size
 */
export function validateFillSize(
  requestedSize: bigint,
  availableSize: bigint,
  minSize?: bigint
): void {
  if (requestedSize <= 0n) {
    throw createError('INVALID_PARAMS', 'Fill size must be greater than 0');
  }

  if (requestedSize > availableSize) {
    throw createError(
      'SIZE_EXCEEDED',
      `Requested size ${requestedSize.toString()} exceeds available size ${availableSize.toString()}`,
      undefined,
      { requestedSize: requestedSize.toString(), availableSize: availableSize.toString() }
    );
  }

  if (minSize !== undefined && requestedSize < minSize) {
    throw createError(
      'INVALID_PARAMS',
      `Requested size ${requestedSize.toString()} is below minimum size ${minSize.toString()}`,
      undefined,
      { requestedSize: requestedSize.toString(), minSize: minSize.toString() }
    );
  }
}

/**
 * Validate slippage check for buy orders
 * @param actualPrice The actual price from the order
 * @param maxPrice Maximum price the buyer is willing to pay
 */
export function validateBuySlippage(actualPrice: bigint, maxPrice: bigint): void {
  if (actualPrice > maxPrice) {
    throw createError(
      'SLIPPAGE_EXCEEDED',
      `Price ${actualPrice.toString()} exceeds maximum allowed price ${maxPrice.toString()}`,
      undefined,
      { actualPrice: actualPrice.toString(), maxPrice: maxPrice.toString() }
    );
  }
}

/**
 * Validate slippage check for sell orders
 * @param actualPrice The actual price from the order
 * @param minPrice Minimum price the seller is willing to accept
 */
export function validateSellSlippage(actualPrice: bigint, minPrice: bigint): void {
  if (actualPrice < minPrice) {
    throw createError(
      'SLIPPAGE_EXCEEDED',
      `Price ${actualPrice.toString()} is below minimum acceptable price ${minPrice.toString()}`,
      undefined,
      { actualPrice: actualPrice.toString(), minPrice: minPrice.toString() }
    );
  }
}

/**
 * Calculate slippage-adjusted price
 * @param price Base price
 * @param slippageBps Slippage tolerance in basis points (e.g., 50 = 0.5%)
 * @param isBuy Whether this is a buy order (adds slippage) or sell (subtracts)
 */
export function calculateSlippagePrice(
  price: bigint,
  slippageBps: number,
  isBuy: boolean
): bigint {
  // Reject negative/non-integer/>100% slippage — negative inverts direction
  // and >10000 underflows the BigInt formula for sells (TNU-AUDIT-0072).
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) {
    throw createError(
      'INVALID_PARAMS',
      `slippageBps must be an integer in [0, 10000]; got ${slippageBps}`,
    );
  }
  const basisPoints = 10000n;
  const slippage = BigInt(slippageBps);

  if (isBuy) {
    // For buys, add slippage to get max price
    return (price * (basisPoints + slippage)) / basisPoints;
  } else {
    // For sells, subtract slippage to get min price
    return (price * (basisPoints - slippage)) / basisPoints;
  }
}
