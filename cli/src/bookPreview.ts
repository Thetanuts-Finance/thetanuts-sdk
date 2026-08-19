/**
 * OptionBook prices use the protocol's fixed 8-decimal scale. Contract counts
 * for the CLI's supported USDC book fills use 6 decimals.
 */
export const BOOK_PRICE_SCALE = 100_000_000n;

export interface BookPreviewAmounts {
  numContracts: bigint;
  pricePerContract: bigint;
  totalCollateral: bigint;
}

/**
 * Correct the legacy SDK preview's `totalCollateral` field locally.
 *
 * Older SDK releases echo the requested spend ceiling when one is provided.
 * That is harmless for contract encoding, but it overstates the premium when
 * maker liquidity caps the fill. The CLI must approve and display the premium
 * for the contracts that will actually be filled.
 */
export function withActualBookPremium<T extends BookPreviewAmounts>(preview: T): T {
  return {
    ...preview,
    totalCollateral:
      (preview.numContracts * preview.pricePerContract) / BOOK_PRICE_SCALE,
  };
}

/**
 * Ceiling of the same premium — for allowance sizing only.
 *
 * `withActualBookPremium` floors, matching the SDK's own formula. If the
 * OptionBook contract instead rounds the taker's premium up, an exactly-floored
 * approval is one unit short and the fill reverts at broadcast. Approving the
 * ceiling costs at most one unit of the collateral token (1e-6 USDC) and makes
 * the fill robust to either rounding convention. Display still shows the real
 * (floored) premium.
 */
export function bookPremiumCeiling(preview: BookPreviewAmounts): bigint {
  const product = preview.numContracts * preview.pricePerContract;
  return (product + BOOK_PRICE_SCALE - 1n) / BOOK_PRICE_SCALE;
}
