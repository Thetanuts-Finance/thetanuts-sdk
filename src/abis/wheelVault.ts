/**
 * WheelVault Contract ABIs (Ethereum Mainnet)
 *
 * ABIs for wheel strategy vault contracts.
 * Converted from ethers v5 JSON format to ethers v6 human-readable format.
 */

/** WheelVault — multi-series vault with Uniswap V3 LP positions */
export const WHEEL_VAULT_ABI = [
  // --- View functions ---
  'function base() view returns (address)',
  'function quote() view returns (address)',
  'function vaultMath() view returns (address)',
  'function minDepositValue() view returns (uint256)',
  'function getTwapPrice() view returns (uint256 price)',
  'function ivBps() view returns (uint256)',
  'function lastActiveTick() view returns (int24)',
  'function getCurrentPrice() view returns (uint256 price)',
  'function currentPositionIds(uint256) view returns (uint256)',
  'function paused() view returns (bool)',
  'function totalAssets() view returns (uint256 totalBaseAmt, uint256 totalQuoteAmt, uint256 totalValue)',
  'function seriesCount() view returns (uint256)',
  'function series(uint256 seriesId) view returns (uint256 strike, uint256 epochExpiry, uint256 strategy, uint256 totalShares, uint256 idleBase, uint256 idleQuote, uint128[3] contributionLiq, bool active)',
  'function seriesToken(uint256 seriesId) view returns (address)',
  'function seriesTotalValue(uint256 seriesId) view returns (uint256 baseValueInQuote, uint256 totalValue)',
  'function getShareValueInQuote(uint256 seriesId, uint256 shares) view returns (uint256)',
  'function getEffectiveExpiryForSeries(uint256 seriesId) view returns (uint256)',
  'function getEpochExpiries(uint256 seriesId) view returns (uint40[])',
  'function baseDecimals() view returns (uint8)',
  'function quoteDecimals() view returns (uint8)',
  'function getSnapshot(uint256 seriesId, uint40 expiry) view returns (tuple(uint128 basePerShare, uint128 quotePerShare, uint128 priceAtRoll, uint40 timestamp, uint48 epoch))',
  'function getSnapshotRange(uint256 seriesId, uint256 fromIndex, uint256 toIndex) view returns (tuple(uint128 basePerShare, uint128 quotePerShare, uint128 priceAtRoll, uint40 timestamp, uint48 epoch)[])',
  'function getAaveValue(uint256 seriesId, uint256 price) view returns (uint256 baseValueInQuote, uint256 quoteValue)',
  'function cowEnabled() view returns (bool)',
  'function aaveEnabled() view returns (bool)',
  'function cowThresholdBps() view returns (uint256)',
  'function cowSlippageBps() view returns (uint256)',
  'function pool() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function feeTier() view returns (uint24)',
  'function baseIsToken0() view returns (bool)',
  'function pokeProfitWei() view returns (uint256)',
  'function pokeCooldown() view returns (uint256)',
  'function lastPaidPokeTime() view returns (uint256)',
  'function ivUpdater() view returns (address)',
  'function minLiquidity() view returns (uint128)',
  'function owner() view returns (address)',
  'function withdrawFeeBps() view returns (uint16)',

  // --- Write functions ---
  'function deposit(uint256 seriesId, uint256 baseAmt, uint256 quoteAmt, uint256 expectedPrice) returns (uint256 sharesToMint)',
  'function deposit(uint256 seriesId, uint256 baseAmt, uint256 quoteAmt, uint256 expectedPrice, address onBehalfOf) returns (uint256 sharesToMint)',
  'function withdraw(uint256 seriesId, uint256 sharesToBurn) returns (uint256 baseOut, uint256 quoteOut)',
  'function withdraw(uint256 seriesId, uint256 sharesToBurn, address recipient) returns (uint256 baseOut, uint256 quoteOut)',
  'function withdrawIdle(uint256 seriesId, uint256 sharesToBurn)',
  // trigger() is admin/keeper-only and reverts for non-owner callers. Intentionally omitted from the SDK ABI.
  'function poke()',

  // --- Events ---
  'event Deposit(uint256 indexed seriesId, address indexed user, uint256 baseAmt, uint256 quoteAmt, uint256 shares, uint256 totalShares, uint256 spotPrice, uint256 valuationPrice)',
  'event Withdraw(uint256 indexed seriesId, address indexed user, uint256 shares, uint256 baseOut, uint256 quoteOut, uint256 totalShares, uint256 price)',
  'event Trigger(int24 indexed newTick, uint256[3] positionIds)',
  'event Roll(uint256 indexed seriesId, uint256 indexed newEpochExpiry)',
  'event FeesCollected(uint256 indexed seriesId, uint256 baseFees, uint256 quoteFees)',
  'event SeriesAdded(uint256 indexed seriesId, uint256 strike, uint256 strategy)',
  'event IvBpsUpdated(uint256 newIvBps)',
  'event PauseToggled(bool paused)',
  'event CowEnabledToggled(bool enabled)',
  'event PokeRewardWithdrawn(address indexed to, uint256 amount)',
  'event ExcessSwept(address indexed token, uint256 amount)',
  'event EpochSnapshot(uint256 indexed seriesId, uint256 indexed epochExpiry, uint256 idleBase, uint256 idleQuote, uint256 totalShares)',
  'event SeriesDeactivated(uint256 indexed seriesId)',
  'event IvUpdaterSet(address indexed oldUpdater, address indexed newUpdater)',
  'event AaveEnabledToggled(bool enabled)',
  'event SeriesTokenDeployed(uint256 indexed seriesId, address indexed token)',
  'event IdleDeductionCapped(uint256 indexed seriesId, uint256 baseOvershoot, uint256 quoteOvershoot)',
  'event ShareSnapshotRecorded(uint256 indexed seriesId, uint48 epoch, uint128 basePerShare, uint128 quotePerShare, uint128 priceAtRoll, uint40 timestamp)',
  'event AaveYieldCollected(uint256 indexed seriesId, uint256 baseDeposited, uint256 baseWithdrawn, uint256 quoteDeposited, uint256 quoteWithdrawn)',
  'event AaveSupplied(uint256 baseAmt, uint256 quoteAmt)',
  'event AaveWithdrawn(uint256 baseAmt, uint256 quoteAmt)',
  'event AaveOperationFailed(string operation, address asset)',
  'event WithdrawIdle(uint256 indexed seriesId, address indexed user, uint256 shares, uint256 baseOut, uint256 quoteOut)',
];

