/**
 * WheelVault Types — Wheel strategy vaults on Ethereum
 *
 * Types for the WheelVault, WheelVaultRouter, WheelVaultLens,
 * Markets, MarketsLens, and VaultMath contracts.
 */

import type { TransactionReceipt } from 'ethers';

// ─── Asset Configuration ───

export type WheelVaultAssetKey = 'WBTC' | 'XAUT' | 'SPYON';

export interface WheelVaultAssetConfig {
  label: string;
  icon: string;
  vault: string;
  markets: string;
  marketsLens: string;
  color: string;
  colorGradient: string;
}

// ─── Vault Series ───

export interface VaultSeries {
  strike: bigint;
  epochExpiry: bigint;
  strategy: bigint;
  totalShares: bigint;
  idleBase: bigint;
  idleQuote: bigint;
  contributionLiq: [bigint, bigint, bigint];
  active: boolean;
}

// ─── Vault State (aggregated from multicall) ───

export interface VaultState {
  seriesCount: number;
  series: VaultSeries;
  currentPrice: bigint;
  tvl: bigint;
  baseValueInQuote: bigint;
  totalBaseAmt: bigint;
  totalQuoteAmt: bigint;
  /**
   * Third return of `totalAssets()` — total vault value in quote-decimals,
   * sourced from the same accounting view as `totalBaseAmt`/`totalQuoteAmt`.
   * Surfaced separately from `tvl` (which derives from `seriesTotalValue`)
   * so callers can detect divergence (TNU-AUDIT-0018).
   */
  totalValueFromAssets: bigint;
  ivBps: number;
  baseDecimals: number;
  quoteDecimals: number;
  baseAddress: string;
  quoteAddress: string;
  baseIsToken0: boolean;
  seriesTokenAddress: string;
  vaultMathAddress: string;
  /**
   * Epoch expiry timestamps as Unix seconds (NOT milliseconds).
   * To produce a JS `Date`, multiply by 1000 (TNU-AUDIT-0019).
   */
  epochExpiries: number[];
  paused: boolean;
}

// ─── Share Snapshot ───

export interface ShareSnapshot {
  basePerShare: bigint;
  quotePerShare: bigint;
  priceAtRoll: bigint;
  timestamp: number;
  epoch: number;
}

// ─── Depth Chart Types ───

export interface DeficitPreview {
  lockPerShareBase: bigint;
  spotPrice: bigint;
  hedgingCostPerShareQuote: bigint;
  intrinsicPerShareQuote: bigint;
  effectiveDeficitPerShareQuote: bigint;
  tte: bigint;
  strike: bigint;
}

export interface BucketPreview {
  ivBps: number;
  premiumPerUnitQuote: bigint;
  premiumPerShareQuote: bigint;
  cutoffBps: number;
  sellerNetPerShareQuote: bigint;
  fillableShares: bigint;
  contributorsAvailable: number;
  scannedCount: number;
  bucketActive: boolean;
}

export interface DepthChartResult {
  deficitPreview: DeficitPreview;
  bucketPreviews: BucketPreview[];
}

// ─── Option Types ───

export interface VaultOption {
  buyer: string;
  side: number;
  status: number;
  seriesId: number;
  numContributors: number;
  expiry: number;
  notionalBase: bigint;
  lockAmount: bigint;
  strike18: bigint;
  sharesToFill: bigint;
}

export interface ExercisePreview {
  isCall: boolean;
  lockAmount: bigint;
  strikePayment: bigint;
  spotValue: bigint;
  /**
   * int256 — signed bigint. NEGATIVE for OTM options (exercise would lose funds).
   * Use `canExercise` and `shouldExercise` to gate exercise decisions, NOT this value.
   * Never coerce to Number() — values can exceed 2^53 and lose precision.
   */
  exerciseProfit: bigint;
  expiry: bigint;
  canExercise: boolean;
  /**
   * Convenience gate: true iff `canExercise === true` AND `exerciseProfit > 0n`.
   * Authoritative guard for automated exercise decisions; safer than reading `exerciseProfit` directly.
   */
  shouldExercise: boolean;
  isExpired: boolean;
}

export interface SellerPosition {
  entryId: number;
  ivBps: number;
  shares: bigint;
  minAcceptableBps: number;
  isExpired: boolean;
}

export interface FillTranche {
  ivBps: number;
  sharesFilled: bigint;
  premiumQuote: bigint;
  premiumPerShareQuote: bigint;
}

export interface FillPremiumPreview {
  totalPremiumQuote: bigint;
  totalSharesFilled: bigint;
  trancheCount: number;
  tranches: FillTranche[];
}

export interface BuyerOption {
  optionId: bigint;
  side: number;
  status: number;
  seriesId: number;
  expiry: number;
  notionalBase: bigint;
  lockAmount: bigint;
  strike18: bigint;
}

export interface ClaimableSummary {
  claimableBase: bigint;
  claimableQuote: bigint;
  claimableShares: bigint[];
}

// ─── Deposit/Withdraw Preview ───

export interface DepositPreview {
  sharesToMint: bigint;
}

export interface WithdrawPreview {
  baseOut: bigint;
  quoteOut: bigint;
  baseFee: bigint;
  quoteFee: bigint;
}

export interface DepositSplitEstimate {
  swapAmt: bigint;
  keepAmt: bigint;
}

// ─── Transaction Results ───

export interface VaultDepositResult {
  receipt: TransactionReceipt;
  sharesToMint: bigint;
}

export interface VaultWithdrawResult {
  receipt: TransactionReceipt;
  baseOut: bigint;
  quoteOut: bigint;
}

// ─── Router Types ───

export interface MarketSwapParams {
  router: string;
  approvalTarget: string;
  minAmountOut: bigint;
  deadline: bigint;
  data: string;
}

export interface DepositSingleParams {
  vaultAddress: string;
  seriesId: number;
  depositToken: string;
  depositAmount: bigint;
  aggregator: string;
  swapData: string;
  expectedPrice: bigint;
  minShares: bigint;
}

export interface DepositDualParams {
  vaultAddress: string;
  seriesId: number;
  baseAmt: bigint;
  quoteAmt: bigint;
  expectedPrice: bigint;
  minShares: bigint;
}

export interface WithdrawSingleParams {
  vaultAddress: string;
  seriesId: number;
  shares: bigint;
  targetToken: string;
  aggregator: string;
  swapData: string;
  minOut: bigint;
}

export interface WithdrawSingleWithPermitParams extends WithdrawSingleParams {
  deadline: bigint;
  v: number;
  r: string;
  s: string;
}

// ─── MarketFill Params ───

export interface MarketFillParams {
  seriesId: number;
  isCall: boolean;
  sharesToFill: bigint;
  maxIvBps: number;
  minCollateralOut: bigint;
  maxPremium: bigint;
  maxStructDeficitQuote: bigint;
  maxExecutionTopupQuote: bigint;
  deadline: bigint;
  useSwap: boolean;
  swap: MarketSwapParams;
}

export interface DepositToBucketParams {
  seriesId: number;
  ivBps: number;
  shares: bigint;
  minAcceptableBps: number;
  expiryType: number;
  expiryParam: bigint;
}

// ─── Uniswap V3 Position ───

export interface UniswapV3Position {
  nonce: bigint;
  operator: string;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}
