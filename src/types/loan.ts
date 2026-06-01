/**
 * Loan Module Type Definitions
 *
 * Types for the non-liquidatable lending module powered by
 * physically-settled call options via Thetanuts V4 RFQ.
 */

import type { TransactionReceipt } from 'ethers';
import type { RFQKeyPair } from './rfqKeyManager.js';

// ─── Asset Configuration ───

/** Supported Loan underlying assets */
export type LoanUnderlying = 'ETH' | 'BTC';

/** Per-asset configuration for Loan collateral */
export interface LoanAssetConfig {
  /** Collateral token address (WETH or cbBTC) */
  collateral: string;
  /** Token decimals (18 for WETH, 8 for cbBTC) */
  decimals: number;
  /** Chainlink price feed address */
  priceFeed: string;
}

/** Promotional pricing configuration */
export interface LoanPromoConfig {
  /** Whether promo is currently active */
  enabled: boolean;
  /** Minimum days to expiry for promo eligibility */
  minDaysToExpiry: number;
  /** Maximum LTV percentage for promo eligibility */
  maxLtvPercent: number;
  /** Whether option premium is waived under promo */
  optionPremiumWaived: boolean;
  /** Borrowing fee percentage under promo */
  borrowingFeePercent: number;
  /** Maximum loan amount per person in USD */
  maxPerPersonUsd: number;
  /** Maximum total promo allocation in USD */
  maxTotalUsd: number;
}

// ─── Loan Request ───

/** Input parameters for requesting a new loan */
export interface LoanRequest {
  /** Underlying asset: 'ETH' or 'BTC' */
  underlying: LoanUnderlying;
  /** Collateral amount as human-readable string (e.g. '1.0') or bigint (wei) */
  collateralAmount: string | bigint;
  /** Strike price in USD (human-readable, e.g. 1600) */
  strike: number;
  /** Option expiry timestamp (Unix seconds) */
  expiryTimestamp: number;
  /** Minimum settlement amount in USDC (6 decimals) — use calculateLoan() to compute */
  minSettlementAmount: bigint;
  /**
   * @deprecated The r12 LoanCoordinator no longer accepts this field;
   * it is ignored at the contract level. Kept on the type to preserve
   * backwards compatibility with existing callers.
   */
  keepOrderOpen?: boolean;
  /** Custom offer duration in seconds (default: 30) */
  offerDurationSeconds?: number;
  /**
   * ECDH compressed public key (hex string) the MM uses to encrypt offers.
   * Required by `encodeRequestLoan` (viem/wagmi integrations) so MMs can
   * deliver encrypted offers. `requestLoan()` resolves this automatically via
   * `client.rfqKeys.getOrCreateKeyPair()`.
   */
  requesterPublicKey?: string;
}

/** Result of a successful loan request */
export interface LoanResult {
  /** Transaction receipt */
  receipt: TransactionReceipt;
  /** The quotation ID assigned to this loan request */
  quotationId: bigint;
  /** ECDH keypair used for encrypted offer delivery */
  keyPair: RFQKeyPair;
}

// ─── Loan Calculation ───

/** Input parameters for calculating loan costs */
export interface LoanCalculateParams {
  /** Deposit amount as human-readable string (e.g. '1.0') */
  depositAmount: string;
  /** Underlying asset: 'ETH' or 'BTC' */
  underlying: LoanUnderlying;
  /** Strike price in USD */
  strike: number;
  /** Option expiry timestamp (Unix seconds) */
  expiryTimestamp: number;
  /** Option ask price (as a fraction of underlying, e.g. 0.007) */
  askPrice: number;
  /** Current underlying price in USD */
  underlyingPrice: number;
  /** Maximum borrowing APR (default: 20) */
  maxApr?: number;
}

/** Full breakdown of loan costs and amounts */
export interface LoanCalculation {
  /** Total amount owed at expiry (USDC, 6 decimals) */
  owe: bigint;
  /** Option premium cost (USDC, 6 decimals) */
  optionCost: bigint;
  /** Borrowing fee / capital cost (USDC, 6 decimals) */
  capitalCost: bigint;
  /** Protocol fee (USDC, 6 decimals) */
  protocolFee: bigint;
  /** Total of all costs (USDC, 6 decimals) */
  totalCosts: bigint;
  /** Final loan amount received (USDC, 6 decimals) */
  finalLoanAmount: bigint;
  /** Effective APR including all costs */
  effectiveApr: number;
  /** Whether this loan qualifies for promotional pricing */
  isPromo: boolean;
  /** Formatted display values */
  formatted: {
    /** Amount borrower receives (e.g. "1422.41") */
    receive: string;
    /** Amount borrower must repay (e.g. "1600.00") */
    repay: string;
    /** Option cost formatted (e.g. "16.2960") */
    optionCost: string;
    /** Capital cost formatted (e.g. "12.3456") */
    capitalCost: string;
    /** Protocol fee formatted (e.g. "0.6400") */
    protocolFee: string;
    /** Effective APR formatted (e.g. "18.52") */
    apr: string;
  };
}

// ─── Strike Options ───

/** Filter/sort settings for strike option queries */
export interface LoanStrikeSettings {
  /** Minimum days to expiry (default: 7) */
  minDurationDays: number;
  /** Maximum number of strikes per expiry group (default: 20) */
  maxStrikes: number;
  /** Sort order for results */
  sortOrder: 'highestStrike' | 'lowestStrike' | 'nearestExpiry' | 'furthestExpiry';
  /** Maximum borrowing APR for cost estimation (default: 20) */
  maxApr: number;
}