/** VaultMathExternal — pure math helpers (Black-Scholes delta) */
export const VAULT_MATH_ABI = [
  'function bsBaseDelta(uint256 spot, uint256 strike, uint256 ivBps, uint256 tteSeconds) pure returns (uint256 delta)',
];

/** Markets — option minting, bucket deposits, exercise/expiry */
export const WHEEL_MARKETS_ABI = [
  // --- Write functions ---
  'function marketFill(uint256 seriesId, bool isCall, uint256 sharesToFill, uint16 maxIvBps, uint256 minCollateralOut, uint256 maxPremium, uint256 maxStructDeficitQuote, uint256 maxExecutionTopupQuote, uint256 deadline, bool useSwap, tuple(address router, address approvalTarget, uint256 minAmountOut, uint256 deadline, bytes data) swap) returns (uint256 optionId)',
  'function depositToBucket(uint256 seriesId, uint16 ivBps, uint256 shares, uint16 minAcceptableBps, uint8 expiryType, uint256 expiryParam) returns (uint256 entryId)',
  'function cancelDeposit(uint256 entryId)',
  'function claim(address token)',
  'function exercise(uint256 optionId)',
  'function expire(uint256 optionId)',
  'function swapAndExercise(uint256 optionId, address swapTarget, bytes swapData)',
  'function sweepExpired(uint256 seriesId, uint16 ivBps, uint256 maxEntries)',

  // --- View functions ---
  'function options(uint256 optionId) view returns (address buyer, uint8 side, uint8 status, uint16 seriesId, uint16 numContributors, uint40 expiry, uint128 notionalBase, uint128 lockAmount, uint128 strike18, uint128 sharesToFill)',
  'function claimable(address user, address token) view returns (uint256)',
  'function nextOptionId() view returns (uint256)',
  'function previewFillableShares(uint256 seriesId, uint16 ivBps, uint256 maxEntries) view returns (uint256 fillableShares, uint16 contributorsUsed, uint256 scannedEntries, uint256 blockedEntryId, bool isTruncated)',
  'function isEntryExpired(uint256 entryId) view returns (bool)',
  'function vault() view returns (address)',
  'function EXERCISE_WINDOW() view returns (uint256)',
  'function routerWhitelist(address) view returns (bool)',

  // --- Events ---
  'event OptionMinted(uint256 indexed optionId, address buyer, uint256 seriesId, uint8 side, uint128 notionalBase, uint128 lockAmount, uint128 strike18, uint40 expiry, uint16 numContributors, uint128 sharesToFill)',
  'event MarketFillExecuted(uint256 indexed optionId, uint256 indexed seriesId, address buyer, uint256 shares, uint256 collateral, address collateralToken, uint256 premiumTotal, uint256 hedgingCostQuote, uint256 intrinsicQuote, uint16 bucketsUsed, uint256 itmPenaltyQuote, uint256 convPenaltyQuote, uint256 executionTopupUsedQuote)',
  'event BucketDeposit(uint256 indexed seriesId, uint16 indexed ivBps, uint256 indexed entryId, address seller, uint256 shares, uint16 minAcceptableBps, uint8 expiryType, uint256 expiryParam)',
  'event BucketCancel(uint256 indexed entryId, uint256 indexed seriesId, uint16 indexed ivBps, address seller, uint256 shares)',
  'event OptionExercised(uint256 indexed optionId, address indexed buyer, uint256 strikePayment)',
  'event OptionExpired(uint256 indexed optionId)',
  'event Claimed(address indexed seller, address indexed token, uint256 amount)',
  'event SwapExercised(uint256 indexed optionId, address indexed buyer, uint256 deltaSrc, uint256 deltaRcv, uint256 sellerPayment, uint256 buyerProfit)',
  'event EntryConsumed(uint32 indexed entryId, uint256 indexed optionId, uint128 sharesConsumed, uint128 sharesRemaining)',
  'event EntryExpired(uint256 indexed entryId, uint256 indexed seriesId, uint16 indexed ivBps, address seller, uint256 shares)',
  'event RouterWhitelistUpdated(address indexed router, bool isWhitelisted)',
  'event LiqParamUpdated(uint256 indexed seriesId, uint256 value)',
  'event SurchargesApplied(uint256 indexed optionId, uint256 itmPenaltyQuote, uint256 convPenaltyQuote)',
];

