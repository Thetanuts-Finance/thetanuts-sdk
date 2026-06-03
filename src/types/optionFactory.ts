import type { TransactionReceipt, TransactionResponse } from 'ethers';

/**
 * Option type enum matching contract values
 */
export enum OptionTypeEnum {
  CALL = 0,
  PUT = 1,
  CALL_SPREAD = 2,
  PUT_SPREAD = 3,
  BUTTERFLY = 4,
  IRON_CONDOR = 5,
}

/**
 * Quotation status enum matching contract values
 */
export enum QuotationStatus {
  PENDING = 0,
  OFFER_PHASE = 1,
  REVEAL_PHASE = 2,
  SETTLED = 3,
  CANCELLED = 4,
}

/**
 * QuotationParameters struct matching the on-chain OptionFactory contract.
 * All 14 fields must be provided to match the ABI tuple.
 */
export interface QuotationParameters {
  /** Address of the requester */
  requester: string;
  /** Existing option address (zero address if new) */
  existingOptionAddress: string;
  /** Collateral token address */
  collateral: string;
  /** Chainlink price feed address for collateral */
  collateralPriceFeed: string;
  /** Option implementation contract address */
  implementation: string;
  /** Strike prices for the option */
  strikes: bigint[];
  /** Number of contracts requested */
  numContracts: bigint;
  /** Requester's collateral deposit amount */
  requesterDeposit: bigint;
  /** Total collateral amount */
  collateralAmount: bigint;
  /** Option expiry timestamp */
  expiryTimestamp: bigint;
  /** Offer period end timestamp */
  offerEndTimestamp: bigint;
  /** Whether requester wants to buy (long) the option */
  isRequestingLongPosition: boolean;
  /** Whether to convert to a limit order if no offers */
  convertToLimitOrder: boolean;
  /** Extra option data (encoded bytes) */
  extraOptionData: string;
}

/**
 * QuotationTracking struct matching the on-chain OptionFactory contract.
 */
export interface QuotationTracking {
  /** Referral ID for fee sharing */
  referralId: bigint;
  /** Event code for tracking */
  eventCode: bigint;
}

/**
 * @deprecated Use QuotationParameters instead
 */
export type RFQParams = QuotationParameters;

/**
 * Full RFQ request data
 */
export interface RFQRequest {
  /** Quotation parameters matching the on-chain struct */
  params: QuotationParameters;
  /** Tracking info (referralId + eventCode) */
  tracking: QuotationTracking;
  /** Reserve price (minimum/maximum acceptable) */
  reservePrice: bigint;
  /** Public key for encrypted offers */
  requesterPublicKey: string;
}

/**
 * QuotationState struct returned from the quotations() view function
 */
export interface QuotationState {
  /** Whether the quotation is active */
  isActive: boolean;
  /** Current winning offeror address */
  currentWinner: string;
  /** Current best price or reserve price */
  currentBestPriceOrReserve: bigint;
  /** Fee collected */
  feeCollected: bigint;
  /** Deployed option contract address (after settlement) */
  optionContract: string;
}

/**
 * Full quotation data from the contract's quotations() view function.
 * Returns both the parameters tuple and the state tuple.
 */
export interface Quotation {
  /** Quotation parameters */
  params: QuotationParameters;
  /** Quotation state */
  state: QuotationState;
}

/**
 * Parameters for making an offer
 */
export interface MakeOfferParams {
  /** Quotation ID to make offer for */
  quotationId: bigint;
  /** Signature proving authorization */
  signature: string;
  /** Signing key used */
  signingKey: string;
  /** Encrypted offer data */
  encryptedOffer: string;
}

/**
 * Parameters for revealing an offer
 */
export interface RevealOfferParams {
  /** Quotation ID */
  quotationId: bigint;
  /** Offer amount (unencrypted) */
  offerAmount: bigint;
  /** Nonce used in encryption */
  nonce: bigint;
  /** Offeror address */
  offeror: string;
}

