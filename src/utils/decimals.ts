/**
 * Standard decimal configurations
 */
export const DECIMALS = {
  USDC: 6,
  WETH: 18,
  cbBTC: 8,
  PRICE: 8, // Standard price decimals (like Chainlink)
  OPTION_SIZE: 18, // Option contract size decimals
} as const;

/** Pre-computed scale for 8-decimal price values */
export const PRICE_SCALE = 10n ** 8n;

/** Scale factor for converting floats to bigint with 12 decimal places of precision */
export const FLOAT_SCALE = 10n ** 12n;
export const FLOAT_SCALE_NUM = 1e12;

/**
 * Convert a float to a scaled bigint representation.
 * Useful for converting API float prices to bigint before doing math.
 *
 * @param value - Float value (e.g., 0.05, 1800.50)
 * @param scale - Scale factor as number (default: 1e12 for 12 decimal places)
 * @returns Scaled bigint (e.g., 0.05 * 1e12 = 50000000000n)
 *
 * @throws If the scaled value exceeds JS Number safe-integer precision.
 *   With the default `scale = 1e12`, the safe input range is roughly
 *   |value| < 9007. Larger inputs (e.g. BTC > $9,007) silently lose low
 *   digits via `Math.round` — reject loudly rather than return a wrong
 *   bigint (TNU-AUDIT-0056). Use `toBigInt(value, decimals)` for string
 *   inputs that preserve full precision.
 */
export function floatToBigInt(value: number, scale: number = FLOAT_SCALE_NUM): bigint {
  if (!Number.isFinite(value)) {
    throw new Error(`floatToBigInt: value must be finite; got ${value}`);
  }
  const scaled = value * scale;
  if (!Number.isFinite(scaled) || Math.abs(scaled) >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `floatToBigInt: scaled value ${scaled} exceeds Number safe-integer range. ` +
        `Use toBigInt(value, decimals) with a string input instead.`,
    );
  }
  return BigInt(Math.round(scaled));
}

/**
 * Convert a number to a fixed-point string without scientific notation
 * Handles edge cases like 1e-7, 1e21 that Number.toString() renders
 * in scientific notation.
 *
 * Uses toString() for normal numbers (preserves human-expected rounding),
 * falls back to toFixed(20) only when toString() produces scientific notation
 */
function toFixedPointString(value: number): string {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  const str = value.toString();
  // Only use toFixed when toString() produces scientific notation (e.g., "1e-7", "1e+21")
  if (/[eE]/.test(str)) {
    const fixed = value.toFixed(20);
    return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return str;
}

/**
 * Convert a human-readable number to bigint with specified decimals
 *
 * Truncates (rounds toward zero) any fractional digits beyond the specified
 * decimal precision. This is standard DeFi behavior — you never want to
 * round UP a spend amount.
 *
 * @param value - Human-readable value (e.g., "1.5", 0.05, "-0.5")
 * @param decimals - Number of decimal places for the target token
 * @returns Bigint representation in smallest unit
 * @throws {Error} If the value cannot be parsed as a valid number
 *
 * @example
 * ```typescript
 * toBigInt("1.5", 6)      // 1500000n (1.5 USDC)
 * toBigInt(0.05, 8)       // 5000000n (0.05 in 8 decimals)
 * toBigInt("0.1234567", 6) // 123456n (truncated, not rounded)
 * toBigInt(1e-7, 8)       // 10n (0.0000001 in 8 decimals)
 * toBigInt("-1.5", 6)     // -1500000n
 * ```
 */
export function toBigInt(value: number | string, decimals: number): bigint {
  // Normalize: convert number to fixed-point string to handle scientific notation
  let str: string;
  if (typeof value === 'number') {
    str = toFixedPointString(value);
  } else {
    // Handle string scientific notation like "1e6"
    if (/[eE]/.test(value)) {
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`Invalid numeric string: ${value}`);
      }
      str = toFixedPointString(num);
    } else {
      str = value;
    }
  }

  // Handle negative numbers: extract sign, process magnitude, apply sign at the end
  const negative = str.startsWith('-');
  if (negative) {
    str = str.slice(1);
  }

  // Split into whole and fraction
  const [whole = '0', fraction = ''] = str.split('.');

  // Validate whole part is numeric
  if (!/^\d+$/.test(whole)) {
    throw new Error(`Invalid numeric value: ${negative ? '-' : ''}${str}`);
  }

  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  const result = BigInt(whole + paddedFraction);
  return negative ? -result : result;
}

/**
 * Convert a bigint to a human-readable number string with specified decimals
 *
 * @param value - Bigint value in smallest unit
 * @param decimals - Number of decimal places
 * @returns Human-readable string (e.g., "1.5")
 *
 * @example
 * ```typescript
 * fromBigInt(1500000n, 6)  // "1.5"
 * fromBigInt(-1500000n, 6) // "-1.5"
 * fromBigInt(0n, 6)        // "0"
 * ```
 */
export function fromBigInt(value: bigint, decimals: number): string {
  // Handle negative values: process magnitude, prepend sign
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const str = abs.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, -decimals) || '0';
  const fraction = str.slice(-decimals);
  const trimmedFraction = fraction.replace(/0+$/, '');
  const result = trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
  return negative ? `-${result}` : result;
}

/**
 * Scale a value from one decimal precision to another
 */
export function scaleDecimals(
  value: bigint,
  fromDecimals: number,
  toDecimals: number
): bigint {
  if (fromDecimals === toDecimals) {
    return value;
  }

  if (fromDecimals < toDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }

  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

/**
 * Format a bigint value for display with the given decimals
 */
export function formatAmount(
  value: bigint,
  decimals: number,
  displayDecimals?: number
): string {
  const str = fromBigInt(value, decimals);
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
 * Parse an amount string into bigint with proper decimal handling
 */
export function parseAmount(amount: string, decimals: number): bigint {
  // Remove any commas
  const cleaned = amount.replace(/,/g, '');
  return toBigInt(cleaned, decimals);
}
