import { Contract, Interface, AbiCoder } from 'ethers';
import type { TransactionReceipt, ContractTransactionResponse } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import { OPTION_FACTORY_ABI } from '../abis/optionFactory.js';
import type {
  RFQRequest,
  Quotation,
  QuotationParameters,
  QuotationTracking,
  QuotationState,
  MakeOfferParams,
  RevealOfferParams,
  ReferralParameters,
  SwapAndCallParams,
  Eip712DomainResult,
  RFQBuilderParams,
  RFQUnderlying,
  RFQCollateralToken,
  SpreadRFQParams,
  ButterflyRFQParams,
  CondorRFQParams,
  IronCondorRFQParams,
  PhysicalOptionRFQParams,
  PhysicalSpreadRFQParams,
  PhysicalButterflyRFQParams,
  PhysicalCondorRFQParams,
  PhysicalIronCondorRFQParams,
} from '../types/optionFactory.js';
import type { CallStaticResult } from '../types/callStatic.js';
import type { ImplementationAddresses } from '../chains/index.js';
import { createError, mapContractError } from '../utils/errors.js';
import { NotFoundError } from '../types/errors.js';
import { validateAddress, validateHexBytes } from '../utils/validation.js';

/**
 * Contract-level interface matching the OptionFactory ABI exactly.
 */
interface OptionFactoryContract {
  requestForQuotation(
    params: QuotationParameters,
    tracking: QuotationTracking,
    reservePrice: bigint,
    requesterPublicKey: string
  ): Promise<ContractTransactionResponse>;
  makeOfferForQuotation(
    quotationId: bigint,
    signature: string,
    signingKey: string,
    encryptedOffer: string
  ): Promise<ContractTransactionResponse>;
  revealOffer(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string
  ): Promise<ContractTransactionResponse>;
  settleQuotation(quotationId: bigint): Promise<ContractTransactionResponse>;
  settleQuotationEarly(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string
  ): Promise<ContractTransactionResponse>;
  cancelQuotation(quotationId: bigint): Promise<ContractTransactionResponse>;
  cancelOfferForQuotation(quotationId: bigint): Promise<ContractTransactionResponse>;
  // View: returns [QuotationParameters tuple, QuotationState tuple]
  quotations(quotationId: bigint): Promise<[QuotationParameters, QuotationState]>;
  getQuotationCount(): Promise<bigint>;
  calculateFee(numContracts: bigint, premium: bigint, price: bigint): Promise<bigint>;

  // View: constants
  MAX_RFQ_VALUE(): Promise<bigint>;
  OFFER_TYPEHASH(): Promise<string>;
  REVEAL_WINDOW(): Promise<bigint>;
  TWAP_PERIOD(): Promise<bigint>;

  // View: state
  authorizedRouters(router: string): Promise<boolean>;
  eip712Domain(): Promise<[string, string, string, bigint, string, string, bigint[]]>;
  historicalTWAPConsumer(): Promise<string>;

  // View: referral
  quotationTracking(quotationId: bigint): Promise<[bigint, bigint]>;
  referralFees(referralId: bigint): Promise<bigint>;
  returnReferralParameters(referralId: bigint): Promise<[string, string, string, bigint[], bigint, boolean, string]>;

  // Write: referral + swap
  registerReferral(params: QuotationParameters): Promise<ContractTransactionResponse>;
  swapAndCall(
    swapRouter: string,
    swapSrcToken: string,
    swapDstToken: string,
    swapSrcAmount: bigint,
    swapCallData: string,
    selfCallData: string,
  ): Promise<ContractTransactionResponse>;
}

/**
 * Module for OptionFactory contract interactions
 *
 * Provides methods for the RFQ (Request for Quotation) lifecycle:
 * - Creating RFQs
 * - Making and revealing offers
 * - Settling quotations
 *
 * **IMPORTANT: collateralAmount must ALWAYS be 0 in RFQ params**
 *
 * Collateral is NOT locked at RFQ creation time - it is pulled from both parties
 * at settlement time. For SELL positions, approve tokens separately before creating RFQ.
 *
 * @example
 * ```typescript
 * const chainConfig = client.chainConfig;
 *
 * const receipt = await client.optionFactory.requestForQuotation({
 *   params: {
 *     requester: '0xYourAddress',
 *     existingOptionAddress: '0x0000000000000000000000000000000000000000',
 *     collateral: chainConfig.tokens.USDC.address,
 *     collateralPriceFeed: chainConfig.priceFeeds.ETH,
 *     implementation: chainConfig.implementations.PUT,
 *     strikes: [BigInt(2000) * BigInt(1e8)],  // $2000 strike in 8 decimals
 *     numContracts: BigInt(10) * BigInt(1e6), // 10 contracts in USDC decimals
 *     requesterDeposit: BigInt(0),
 *     collateralAmount: BigInt(0),  // ALWAYS 0 - collateral pulled at settlement
 *     expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
 *     offerEndTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
 *     isRequestingLongPosition: true,
 *     convertToLimitOrder: false,
 *     extraOptionData: '0x',
 *   },
 *   tracking: { referralId: BigInt(0), eventCode: BigInt(0) },
 *   reservePrice: BigInt(100) * BigInt(1e6),  // Reserve price in USDC decimals
 *   requesterPublicKey: '0x...',
 * });
 * ```
 */
export class OptionFactoryModule {
  /** Cached contract instance for read operations */
  private _readContract: OptionFactoryContract | null = null;

  constructor(private readonly client: ThetanutsClient) {}

  /**
   * Get the OptionFactory contract address
   */
  get contractAddress(): string {
    return this.client.getContractAddress('optionFactory');
  }

  private ensureAvailable(): void {
    this.client.getContractAddress('optionFactory');
  }

  private getImplementationAddress(name: keyof ImplementationAddresses): string {
    const implementation = this.client.chainConfig.implementations[name];
    if (!implementation || implementation === '0x0000000000000000000000000000000000000000') {
      throw createError(
        'NETWORK_UNSUPPORTED',
        `${name} implementation is not deployed on ${this.client.chainConfig.name} (chain ${this.client.chainId})`
      );
    }
    return implementation;
  }

  /**
   * Get a read-only contract instance
   */
  private getReadContract(): OptionFactoryContract {
    if (!this._readContract) {
      this._readContract = new Contract(
        this.contractAddress,
        OPTION_FACTORY_ABI,
        this.client.provider
      ) as unknown as OptionFactoryContract;
    }
    return this._readContract;
  }

  /**
   * Get a contract instance with signer for write operations
   */
  private getWriteContract(): OptionFactoryContract {
    const signer = this.client.requireSigner();
    return new Contract(
      this.contractAddress,
      OPTION_FACTORY_ABI,
      signer
    ) as unknown as OptionFactoryContract;
  }

  /**
   * Convert numContracts input to on-chain BigInt format.
   *
   * This utility handles the precision issue when closing positions by allowing
   * users to pass the exact BigInt value from the chain, avoiding floating-point
   * rounding errors.
   *
   * @param input - User input (number, bigint, or string)
   *   - `number`: Human-readable (e.g., 1.5) - converted using token decimals
   *   - `bigint`: On-chain format - used directly, no conversion
   *   - `string`: Parsed as BigInt
   * @param decimals - Token decimals (only used for number input)
   * @returns BigInt in on-chain format
   * @throws Error if input is invalid or not positive
   *
   * @example BigInt pass-through (for closing positions)
   * ```typescript
   * // Get exact numContracts from chain
   * const position = await client.option.getNumContracts(optionAddress);
   * // Pass directly - no conversion, no precision loss
   * const onChain = this.toNumContractsOnChain(position, 18);
   * // onChain === position (exact match)
   * ```
   *
   * @example Number conversion (for new positions)
   * ```typescript
   * const onChain = this.toNumContractsOnChain(1.5, 18);
   * // onChain === 1500000000000000000n
   * ```
   */
  private toNumContractsOnChain(
    input: number | bigint | string,
    decimals: number
  ): bigint {
    // BigInt: use directly (already in on-chain format)
    if (typeof input === 'bigint') {
      if (input <= 0n) {
        throw createError('INVALID_PARAMS', 'numContracts must be positive');
      }
      return input;
    }

    // String: parse as BigInt
    if (typeof input === 'string') {
      let parsed: bigint;
      try {
        parsed = BigInt(input);
      } catch {
        throw createError(
          'INVALID_PARAMS',
          `Invalid numContracts string: "${input}". Expected a valid integer string.`
        );
      }
      if (parsed <= 0n) {
        throw createError('INVALID_PARAMS', 'numContracts must be positive');
      }
      return parsed;
    }

    // Number: convert using string-based approach to avoid floating-point errors
    if (typeof input === 'number') {
      if (input <= 0) {
        throw createError('INVALID_PARAMS', 'numContracts must be positive');
      }
      if (!Number.isFinite(input)) {
        throw createError('INVALID_PARAMS', 'numContracts must be a finite number');
      }
      // Use string-based conversion to avoid floating-point precision issues
      // This is the same approach as toBigInt in utils/decimals.ts
      const str = input.toString();
      const [whole, fraction = ''] = str.split('.');
      const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
      return BigInt(whole + paddedFraction);
    }

    throw createError(
      'INVALID_PARAMS',
      'numContracts must be a number, bigint, or string'
    );
  }

  /**
   * Calculate reserve price handling both number and BigInt numContracts.
   *
   * @param reservePricePerContract - Reserve price per contract (human-readable)
   * @param numContracts - Number of contracts (number, bigint, or string)
   * @param decimals - Token decimals
   * @returns Total reserve price in on-chain format
   */
  private calculateReservePrice(
    reservePricePerContract: number,
    numContracts: number | bigint | string,
    decimals: number
  ): bigint {
    if (typeof numContracts === 'bigint') {
      // Convert reservePrice to on-chain format, then multiply
      // numContracts is already in decimals, so divide by 10**decimals to avoid double-scaling
      const reserveInDecimals = BigInt(Math.round(reservePricePerContract * 10 ** decimals));
      return (reserveInDecimals * numContracts) / BigInt(10 ** decimals);
    }

    if (typeof numContracts === 'string') {
      return this.calculateReservePrice(reservePricePerContract, BigInt(numContracts), decimals);
    }

    // Number: use existing logic
    return BigInt(Math.round(reservePricePerContract * numContracts * 10 ** decimals));
  }