/**
 * EIP-712 typed-data envelope an offeror signs when calling
 * `makeOfferForQuotation`. Built by `optionFactory.buildOfferTypedData()`
 * and consumed by any signer that supports `signTypedData_v4` (Base MCP's
 * `sign` tool with `type: "typed_data"`, viem `signTypedData`, ethers
 * `signTypedData`, etc.).
 *
 * The struct definition is verified at build time against the live
 * `OFFER_TYPEHASH()` on the OptionFactory — see `buildOfferTypedData`.
 */
export interface OfferTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  types: {
    Offer: Array<{ name: string; type: string }>;
  };
  primaryType: 'Offer';
  message: {
    quotationId: string;
    offerAmount: string;
    offeror: string;
    nonce: string;
  };
}

/**
 * Referral parameters returned by returnReferralParameters()
 */
export interface ReferralParameters {
  /** Collateral token address */
  collateral: string;
  /** Collateral price feed address */
  collateralPriceFeed: string;
  /** Option implementation address */
  implementation: string;
  /** Strike prices */
  strikes: bigint[];
  /** Expiry timestamp */
  expiryTimestamp: bigint;
  /** Whether requesting long position */
  isRequestingLongPosition: boolean;
  /** Extra option data */
  extraOptionData: string;
}

/**
 * Parameters for swapAndCall()
 *
 * Performs a token swap via an authorized router then executes
 * a self-call (e.g., requestForQuotation) in a single transaction.
 *
 * @example
 * ```typescript
 * await client.optionFactory.swapAndCall({
 *   swapRouter: '0xRouterAddress',
 *   swapSrcToken: '0xWETH',
 *   swapDstToken: '0xUSDC',
 *   swapSrcAmount: parseEther('1'),
 *   swapCallData: '0x...',  // encoded swap calldata
 *   selfCallData: '0x...',  // encoded requestForQuotation calldata
 * });
 * ```
 */
export interface SwapAndCallParams {
  /** Swap router address (must be authorized) */
  swapRouter: string;
  /** Source token address for swap */
  swapSrcToken: string;
  /** Destination token address for swap */
  swapDstToken: string;
  /** Amount of source token to swap */
  swapSrcAmount: bigint;
  /** Encoded swap calldata for the router */
  swapCallData: string;
  /** Encoded self-call data (e.g., requestForQuotation calldata) */
  selfCallData: string;
  /** ETH value to send with the transaction (for native token swaps) */
  value?: bigint;
}

/**
 * EIP-712 domain data returned by eip712Domain()
 */
export interface Eip712DomainResult {
  /** EIP-712 domain fields bitmask */
  fields: string;
  /** Domain name */
  name: string;
  /** Domain version */
  version: string;
  /** Chain ID */
  chainId: bigint;
  /** Verifying contract address */
  verifyingContract: string;
  /** Salt */
  salt: string;
  /** Extensions */
  extensions: bigint[];
}

/**
 * Result of requestForQuotation transaction
 */
export interface RequestQuotationResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction response */
  tx: TransactionResponse;
  /** Created quotation ID */
  quotationId: bigint;
  /** Wait for confirmation */
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

/**
 * Result of settleQuotation transaction
 */
export interface SettleQuotationResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction response */
  tx: TransactionResponse;
  /** Quotation ID */
  quotationId: bigint;
  /** Created option contract address */
  optionAddress: string;
  /** Wait for confirmation */
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

/**
 * Result of makeOfferForQuotation transaction
 */
export interface MakeOfferResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction response */
  tx: TransactionResponse;
  /** Quotation ID */
  quotationId: bigint;
  /** Wait for confirmation */
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

/**
 * Result of revealOffer transaction
 */
export interface RevealOfferResult {
  /** Transaction hash */
  txHash: string;
  /** Transaction response */
  tx: TransactionResponse;
  /** Quotation ID */
  quotationId: bigint;
  /** Revealed offer amount */
  offerAmount: bigint;
  /** Wait for confirmation */
  wait(confirmations?: number): Promise<TransactionReceipt>;
}

