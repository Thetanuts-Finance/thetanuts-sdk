// ============ Client ============
export { ThetanutsClient } from './client/ThetanutsClient.js';

export type {
  ThetanutsClientConfig,
  SupportedChainId,
  SupportedNetwork,
  Environment,
} from './types/client.js';

// ============ Errors ============
export {
  ThetanutsError,
  APIError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
  ContractRevertError,
  InsufficientAllowanceError,
  InsufficientBalanceError,
  OrderExpiredError,
  SlippageExceededError,
  SignerRequiredError,
  InvalidParamsError,
  NetworkUnsupportedError,
  WebSocketError,
  KeyNotFoundError,
  InvalidKeyError,
  EncryptionError,
  DecryptionError,
  isThetanutsError,
} from './types/errors.js';

export type { ThetanutsErrorCode } from './types/errors.js';

export {
  createError,
  wrapError,
  mapHttpError,
  mapContractError,
} from './utils/errors.js';

// ============ ABIs ============
export {
  ERC20_ABI,
  OPTION_BOOK_ABI,
  OPTION_FACTORY_ABI,
  OPTION_ABI,
  BASE_OPTION_ABI,
  RANGER_OPTION_ABI,
  LOAN_COORDINATOR_ABI,
  LOAN_OPTION_ABI,
  LOAN_HANDLER_ABI,
  LOAN_WETH_ABI,
  WHEEL_VAULT_ABI,
  VAULT_MATH_ABI,
  WHEEL_MARKETS_ABI,
  WHEEL_MARKETS_LENS_ABI,
  WHEEL_VAULT_ROUTER_ABI,
  WHEEL_VAULT_LENS_ABI,
  MULTICALL3_ABI,
  UNISWAP_NPM_ABI,
  STRATEGY_VAULT_ABI,
} from './abis/index.js';

// ============ Chain Configuration ============
export {
  CHAIN_CONFIGS_BY_ID,
  getChainConfigById,
  getTokenConfigById,
  getSupportedTokensById,
  isChainIdSupported,
  getOptionImplementationInfo,
  buildPriceFeedSymbolMap,
} from './chains/index.js';

export { LOAN_CONFIG } from './chains/loan.js';
export { WHEEL_VAULT_CONFIG } from './chains/wheelVault.js';
export { STRATEGY_VAULT_CONFIG } from './chains/strategyVault.js';

export type { ChainConfig, TokenConfig, ContractAddresses, OptionImplementationInfo, ImplementationAddresses } from './chains/index.js';

// ============ Modules ============
export { ERC20Module } from './modules/erc20.js';
export { OptionBookModule } from './modules/optionBook.js';
export { APIModule } from './modules/api.js';
export { OptionFactoryModule } from './modules/optionFactory.js';
export { OptionModule } from './modules/option.js';
export { RangerModule } from './modules/ranger.js';
export type { RangerInfo } from './modules/ranger.js';
export { EventsModule } from './modules/events.js';
export { WebSocketModule } from './modules/websocket.js';
export { UtilsModule } from './modules/utils.js';
export { RFQKeyManagerModule } from './modules/rfqKeyManager.js';
export { MMPricingModule, parseTicker, buildTicker, applyFeeAdjustment, calculateCollateralCost } from './modules/mmPricing.js';
export { LoanModule } from './modules/loan.js';
export { CollarModule } from './modules/collar.js';
export type {
  CollarUnderlying,
  CollarEstimate,
  CollarCapStrike,
  CollarCapStrikeGroup,
  CollarStrikeFilter,
  CollarLoanRequest,
  CollarLoanResult,
} from './modules/collar.js';
export type {
  CollarSettings,
  CollarAssetConfig,
} from './chains/collar.js';
export { WheelVaultModule } from './modules/wheelVault.js';
export { StrategyVaultModule } from './modules/strategyVault.js';

// ============ Types — Logger ============
export type { ThetanutsLogger } from './types/logger.js';