/** MarketsLens — read-only previews and position queries */
export const WHEEL_MARKETS_LENS_ABI = [
  'function getDepthChart(uint256 seriesId, bool isCall, uint16 maxIvBps) view returns (tuple(uint256 lockPerShareBase, uint256 spotPrice, uint256 hedgingCostPerShareQuote, uint256 intrinsicPerShareQuote, uint256 effectiveDeficitPerShareQuote, uint256 tte, uint256 strike) deficitPreview, tuple(uint16 ivBps, uint256 premiumPerUnitQuote, uint256 premiumPerShareQuote, uint16 cutoffBps, uint256 sellerNetPerShareQuote, uint256 fillableShares, uint16 contributorsAvailable, uint16 scannedCount, bool bucketActive)[] bucketPreviews)',
  'function previewDeficit(uint256 seriesId, bool isCall) view returns (tuple(uint256 lockPerShareBase, uint256 spotPrice, uint256 hedgingCostPerShareQuote, uint256 intrinsicPerShareQuote, uint256 effectiveDeficitPerShareQuote, uint256 tte, uint256 strike))',
  'function previewBucket(uint256 seriesId, bool isCall, uint16 ivBps) view returns (tuple(uint16 ivBps, uint256 premiumPerUnitQuote, uint256 premiumPerShareQuote, uint16 cutoffBps, uint256 sellerNetPerShareQuote, uint256 fillableShares, uint16 contributorsAvailable, uint16 scannedCount, bool bucketActive))',
  'function previewExercise(uint256 optionId) view returns (tuple(bool isCall, uint256 lockAmount, uint256 strikePayment, uint256 spotValue, int256 exerciseProfit, uint256 expiry, bool canExercise, bool isExpired) ep)',
  'function getSellerPositions(address seller, uint256 seriesId, uint16 maxIvBps, uint16 maxEntries) view returns (tuple(uint32 entryId, uint16 ivBps, uint128 shares, uint16 minAcceptableBps, bool isExpired)[])',
  'function getClaimableSummary(address seller, uint256[] seriesIds) view returns (uint256 claimableBase, uint256 claimableQuote, uint256[] claimableShares)',
  'function previewFillPremium(uint256 seriesId, bool isCall, uint256 sharesToFill, uint16 maxIvBps) view returns (tuple(uint256 totalPremiumQuote, uint256 totalSharesFilled, uint16 trancheCount, tuple(uint16 ivBps, uint256 sharesFilled, uint256 premiumQuote, uint256 premiumPerShareQuote)[] tranches) fp)',
  'function getBuyerOptions(address buyer, uint256 fromId, uint256 maxCount) view returns (tuple(uint256 optionId, uint8 side, uint8 status, uint16 seriesId, uint40 expiry, uint128 notionalBase, uint128 lockAmount, uint128 strike18)[] opts)',
];