/**
 * Supported underlying assets for RFQ builder
 */
export type RFQUnderlying = 'ETH' | 'BTC' | 'SOL' | 'DOGE' | 'XRP' | 'BNB' | 'PAXG' | 'AVAX';

/**
 * Supported option types for RFQ builder
 */
export type RFQOptionType = 'CALL' | 'PUT';

/**
 * Supported collateral tokens for RFQ builder
 */
export type RFQCollateralToken = 'USDC' | 'WETH' | 'cbBTC' | 'aBasWETH' | 'aBascbBTC' | 'aBasUSDC' | 'cbDOGE' | 'cbXRP';

/**
 * High-level parameters for building RFQ requests.
 *
 * This interface simplifies RFQ creation by using human-readable values
 * and automatically resolving addresses from chain config.
 *
 * **IMPORTANT**: The generated RFQ params will ALWAYS have collateralAmount = 0.
 * Collateral is pulled at settlement time, not at RFQ creation.
 *
 * For SELL positions, you must separately approve tokens for the OptionFactory.
 *
 * @example Vanilla option (single strike)
 * ```typescript
 * const params: RFQBuilderParams = {
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   strikes: 1850,           // Single strike for vanilla
 *   expiry: 1735689600,
 *   numContracts: 1.5,
 *   isLong: true,
 *   offerDeadlineMinutes: 60,
 *   collateralToken: 'USDC',
 * };
 * ```
 *
 * @example Spread (2 strikes)
 * ```typescript
 * const params: RFQBuilderParams = {
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   strikes: [1800, 2000],   // 2 strikes for spread
 *   expiry: 1735689600,
 *   numContracts: 1.5,
 *   isLong: true,
 *   offerDeadlineMinutes: 60,
 *   collateralToken: 'USDC',
 * };
 * ```
 *
 * @example Butterfly (3 strikes)
 * ```typescript
 * const params: RFQBuilderParams = {
 *   strikes: [1800, 1900, 2000],  // 3 strikes for butterfly
 *   // ...other params
 * };
 * ```
 *
 * @example Condor (4 strikes)
 * ```typescript
 * const params: RFQBuilderParams = {
 *   strikes: [1700, 1800, 1900, 2000],  // 4 strikes for condor
 *   // ...other params
 * };
 * ```
 */
