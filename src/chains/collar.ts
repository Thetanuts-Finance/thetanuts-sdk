/**
 * Collar Loan Configuration
 *
 * Contract addresses + tunable knobs for the collar loan flow on Base.
 *
 * NOTE: collar-v12 is not yet deployed on Base mainnet. The coordinator/handler
 * addresses below are zero placeholders. Write methods on CollarModule will
 * throw a clear "not deployed" error until these are populated.
 */

export interface CollarAssetConfig {
  collateral: string;
  decimals: number;
  priceFeed: string;
}

export interface CollarSettings {
  /** Hide caps expiring sooner than this. */
  minDurationDays: number;
  /** Hide caps below this $ floor (0 disables). */
  minCapStrikeUsd: number;
  /** Hide caps within this % of the implied trigger — too tight to be a real collar. */
  minCapGapPct: number;
  /** After dedup, how many distinct loan tiers to surface per expiry. */
  maxStrikesPerExpiry: number;
  /** Conservative MM margin (% of call premium that MM keeps as edge). */
  mmMarginPct: number;
  /** minLoan = estimate × reserveFloor/100, in USDC. Auction won't fill below. */
  reserveFloorPct: number;
}

export const COLLAR_DEFAULT_SETTINGS: CollarSettings = {
  minDurationDays: 30,
  // 0 disables the floor. Collateral can be BTC (~$90k) or ETH (~$2k), so any
  // non-zero default is wrong for one of the two assets; let callers opt-in.
  minCapStrikeUsd: 0,
  minCapGapPct: 20,
  maxStrikesPerExpiry: 6,
  mmMarginPct: 4,
  reserveFloorPct: 90,
};

export const COLLAR_CONFIG = {
  /** CollarLoanCoordinator and friends — PLACEHOLDERS until collar-v12 ships. */
  contracts: {
    collarCoordinator: '0x0000000000000000000000000000000000000000',
    collarHandler: '0x0000000000000000000000000000000000000000',
    collaredCallOption: '0x0000000000000000000000000000000000000000',
  },

  /** Strike price decimals (Chainlink-style, on-chain representation). */
  strikeDecimals: 8,

  /** Settlement token address (USDC on Base). */
  settlement: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',

  /** Pricing reference (shared with LoanModule). */
  pricingUrl: 'https://pricing.thetanuts.finance/all',

  /** Default offer duration when posting an RFQ. Matches the broader RFQ convention (~5 min). */
  defaultOfferDurationSeconds: 300,

  /** Settlement token decimals (USDC on Base). */
  settlementDecimals: 6,

  /** Per-asset collateral configuration. */
  assets: {
    ETH: {
      collateral: '0x4200000000000000000000000000000000000006',
      decimals: 18,
      priceFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    } satisfies CollarAssetConfig,
    BTC: {
      collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      decimals: 8,
      priceFeed: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
    } satisfies CollarAssetConfig,
  },
} as const;

export function isCollarDeployed(): boolean {
  return COLLAR_CONFIG.contracts.collarCoordinator !== '0x0000000000000000000000000000000000000000';
}