  /**
   * Create a new Request for Quotation
   *
   * **IMPORTANT: collateralAmount must ALWAYS be 0**
   *
   * The `collateralAmount` parameter must always be `BigInt(0)`.
   * Collateral is pulled at settlement time, not at RFQ creation.
   *
   * For SELL positions, approve tokens separately before calling this method.
   *
   * @param request - RFQ request data with full QuotationParameters
   * @returns Transaction receipt
   */
  async requestForQuotation(request: RFQRequest): Promise<TransactionReceipt> {
    validateAddress(request.params.requester, 'requester');
    validateAddress(request.params.collateral, 'collateral');
    this.assertImplementationDeployed(request.params.implementation, 'requestForQuotation');

    if (request.params.strikes.length === 0) {
      throw createError('INVALID_PARAMS', 'At least one strike price is required');
    }

    this.client.logger.debug('Creating RFQ', {
      requester: request.params.requester,
      collateral: request.params.collateral,
      numContracts: request.params.numContracts.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.requestForQuotation(
        request.params,
        request.tracking,
        request.reservePrice,
        request.requesterPublicKey
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('RFQ created successfully', {
        txHash: receipt.hash,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to create RFQ', { error, request });
      throw mapContractError(error);
    }
  }

  /**
   * Make an offer for a quotation
   *
   * @param params - Offer parameters
   * @returns Transaction receipt
   */
  async makeOfferForQuotation(params: MakeOfferParams): Promise<TransactionReceipt> {
    // Validate signingKey at the SDK boundary so callers get a clean
    // INVALID_PARAMS error instead of a generic on-chain revert
    // (TNU-AUDIT-0061; sibling `revealOffer` already validates `offeror`).
    validateAddress(params.signingKey, 'signingKey');
    // 65-byte vrs signature shape check — catches malformed signatures
    // before paying gas for a guaranteed revert (TNU-AUDIT-0082).
    validateHexBytes(params.signature, 65, 'signature');
    this.client.logger.debug('Making offer for quotation', {
      quotationId: params.quotationId.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.makeOfferForQuotation(
        params.quotationId,
        params.signature,
        params.signingKey,
        params.encryptedOffer
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Offer made successfully', {
        txHash: receipt.hash,
        quotationId: params.quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to make offer', { error, params });
      throw mapContractError(error);
    }
  }

  /**
   * Reveal an offer for a quotation
   *
   * @param params - Reveal parameters
   * @returns Transaction receipt
   */
  async revealOffer(params: RevealOfferParams): Promise<TransactionReceipt> {
    validateAddress(params.offeror, 'offeror');

    this.client.logger.debug('Revealing offer', {
      quotationId: params.quotationId.toString(),
      offerAmount: params.offerAmount.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.revealOffer(
        params.quotationId,
        params.offerAmount,
        params.nonce,
        params.offeror
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Offer revealed successfully', {
        txHash: receipt.hash,
        quotationId: params.quotationId.toString(),
        offerAmount: params.offerAmount.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to reveal offer', { error, params });
      throw mapContractError(error);
    }
  }

  /**
   * Settle a quotation after reveal phase
   */
  async settleQuotation(quotationId: bigint): Promise<TransactionReceipt> {
    this.client.logger.debug('Settling quotation', {
      quotationId: quotationId.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.settleQuotation(quotationId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Quotation settled successfully', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to settle quotation', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Settle a quotation early with specific offer
   */
  async settleQuotationEarly(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string
  ): Promise<TransactionReceipt> {
    validateAddress(offeror, 'offeror');

    this.client.logger.debug('Settling quotation early', {
      quotationId: quotationId.toString(),
      offeror,
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.settleQuotationEarly(quotationId, offerAmount, nonce, offeror);
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Quotation settled early', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to settle quotation early', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Cancel a quotation (requester only)
   */
  async cancelQuotation(quotationId: bigint): Promise<TransactionReceipt> {
    this.client.logger.debug('Cancelling quotation', {
      quotationId: quotationId.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.cancelQuotation(quotationId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Quotation cancelled successfully', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to cancel quotation', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Cancel an offer for a quotation
   */
  async cancelOfferForQuotation(quotationId: bigint): Promise<TransactionReceipt> {
    this.client.logger.debug('Cancelling offer for quotation', {
      quotationId: quotationId.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.cancelOfferForQuotation(quotationId);
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Offer cancelled successfully', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to cancel offer', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Get a quotation by ID using the quotations() view function.
   * Returns both the QuotationParameters and QuotationState.
   *
   * @param quotationId - Quotation ID
   * @returns Quotation data (params + state)
   *
   * @example
   * ```typescript
   * const quotation = await client.optionFactory.getQuotation(1n);
   * console.log('Active:', quotation.state.isActive);
   * console.log('Winner:', quotation.state.currentWinner);
   * ```
   */
  async getQuotation(quotationId: bigint): Promise<Quotation> {
    this.client.logger.debug('Getting quotation', {
      quotationId: quotationId.toString(),
    });

    try {
      const contract = this.getReadContract();
      const [params, state] = await contract.quotations(quotationId);

      return { params, state };
    } catch (error: unknown) {
      // Detect Solidity Panic(0x32) = array/index out of bounds
      const errorMsg = error instanceof Error ? error.message : '';
      if (errorMsg.includes('ARRAY_RANGE_ERROR') || errorMsg.includes('Panic due to')) {
        throw new NotFoundError(
          `Quotation ID ${quotationId} not found (out of range)`,
          error,
          { quotationId: quotationId.toString() },
        );
      }
      this.client.logger.error('Failed to get quotation', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Get the total number of quotations
   */
  async getQuotationCount(): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.getQuotationCount();
    } catch (error) {
      this.client.logger.error('Failed to get quotation count', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Calculate fee for a quotation
   */
  async calculateFee(numContracts: bigint, premium: bigint, price: bigint): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.calculateFee(numContracts, premium, price);
    } catch (error) {
      this.client.logger.error('Failed to calculate fee', { error });
      throw mapContractError(error);
    }
  }

  // ============================================================
  // View methods — Constants
  // ============================================================

  /**
   * Get the maximum RFQ value constant
   *
   * @returns MAX_RFQ_VALUE as bigint
   */
  async getMaxRfqValue(): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.MAX_RFQ_VALUE();
    } catch (error) {
      this.client.logger.error('Failed to get MAX_RFQ_VALUE', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the EIP-712 offer typehash
   *
   * @returns OFFER_TYPEHASH as hex string
   */
  async getOfferTypehash(): Promise<string> {
    try {
      const contract = this.getReadContract();
      return await contract.OFFER_TYPEHASH();
    } catch (error) {
      this.client.logger.error('Failed to get OFFER_TYPEHASH', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the reveal window duration
   *
   * @returns REVEAL_WINDOW in seconds as bigint
   */
  async getRevealWindow(): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.REVEAL_WINDOW();
    } catch (error) {
      this.client.logger.error('Failed to get REVEAL_WINDOW', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the TWAP period duration
   *
   * @returns TWAP_PERIOD in seconds as bigint
   */
  async getTwapPeriod(): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.TWAP_PERIOD();
    } catch (error) {
      this.client.logger.error('Failed to get TWAP_PERIOD', { error });
      throw mapContractError(error);
    }
  }

  // ============================================================
  // View methods — State
  // ============================================================

  /**
   * Check if a router address is authorized
   *
   * @param router - Router address to check
   * @returns true if the router is authorized
   */
  async isRouterAuthorized(router: string): Promise<boolean> {
    validateAddress(router, 'router');

    try {
      const contract = this.getReadContract();
      return await contract.authorizedRouters(router);
    } catch (error) {
      this.client.logger.error('Failed to check router authorization', { error, router });
      throw mapContractError(error);
    }
  }

  /**
   * Get the EIP-712 domain separator fields
   *
   * @returns EIP-712 domain data
   *
   * @example
   * ```typescript
   * const domain = await client.optionFactory.getEip712Domain();
   * console.log('Name:', domain.name);
   * console.log('Chain:', domain.chainId);
   * ```
   */
  async getEip712Domain(): Promise<Eip712DomainResult> {
    try {
      const contract = this.getReadContract();
      const [fields, name, version, chainId, verifyingContract, salt, extensions] =
        await contract.eip712Domain();

      return { fields, name, version, chainId, verifyingContract, salt, extensions };
    } catch (error) {
      this.client.logger.error('Failed to get EIP-712 domain', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the historical TWAP consumer address
   *
   * @returns Consumer contract address
   */
  async getHistoricalTWAPConsumer(): Promise<string> {
    try {
      const contract = this.getReadContract();
      return await contract.historicalTWAPConsumer();
    } catch (error) {
      this.client.logger.error('Failed to get historicalTWAPConsumer', { error });
      throw mapContractError(error);
    }
  }

  // Removed in audit fix (TNU-AUDIT-0045): getOfferSignature and
  // getPendingFees relied on offerSignatures/pendingFees view functions that
  // do not exist on the r12 OptionFactory deployment. Calls were silently
  // generating valid-looking calldata that reverted on-chain.

  // ============================================================
  // View methods — Referral
  // ============================================================

  /**
   * Get tracking data for a quotation
   *
   * @param quotationId - Quotation ID
   * @returns Tracking data with referralId and eventCode
   */
  async getQuotationTracking(quotationId: bigint): Promise<QuotationTracking> {
    try {
      const contract = this.getReadContract();
      const [referralId, eventCode] = await contract.quotationTracking(quotationId);

      return { referralId, eventCode };
    } catch (error) {
      this.client.logger.error('Failed to get quotation tracking', {
        error,
        quotationId: quotationId.toString(),
      });
      throw mapContractError(error);
    }
  }

  /**
   * Get accumulated fees for a referral ID
   *
   * @param referralId - Referral ID
   * @returns Fee amount as bigint
   */
  async getReferralFees(referralId: bigint): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.referralFees(referralId);
    } catch (error) {
      this.client.logger.error('Failed to get referral fees', {
        error,
        referralId: referralId.toString(),
      });
      throw mapContractError(error);
    }
  }

  // Removed in audit fix (TNU-AUDIT-0045): getReferralOwner relied on a
  // referralOwner view function not present on r12 OptionFactory. Use
  // referral-emitted events (ReferralRegistered) or off-chain indexer if you
  // need to resolve referral → owner.

  /**
   * Get the full referral parameters for a referral ID
   *
   * @param referralId - Referral ID
   * @returns Referral parameters
   *
   * @example
   * ```typescript
   * const params = await client.optionFactory.getReferralParameters(1n);
   * console.log('Collateral:', params.collateral);
   * console.log('Strikes:', params.strikes);
   * ```
   */
  async getReferralParameters(referralId: bigint): Promise<ReferralParameters> {
    try {
      const contract = this.getReadContract();
      const [collateral, collateralPriceFeed, implementation, strikes, expiryTimestamp, isRequestingLongPosition, extraOptionData] =
        await contract.returnReferralParameters(referralId);

      return {
        collateral,
        collateralPriceFeed,
        implementation,
        strikes,
        expiryTimestamp,
        isRequestingLongPosition,
        extraOptionData,
      };
    } catch (error) {
      this.client.logger.error('Failed to get referral parameters', {
        error,
        referralId: referralId.toString(),
      });
      throw mapContractError(error);
    }
  }

  // ============================================================
  // Write methods — Referral & Swap
  // ============================================================

  /**
   * Register a new referral with quotation parameters
   *
   * @param params - Quotation parameters to register as a referral
   * @returns Transaction receipt
   *
   * @example
   * ```typescript
   * const chainConfig = client.chainConfig;
   *
   * const receipt = await client.optionFactory.registerReferral({
   *   requester: '0x...',
   *   existingOptionAddress: '0x0000000000000000000000000000000000000000',
   *   collateral: chainConfig.tokens.USDC.address,
   *   collateralPriceFeed: chainConfig.priceFeeds.ETH,
   *   implementation: chainConfig.implementations.PUT,
   *   strikes: [BigInt(2000) * BigInt(1e8)],
   *   numContracts: BigInt(10) * BigInt(1e6),
   *   requesterDeposit: BigInt(0),
   *   collateralAmount: BigInt(0),  // ALWAYS 0
   *   expiryTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
   *   offerEndTimestamp: BigInt(Math.floor(Date.now() / 1000) + 86400),
   *   isRequestingLongPosition: true,
   *   convertToLimitOrder: false,
   *   extraOptionData: '0x',
   * });
   * ```
   */
  async registerReferral(params: QuotationParameters): Promise<TransactionReceipt> {
    validateAddress(params.requester, 'requester');
    validateAddress(params.collateral, 'collateral');
    this.assertImplementationDeployed(params.implementation, 'registerReferral');

    this.client.logger.debug('Registering referral', {
      requester: params.requester,
      collateral: params.collateral,
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.registerReferral(params);
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Referral registered successfully', {
        txHash: receipt.hash,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to register referral', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Swap tokens and execute a call in a single transaction
   *
   * Performs a token swap via an authorized router then executes
   * a self-call (e.g., requestForQuotation) atomically.
   *
   * @param params - Swap and call parameters
   * @returns Transaction receipt
   *
   * @example
   * ```typescript
   * const receipt = await client.optionFactory.swapAndCall({
   *   swapRouter: '0xRouterAddress',
   *   swapSrcToken: '0xWETH',
   *   swapDstToken: '0xUSDC',
   *   swapSrcAmount: 1000000000000000000n, // 1 ETH
   *   swapCallData: '0x...',
   *   selfCallData: '0x...',
   * });
   * ```
   */
  async swapAndCall(params: SwapAndCallParams): Promise<TransactionReceipt> {
    validateAddress(params.swapRouter, 'swapRouter');
    validateAddress(params.swapSrcToken, 'swapSrcToken');
    validateAddress(params.swapDstToken, 'swapDstToken');

    this.client.logger.debug('Executing swapAndCall', {
      swapRouter: params.swapRouter,
      swapSrcToken: params.swapSrcToken,
      swapDstToken: params.swapDstToken,
      swapSrcAmount: params.swapSrcAmount.toString(),
    });

    try {
      const contract = this.getWriteContract();
      const tx = await contract.swapAndCall(
        params.swapRouter,
        params.swapSrcToken,
        params.swapDstToken,
        params.swapSrcAmount,
        params.swapCallData,
        params.selfCallData,
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('swapAndCall executed successfully', {
        txHash: receipt.hash,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to execute swapAndCall', { error });
      throw mapContractError(error);
    }
  }

  // Removed in audit fix (TNU-AUDIT-0044): withdrawFees is admin-only on the
  // OptionFactory contract per CLAUDE.md policy ("Never include admin-only
  // contract functions in SDK ABIs — they revert for non-owner callers"). The
  // ABI entry has been removed alongside this wrapper.

  // ============ Encode Methods (for external wallet use) ============

  /**
   * Encode a requestForQuotation transaction for use with any wallet library
   *
   * This method returns encoded transaction data that can be sent via viem, wagmi,
   * ethers.js, or any other wallet library. This is especially useful for:
   * - Account Abstraction wallets (Coinbase Smart Wallet, Safe, etc.)
   * - Apps using viem/wagmi instead of ethers.js
   * - Custom transaction signing flows
   *
   * **IMPORTANT: collateralAmount must ALWAYS be 0**
   *
   * The `collateralAmount` parameter in RFQ params must always be `BigInt(0)`.
   * Collateral is NOT locked at RFQ creation time - it is pulled from both parties
   * at settlement time when the option is created.
   *
   * For **SELL** positions (isRequestingLongPosition = false):
   * You must separately approve the collateral token for the OptionFactory contract.
   * Calculate the approval amount as:
   * - **CALL (inverse)**: `approval = numContracts` (1:1 with underlying token)
   * - **PUT**: `approval = strike * numContracts / 10^8`
   *
   * For **BUY** positions (isRequestingLongPosition = true):
   * No approval is needed - the counterparty (market maker) provides collateral.
   *
   * @param request - RFQ request data with full QuotationParameters
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   *
   * @example
   * ```typescript
   * // With viem/wagmi
   * const { to, data } = client.optionFactory.encodeRequestForQuotation({
   *   params: {
   *     requester: userAddress,
   *     existingOptionAddress: '0x0000000000000000000000000000000000000000',
   *     collateral: chainConfig.tokens.USDC.address,
   *     collateralPriceFeed: chainConfig.priceFeeds.ETH,
   *     implementation: chainConfig.implementations.PUT,
   *     strikes: [BigInt(1850) * BigInt(1e8)],  // Strike in 8 decimals
   *     numContracts: BigInt(1e6),  // 1 contract in USDC decimals
   *     requesterDeposit: BigInt(0),
   *     collateralAmount: BigInt(0),  // ALWAYS 0 - collateral pulled at settlement
   *     expiryTimestamp: BigInt(expiry),
   *     offerEndTimestamp: BigInt(offerDeadline),
   *     isRequestingLongPosition: true,
   *     convertToLimitOrder: false,
   *     extraOptionData: '0x',
   *   },
   *   tracking: { referralId: BigInt(0), eventCode: BigInt(0) },
   *   reservePrice: BigInt(0),
   *   requesterPublicKey: '0x...',
   * });
   * const hash = await walletClient.sendTransaction({ to, data });
   * ```
   */
  encodeRequestForQuotation(request: RFQRequest): { to: string; data: string } {
    validateAddress(request.params.requester, 'requester');
    validateAddress(request.params.collateral, 'collateral');
    this.assertImplementationDeployed(request.params.implementation, 'encodeRequestForQuotation');

    if (request.params.strikes.length === 0) {
      throw createError('INVALID_PARAMS', 'At least one strike price is required');
    }

    const iface = new Interface(OPTION_FACTORY_ABI);

    // Convert params to tuple format expected by the contract
    const paramsTuple = [
      request.params.requester,
      request.params.existingOptionAddress,
      request.params.collateral,
      request.params.collateralPriceFeed,
      request.params.implementation,
      request.params.strikes,
      request.params.numContracts,
      request.params.requesterDeposit,
      request.params.collateralAmount,
      request.params.expiryTimestamp,
      request.params.offerEndTimestamp,
      request.params.isRequestingLongPosition,
      request.params.convertToLimitOrder,
      request.params.extraOptionData,
    ];

    const trackingTuple = [
      request.tracking.referralId,
      request.tracking.eventCode,
    ];

    const data = iface.encodeFunctionData('requestForQuotation', [
      paramsTuple,
      trackingTuple,
      request.reservePrice,
      request.requesterPublicKey,
    ]);

    return { to: this.contractAddress, data };
  }

  /**
   * Encode a makeOfferForQuotation transaction for use with any wallet library
   *
   * @param params - Offer parameters
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   */
  encodeMakeOfferForQuotation(params: MakeOfferParams): { to: string; data: string } {
    const iface = new Interface(OPTION_FACTORY_ABI);
    const data = iface.encodeFunctionData('makeOfferForQuotation', [
      params.quotationId,
      params.signature,
      params.signingKey,
      params.encryptedOffer,
    ]);

    return { to: this.contractAddress, data };
  }

  /**
   * Encode a settleQuotation transaction for use with any wallet library
   *
   * @param quotationId - ID of the quotation to settle
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   */
  encodeSettleQuotation(quotationId: bigint): { to: string; data: string } {
    const iface = new Interface(OPTION_FACTORY_ABI);
    const data = iface.encodeFunctionData('settleQuotation', [quotationId]);

    return { to: this.contractAddress, data };
  }

  /**
   * Encode a cancelQuotation transaction for use with any wallet library
   *
   * @param quotationId - ID of the quotation to cancel
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   */
  encodeCancelQuotation(quotationId: bigint): { to: string; data: string } {
    const iface = new Interface(OPTION_FACTORY_ABI);
    const data = iface.encodeFunctionData('cancelQuotation', [quotationId]);

    return { to: this.contractAddress, data };
  }

  /**
   * Encode a settleQuotationEarly transaction for use with any wallet library.
   * Use this for early settlement before offer period ends.
   *
   * @param quotationId - ID of the quotation to settle
   * @param offerAmount - The offer amount (in collateral token decimals)
   * @param nonce - Nonce from the decrypted offer
   * @param offeror - Address of the offeror/market maker
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   *
   * @example
   * ```typescript
   * // First decrypt the offer to get nonce and amount
   * const decrypted = await client.rfqKeys.decryptOffer(
   *   offer.signedOfferForRequester,
   *   offer.signingKey
   * );
   *
   * // Encode for wallet
   * const { to, data } = client.optionFactory.encodeSettleQuotationEarly(
   *   quotationId,
   *   decrypted.offerAmount,
   *   decrypted.nonce,
   *   offerorAddress
   * );
   * ```
   */
  encodeSettleQuotationEarly(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string
  ): { to: string; data: string } {
    validateAddress(offeror, 'offeror');

    const iface = new Interface(OPTION_FACTORY_ABI);
    const data = iface.encodeFunctionData('settleQuotationEarly', [
      quotationId,
      offerAmount,
      nonce,
      offeror,
    ]);

    return { to: this.contractAddress, data };
  }

  /**
   * Encode a cancelOfferForQuotation transaction for use with any wallet library.
   * Use this to cancel your offer for an RFQ.
   *
   * @param quotationId - ID of the quotation to cancel offer for
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   */
  encodeCancelOfferForQuotation(quotationId: bigint): { to: string; data: string } {
    const iface = new Interface(OPTION_FACTORY_ABI);
    const data = iface.encodeFunctionData('cancelOfferForQuotation', [quotationId]);

    return { to: this.contractAddress, data };
  }

  /**
   * Encode a swapAndCall transaction for use with any wallet library.
   *
   * This enables atomic token swaps + RFQ operations in a single transaction.
   * Common use cases:
   * - **Native ETH wrapping**: Wrap ETH to WETH and create RFQ in one tx
   * - **Alternative asset swap**: Swap USDC/cbETH/etc to collateral and create RFQ
   * - **Settlement with swap**: Swap tokens and settle early in one tx
   *
   * For native ETH wrapping, use address(0) or zero address as swapSrcToken
   * and pass the ETH amount in the `value` field.
   *
   * @param params - Swap and call parameters
   * @returns Object with `to`, `data`, and optionally `value` for native ETH
   *
   * @example Native ETH wrapping for WETH call option
   * ```typescript
   * // First encode the RFQ creation
   * const rfqCalldata = client.optionFactory.encodeRequestForQuotation(request);
   *
   * // Then wrap in swapAndCall for native ETH
   * const { to, data, value } = client.optionFactory.encodeSwapAndCall({
   *   swapRouter: '0x0000000000000000000000000000000000000000', // No swap needed
   *   swapSrcToken: '0x0000000000000000000000000000000000000000', // Native ETH
   *   swapDstToken: WETH_ADDRESS,
   *   swapSrcAmount: collateralAmount,
   *   swapCallData: '0x', // No swap needed, just wrap
   *   selfCallData: rfqCalldata.data,
   *   value: collateralAmount, // Send ETH with tx
   * });
   *
   * // Send via wagmi/viem
   * await walletClient.sendTransaction({ to, data, value });
   * ```
   *
   * @example Alternative asset swap (USDC -> collateral)
   * ```typescript
   * // Get swap route from KyberSwap
   * const swapQuote = await getKyberSwapQuote(USDC, collateral, amount);
   *
   * // Encode RFQ creation
   * const rfqCalldata = client.optionFactory.encodeRequestForQuotation(request);
   *
   * // Combine swap + RFQ
   * const { to, data } = client.optionFactory.encodeSwapAndCall({
   *   swapRouter: swapQuote.routerAddress,
   *   swapSrcToken: USDC_ADDRESS,
   *   swapDstToken: collateralAddress,
   *   swapSrcAmount: usdcAmount,
   *   swapCallData: swapQuote.encodedSwapData,
   *   selfCallData: rfqCalldata.data,
   * });
   *
   * await walletClient.sendTransaction({ to, data });
   * ```
   */
  encodeSwapAndCall(params: SwapAndCallParams): { to: string; data: string; value?: bigint } {
    validateAddress(params.swapRouter, 'swapRouter');
    validateAddress(params.swapSrcToken, 'swapSrcToken');
    validateAddress(params.swapDstToken, 'swapDstToken');

    const iface = new Interface(OPTION_FACTORY_ABI);
    const data = iface.encodeFunctionData('swapAndCall', [
      params.swapRouter,
      params.swapSrcToken,
      params.swapDstToken,
      params.swapSrcAmount,
      params.swapCallData,
      params.selfCallData,
    ]);

    const result: { to: string; data: string; value?: bigint } = {
      to: this.contractAddress,
      data,
    };

    if (params.value !== undefined) {
      result.value = params.value;
    }

    return result;
  }

  // ============ Call Static Methods (transaction simulation) ============

  /**
   * Simulate creating an RFQ without submitting the transaction.
   * Returns the next RFQ ID that would be assigned.
   *
   * This uses ethers.js v6 staticCall to simulate the transaction
   * and get the return value without spending gas.
   *
   * @param request - RFQ request data
   * @returns CallStaticResult with the next RFQ ID (bigint)
   *
   * @example
   * ```typescript
   * const result = await client.optionFactory.callStaticCreateRFQ(request);
   * if (result.success) {
   *   console.log('Next RFQ ID will be:', result.returnValue);
   *   // Now submit the actual transaction
   *   const receipt = await client.optionFactory.requestForQuotation(request);
   * }
   * ```
   */
  async callStaticCreateRFQ(request: RFQRequest): Promise<CallStaticResult<bigint>> {
    validateAddress(request.params.requester, 'requester');
    validateAddress(request.params.collateral, 'collateral');
    this.assertImplementationDeployed(request.params.implementation, 'callStaticCreateRFQ');

    if (request.params.strikes.length === 0) {
      return {
        success: false,
        error: createError('INVALID_PARAMS', 'At least one strike price is required'),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }

    this.client.logger.debug('Simulating createRFQ (callStatic)', {
      requester: request.params.requester,
      collateral: request.params.collateral,
    });

    try {
      const signer = this.client.requireSigner();
      const contract = new Contract(this.contractAddress, OPTION_FACTORY_ABI, signer);

      // Use staticCall to simulate and get the return value (RFQ ID)
      const rfqId = await contract.getFunction('requestForQuotation').staticCall(
        request.params,
        request.tracking,
        request.reservePrice,
        request.requesterPublicKey
      ) as bigint;

      // Estimate gas for the transaction
      const gasEstimate = await contract.getFunction('requestForQuotation').estimateGas(
        request.params,
        request.tracking,
        request.reservePrice,
        request.requesterPublicKey
      );

      this.client.logger.info('callStaticCreateRFQ succeeded', {
        rfqId: rfqId.toString(),
        gasEstimate: gasEstimate.toString(),
      });

      return {
        success: true,
        returnValue: rfqId,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticCreateRFQ failed - transaction would revert', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  /**
   * Simulate making an offer without submitting the transaction.
   *
   * @param params - Offer parameters
   * @returns CallStaticResult indicating if the transaction would succeed
   */
  async callStaticMakeOffer(params: MakeOfferParams): Promise<CallStaticResult<void>> {
    this.client.logger.debug('Simulating makeOffer (callStatic)', {
      quotationId: params.quotationId.toString(),
    });

    try {
      const signer = this.client.requireSigner();
      const contract = new Contract(this.contractAddress, OPTION_FACTORY_ABI, signer);

      await contract.getFunction('makeOfferForQuotation').staticCall(
        params.quotationId,
        params.signature,
        params.signingKey,
        params.encryptedOffer
      );

      const gasEstimate = await contract.getFunction('makeOfferForQuotation').estimateGas(
        params.quotationId,
        params.signature,
        params.signingKey,
        params.encryptedOffer
      );

      return {
        success: true,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticMakeOffer failed', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  /**
   * Simulate revealing an offer without submitting the transaction.
   *
   * @param params - Reveal parameters
   * @returns CallStaticResult indicating if the transaction would succeed
   */
  async callStaticRevealOffer(params: RevealOfferParams): Promise<CallStaticResult<void>> {
    validateAddress(params.offeror, 'offeror');

    this.client.logger.debug('Simulating revealOffer (callStatic)', {
      quotationId: params.quotationId.toString(),
    });

    try {
      const signer = this.client.requireSigner();
      const contract = new Contract(this.contractAddress, OPTION_FACTORY_ABI, signer);

      await contract.getFunction('revealOffer').staticCall(
        params.quotationId,
        params.offerAmount,
        params.nonce,
        params.offeror
      );

      const gasEstimate = await contract.getFunction('revealOffer').estimateGas(
        params.quotationId,
        params.offerAmount,
        params.nonce,
        params.offeror
      );

      return {
        success: true,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticRevealOffer failed', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  /**
   * Simulate settling a quotation without submitting the transaction.
   * Returns the option address that would be created.
   *
   * @param quotationId - Quotation ID to settle
   * @returns CallStaticResult with the option address (string)
   */
  async callStaticSettleQuotation(quotationId: bigint): Promise<CallStaticResult<string>> {
    this.client.logger.debug('Simulating settleQuotation (callStatic)', {
      quotationId: quotationId.toString(),
    });

    try {
      const signer = this.client.requireSigner();
      const contract = new Contract(this.contractAddress, OPTION_FACTORY_ABI, signer);

      const optionAddress = await contract.getFunction('settleQuotation').staticCall(quotationId) as string;

      const gasEstimate = await contract.getFunction('settleQuotation').estimateGas(quotationId);

      return {
        success: true,
        returnValue: optionAddress,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticSettleQuotation failed', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  // ============ High-Level Builder Methods ============

  /**
   * Build RFQ parameters from high-level, human-readable inputs.
   *
   * This method simplifies RFQ creation by:
   * 1. **Enforcing collateralAmount = 0** (impossible to pass wrong value)
   * 2. Automatically resolving addresses from chain config
   * 3. Handling decimal conversions correctly
   * 4. Using human-readable strike and contract amounts
   *
   * **IMPORTANT**: For SELL positions (isLong = false), you must separately
   * approve the collateral token for the OptionFactory contract.
   * - CALL (inverse): approval = numContracts (1:1 with underlying)
   * - PUT: approval = strike * numContracts / 10^8
   *
   * @param params - High-level RFQ builder parameters
   * @returns QuotationParameters ready to use with encodeRequestForQuotation()
   *
   * @example
   * ```typescript
   * // Build params for an ETH PUT option
   * const quotationParams = client.optionFactory.buildRFQParams({
   *   requester: userAddress,
   *   underlying: 'ETH',
   *   optionType: 'PUT',
   *   strike: 1850,           // $1,850 strike
   *   expiry: 1735689600,     // Option expiry
   *   numContracts: 1.5,      // 1.5 contracts
   *   isLong: true,           // BUY position
   *   offerDeadlineMinutes: 60,
   *   collateralToken: 'USDC',
   * });
   *
   * // Use with encodeRequestForQuotation
   * const { to, data } = client.optionFactory.encodeRequestForQuotation({
   *   params: quotationParams,
   *   tracking: { referralId: BigInt(0), eventCode: BigInt(0) },
   *   reservePrice: BigInt(0),
   *   requesterPublicKey: keypair.compressedPublicKey,
   * });
   * ```
   */
  buildRFQParams(params: RFQBuilderParams): QuotationParameters {
    this.ensureAvailable();
    validateAddress(params.requester, 'requester');

    const chainConfig = this.client.chainConfig;

    // Get token config for collateral
    const tokenConfig = chainConfig.tokens[params.collateralToken];
    if (!tokenConfig) {
      throw createError('INVALID_PARAMS', `Unknown collateral token: ${params.collateralToken}`);
    }

    // Get price feed for underlying
    const priceFeed = chainConfig.priceFeeds[params.underlying];
    if (!priceFeed) {
      throw createError('INVALID_PARAMS', `Unknown underlying: ${params.underlying}`);
    }

    // Normalize strikes to array (handle both new 'strikes' and deprecated 'strike')
    let strikesInput: number[];
    if (params.strikes !== undefined) {
      strikesInput = Array.isArray(params.strikes) ? params.strikes : [params.strikes];
    } else if (params.strike !== undefined) {
      // Backward compatibility with deprecated 'strike' field
      strikesInput = [params.strike];
    } else {
      throw createError('INVALID_PARAMS', 'Either strikes or strike must be provided');
    }

    // Validate strike count (1-4)
    if (strikesInput.length === 0 || strikesInput.length > 4) {
      throw createError(
        'INVALID_PARAMS',
        `Strikes must have 1-4 values (got ${strikesInput.length}). ` +
        '1=vanilla, 2=spread, 3=butterfly, 4=condor'
      );
    }

    // Validate iron condor requires exactly 4 strikes
    if (params.isIronCondor && strikesInput.length !== 4) {
      throw createError(
        'INVALID_PARAMS',
        `Iron condor requires exactly 4 strikes (got ${strikesInput.length})`
      );
    }

    // Validate all strikes are positive
    if (strikesInput.some(s => s <= 0)) {
      throw createError('INVALID_PARAMS', 'All strike prices must be positive');
    }

    // Iron condor invariant (engagement spec): strikes must already be strictly
    // ascending. Auto-sorting for iron condor hides caller bugs and can cross
    // leg legs (PUT_LO < PUT_HI < CALL_LO < CALL_HI) — TNU-AUDIT-0042.
    if (params.isIronCondor) {
      for (let i = 1; i < strikesInput.length; i++) {
        if (strikesInput[i]! <= strikesInput[i - 1]!) {
          throw createError(
            'INVALID_PARAMS',
            'Iron condor strikes must be in ascending order: strike1 < strike2 < strike3 < strike4'
          );
        }
      }
    }

    // Sort strikes based on option type AND strike count
    // Vanilla (1 strike): No sorting needed
    // CALL_SPREAD (2 strikes): ASCENDING
    // PUT_SPREAD (2 strikes): DESCENDING
    // CALL_FLY (3 strikes): ASCENDING
    // PUT_FLY (3 strikes): DESCENDING
    // CALL_CONDOR (4 strikes): ASCENDING
    // PUT_CONDOR (4 strikes): ASCENDING (different from spread/fly!)
    const isCall = params.optionType === 'CALL';
    const isCondor = strikesInput.length === 4;
    // Condors always use ascending order regardless of PUT/CALL
    // Spreads and butterflies use descending for PUT, ascending for CALL
    const useAscending = isCall || isCondor;
    const sortedStrikes = [...strikesInput].sort((a, b) => useAscending ? a - b : b - a);

    // Convert strikes to on-chain format (8 decimals) using precision-safe method
    const strikesOnChain = sortedStrikes.map(s => this.client.utils.strikeToChain(s));

    // Get implementation based on option type, strike count, and isIronCondor
    const implementation = this.getImplementationForStructure(
      params.optionType,
      strikesOnChain.length,
      params.isIronCondor ?? false
    );

    // Convert numContracts to on-chain format (collateral token decimals)
    // Supports number (human-readable), bigint (on-chain), or string input
    const numContractsOnChain = this.toNumContractsOnChain(
      params.numContracts,
      tokenConfig.decimals
    );

    // Calculate timestamps
    const now = Math.floor(Date.now() / 1000);
    const offerEndTimestamp = BigInt(now + params.offerDeadlineMinutes * 60);
    const expiryTimestamp = BigInt(params.expiry);

    // Validate expiry > offer deadline
    if (expiryTimestamp <= offerEndTimestamp) {
      throw createError(
        'INVALID_PARAMS',
        'Option expiry must be after offer deadline. Choose a shorter deadline or later expiry.'
      );
    }

    // Use existingOptionAddress if provided, otherwise default to zero address
    const existingOptionAddress = params.existingOptionAddress ?? '0x0000000000000000000000000000000000000000';

    return {
      requester: params.requester,
      existingOptionAddress,
      collateral: tokenConfig.address,
      collateralPriceFeed: priceFeed,
      implementation,
      strikes: strikesOnChain,
      numContracts: numContractsOnChain,
      requesterDeposit: BigInt(0),
      collateralAmount: BigInt(0),  // ALWAYS 0 - enforced by this helper
      expiryTimestamp,
      offerEndTimestamp,
      isRequestingLongPosition: params.isLong,
      convertToLimitOrder: false,
      extraOptionData: '0x',
    };
  }

  /**
   * Get the correct implementation contract address based on option type and strike count.
   *
   * @param optionType - CALL or PUT
   * @param strikeCount - Number of strikes (1-4)
   * @param chainConfig - Chain configuration
   * @param isIronCondor - Whether this is an iron condor (requires 4 strikes)
   * @returns Implementation contract address
   */
  private getImplementationForStructure(
    optionType: 'CALL' | 'PUT',
    strikeCount: number,
    isIronCondor: boolean = false
  ): string {
    const isCall = optionType === 'CALL';

    switch (strikeCount) {
      case 1:
        // Vanilla option
        return this.getImplementationAddress(isCall ? 'INVERSE_CALL' : 'PUT');

      case 2:
        // Spread
        return this.getImplementationAddress(isCall ? 'CALL_SPREAD' : 'PUT_SPREAD');

      case 3:
        // Butterfly - uses butterfly (FLY) implementation
        return this.getImplementationAddress(isCall ? 'CALL_FLY' : 'PUT_FLY');

      case 4:
        // Condor - uses condor implementation
        // Iron condor uses a different implementation (put spread + call spread)
        if (isIronCondor) {
          return this.getImplementationAddress('IRON_CONDOR');
        }
        return this.getImplementationAddress(isCall ? 'CALL_CONDOR' : 'PUT_CONDOR');

      default:
        throw createError(
          'INVALID_PARAMS',
          `Invalid strike count: ${strikeCount}. Must be 1-4.`
        );
    }
  }

  /**
   * Build a complete RFQRequest from high-level parameters.
   *
   * This is a convenience method that builds both QuotationParameters
   * and QuotationTracking, returning a complete RFQRequest.
   *
   * @param params - High-level RFQ builder parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
   *
   * @example
   * ```typescript
   * const request = client.optionFactory.buildRFQRequest({
   *   requester: userAddress,
   *   underlying: 'ETH',
   *   optionType: 'PUT',
   *   strike: 1850,
   *   expiry: 1735689600,
   *   numContracts: 1.5,
   *   isLong: true,
   *   offerDeadlineMinutes: 60,
   *   collateralToken: 'USDC',
   *   requesterPublicKey: keypair.compressedPublicKey,
   * });
   *
   * const { to, data } = client.optionFactory.encodeRequestForQuotation(request);
   * ```
   */
  buildRFQRequest(params: RFQBuilderParams): RFQRequest {
    const quotationParams = this.buildRFQParams(params);

    // Calculate reserve price if provided
    let reservePrice = BigInt(0);
    if (params.reservePrice !== undefined && params.reservePrice > 0) {
      const tokenConfig = this.client.chainConfig.tokens[params.collateralToken];
      if (!tokenConfig) {
        throw createError('INVALID_PARAMS', `Unknown collateral token: ${params.collateralToken}`);
      }
      // Reserve price is total premium in collateral decimals
      // = reservePricePerContract * numContracts
      // Uses calculateReservePrice to handle both number and BigInt numContracts
      reservePrice = this.calculateReservePrice(
        params.reservePrice,
        params.numContracts,
        tokenConfig.decimals
      );
    }

    return {
      params: quotationParams,
      tracking: {
        referralId: params.referralId ?? BigInt(0),
        eventCode: params.eventCode ?? BigInt(0),
      },
      reservePrice,
      requesterPublicKey: params.requesterPublicKey ?? '',
    };
  }

  /**
   * Build a spread RFQ request using explicit lower/upper strike parameters.
   *
   * This is a convenience method for creating spread option RFQs.
   * Strikes are automatically sorted ascending.
   *
   * @param params - Spread-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
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
   *   requesterPublicKey: keypair.compressedPublicKey,
   * });
   * ```
   */
  buildSpreadRFQ(params: SpreadRFQParams): RFQRequest {
    return this.buildRFQRequest({
      ...params,
      strikes: [params.lowerStrike, params.upperStrike],
    });
  }

  /**
   * Build a butterfly RFQ request using explicit lower/middle/upper strike parameters.
   *
   * This is a convenience method for creating butterfly option RFQs.
   * Strikes are automatically sorted ascending.
   *
   * @param params - Butterfly-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
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
   *   requesterPublicKey: keypair.compressedPublicKey,
   * });
   * ```
   */
  buildButterflyRFQ(params: ButterflyRFQParams): RFQRequest {
    return this.buildRFQRequest({
      ...params,
      strikes: [params.lowerStrike, params.middleStrike, params.upperStrike],
    });
  }

  /**
   * Build a condor RFQ request using explicit strike1/2/3/4 parameters.
   *
   * This is a convenience method for creating condor option RFQs.
   * Strikes are automatically sorted ascending.
   *
   * @param params - Condor-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
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
   *   requesterPublicKey: keypair.compressedPublicKey,
   * });
   * ```
   */
  buildCondorRFQ(params: CondorRFQParams): RFQRequest {
    return this.buildRFQRequest({
      ...params,
      strikes: [params.strike1, params.strike2, params.strike3, params.strike4],
    });
  }

  /**
   * Build an iron condor RFQ request using explicit strike1/2/3/4 parameters.
   *
   * An iron condor combines a put spread (lower strikes) with a call spread (upper strikes).
   * This uses the IRON_CONDOR implementation contract.
   *
   * Strikes are automatically sorted ascending.
   *
   * @param params - Iron condor-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
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
   *   requesterPublicKey: keypair.compressedPublicKey,
   * });
   * ```
   */
  buildIronCondorRFQ(params: IronCondorRFQParams): RFQRequest {
    return this.buildRFQRequest({
      ...params,
      optionType: 'PUT', // Iron condor uses PUT as base but IRON_CONDOR implementation
      strikes: [params.strike1, params.strike2, params.strike3, params.strike4],
      isIronCondor: true,
    });
  }

  /**
   * Build an RFQ request for a physically settled option.
   *
   * Physically settled options involve actual delivery of the underlying asset
   * at settlement, rather than cash settlement of the difference.
   *
   * **Collateral Rules:**
   * - PHYSICAL_CALL: requires BASE collateral (WETH for ETH, cbBTC for BTC)
   * - PHYSICAL_PUT: requires QUOTE collateral (USDC)
   *
   * **Delivery Token Rules:**
   * - PHYSICAL_CALL: delivery token should be USDC (buyer pays strike in USDC)
   * - PHYSICAL_PUT: delivery token should be underlying (WETH for ETH, cbBTC for BTC)
   *
   * The delivery token is ABI-encoded into `extraOptionsData`.
   *
   * @param params - Physical option RFQ parameters
   * @returns Complete RFQRequest with encoded extraOptionsData
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
   *   deliveryToken: client.chainConfig.tokens.USDC.address,
   *   collateralToken: 'WETH',
   *   offerDeadlineMinutes: 6,
   *   requesterPublicKey: keyPair.compressedPublicKey,
   * });
   * ```
   */
  buildPhysicalOptionRFQ(params: PhysicalOptionRFQParams): RFQRequest {
    this.ensureAvailable();
    const { optionType, underlying, deliveryToken, collateralToken } = params;

    // 1. Validate option type
    if (optionType !== 'CALL' && optionType !== 'PUT') {
      throw createError('INVALID_PARAMS', 'optionType must be CALL or PUT');
    }

    // 2. Validate delivery token
    if (!deliveryToken) {
      throw createError(
        'INVALID_PARAMS',
        'deliveryToken is required for physical options. ' +
        'Use USDC for calls, underlying token (WETH/cbBTC) for puts.'
      );
    }
    validateAddress(deliveryToken, 'deliveryToken');

    // 3. Select implementation
    const implKey = optionType === 'CALL' ? 'PHYSICAL_CALL' : 'PHYSICAL_PUT';
    const implementation = this.getImplementationAddress(implKey);

    // 4. Validate/infer collateral token
    const inferredCollateral = this.inferPhysicalCollateral(optionType, underlying);
    const finalCollateral = collateralToken || inferredCollateral;
    this.validatePhysicalCollateral(optionType, finalCollateral, underlying);

    // 5. Encode delivery token into extraOptionsData
    const extraOptionData = this.encodeDeliveryToken(deliveryToken);

    // 6. Get token config and price feed
    const tokenConfig = this.client.chainConfig.tokens[finalCollateral];
    if (!tokenConfig) {
      throw createError('INVALID_PARAMS', `Unknown collateral token: ${finalCollateral}`);
    }

    const priceFeed = this.client.chainConfig.priceFeeds[underlying];
    if (!priceFeed) {
      throw createError('INVALID_PARAMS', `No price feed found for underlying: ${underlying}`);
    }

    // 7. Convert strike to on-chain format (8 decimals) using precision-safe method
    const strikeOnChain = this.client.utils.strikeToChain(params.strike);

    // 8. Convert numContracts to on-chain format
    // Supports number (human-readable), bigint (on-chain), or string input
    const numContractsOnChain = this.toNumContractsOnChain(
      params.numContracts,
      tokenConfig.decimals
    );

    // 9. Calculate timestamps
    const now = Math.floor(Date.now() / 1000);
    const offerDeadlineMinutes = params.offerDeadlineMinutes ?? 6;
    const offerEndTimestamp = BigInt(now + offerDeadlineMinutes * 60);
    const expiryTimestamp = BigInt(params.expiry);

    // Validate expiry > offer deadline
    if (expiryTimestamp <= offerEndTimestamp) {
      throw createError(
        'INVALID_PARAMS',
        'Option expiry must be after offer deadline. Choose a shorter deadline or later expiry.'
      );
    }

    // 10. Calculate reserve price if provided
    let reservePrice = BigInt(0);
    if (params.reservePrice !== undefined && params.reservePrice > 0) {
      reservePrice = this.calculateReservePrice(
        params.reservePrice,
        params.numContracts,
        tokenConfig.decimals
      );
    }

    // Use existingOptionAddress if provided, otherwise default to zero address
    const existingOptionAddress = params.existingOptionAddress ?? '0x0000000000000000000000000000000000000000';

    // 11. Build and return RFQRequest
    return {
      params: {
        requester: params.requester,
        existingOptionAddress,
        collateral: tokenConfig.address,
        collateralPriceFeed: priceFeed,
        implementation,
        strikes: [strikeOnChain],
        numContracts: numContractsOnChain,
        requesterDeposit: BigInt(0),
        collateralAmount: BigInt(0),
        expiryTimestamp,
        offerEndTimestamp,
        isRequestingLongPosition: params.isLong,
        convertToLimitOrder: false,
        extraOptionData,
      },
      tracking: {
        referralId: params.referralId ?? BigInt(0),
        eventCode: params.eventCode ?? BigInt(0),
      },
      reservePrice,
      requesterPublicKey: params.requesterPublicKey,
    };
  }

  /**
   * Encode delivery token address for extraOptionsData.
   *
   * @param deliveryToken - Delivery token address
   * @returns ABI-encoded address as hex string
   */
  private encodeDeliveryToken(deliveryToken: string): string {
    return AbiCoder.defaultAbiCoder().encode(['address'], [deliveryToken]);
  }

  /**
   * Infer the correct collateral token for a physical option.
   *
   * @param optionType - CALL or PUT
   * @param underlying - ETH or BTC
   * @returns Inferred collateral token
   */
  private inferPhysicalCollateral(
    optionType: 'CALL' | 'PUT',
    underlying: RFQUnderlying
  ): RFQCollateralToken {
    if (optionType === 'PUT') {
      return 'USDC';
    }
    // CALL requires underlying as collateral
    const underlyingToCollateral: Partial<Record<RFQUnderlying, RFQCollateralToken>> = {
      ETH: 'WETH',
      BTC: 'cbBTC',
    };
    const collateral = underlyingToCollateral[underlying];
    if (!collateral) {
      throw createError(
        'INVALID_PARAMS',
        `Physical CALL not supported for underlying: ${underlying}. Provide collateralToken explicitly.`
      );
    }
    return collateral;
  }

  /**
   * Validate that the collateral token matches the physical option type.
   *
   * @param optionType - CALL or PUT
   * @param collateral - Collateral token
   * @param underlying - ETH or BTC
   * @throws Error if collateral doesn't match requirements
   */
  private validatePhysicalCollateral(
    optionType: 'CALL' | 'PUT',
    collateral: string,
    underlying: RFQUnderlying
  ): void {
    if (optionType === 'CALL') {
      const underlyingToCollateral: Partial<Record<RFQUnderlying, string>> = {
        ETH: 'WETH',
        BTC: 'cbBTC',
      };
      const expected = underlyingToCollateral[underlying];
      if (expected && collateral !== expected) {
        throw createError(
          'INVALID_PARAMS',
          `PHYSICAL_CALL requires ${expected} collateral for ${underlying} underlying. Got: ${collateral}`
        );
      }
    } else {
      if (collateral !== 'USDC') {
        throw createError(
          'INVALID_PARAMS',
          `PHYSICAL_PUT requires USDC collateral. Got: ${collateral}`
        );
      }
    }
  }

  /**
   * Get the correct physical implementation contract address based on option type and strike count.
   *
   * @param optionType - CALL or PUT
   * @param strikeCount - Number of strikes (1-4)
   * @param isIronCondor - Whether this is an iron condor (requires 4 strikes)
   * @returns Implementation contract address
   * @throws Error if implementation not found or is zero address
   */
  private getPhysicalImplementationForStructure(
    optionType: 'CALL' | 'PUT',
    strikeCount: number,
    isIronCondor: boolean = false
  ): string {
    const chainConfig = this.client.chainConfig;
    const isCall = optionType === 'CALL';
    let implementation: string | undefined;
    let implName: string;

    switch (strikeCount) {
      case 1:
        // Vanilla physical option
        implementation = isCall
          ? chainConfig.implementations.PHYSICAL_CALL
          : chainConfig.implementations.PHYSICAL_PUT;
        implName = isCall ? 'PHYSICAL_CALL' : 'PHYSICAL_PUT';
        break;

      case 2:
        // Physical spread
        implementation = isCall
          ? chainConfig.implementations.PHYSICAL_CALL_SPREAD
          : chainConfig.implementations.PHYSICAL_PUT_SPREAD;
        implName = isCall ? 'PHYSICAL_CALL_SPREAD' : 'PHYSICAL_PUT_SPREAD';
        break;

      case 3:
        // Physical butterfly
        implementation = isCall
          ? chainConfig.implementations.PHYSICAL_CALL_FLY
          : chainConfig.implementations.PHYSICAL_PUT_FLY;
        implName = isCall ? 'PHYSICAL_CALL_FLY' : 'PHYSICAL_PUT_FLY';
        break;

      case 4:
        // Physical condor or iron condor
        if (isIronCondor) {
          implementation = chainConfig.implementations.PHYSICAL_IRON_CONDOR;
          implName = 'PHYSICAL_IRON_CONDOR';
        } else {
          implementation = isCall
            ? chainConfig.implementations.PHYSICAL_CALL_CONDOR
            : chainConfig.implementations.PHYSICAL_PUT_CONDOR;
          implName = isCall ? 'PHYSICAL_CALL_CONDOR' : 'PHYSICAL_PUT_CONDOR';
        }
        break;

      default:
        throw createError(
          'INVALID_PARAMS',
          `Invalid strike count for physical option: ${strikeCount}. Must be 1-4.`
        );
    }

    // Validate implementation is not zero address
    if (!implementation || implementation === '0x0000000000000000000000000000000000000000') {
      throw createError(
        'INVALID_PARAMS',
        `${implName} implementation not found or is zero address. ` +
        `Physical multi-leg contracts may not yet be deployed on this chain.`
      );
    }

    return implementation;
  }

  /**
   * Guard against passing a zero-address implementation to the on-chain RFQ.
   *
   * The seven physical multi-leg implementations (PHYSICAL_*_SPREAD/FLY/CONDOR/
   * IRON_CONDOR) are stored as 0x000…000 in the chain registry until the
   * contracts deploy. Without this guard, raw callers using
   * `requestForQuotation` / `encodeRequestForQuotation` who pass
   * `chainConfig.implementations.PHYSICAL_*` directly would otherwise produce
   * calldata or send a transaction targeting the zero address — leading to a
   * cryptic on-chain revert with no SDK-level explanation.
   */
  private assertImplementationDeployed(impl: string, where: string): void {
    if (!impl || impl === '0x0000000000000000000000000000000000000000') {
      throw createError(
        'INVALID_PARAMS',
        `${where}: implementation 0x000…000 — physical multi-leg contracts not yet deployed in r12. ` +
        `If this is unexpected, check chainConfig.implementations for your option type.`,
      );
    }
  }

  /**
   * Build a physical spread RFQ request using explicit lower/upper strike parameters.
   *
   * A physical spread involves 2 strikes with actual asset delivery at settlement.
   *
   * @param params - Physical spread-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
   *
   * @example
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
   *   deliveryToken: client.chainConfig.tokens.WETH.address,
   *   collateralToken: 'USDC',
   *   requesterPublicKey: keyPair.compressedPublicKey,
   * });
   * ```
   */
  buildPhysicalSpreadRFQ(params: PhysicalSpreadRFQParams): RFQRequest {
    this.ensureAvailable();
    const { optionType, underlying, lowerStrike, upperStrike, deliveryToken, collateralToken } = params;

    // Validate delivery token
    if (!deliveryToken) {
      throw createError(
        'INVALID_PARAMS',
        'deliveryToken is required for physical options. ' +
        'Use USDC for calls, underlying token (WETH/cbBTC) for puts.'
      );
    }
    validateAddress(deliveryToken, 'deliveryToken');

    // Get implementation for 2-strike physical option
    const implementation = this.getPhysicalImplementationForStructure(optionType, 2, false);

    // Validate/infer collateral token
    const inferredCollateral = this.inferPhysicalCollateral(optionType, underlying);
    const finalCollateral = collateralToken || inferredCollateral;
    this.validatePhysicalCollateral(optionType, finalCollateral, underlying);

    // Encode delivery token into extraOptionData
    const extraOptionData = this.encodeDeliveryToken(deliveryToken);

    // Get token config and price feed
    const tokenConfig = this.client.chainConfig.tokens[finalCollateral];
    if (!tokenConfig) {
      throw createError('INVALID_PARAMS', `Unknown collateral token: ${finalCollateral}`);
    }

    const priceFeed = this.client.chainConfig.priceFeeds[underlying];
    if (!priceFeed) {
      throw createError('INVALID_PARAMS', `No price feed found for underlying: ${underlying}`);
    }

    // Sort strikes based on option type
    const isCall = optionType === 'CALL';
    const sortedStrikes = isCall
      ? [lowerStrike, upperStrike].sort((a, b) => a - b)  // Ascending for CALL
      : [lowerStrike, upperStrike].sort((a, b) => b - a); // Descending for PUT

    // Convert strikes to on-chain format (8 decimals) using precision-safe method
    const strikesOnChain = sortedStrikes.map(s => this.client.utils.strikeToChain(s));

    // Convert numContracts to on-chain format
    // Supports number (human-readable), bigint (on-chain), or string input
    const numContractsOnChain = this.toNumContractsOnChain(
      params.numContracts,
      tokenConfig.decimals
    );

    // Calculate timestamps
    const now = Math.floor(Date.now() / 1000);
    const offerDeadlineMinutes = params.offerDeadlineMinutes ?? 6;
    const offerEndTimestamp = BigInt(now + offerDeadlineMinutes * 60);
    const expiryTimestamp = BigInt(params.expiry);

    if (expiryTimestamp <= offerEndTimestamp) {
      throw createError(
        'INVALID_PARAMS',
        'Option expiry must be after offer deadline. Choose a shorter deadline or later expiry.'
      );
    }

    // Calculate reserve price
    let reservePrice = BigInt(0);
    if (params.reservePrice !== undefined && params.reservePrice > 0) {
      reservePrice = this.calculateReservePrice(
        params.reservePrice,
        params.numContracts,
        tokenConfig.decimals
      );
    }

    // Use existingOptionAddress if provided, otherwise default to zero address
    const existingOptionAddress = params.existingOptionAddress ?? '0x0000000000000000000000000000000000000000';

    return {
      params: {
        requester: params.requester,
        existingOptionAddress,
        collateral: tokenConfig.address,
        collateralPriceFeed: priceFeed,
        implementation,
        strikes: strikesOnChain,
        numContracts: numContractsOnChain,
        requesterDeposit: BigInt(0),
        collateralAmount: BigInt(0),
        expiryTimestamp,
        offerEndTimestamp,
        isRequestingLongPosition: params.isLong,
        convertToLimitOrder: false,
        extraOptionData,
      },
      tracking: {
        referralId: params.referralId ?? BigInt(0),
        eventCode: params.eventCode ?? BigInt(0),
      },
      reservePrice,
      requesterPublicKey: params.requesterPublicKey,
    };
  }

  /**
   * Build a physical butterfly RFQ request using explicit lower/middle/upper strike parameters.
   *
   * A physical butterfly involves 3 strikes with actual asset delivery at settlement.
   *
   * @param params - Physical butterfly-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
   *
   * @example
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
   *   deliveryToken: client.chainConfig.tokens.WETH.address,
   *   collateralToken: 'USDC',
   *   requesterPublicKey: keyPair.compressedPublicKey,
   * });
   * ```
   */
  buildPhysicalButterflyRFQ(params: PhysicalButterflyRFQParams): RFQRequest {
    this.ensureAvailable();
    const { optionType, underlying, lowerStrike, middleStrike, upperStrike, deliveryToken, collateralToken } = params;

    // Validate delivery token
    if (!deliveryToken) {
      throw createError(
        'INVALID_PARAMS',
        'deliveryToken is required for physical options. ' +
        'Use USDC for calls, underlying token (WETH/cbBTC) for puts.'
      );
    }
    validateAddress(deliveryToken, 'deliveryToken');

    // Get implementation for 3-strike physical option
    const implementation = this.getPhysicalImplementationForStructure(optionType, 3, false);

    // Validate/infer collateral token
    const inferredCollateral = this.inferPhysicalCollateral(optionType, underlying);
    const finalCollateral = collateralToken || inferredCollateral;
    this.validatePhysicalCollateral(optionType, finalCollateral, underlying);

    // Encode delivery token into extraOptionData
    const extraOptionData = this.encodeDeliveryToken(deliveryToken);

    // Get token config and price feed
    const tokenConfig = this.client.chainConfig.tokens[finalCollateral];
    if (!tokenConfig) {
      throw createError('INVALID_PARAMS', `Unknown collateral token: ${finalCollateral}`);
    }

    const priceFeed = this.client.chainConfig.priceFeeds[underlying];
    if (!priceFeed) {
      throw createError('INVALID_PARAMS', `No price feed found for underlying: ${underlying}`);
    }

    // Sort strikes based on option type
    const isCall = optionType === 'CALL';
    const strikes = [lowerStrike, middleStrike, upperStrike];
    const sortedStrikes = isCall
      ? [...strikes].sort((a, b) => a - b)  // Ascending for CALL
      : [...strikes].sort((a, b) => b - a); // Descending for PUT

    // Convert strikes to on-chain format (8 decimals) using precision-safe method
    const strikesOnChain = sortedStrikes.map(s => this.client.utils.strikeToChain(s));

    // Convert numContracts to on-chain format
    // Supports number (human-readable), bigint (on-chain), or string input
    const numContractsOnChain = this.toNumContractsOnChain(
      params.numContracts,
      tokenConfig.decimals
    );

    // Calculate timestamps
    const now = Math.floor(Date.now() / 1000);
    const offerDeadlineMinutes = params.offerDeadlineMinutes ?? 6;
    const offerEndTimestamp = BigInt(now + offerDeadlineMinutes * 60);
    const expiryTimestamp = BigInt(params.expiry);

    if (expiryTimestamp <= offerEndTimestamp) {
      throw createError(
        'INVALID_PARAMS',
        'Option expiry must be after offer deadline. Choose a shorter deadline or later expiry.'
      );
    }

    // Calculate reserve price
    let reservePrice = BigInt(0);
    if (params.reservePrice !== undefined && params.reservePrice > 0) {
      reservePrice = this.calculateReservePrice(
        params.reservePrice,
        params.numContracts,
        tokenConfig.decimals
      );
    }

    // Use existingOptionAddress if provided, otherwise default to zero address
    const existingOptionAddress = params.existingOptionAddress ?? '0x0000000000000000000000000000000000000000';

    return {
      params: {
        requester: params.requester,
        existingOptionAddress,
        collateral: tokenConfig.address,
        collateralPriceFeed: priceFeed,
        implementation,
        strikes: strikesOnChain,
        numContracts: numContractsOnChain,
        requesterDeposit: BigInt(0),
        collateralAmount: BigInt(0),
        expiryTimestamp,
        offerEndTimestamp,
        isRequestingLongPosition: params.isLong,
        convertToLimitOrder: false,
        extraOptionData,
      },
      tracking: {
        referralId: params.referralId ?? BigInt(0),
        eventCode: params.eventCode ?? BigInt(0),
      },
      reservePrice,
      requesterPublicKey: params.requesterPublicKey,
    };
  }

  /**
   * Build a physical condor RFQ request using explicit strike1/2/3/4 parameters.
   *
   * A physical condor involves 4 strikes with actual asset delivery at settlement.
   *
   * @param params - Physical condor-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
   *
   * @example
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
   *   deliveryToken: client.chainConfig.tokens.WETH.address,
   *   collateralToken: 'USDC',
   *   requesterPublicKey: keyPair.compressedPublicKey,
   * });
   * ```
   */
  buildPhysicalCondorRFQ(params: PhysicalCondorRFQParams): RFQRequest {
    this.ensureAvailable();
    const { optionType, underlying, strike1, strike2, strike3, strike4, deliveryToken, collateralToken } = params;

    // Validate delivery token
    if (!deliveryToken) {
      throw createError(
        'INVALID_PARAMS',
        'deliveryToken is required for physical options. ' +
        'Use USDC for calls, underlying token (WETH/cbBTC) for puts.'
      );
    }
    validateAddress(deliveryToken, 'deliveryToken');

    // Get implementation for 4-strike physical option (not iron condor)
    const implementation = this.getPhysicalImplementationForStructure(optionType, 4, false);

    // Validate/infer collateral token
    const inferredCollateral = this.inferPhysicalCollateral(optionType, underlying);
    const finalCollateral = collateralToken || inferredCollateral;
    this.validatePhysicalCollateral(optionType, finalCollateral, underlying);

    // Encode delivery token into extraOptionData
    const extraOptionData = this.encodeDeliveryToken(deliveryToken);

    // Get token config and price feed
    const tokenConfig = this.client.chainConfig.tokens[finalCollateral];
    if (!tokenConfig) {
      throw createError('INVALID_PARAMS', `Unknown collateral token: ${finalCollateral}`);
    }

    const priceFeed = this.client.chainConfig.priceFeeds[underlying];
    if (!priceFeed) {
      throw createError('INVALID_PARAMS', `No price feed found for underlying: ${underlying}`);
    }

    // Condors always use ascending strike order
    const strikes = [strike1, strike2, strike3, strike4];
    const sortedStrikes = [...strikes].sort((a, b) => a - b);

    // Convert strikes to on-chain format (8 decimals) using precision-safe method
    const strikesOnChain = sortedStrikes.map(s => this.client.utils.strikeToChain(s));

    // Convert numContracts to on-chain format
    // Supports number (human-readable), bigint (on-chain), or string input
    const numContractsOnChain = this.toNumContractsOnChain(
      params.numContracts,
      tokenConfig.decimals
    );

    // Calculate timestamps
    const now = Math.floor(Date.now() / 1000);
    const offerDeadlineMinutes = params.offerDeadlineMinutes ?? 6;
    const offerEndTimestamp = BigInt(now + offerDeadlineMinutes * 60);
    const expiryTimestamp = BigInt(params.expiry);

    if (expiryTimestamp <= offerEndTimestamp) {
      throw createError(
        'INVALID_PARAMS',
        'Option expiry must be after offer deadline. Choose a shorter deadline or later expiry.'
      );
    }

    // Calculate reserve price
    let reservePrice = BigInt(0);
    if (params.reservePrice !== undefined && params.reservePrice > 0) {
      reservePrice = this.calculateReservePrice(
        params.reservePrice,
        params.numContracts,
        tokenConfig.decimals
      );
    }

    // Use existingOptionAddress if provided, otherwise default to zero address
    const existingOptionAddress = params.existingOptionAddress ?? '0x0000000000000000000000000000000000000000';

    return {
      params: {
        requester: params.requester,
        existingOptionAddress,
        collateral: tokenConfig.address,
        collateralPriceFeed: priceFeed,
        implementation,
        strikes: strikesOnChain,
        numContracts: numContractsOnChain,
        requesterDeposit: BigInt(0),
        collateralAmount: BigInt(0),
        expiryTimestamp,
        offerEndTimestamp,
        isRequestingLongPosition: params.isLong,
        convertToLimitOrder: false,
        extraOptionData,
      },
      tracking: {
        referralId: params.referralId ?? BigInt(0),
        eventCode: params.eventCode ?? BigInt(0),
      },
      reservePrice,
      requesterPublicKey: params.requesterPublicKey,
    };
  }

  /**
   * Build a physical iron condor RFQ request using explicit strike1/2/3/4 parameters.
   *
   * A physical iron condor combines a put spread (lower strikes) with a call spread (upper strikes),
   * with actual asset delivery at settlement.
   *
   * @param params - Physical iron condor-specific RFQ parameters
   * @returns Complete RFQRequest ready for encodeRequestForQuotation()
   *
   * @example
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
   *   deliveryToken: client.chainConfig.tokens.WETH.address,
   *   collateralToken: 'USDC',
   *   requesterPublicKey: keyPair.compressedPublicKey,
   * });
   * ```
   */
  buildPhysicalIronCondorRFQ(params: PhysicalIronCondorRFQParams): RFQRequest {
    this.ensureAvailable();
    const { underlying, strike1, strike2, strike3, strike4, deliveryToken, collateralToken } = params;

    // Validate delivery token
    if (!deliveryToken) {
      throw createError(
        'INVALID_PARAMS',
        'deliveryToken is required for physical options. ' +
        'Use underlying token (WETH/cbBTC) for iron condors.'
      );
    }
    validateAddress(deliveryToken, 'deliveryToken');

    // Get implementation for physical iron condor (uses PUT as base type internally)
    const implementation = this.getPhysicalImplementationForStructure('PUT', 4, true);

    // Iron condors use USDC collateral
    const finalCollateral = collateralToken || 'USDC';
    if (finalCollateral !== 'USDC') {
      throw createError(
        'INVALID_PARAMS',
        `PHYSICAL_IRON_CONDOR requires USDC collateral. Got: ${finalCollateral}`
      );
    }

    // Encode delivery token into extraOptionData
    const extraOptionData = this.encodeDeliveryToken(deliveryToken);

    // Get token config and price feed
    const tokenConfig = this.client.chainConfig.tokens[finalCollateral];
    if (!tokenConfig) {
      throw createError('INVALID_PARAMS', `Unknown collateral token: ${finalCollateral}`);
    }

    const priceFeed = this.client.chainConfig.priceFeeds[underlying];
    if (!priceFeed) {
      throw createError('INVALID_PARAMS', `No price feed found for underlying: ${underlying}`);
    }

    // Iron condor invariant: callers must pass strikes already in strict
    // ascending order. Auto-sorting hides bugs where put/call legs were
    // crossed — TNU-AUDIT-0042.
    const strikes = [strike1, strike2, strike3, strike4];
    for (let i = 1; i < strikes.length; i++) {
      if (strikes[i]! <= strikes[i - 1]!) {
        throw createError(
          'INVALID_PARAMS',
          'Iron condor strikes must be in ascending order: strike1 < strike2 < strike3 < strike4'
        );
      }
    }
    if (strikes.some(s => s <= 0)) {
      throw createError('INVALID_PARAMS', 'All strike prices must be positive');
    }
    const sortedStrikes = strikes;

    // Convert strikes to on-chain format (8 decimals) using precision-safe method
    const strikesOnChain = sortedStrikes.map(s => this.client.utils.strikeToChain(s));

    // Convert numContracts to on-chain format
    // Supports number (human-readable), bigint (on-chain), or string input
    const numContractsOnChain = this.toNumContractsOnChain(
      params.numContracts,
      tokenConfig.decimals
    );

    // Calculate timestamps
    const now = Math.floor(Date.now() / 1000);
    const offerDeadlineMinutes = params.offerDeadlineMinutes ?? 6;
    const offerEndTimestamp = BigInt(now + offerDeadlineMinutes * 60);
    const expiryTimestamp = BigInt(params.expiry);

    if (expiryTimestamp <= offerEndTimestamp) {
      throw createError(
        'INVALID_PARAMS',
        'Option expiry must be after offer deadline. Choose a shorter deadline or later expiry.'
      );
    }

    // Calculate reserve price
    let reservePrice = BigInt(0);
    if (params.reservePrice !== undefined && params.reservePrice > 0) {
      reservePrice = this.calculateReservePrice(
        params.reservePrice,
        params.numContracts,
        tokenConfig.decimals
      );
    }

    // Use existingOptionAddress if provided, otherwise default to zero address
    const existingOptionAddress = params.existingOptionAddress ?? '0x0000000000000000000000000000000000000000';

    return {
      params: {
        requester: params.requester,
        existingOptionAddress,
        collateral: tokenConfig.address,
        collateralPriceFeed: priceFeed,
        implementation,
        strikes: strikesOnChain,
        numContracts: numContractsOnChain,
        requesterDeposit: BigInt(0),
        collateralAmount: BigInt(0),
        expiryTimestamp,
        offerEndTimestamp,
        isRequestingLongPosition: params.isLong,
        convertToLimitOrder: false,
        extraOptionData,
      },
      tracking: {
        referralId: params.referralId ?? BigInt(0),
        eventCode: params.eventCode ?? BigInt(0),
      },
      reservePrice,
      requesterPublicKey: params.requesterPublicKey,
    };
  }
}