export interface RFQBuilderParams {
  /** Requester's wallet address */
  requester: `0x${string}`;
  /** Underlying asset (ETH or BTC) */
  underlying: RFQUnderlying;
  /** Option type (CALL or PUT) */
  optionType: RFQOptionType;
  /**
   * Strike price(s) - human-readable (e.g., 1850 for $1,850)
   * - Single number: vanilla option (1 strike)
   * - Array of 2: spread
   * - Array of 3: butterfly
   * - Array of 4: condor
   *
   * Strikes are automatically sorted ascending.
   */
  strikes: number | number[];
  /**
   * @deprecated Use `strikes` instead. Will be removed in future version.
   * Single strike price - human-readable (e.g., 1850 for $1,850)
   */
  strike?: number;
  /** Expiry timestamp (Unix seconds) */
  expiry: number;
  /**
   * Number of contracts.
   * - `number`: Human-readable (e.g., 1.5 for 1.5 contracts) - converted using token decimals
   * - `bigint`: On-chain format (e.g., 1500000000000000000n) - used directly, no conversion
   * - `string`: Parsed as BigInt if valid numeric string
   *
   * **Use `bigint` when closing positions** to ensure exact match with on-chain value.
   * Floating-point conversion can introduce tiny rounding errors with 18-decimal tokens.
   *
   * @example New position (human-readable)
   * ```typescript
   * numContracts: 1.5  // Converted to on-chain format using token decimals
   * ```
   *
   * @example Closing position (exact BigInt from chain)
   * ```typescript
   * const position = await client.option.getNumContracts(optionAddress);
   * numContracts: position  // Use exact value from chain
   * ```
   */
  numContracts: number | bigint | string;
  /** True for BUY (long), false for SELL (short) */
  isLong: boolean;
  /** Offer deadline in minutes from now */
  offerDeadlineMinutes: number;
  /** Collateral token to use */
  collateralToken: RFQCollateralToken;
  /** Reserve price (optional) - human-readable, per-contract */
  reservePrice?: number;
  /** Referral ID (optional, defaults to 0) */
  referralId?: bigint;
  /** Event code (optional, defaults to 0) */
  eventCode?: bigint;
  /** ECDH public key for encrypted offers (if already generated) */
  requesterPublicKey?: string;
  /**
   * Set to true to create an iron condor (put spread + call spread).
   * Requires exactly 4 strikes. Uses IRON_CONDOR implementation contract.
   * When true, optionType is ignored as iron condors combine puts and calls.
   * Default: false (uses CALL_CONDOR or PUT_CONDOR based on optionType)
   */
  isIronCondor?: boolean;
  /**
   * Existing option address when closing a position.
   * If provided, the RFQ will reference this existing option contract.
   * If not provided, defaults to zero address (for new positions).
   *
   * @example Closing a position
   * ```typescript
   * existingOptionAddress: '0x1234...abcd'  // The option contract to close
   * ```
   */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a spread RFQ using the convenience helper.
 *
 * @example
 * ```typescript
 * const request = client.optionFactory.buildSpreadRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   lowerStrike: 1800,
 *   upperStrike: 2000,
 *   expiry: 1735689600,
 *   numContracts: 1.5,
 *   isLong: true,
 *   offerDeadlineMinutes: 60,
 *   collateralToken: 'USDC',
 * });
 * ```
 */
export interface SpreadRFQParams {
  requester: `0x${string}`;
  underlying: RFQUnderlying;
  optionType: RFQOptionType;
  /** Lower strike price - human-readable */
  lowerStrike: number;
  /** Upper strike price - human-readable */
  upperStrike: number;
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  isLong: boolean;
  offerDeadlineMinutes: number;
  collateralToken: RFQCollateralToken;
  reservePrice?: number;
  referralId?: bigint;
  eventCode?: bigint;
  requesterPublicKey?: string;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a butterfly RFQ using the convenience helper.
 *
 * @example
 * ```typescript
 * const request = client.optionFactory.buildButterflyRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   lowerStrike: 1800,
 *   middleStrike: 1900,
 *   upperStrike: 2000,
 *   expiry: 1735689600,
 *   numContracts: 1.5,
 *   isLong: true,
 *   offerDeadlineMinutes: 60,
 *   collateralToken: 'USDC',
 * });
 * ```
 */
export interface ButterflyRFQParams {
  requester: `0x${string}`;
  underlying: RFQUnderlying;
  optionType: RFQOptionType;
  /** Lower strike price - human-readable */
  lowerStrike: number;
  /** Middle strike price - human-readable */
  middleStrike: number;
  /** Upper strike price - human-readable */
  upperStrike: number;
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  isLong: boolean;
  offerDeadlineMinutes: number;
  collateralToken: RFQCollateralToken;
  reservePrice?: number;
  referralId?: bigint;
  eventCode?: bigint;
  requesterPublicKey?: string;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a condor RFQ using the convenience helper.
 *
 * @example
 * ```typescript
 * const request = client.optionFactory.buildCondorRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   strike1: 1700,
 *   strike2: 1800,
 *   strike3: 1900,
 *   strike4: 2000,
 *   expiry: 1735689600,
 *   numContracts: 1.5,
 *   isLong: true,
 *   offerDeadlineMinutes: 60,
 *   collateralToken: 'USDC',
 * });
 * ```
 */
export interface CondorRFQParams {
  requester: `0x${string}`;
  underlying: RFQUnderlying;
  optionType: RFQOptionType;
  /** First (lowest) strike price - human-readable */
  strike1: number;
  /** Second strike price - human-readable */
  strike2: number;
  /** Third strike price - human-readable */
  strike3: number;
  /** Fourth (highest) strike price - human-readable */
  strike4: number;
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  isLong: boolean;
  offerDeadlineMinutes: number;
  collateralToken: RFQCollateralToken;
  reservePrice?: number;
  referralId?: bigint;
  eventCode?: bigint;
  requesterPublicKey?: string;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating an iron condor RFQ using the convenience helper.
 *
 * An iron condor combines a put spread (lower strikes) with a call spread (upper strikes).
 * This uses the IRON_CONDOR implementation contract.
 *
 * Note: optionType is not required since iron condors combine both puts and calls.
 *
 * @example
 * ```typescript
 * const request = client.optionFactory.buildIronCondorRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   strike1: 2200,  // buy put
 *   strike2: 2400,  // sell put
 *   strike3: 2600,  // sell call
 *   strike4: 2800,  // buy call
 *   expiry: 1774627200,
 *   numContracts: 1,
 *   isLong: true,
 *   offerDeadlineMinutes: 60,
 *   collateralToken: 'USDC',
 * });
 * ```
 */
export interface IronCondorRFQParams {
  requester: `0x${string}`;
  underlying: RFQUnderlying;
  /** First (lowest) strike price - put spread lower leg */
  strike1: number;
  /** Second strike price - put spread upper leg */
  strike2: number;
  /** Third strike price - call spread lower leg */
  strike3: number;
  /** Fourth (highest) strike price - call spread upper leg */
  strike4: number;
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  isLong: boolean;
  offerDeadlineMinutes: number;
  collateralToken: RFQCollateralToken;
  reservePrice?: number;
  referralId?: bigint;
  eventCode?: bigint;
  requesterPublicKey?: string;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a physically settled option RFQ.
 *
 * Physically settled options involve actual delivery of the underlying asset
 * at settlement, rather than cash settlement of the difference.
 *
 * **Collateral Rules:**
 * - PHYSICAL_CALL: requires BASE collateral (WETH for ETH, cbBTC for BTC)
 * - PHYSICAL_PUT: requires QUOTE collateral (USDC)
 *
 * **Delivery Token Rules:**
 * - PHYSICAL_CALL: delivery token is USDC (buyer pays strike in USDC)
 * - PHYSICAL_PUT: delivery token is underlying (WETH for ETH, cbBTC for BTC)
 *
 * The delivery token is ABI-encoded into `extraOptionsData`.
 *
 * @example Physical CALL (buyer receives ETH, pays USDC at strike)
 * ```typescript
 * const request = client.optionFactory.buildPhysicalOptionRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'CALL',
 *   strike: 2500,
 *   expiry: 1774627200,
 *   numContracts: 0.1,
 *   isLong: true,
 *   deliveryToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
 *   collateralToken: 'WETH',
 *   offerDeadlineMinutes: 6,
 *   requesterPublicKey: keyPair.compressedPublicKey,
 * });
 * ```
 *
 * @example Physical PUT (buyer delivers ETH, receives USDC at strike)
 * ```typescript
 * const request = client.optionFactory.buildPhysicalOptionRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   strike: 2500,
 *   expiry: 1774627200,
 *   numContracts: 0.1,
 *   isLong: true,
 *   deliveryToken: '0x4200000000000000000000000000000000000006', // WETH
 *   collateralToken: 'USDC',
 *   offerDeadlineMinutes: 6,
 *   requesterPublicKey: keyPair.compressedPublicKey,
 * });
 * ```
 */
export interface PhysicalOptionRFQParams {
  /** Requester's wallet address */
  requester: `0x${string}`;
  /** Underlying asset (ETH or BTC) */
  underlying: RFQUnderlying;
  /** Option type (CALL or PUT) */
  optionType: RFQOptionType;
  /** Strike price - human-readable (e.g., 2500 for $2,500) */
  strike: number;
  /** Expiry timestamp (Unix seconds) - must be Friday 8:00 UTC */
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  /** True for BUY (long), false for SELL (short) */
  isLong: boolean;
  /**
   * Delivery token address for physical settlement.
   * - For CALL: should be USDC (buyer pays strike in USDC)
   * - For PUT: should be underlying token (WETH for ETH, cbBTC for BTC)
   */
  deliveryToken: `0x${string}`;
  /** ECDH public key for encrypted offers */
  requesterPublicKey: string;
  /**
   * Collateral token to use.
   * - For CALL: must be WETH (ETH) or cbBTC (BTC)
   * - For PUT: must be USDC
   * If not provided, will be auto-inferred based on optionType and underlying.
   */
  collateralToken?: RFQCollateralToken;
  /** Offer deadline in minutes from now (default: 6) */
  offerDeadlineMinutes?: number;
  /** Reserve price (optional) - human-readable, per-contract */
  reservePrice?: number;
  /** Referral ID (optional, defaults to 0) */
  referralId?: bigint;
  /** Event code (optional, defaults to 0) */
  eventCode?: bigint;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a physically settled spread RFQ.
 *
 * A physical spread involves 2 strikes with actual asset delivery at settlement.
 *
 * **Collateral Rules:**
 * - PHYSICAL_CALL_SPREAD: requires BASE collateral (WETH for ETH, cbBTC for BTC)
 * - PHYSICAL_PUT_SPREAD: requires QUOTE collateral (USDC)
 *
 * **Delivery Token Rules:**
 * - PHYSICAL_CALL_SPREAD: delivery token is USDC (buyer pays strike in USDC)
 * - PHYSICAL_PUT_SPREAD: delivery token is underlying (WETH for ETH, cbBTC for BTC)
 *
 * @example Physical PUT Spread
 * ```typescript
 * const request = client.optionFactory.buildPhysicalSpreadRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   lowerStrike: 2400,
 *   upperStrike: 2600,
 *   expiry: 1774627200,
 *   numContracts: 0.1,
 *   isLong: true,
 *   deliveryToken: '0x4200000000000000000000000000000000000006', // WETH
 *   collateralToken: 'USDC',
 *   requesterPublicKey: keyPair.compressedPublicKey,
 * });
 * ```
 */
export interface PhysicalSpreadRFQParams {
  /** Requester's wallet address */
  requester: `0x${string}`;
  /** Underlying asset (ETH or BTC) */
  underlying: RFQUnderlying;
  /** Option type (CALL or PUT) */
  optionType: RFQOptionType;
  /** Lower strike price - human-readable (e.g., 2400 for $2,400) */
  lowerStrike: number;
  /** Upper strike price - human-readable (e.g., 2600 for $2,600) */
  upperStrike: number;
  /** Expiry timestamp (Unix seconds) - must be Friday 8:00 UTC */
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  /** True for BUY (long), false for SELL (short) */
  isLong: boolean;
  /**
   * Delivery token address for physical settlement.
   * - For CALL: should be USDC (buyer pays strike in USDC)
   * - For PUT: should be underlying token (WETH for ETH, cbBTC for BTC)
   */
  deliveryToken: `0x${string}`;
  /** ECDH public key for encrypted offers */
  requesterPublicKey: string;
  /**
   * Collateral token to use.
   * - For CALL: must be WETH (ETH) or cbBTC (BTC)
   * - For PUT: must be USDC
   * If not provided, will be auto-inferred based on optionType and underlying.
   */
  collateralToken?: RFQCollateralToken;
  /** Offer deadline in minutes from now (default: 6) */
  offerDeadlineMinutes?: number;
  /** Reserve price (optional) - human-readable, per-contract */
  reservePrice?: number;
  /** Referral ID (optional, defaults to 0) */
  referralId?: bigint;
  /** Event code (optional, defaults to 0) */
  eventCode?: bigint;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a physically settled butterfly RFQ.
 *
 * A physical butterfly involves 3 strikes with actual asset delivery at settlement.
 *
 * **Collateral Rules:**
 * - PHYSICAL_CALL_FLY: requires BASE collateral (WETH for ETH, cbBTC for BTC)
 * - PHYSICAL_PUT_FLY: requires QUOTE collateral (USDC)
 *
 * **Delivery Token Rules:**
 * - PHYSICAL_CALL_FLY: delivery token is USDC (buyer pays strike in USDC)
 * - PHYSICAL_PUT_FLY: delivery token is underlying (WETH for ETH, cbBTC for BTC)
 *
 * @example Physical PUT Butterfly
 * ```typescript
 * const request = client.optionFactory.buildPhysicalButterflyRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   lowerStrike: 2400,
 *   middleStrike: 2500,
 *   upperStrike: 2600,
 *   expiry: 1774627200,
 *   numContracts: 0.1,
 *   isLong: true,
 *   deliveryToken: '0x4200000000000000000000000000000000000006', // WETH
 *   collateralToken: 'USDC',
 *   requesterPublicKey: keyPair.compressedPublicKey,
 * });
 * ```
 */
export interface PhysicalButterflyRFQParams {
  /** Requester's wallet address */
  requester: `0x${string}`;
  /** Underlying asset (ETH or BTC) */
  underlying: RFQUnderlying;
  /** Option type (CALL or PUT) */
  optionType: RFQOptionType;
  /** Lower strike price - human-readable */
  lowerStrike: number;
  /** Middle strike price - human-readable */
  middleStrike: number;
  /** Upper strike price - human-readable */
  upperStrike: number;
  /** Expiry timestamp (Unix seconds) - must be Friday 8:00 UTC */
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  /** True for BUY (long), false for SELL (short) */
  isLong: boolean;
  /**
   * Delivery token address for physical settlement.
   * - For CALL: should be USDC (buyer pays strike in USDC)
   * - For PUT: should be underlying token (WETH for ETH, cbBTC for BTC)
   */
  deliveryToken: `0x${string}`;
  /** ECDH public key for encrypted offers */
  requesterPublicKey: string;
  /**
   * Collateral token to use.
   * - For CALL: must be WETH (ETH) or cbBTC (BTC)
   * - For PUT: must be USDC
   * If not provided, will be auto-inferred based on optionType and underlying.
   */
  collateralToken?: RFQCollateralToken;
  /** Offer deadline in minutes from now (default: 6) */
  offerDeadlineMinutes?: number;
  /** Reserve price (optional) - human-readable, per-contract */
  reservePrice?: number;
  /** Referral ID (optional, defaults to 0) */
  referralId?: bigint;
  /** Event code (optional, defaults to 0) */
  eventCode?: bigint;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a physically settled condor RFQ.
 *
 * A physical condor involves 4 strikes with actual asset delivery at settlement.
 *
 * **Collateral Rules:**
 * - PHYSICAL_CALL_CONDOR: requires BASE collateral (WETH for ETH, cbBTC for BTC)
 * - PHYSICAL_PUT_CONDOR: requires QUOTE collateral (USDC)
 *
 * **Delivery Token Rules:**
 * - PHYSICAL_CALL_CONDOR: delivery token is USDC (buyer pays strike in USDC)
 * - PHYSICAL_PUT_CONDOR: delivery token is underlying (WETH for ETH, cbBTC for BTC)
 *
 * @example Physical PUT Condor
 * ```typescript
 * const request = client.optionFactory.buildPhysicalCondorRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   optionType: 'PUT',
 *   strike1: 2300,
 *   strike2: 2400,
 *   strike3: 2600,
 *   strike4: 2700,
 *   expiry: 1774627200,
 *   numContracts: 0.1,
 *   isLong: true,
 *   deliveryToken: '0x4200000000000000000000000000000000000006', // WETH
 *   collateralToken: 'USDC',
 *   requesterPublicKey: keyPair.compressedPublicKey,
 * });
 * ```
 */
export interface PhysicalCondorRFQParams {
  /** Requester's wallet address */
  requester: `0x${string}`;
  /** Underlying asset (ETH or BTC) */
  underlying: RFQUnderlying;
  /** Option type (CALL or PUT) */
  optionType: RFQOptionType;
  /** First (lowest) strike price - human-readable */
  strike1: number;
  /** Second strike price - human-readable */
  strike2: number;
  /** Third strike price - human-readable */
  strike3: number;
  /** Fourth (highest) strike price - human-readable */
  strike4: number;
  /** Expiry timestamp (Unix seconds) - must be Friday 8:00 UTC */
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  /** True for BUY (long), false for SELL (short) */
  isLong: boolean;
  /**
   * Delivery token address for physical settlement.
   * - For CALL: should be USDC (buyer pays strike in USDC)
   * - For PUT: should be underlying token (WETH for ETH, cbBTC for BTC)
   */
  deliveryToken: `0x${string}`;
  /** ECDH public key for encrypted offers */
  requesterPublicKey: string;
  /**
   * Collateral token to use.
   * - For CALL: must be WETH (ETH) or cbBTC (BTC)
   * - For PUT: must be USDC
   * If not provided, will be auto-inferred based on optionType and underlying.
   */
  collateralToken?: RFQCollateralToken;
  /** Offer deadline in minutes from now (default: 6) */
  offerDeadlineMinutes?: number;
  /** Reserve price (optional) - human-readable, per-contract */
  reservePrice?: number;
  /** Referral ID (optional, defaults to 0) */
  referralId?: bigint;
  /** Event code (optional, defaults to 0) */
  eventCode?: bigint;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}

/**
 * Parameters for creating a physically settled iron condor RFQ.
 *
 * A physical iron condor combines a put spread (lower strikes) with a call spread (upper strikes),
 * with actual asset delivery at settlement.
 *
 * Note: optionType is not required since iron condors combine both puts and calls.
 *
 * **Collateral Rules:**
 * - PHYSICAL_IRON_CONDOR: requires QUOTE collateral (USDC)
 *
 * @example Physical Iron Condor
 * ```typescript
 * const request = client.optionFactory.buildPhysicalIronCondorRFQ({
 *   requester: userAddress,
 *   underlying: 'ETH',
 *   strike1: 2200,  // buy put
 *   strike2: 2400,  // sell put
 *   strike3: 2600,  // sell call
 *   strike4: 2800,  // buy call
 *   expiry: 1774627200,
 *   numContracts: 0.1,
 *   isLong: true,
 *   deliveryToken: '0x4200000000000000000000000000000000000006', // WETH
 *   collateralToken: 'USDC',
 *   requesterPublicKey: keyPair.compressedPublicKey,
 * });
 * ```
 */
export interface PhysicalIronCondorRFQParams {
  /** Requester's wallet address */
  requester: `0x${string}`;
  /** Underlying asset (ETH or BTC) */
  underlying: RFQUnderlying;
  /** First (lowest) strike price - put spread lower leg */
  strike1: number;
  /** Second strike price - put spread upper leg */
  strike2: number;
  /** Third strike price - call spread lower leg */
  strike3: number;
  /** Fourth (highest) strike price - call spread upper leg */
  strike4: number;
  /** Expiry timestamp (Unix seconds) - must be Friday 8:00 UTC */
  expiry: number;
  /** Number of contracts - number (human-readable), bigint (on-chain), or string */
  numContracts: number | bigint | string;
  /** True for BUY (long), false for SELL (short) */
  isLong: boolean;
  /**
   * Delivery token address for physical settlement.
   * Should be underlying token (WETH for ETH, cbBTC for BTC).
   */
  deliveryToken: `0x${string}`;
  /** ECDH public key for encrypted offers */
  requesterPublicKey: string;
  /**
   * Collateral token to use. Must be USDC for iron condors.
   * If not provided, defaults to USDC.
   */
  collateralToken?: RFQCollateralToken;
  /** Offer deadline in minutes from now (default: 6) */
  offerDeadlineMinutes?: number;
  /** Reserve price (optional) - human-readable, per-contract */
  reservePrice?: number;
  /** Referral ID (optional, defaults to 0) */
  referralId?: bigint;
  /** Event code (optional, defaults to 0) */
  eventCode?: bigint;
  /** Existing option address when closing a position */
  existingOptionAddress?: `0x${string}`;
}