// ============ Types — ERC20 ============
export type {
  ApprovalResult,
  EnsureAllowanceResult,
  TokenBalance,
  TokenInfo,
} from './types/erc20.js';

// ============ Types — OptionBook ============
export type {
  ContractOrder,
  Order,
  SwapParams,
  FeeInfo,
  Quote,
  FillOrderResult,
  SwapAndFillOrderResult,
  CancelOrderResult,
  TransactionResult,
  EncodedTransaction,
  Eip712Domain,
} from './types/optionBook.js';

// ============ Types — API ============
export type {
  OrderWithSignature,
  OrderFilters,
  Position,
  PositionSettlement,
  TradeHistory,
  ProtocolStats as APIProtocolStats,
  MarketPrice,
  MarketPrices,
  MarketDataResponse,
  MarketDataPrices,
  MarketDataMetadata,
  ReferrerStats,
  ReferrerSummary,
  FactoryReferrerStats,
  FactoryReferrerProtocolStats,
  IndexerHealth,
  FactoryStats,
  PositionPnL,
  FactoryOptionSettlement,
  FactoryOptionDetail,
  BookOptionDetail,
  OptionStatusType,
  TokenAmounts,
  TimeWindowStats,
  ImplementationTypeStats,
  ProtocolStatsDetail,
  ProtocolStatsResponse,
  DailyStatsEntry,
  DailyStatsResponse,
  ClaimableFee,
  ClaimFeeResult,
} from './types/api.js';

// ============ Types — OptionFactory ============
export {
  OptionTypeEnum,
  QuotationStatus,
} from './types/optionFactory.js';

export type {
  QuotationParameters,
  QuotationTracking,
  QuotationState,
  RFQRequest,
  Quotation,
  MakeOfferParams,
  RevealOfferParams,
  RequestQuotationResult,
  SettleQuotationResult,
  MakeOfferResult,
  RevealOfferResult,
  ReferralParameters,
  SwapAndCallParams,
  Eip712DomainResult,
  RFQBuilderParams,
  SpreadRFQParams,
  ButterflyRFQParams,
  CondorRFQParams,
  IronCondorRFQParams,
  PhysicalOptionRFQParams,
  PhysicalSpreadRFQParams,
  PhysicalButterflyRFQParams,
  PhysicalCondorRFQParams,
  PhysicalIronCondorRFQParams,
  RFQUnderlying,
  RFQOptionType,
  RFQCollateralToken,
  OfferTypedData,
} from './types/optionFactory.js';

// ============ Types — Option ============
export type {
  OptionInfo,
  FullOptionInfo,
  PositionInfo,
  ClosePositionResult,
  TransferPositionResult,
  SplitPositionResult,
  PayoutCalculation,
  PayoutResult,
  UnpackedOptionType,
  OptionParams,
} from './types/option.js';

// ============ Types — Events ============
export type {
  OrderFillEvent,
  OrderCancelledEvent,
  OptionCreatedEvent,
  QuotationRequestedEvent,
  OfferMadeEvent,
  OfferRevealedEvent,
  QuotationSettledEvent,
  PositionClosedEvent,
  PositionTransferredEvent,
  EventFilters,
  ExcessCollateralReturnedEvent,
  OptionClosedEvent,
  OptionExpiredEvent,
  OptionPayoutEvent,
  OptionSettlementFailedEvent,
  OptionSplitEvent,
  RoleTransferredEvent,
  TransferApprovalEvent,
  ERC20RescuedEvent,
} from './types/events.js';

// ============ Types — WebSocket ============
export type {
  WebSocketState,
  SubscriptionType,
  SubscriptionOptions,
  WebSocketMessage,
  WebSocketConfig,
  OrderUpdate,
  PriceUpdate,
  PositionUpdate,
  TradeUpdate,
  QuotationUpdate,
  WebSocketEventHandler,
} from './types/websocket.js';

// ============ Types — State API ============
export type {
  StateApiResponse,
  StateRfq,
  StateOffer,
  StateOption,
  StateProtocolStats,
  StateReferral,
  ReferralExecution,
} from './types/stateApi.js';

