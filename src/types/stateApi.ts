/**
 * Types for the RFQ State API (indexer)
 *
 * The State API provides a snapshot of all RFQs, offers, options,
 * and protocol statistics from the on-chain OptionFactory contract.
 *
 * @example
 * ```typescript
 * const state = await client.api.getState();
 * console.log('Active RFQs:', state.protocolStats.activeRfqs);
 *
 * const rfq = await client.api.getRfq('42');
 * console.log('Status:', rfq.status);
 * ```
 */

/**
 * User RFQ data structure from the State API
 */
export interface UserRfqData {
  /** Active RFQ IDs */
  active: string[];
  /** Completed RFQ IDs */
  completed: string[];
}

/**
 * User offer data structure from the State API
 */
export interface UserOfferData {
  /** Active offer quotation IDs */
  active: string[];
  /** Completed offer quotation IDs */
  completed: string[];
}

/**
 * User option data structure from the State API
 */
export interface UserOptionData {
  /** Active option addresses */
  active: string[];
  /** Historical option addresses */
  history: string[];
}

/**
 * Full State API response
 */
export interface StateApiResponse {
  /** Last update timestamp (unix seconds) */
  lastUpdateTimestamp: number;
  /** Last processed block number */
  lastProcessedBlock: number;
  /** All RFQs indexed by ID */
  rfqs: Record<string, StateRfq>;
  /** All offers indexed by quotation ID, then by offeror address */
  offers: Record<string, Record<string, StateOffer>>;
  /** All options indexed by address */
  options: Record<string, StateOption>;
  /** User address → RFQ data with active and completed arrays */
  userRFQs: Record<string, UserRfqData>;
  /** User address → offer data with active and completed arrays */
  userOffers: Record<string, UserOfferData>;
  /** User address → option data with active and history arrays */
  userOptions: Record<string, UserOptionData>;
  /** Protocol-level statistics */
  protocolStats: StateProtocolStats;
  /** Referral data indexed by referral ID */
  referrals: Record<string, StateReferral>;
}

/**
 * RFQ entry from the State API
 */
export interface StateRfq {
  /** Quotation ID */
  id: string;
  /**
   * OptionFactory address this RFQ lives on. The indexer surfaces this
   * because it tracks multiple factory deployments simultaneously; SDK
   * methods that target a specific RFQ (`getRfq`, `getRequesterPublicKey`,
   * `getOffer`) cross-check this against the current chain config and
   * refuse to return rows from a predecessor factory.
   */
  factoryAddress?: string;
  /** Requester address */
  requester: string;
  /** Requester's public key for encrypted offers */
  requesterPublicKey: string;
  /** Existing option address (zero address if new) */
  existingOptionAddress: string;
  /** Reserve price */
  reservePrice: string;
  /** RFQ status: 'active' | 'settled' | 'cancelled' */
  status: string;
  /** Creation timestamp (unix seconds) */
  createdAt: number;
  /** Creation transaction hash */
  createdTx: string;
  /** Creation block number */
  createdBlock: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Collateral token address */
  collateral: string;
  /** Collateral price feed address */
  collateralPriceFeed: string;
  /** Option implementation address */
  implementation: string;
  /** Strike prices (8 decimals, as strings) */
  strikes: string[];
  /** Number of contracts (as string) */
  numContracts: string;
  /** Option expiry timestamp */
  expiryTimestamp: number;
  /** Offer period end timestamp */
  offerEndTimestamp: number;
  /** Whether requester wants long position */
  isRequestingLongPosition: boolean;
  /** Whether to convert to limit order */
  convertToLimitOrder: boolean;
  /** Option type (0=call, 1=put, etc.) */
  optionType: number;
  /** Current best offer price (as string) */
  currentBestPrice: string;
  /** Close transaction hash (if settled/cancelled) */
  closedTx?: string;
  /** Close block number (if settled/cancelled) */
  closedBlock?: number;
  /** Winning offeror address (if settled) */
  winner?: string;
  /** Deployed option address (if settled) */
  optionAddress?: string;
  /** Fee amount collected (if settled) */
  feeAmount?: string;
  /** Offers for this RFQ (only present from getRfq, not list endpoints) */
  offers?: Record<string, StateOffer>;
}

/**
 * Offer entry from the State API
 */
export interface StateOffer {
  /** Quotation ID this offer is for */
  quotationId: string;
  /** OptionFactory this offer was made against. See StateRfq.factoryAddress. */
  factoryAddress?: string;
  /** Offeror address */
  offeror: string;
  /** Offer signature */
  signature: string;
  /** Signing key used for offer */
  signingKey: string;
  /** Encrypted offer data for requester */
  signedOfferForRequester: string;
  /** Offer status */
  status: 'pending' | 'accepted' | 'rejected' | 'revealed';
  /** Creation timestamp (unix seconds) */
  createdAt: number;
  /** Creation transaction hash */
  createdTx: string;
  /** Creation block number */
  createdBlock: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Revealed offer amount (if revealed) */
  revealedAmount?: string;

  // Backward compatibility aliases (deprecated)
  /** @deprecated Use signedOfferForRequester instead */
  encryptedOffer?: string;
  /** @deprecated Use createdAt instead */
  timestamp?: number;
  /** @deprecated Use createdTx instead */
  txHash?: string;
}

/**
 * Option entry from the State API
 */
export interface StateOption {
  /** Option contract address */
  address: string;
  /** OptionFactory that minted this option. See StateRfq.factoryAddress. */
  factoryAddress?: string;
  /** Quotation ID that created this option */
  quotationId: string;
  /** Creator address */
  creator: string;
  /** Collateral token address */
  collateral: string;
  /** Strike prices */
  strikes: string[];
  /** Expiry timestamp */
  expiry: number;
  /** Option type */
  optionType: number;
}

/**
 * Protocol statistics from the State API
 */
export interface StateProtocolStats {
  /** Total number of RFQs created */
  totalRfqs: number;
  /** Currently active RFQs */
  activeRfqs: number;
  /** Settled RFQs */
  settledRfqs: number;
  /** Cancelled RFQs */
  cancelledRfqs: number;
  /** Total offers made */
  totalOffers: number;
  /** Total options created */
  totalOptions: number;
}

/**
 * A single referral execution record
 */
export interface ReferralExecution {
  /** Quotation ID that used this referral */
  quotationId: string;
  /** Fee amount earned (as string) */
  amount: string;
  /** Block number where execution occurred */
  executedBlock: number;
}

/**
 * Referral entry from the State API
 */
export interface StateReferral {
  /** Referral ID */
  id: string;
  /** Referrer address */
  referrer: string;
  /** Creation timestamp (unix seconds) */
  createdAt: number;
  /** Creation transaction hash */
  createdTx: string;
  /** Creation block number */
  createdBlock: number;
  /** Executions of this referral across RFQs */
  executed: ReferralExecution[];
}