/** WheelVaultRouter — single/dual token deposit and withdraw with swap routing */
export const WHEEL_VAULT_ROUTER_ABI = [
  'function depositSingle(address vault, uint256 seriesId, address depositToken, uint256 depositAmount, address aggregator, bytes swapData, uint256 expectedPrice, uint256 minShares) returns (uint256 shares)',
  'function depositDual(address vault, uint256 seriesId, uint256 baseAmt, uint256 quoteAmt, uint256 expectedPrice, uint256 minShares) returns (uint256 shares)',
  'function withdrawSingle(address vault, uint256 seriesId, uint256 shares, address targetToken, address aggregator, bytes swapData, uint256 minOut) returns (uint256 amountOut)',
  'function withdrawSingleWithPermit(address vault, uint256 seriesId, uint256 shares, address targetToken, address aggregator, bytes swapData, uint256 minOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256 amountOut)',
  'function aggregatorWhitelist(address) view returns (bool)',
];

/** WheelVaultLens — read-only deposit/withdraw previews */
export const WHEEL_VAULT_LENS_ABI = [
  'function getSeriesAssets(address vault, uint256 seriesId) view returns (uint256 baseAmt, uint256 quoteAmt, uint256 totalShares)',
  'function previewWithdraw(address vault, uint256 seriesId, uint256 shares) view returns (uint256 baseOut, uint256 quoteOut, uint256 baseFee, uint256 quoteFee)',
  'function previewDeposit(address vault, uint256 seriesId, uint256 baseAmt, uint256 quoteAmt) view returns (uint256 sharesToMint)',
  'function estimateDepositSplit(address vault, uint256 seriesId, address depositToken, uint256 depositAmount) view returns (uint256 swapAmt, uint256 keepAmt)',
];

/** Multicall3 — batch RPC calls */
export const MULTICALL3_ABI = [
  'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
];

/** Uniswap V3 NonfungiblePositionManager — position queries */
export const UNISWAP_NPM_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];