// ============ Types — Common ============
export type {
  OptionType,
  ProductType,
  OptionStructure,
  OrderSide,
  OrderStatus,
  PositionStatus,
  UnderlyingAsset,
  CollateralToken,
} from './types/common.js';

// ============ Types — Utils ============
export type {
  PayoutType,
  PayoutParams,
  CollateralParams,
} from './modules/utils.js';

// ============ Types — RFQ Key Manager ============
export type {
  RFQKeyPair,
  EncryptedOffer,
  DecryptedOffer,
  KeyStorageProvider,
} from './types/rfqKeyManager.js';

export {
  MemoryStorageProvider,
  LocalStorageProvider,
} from './types/rfqKeyManager.js';

// ============ Types — MM Pricing ============
export type {
  RawOptionPricing,
  MMAllPricingResponse,
  MMVanillaPricing,
  MMPositionPricing,
  MMSpreadPricing,
  MMCondorPricing,
  MMButterflyPricing,
  ParsedTicker,
  PositionPricingParams,
  SpreadPricingParams,
  CondorPricingParams,
  ButterflyPricingParams,
  CollateralAsset,
} from './types/mmPricing.js';

export { COLLATERAL_APR } from './types/mmPricing.js';

// ============ Types — Loan / Loan ============
export type {
  LoanUnderlying,
  LoanAssetConfig,
  LoanPromoConfig,
  LoanRequest,
  LoanResult,
  LoanCalculateParams,
  LoanCalculation,
  LoanStrikeSettings,
  LoanStrikeOption,
  LoanStrikeOptionGroup,
  LoanState,
  LoanOptionInfo,
  LoanIndexerLoan,
  LoanLendingOpportunity,
  DeribitOptionData,
  DeribitPricingMap,
} from './types/loan.js';

// ============ Types — Call Static ============
export type { CallStaticResult } from './types/callStatic.js';

// ============ Utilities ============
export { noopLogger, consoleLogger, Logger } from './utils/logger.js';

export {
  validateAddress,
  validateOrderExpiry,
  validateFillSize,
  validateBuySlippage,
  validateSellSlippage,
  calculateSlippagePrice,
} from './utils/validation.js';

export {
  DECIMALS,
  toBigInt,
  fromBigInt,
  scaleDecimals,
  formatAmount,
  parseAmount,
} from './utils/decimals.js';

export {
  isBaseCollateral,
  premiumPerContract,
  calculateNumContracts,
  calculateReservePrice,
  calculateCollateralRequired,
  calculateDeliveryAmount,
  isPhysicalProduct,
  validateButterfly,
  validateCondor,
  validateIronCondor,
  validateRanger,
} from './utils/rfqCalculations.js';

export type { ProductName, ValidationResult, DeliveryResult } from './utils/rfqCalculations.js';

// ============ Types — WheelVault ============
export type {
  WheelVaultAssetKey,
  WheelVaultAssetConfig,
  VaultSeries,
  VaultState,
  ShareSnapshot,
  DeficitPreview,
  BucketPreview,
  DepthChartResult,
  VaultOption,
  ExercisePreview,
  SellerPosition,
  FillTranche,
  FillPremiumPreview,
  BuyerOption,
  ClaimableSummary,
  DepositPreview,
  WithdrawPreview,
  DepositSplitEstimate,
  VaultDepositResult,
  VaultWithdrawResult,
  MarketSwapParams,
  DepositSingleParams,
  DepositDualParams,
  WithdrawSingleParams,
  WithdrawSingleWithPermitParams,
  MarketFillParams,
  DepositToBucketParams,
  UniswapV3Position,
} from './types/wheelVault.js';

// ============ Types — StrategyVault ============
export type {
  StrategyVaultEntry,
  StrategyVaultAssets,
  StrategyVaultState,
  VaultEpochInfo,
  StrategyVaultDepositResult,
  StrategyVaultWithdrawResult,
  StrategyVaultCreateOptionResult,
} from './types/strategyVault.js';
