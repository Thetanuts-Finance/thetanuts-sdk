/**
 * Loan Configuration Constants
 *
 * Contract addresses, API endpoints, asset configuration, and
 * promotional pricing settings for Loan lending on Base.
 */

import type { LoanAssetConfig, LoanPromoConfig } from '../types/loan.js';

export const LOAN_CONFIG = {
  /** Loan custom contract addresses (Base_r12) */
  contracts: {
    loanCoordinator: '0x9FB75b24d9d6f7c29D6BdE2870697A4FE0395994',
    loanHandler: '0x7c444A2375275DaB925b32493B64a407eE955DEd',
  },

  /** Loan loan indexer API base URL (r12 worker; v1 worker is archive-only) */
  indexerUrl: 'https://zendfi-loan-indexer-r12.devops-118.workers.dev',

  /** Deribit-style pricing API URL */
  pricingUrl: 'https://pricing.thetanuts.finance/all',

  /** Protocol fee in basis points (4 bps = 0.04%) */
  protocolFeeBps: 4,

  /** Default offer duration for RFQ auctions (seconds) */
  defaultOfferDurationSeconds: 30,

  /** Default market maker address */
  defaultMarketMaker: '0xf1711ba7e74435032aa103ef20a4cbece40b6df5',

  /** Strike price decimals (on-chain representation) */
  strikeDecimals: 8,

  /** Settlement token address (USDC on Base) */
  settlement: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',

  /** Per-asset collateral configuration */
  assets: {
    ETH: {
      collateral: '0x4200000000000000000000000000000000000006',
      decimals: 18,
      priceFeed: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    } satisfies LoanAssetConfig,
    BTC: {
      collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      decimals: 8,
      priceFeed: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F',
    } satisfies LoanAssetConfig,
  },

  /** Promotional pricing configuration */
  promo: {
    enabled: true,
    minDaysToExpiry: 90,
    maxLtvPercent: 50,
    optionPremiumWaived: true,
    borrowingFeePercent: 5.68,
    maxPerPersonUsd: 250_000,
    maxTotalUsd: 2_000_000,
  } satisfies LoanPromoConfig,
} as const;