/** A single strike+expiry option with pricing data */
export interface LoanStrikeOption {
  /** Strike price in USD */
  strike: number;
  /** Formatted strike (e.g. "$1,600") */
  strikeFormatted: string;
  /** Expiry timestamp (Unix seconds) */
  expiry: number;
  /** Formatted expiry date (e.g. "Fri, March 28, 2025") */
  expiryFormatted: string;
  /** Deribit-style expiry label (e.g. "28MAR25") */
  expiryLabel: string;
  /** Current underlying price in USD */
  underlyingPrice: number;
  /** Option ask price (fraction of underlying) */
  askPrice: number;
  /** Estimated loan amount per unit of collateral in USD */
  impliedLoanAmount: number;
  /** Effective APR including all costs */
  effectiveApr: number;
  /** Whether this option qualifies for promotional pricing */
  isPromo: boolean;
}

/** Strike options grouped by expiry date */
export interface LoanStrikeOptionGroup {
  /** Deribit-style expiry label (e.g. "28MAR25") */
  expiryLabel: string;
  /** Formatted expiry date */
  expiryFormatted: string;
  /** Expiry timestamp (Unix seconds) */
  expiryTimestamp: number;
  /** Available strike options for this expiry */
  options: LoanStrikeOption[];
}

// ─── On-Chain State ───

/** On-chain loan state from the LoanCoordinator contract */
export interface LoanState {
  /** Borrower address */
  requester: string;
  /** Collateral amount (token decimals) */
  collateralAmount: bigint;
  /** Strike price (8 decimals) */
  strike: bigint;
  /** Option expiry timestamp */
  expiryTimestamp: number;
  /** Collateral token address */
  collateralToken: string;
  /** Settlement token address (USDC) */
  settlementToken: string;
  /** Whether the loan has been settled */
  isSettled: boolean;
  /** Address of the deployed option contract (zero address if not settled) */
  settledOptionContract: string;
}

/** Detailed option contract information */
export interface LoanOptionInfo {
  /** Option buyer (borrower) address */
  buyer: string;
  /** Option seller (lender) address */
  seller: string;
  /** Collateral token address */
  collateralToken: string;
  /** Collateral amount locked */
  collateralAmount: bigint;
  /** Option expiry timestamp */
  expiryTimestamp: number;
  /** Strike prices (human-readable USD values) */
  strikes: number[];
  /** Whether the option has been settled (exercised or expired) */
  isSettled: boolean;
  /** TWAP price at settlement (raw, 0 if not yet expired) */
  twap: number;
  /** Delivery amount for exercise (settlement token decimals) */
  deliveryAmount: bigint;
  /** Exercise window duration in seconds */
  exerciseWindow: number;
}

// ─── Indexer Types ───

/** Loan record from the Loan indexer API */
export interface LoanIndexerLoan {
  /** Quotation ID */
  quotationId: string;
  /** Borrower address */
  requester: string;
  /** Collateral token address */
  collateralToken: string;
  /** Settlement token address */
  settlementToken: string;
  /** Collateral amount (string, token decimals) */
  collateralAmount: string;
  /** Minimum settlement amount (string, USDC 6 decimals) */
  minSettlementAmount: string;
  /** Strike price (string, 8 decimals) */
  strike: string;
  /** Expiry timestamp */
  expiryTimestamp: number;
  /** Offer end timestamp */
  offerEndTimestamp: number;
  /**
   * Whether this loan was placed with the limit-order conversion flag.
   * Optional — r12 contract dropped this field, but the indexer may still
   * surface it from prior records or off-chain orderbook state.
   */
  convertToLimitOrder?: boolean;
  /** Loan status */
  status: string;
  /** Deployed option contract address (if settled) */
  optionAddress?: string;
  /**
   * Borrower role on the underlying option (= option.seller after role-swap).
   * Populated by the SDK from the on-chain option contract when the indexer
   * omits it. The r12 indexer's `options` entries drop buyer/seller, so the
   * loan module backfills them via `getOptionInfo()` for active loans with
   * an `optionAddress`.
   */
  buyer?: string;
  /**
   * Lender role on the underlying option (= option.buyer after role-swap).
   * Populated by the SDK from the on-chain option contract when the indexer
   * omits it. See `buyer` above for the r12 backfill rationale.
   */
  seller?: string;
}

/** Enriched lending opportunity with computed values */
export interface LoanLendingOpportunity {
  /** Quotation ID */
  quotationId: string;
  /** Borrower address */
  requester: string;
  /** Underlying asset symbol ('ETH' or 'BTC') */
  underlying: string;
  /** Collateral amount formatted (e.g. "1.5") */
  collateralFormatted: string;
  /** Amount lender provides in USDC formatted (e.g. "1422.41") */
  lendAmountFormatted: string;
  /** Lend amount raw (USDC, 6 decimals) */
  lendAmount: bigint;
  /** Strike price in USD */
  strike: number;
  /** Expiry timestamp */
  expiryTimestamp: number;
  /** Formatted expiry date */
  expiryFormatted: string;
  /** Estimated APR for the lender */
  apr: number;
  /** Formatted APR string */
  aprFormatted: string;
  /** Raw indexer data */
  raw: LoanIndexerLoan;
}

// ─── Pricing ───

/** Raw pricing data for a single option from the Deribit-style API */
export interface DeribitOptionData {
  /** Current underlying asset price in USD */
  underlying_price: number;
  /** Best ask price (fraction of underlying) */
  ask_price: number;
  /** Best bid price (fraction of underlying) — not always present */
  bid_price?: number;
  /** Mark price (fraction of underlying) */
  mark_price: number;
}

/**
 * Pricing map keyed by asset ('ETH'|'BTC') then instrument name
 * e.g. pricingMap['ETH']['ETH-28MAR25-3000-P']
 */
export type DeribitPricingMap = Record<string, Record<string, DeribitOptionData>>;
