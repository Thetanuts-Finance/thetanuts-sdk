/**
 * Loan Module — Non-liquidatable lending via physically-settled call options (Loan)
 *
 * Borrowers deposit ETH/BTC collateral, receive USDC, and repay at expiry.
 * Uses the LoanCoordinator contract which wraps Thetanuts V4 RFQ auctions.
 *
 * @example
 * ```typescript
 * const client = new ThetanutsClient({ chainId: 8453, provider, signer });
 *
 * // Get available strikes
 * const groups = await client.loan.getStrikeOptions('ETH');
 *
 * // Calculate loan costs
 * const calc = client.loan.calculateLoan({
 *   depositAmount: '1.0',
 *   underlying: 'ETH',
 *   strike: 1600,
 *   expiryTimestamp: 1780041600,
 *   askPrice: 0.007,
 *   underlyingPrice: 2328,
 * });
 *
 * // Request a loan
 * const result = await client.loan.requestLoan({
 *   underlying: 'ETH',
 *   collateralAmount: '1.0',
 *   strike: 1600,
 *   expiryTimestamp: 1780041600,
 *   minSettlementAmount: calc.finalLoanAmount,
 * });
 * ```
 */

import { Contract, Interface, ethers } from 'ethers';
import type { TransactionReceipt, ContractTransactionResponse } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import {
  LOAN_COORDINATOR_ABI,
  LOAN_OPTION_ABI,
  LOAN_WETH_ABI,
} from '../abis/loan.js';
import { LOAN_CONFIG } from '../chains/loan.js';
import { mapContractError } from '../utils/errors.js';
import { zendfiErr } from '../types/zendfi-errors.js';
import { validateAddress } from '../utils/validation.js';
// Expiry helpers moved to `utils/expiry.ts` so both the put-leg (this module)
// and the call-leg collar module share one parser.
import {
  parseDeribitExpiryOrThrow as parseExpiryTimestamp,
  formatDeribitExpiry as formatExpiryDate,
} from '../utils/expiry.js';
import type {
  LoanUnderlying,
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
  DeribitPricingMap,
} from '../types/loan.js';

// ─── Typed Contract Interfaces ───

interface LoanRequestParams {
  collateralToken: string;
  priceFeed: string;
  settlementToken: string;
  collateralAmount: bigint;
  strike: bigint;
  expiryTimestamp: number;
  offerEndTimestamp: number;
  minSettlementAmount: bigint;
  requesterPublicKey: string;
}

interface LoanCoordinatorContract {
  requestLoan: {
    (params: LoanRequestParams): Promise<ContractTransactionResponse>;
    (params: LoanRequestParams, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(params: LoanRequestParams): Promise<bigint>;
  };
  settleQuotationEarly: {
    (quotationId: bigint, offerAmount: bigint, nonce: bigint, offeror: string): Promise<ContractTransactionResponse>;
    (quotationId: bigint, offerAmount: bigint, nonce: bigint, offeror: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(quotationId: bigint, offerAmount: bigint, nonce: bigint, offeror: string): Promise<bigint>;
  };
  cancelLoan: {
    (quotationId: bigint): Promise<ContractTransactionResponse>;
    (quotationId: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(quotationId: bigint): Promise<bigint>;
  };
  loanRequests(quotationId: bigint): Promise<{
    requester: string;
    collateralAmount: bigint;
    strike: bigint;
    expiryTimestamp: bigint;
    collateralToken: string;
    settlementToken: string;
    isSettled: boolean;
    settledOptionContract: string;
  }>;
}

interface OptionContract {
  exercise: {
    (): Promise<ContractTransactionResponse>;
    (overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(): Promise<bigint>;
  };
  doNotExercise: {
    (): Promise<ContractTransactionResponse>;
    (overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(): Promise<bigint>;
  };
  swapAndExercise: {
    (aggregator: string, swapData: string): Promise<ContractTransactionResponse>;
    (aggregator: string, swapData: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(aggregator: string, swapData: string): Promise<bigint>;
  };
  split: {
    (splitCollateralAmount: bigint, overrides: { value: bigint; gasLimit?: bigint }): Promise<ContractTransactionResponse>;
  };
  reclaimCollateral: {
    (ownedOption: string, overrides: { value: bigint; gasLimit?: bigint }): Promise<ContractTransactionResponse>;
  };
  buyer(): Promise<string>;
  seller(): Promise<string>;
  collateralToken(): Promise<string>;
  collateralAmount(): Promise<bigint>;
  expiryTimestamp(): Promise<bigint>;
  getStrikes(): Promise<bigint[]>;
  optionSettled(): Promise<boolean>;
  getTWAP(): Promise<bigint>;
  isITM(price: bigint): Promise<boolean>;
  calculateDeliveryAmount(): Promise<bigint>;
  EXERCISE_WINDOW(): Promise<bigint>;
  getSplitFee(): Promise<bigint>;
  getReclaimFee(ownedOption: string): Promise<bigint>;
}

interface WETHContract {
  deposit: {
    (overrides: { value: bigint }): Promise<ContractTransactionResponse>;
  };
}

// ─── Internal Helpers ───

function parseDeribitKey(key: string): { asset: string; expiry: string; strike: number; type: string } | null {
  const parts = key.split('-');
  if (parts.length !== 4) return null;
  const strike = parseInt(parts[2]!, 10);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { asset: parts[0]!, expiry: parts[1]!, strike, type: parts[3]! };
}

function getAssetConfig(underlying: LoanUnderlying) {
  return LOAN_CONFIG.assets[underlying];
}

function getPricingKey(underlying: LoanUnderlying): string {
  return underlying === 'ETH' ? 'ETH' : 'BTC';
}

export class LoanModule {
  private pricingCache: { data: DeribitPricingMap; fetchedAt: number } | null = null;
  private readonly PRICING_CACHE_TTL = 30_000;

  constructor(private readonly client: ThetanutsClient) {}

  // ─── Private Contract Accessors ───

  private getCoordinatorReadContract(): LoanCoordinatorContract {
    return new Contract(
      LOAN_CONFIG.contracts.loanCoordinator,
      LOAN_COORDINATOR_ABI,
      this.client.provider,
    ) as unknown as LoanCoordinatorContract;
  }

  private getCoordinatorWriteContract(): LoanCoordinatorContract {
    const signer = this.client.requireSigner();
    return new Contract(
      LOAN_CONFIG.contracts.loanCoordinator,
      LOAN_COORDINATOR_ABI,
      signer,
    ) as unknown as LoanCoordinatorContract;
  }

  private getOptionReadContract(optionAddress: string): OptionContract {
    return new Contract(optionAddress, LOAN_OPTION_ABI, this.client.provider) as unknown as OptionContract;
  }

  private getOptionWriteContract(optionAddress: string): OptionContract {
    const signer = this.client.requireSigner();
    return new Contract(optionAddress, LOAN_OPTION_ABI, signer) as unknown as OptionContract;
  }

  // ═══════════════════════════════════════════
  // Loan Operations
  // ═══════════════════════════════════════════

  /**
   * Request a loan by depositing collateral (ETH or BTC).
   * Automatically wraps native ETH to WETH if the user's WETH balance is insufficient.
   * Generates an ECDH keypair for encrypted offer delivery.
   *
   * @param params - Loan request parameters
   * @returns Transaction receipt, quotation ID, and ECDH keypair
   * @throws {SignerRequiredError} If no signer is attached
   * @throws {InsufficientBalanceError} If insufficient ETH/WETH/cbBTC balance
   * @example
   * ```typescript
   * const result = await client.loan.requestLoan({
   *   underlying: 'ETH',
   *   collateralAmount: '1.0',
   *   strike: 1600,
   *   expiryTimestamp: 1780041600,
   *   minSettlementAmount: 1422410000n,
   * });
   * console.log(`Loan ID: ${result.quotationId}`);
   * ```
   */
  async requestLoan(params: LoanRequest): Promise<LoanResult> {
    const signer = this.client.requireSigner();
    const asset = getAssetConfig(params.underlying);

    const collateralAmount = typeof params.collateralAmount === 'string'
      ? ethers.parseUnits(params.collateralAmount, asset.decimals)
      : params.collateralAmount;

    const keyPair = await this.client.rfqKeys.getOrCreateKeyPair();

    const offerDuration = params.offerDurationSeconds ?? LOAN_CONFIG.defaultOfferDurationSeconds;
    const offerEndTimestamp = Math.floor(Date.now() / 1000) + offerDuration;

    const strikeBN = ethers.parseUnits(params.strike.toString(), LOAN_CONFIG.strikeDecimals);

    // Auto-wrap ETH→WETH if needed
    if (params.underlying === 'ETH') {
      const wethBalance = await this.client.erc20.getBalance(asset.collateral);
      if (wethBalance < collateralAmount) {
        const wrapAmount = collateralAmount - wethBalance;
        this.client.logger.info('Wrapping native ETH to WETH', {
          wrapAmount: ethers.formatEther(wrapAmount),
        });
        const wethContract = new Contract(asset.collateral, LOAN_WETH_ABI, signer) as unknown as WETHContract;
        const wrapTx = await wethContract.deposit({ value: wrapAmount });
        await wrapTx.wait();
      }
    }

    await this.client.erc20.ensureAllowance(
      asset.collateral,
      LOAN_CONFIG.contracts.loanCoordinator,
      collateralAmount,
    );

    const contract = this.getCoordinatorWriteContract();

    try {
      const requestParams: LoanRequestParams = {
        collateralToken: asset.collateral,
        priceFeed: asset.priceFeed,
        settlementToken: LOAN_CONFIG.settlement,
        collateralAmount,
        strike: strikeBN,
        expiryTimestamp: params.expiryTimestamp,
        offerEndTimestamp,
        minSettlementAmount: params.minSettlementAmount,
        requesterPublicKey: keyPair.compressedPublicKey,
      };

      const gasEstimate = await contract.requestLoan.estimateGas(requestParams);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await contract.requestLoan(requestParams, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.requestLoan: no receipt');
      }

      // Parse LoanRequested event to extract quotationId
      const coordinatorIface = new Interface(LOAN_COORDINATOR_ABI);
      let quotationId = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = coordinatorIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed && parsed.name === 'LoanRequested') {
            quotationId = BigInt(parsed.args[0] as string);
            break;
          }
        } catch {
          // Not a LoanCoordinator event, skip
        }
      }

      this.client.logger.info('Loan requested successfully', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return { receipt, quotationId, keyPair };
    } catch (error) {
      this.client.logger.error('Failed to request loan', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Accept a market maker's offer for a pending loan request.
   * Calls LoanCoordinator.settleQuotationEarly().
   *
   * @param quotationId - The RFQ quotation ID
   * @param offerAmount - Decrypted offer amount (USDC, 6 decimals)
   * @param nonce - Offer nonce from decryption
   * @param offeror - Market maker's address
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   * @example
   * ```typescript
   * const decrypted = await client.rfqKeys.decryptOffer(encrypted, signingKey);
   * await client.loan.acceptOffer(953n, decrypted.offerAmount, decrypted.nonce, offerorAddr);
   * ```
   */
  async acceptOffer(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): Promise<TransactionReceipt> {
    validateAddress(offeror, 'offeror');
    const contract = this.getCoordinatorWriteContract();

    try {
      const gasEstimate = await contract.settleQuotationEarly.estimateGas(
        quotationId, offerAmount, nonce, offeror,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await contract.settleQuotationEarly(
        quotationId, offerAmount, nonce, offeror, { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.acceptOffer: no receipt');
      }

      this.client.logger.info('Offer accepted (early settlement)', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to accept offer', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Cancel a pending loan request.
   *
   * @param quotationId - The quotation ID to cancel
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   */
  async cancelLoan(quotationId: bigint): Promise<TransactionReceipt> {
    const contract = this.getCoordinatorWriteContract();

    try {
      const gasEstimate = await contract.cancelLoan.estimateGas(quotationId);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await contract.cancelLoan(quotationId, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.cancelLoan: no receipt');
      }

      this.client.logger.info('Loan cancelled', {
        txHash: receipt.hash,
        quotationId: quotationId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to cancel loan', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Exercise an option at expiry — repay USDC and reclaim collateral.
   * Must be called within the exercise window after expiry.
   *
   * @param optionAddress - The deployed option contract address
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   * @example
   * ```typescript
   * await client.loan.exerciseOption('0x1A1DCcb8...');
   * ```
   */
  async exerciseOption(optionAddress: string): Promise<TransactionReceipt> {
    validateAddress(optionAddress, 'optionAddress');
    const contract = this.getOptionWriteContract(optionAddress);

    try {
      const gasEstimate = await contract.exercise.estimateGas();
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await contract.exercise({ gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.exerciseOption: no receipt');
      }

      this.client.logger.info('Option exercised', { txHash: receipt.hash, optionAddress });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to exercise option', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Walk away from an option at expiry — keep borrowed USDC, forfeit collateral.
   *
   * @param optionAddress - The deployed option contract address
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   */
  async doNotExercise(optionAddress: string): Promise<TransactionReceipt> {
    validateAddress(optionAddress, 'optionAddress');
    const contract = this.getOptionWriteContract(optionAddress);

    try {
      const gasEstimate = await contract.doNotExercise.estimateGas();
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await contract.doNotExercise({ gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.doNotExercise: no receipt');
      }

      this.client.logger.info('Option not exercised (walked away)', { txHash: receipt.hash, optionAddress });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to call doNotExercise', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Swap collateral to USDC via DEX aggregator, then exercise.
   * Requires pre-computed swap data from a DEX aggregator (e.g., KyberSwap).
   *
   * @param optionAddress - The option contract address
   * @param aggregator - DEX aggregator router address
   * @param swapData - Encoded swap calldata
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   */
  async swapAndExercise(
    optionAddress: string,
    aggregator: string,
    swapData: string,
  ): Promise<TransactionReceipt> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(aggregator, 'aggregator');
    const contract = this.getOptionWriteContract(optionAddress);

    try {
      const gasEstimate = await contract.swapAndExercise.estimateGas(aggregator, swapData);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await contract.swapAndExercise(aggregator, swapData, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.swapAndExercise: no receipt');
      }

      this.client.logger.info('Swap and exercise completed', { txHash: receipt.hash, optionAddress });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to swap and exercise', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Split a loan option's collateral into a new child option.
   *
   * r12 split() is payable: this wrapper reads `getSplitFee()` immediately
   * before the call and forwards the result as `msg.value`. Mirrors
   * `OptionModule.split()` and `RangerModule.split()`.
   *
   * @param optionAddress - The loan option contract address
   * @param splitCollateralAmount - Amount of collateral to split off
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   * @throws {Error} If splitCollateralAmount is not positive
   */
  async splitOption(
    optionAddress: string,
    splitCollateralAmount: bigint,
  ): Promise<TransactionReceipt> {
    validateAddress(optionAddress, 'optionAddress');
    if (splitCollateralAmount <= 0n) {
      throw zendfiErr.invalidParam('splitCollateralAmount', 'must be positive');
    }

    try {
      const readContract = this.getOptionReadContract(optionAddress);
      const splitFee = await readContract.getSplitFee();

      const contract = this.getOptionWriteContract(optionAddress);
      const tx = await contract.split(splitCollateralAmount, { value: splitFee });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.splitOption: no receipt');
      }

      this.client.logger.info('Loan option split', {
        txHash: receipt.hash,
        optionAddress,
        splitFee: splitFee.toString(),
        splitCollateralAmount: splitCollateralAmount.toString(),
      });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to split loan option', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Reclaim collateral from a loan option after settlement.
   *
   * Note: `ownedOption` is the option being reclaimed FROM (the position the
   * caller owns), not a transfer destination. Reclaimed collateral always goes
   * to msg.sender. r12 reclaimCollateral() is payable — this wrapper reads
   * `getReclaimFee(ownedOption)` and forwards it as `msg.value`. Mirrors
   * `RangerModule.reclaimCollateral()`.
   *
   * @param optionAddress - The loan option contract to call (the routing contract).
   * @param ownedOption - The option whose collateral the caller is reclaiming.
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   */
  async reclaimCollateral(
    optionAddress: string,
    ownedOption: string,
  ): Promise<TransactionReceipt> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(ownedOption, 'ownedOption');

    try {
      this.client.requireSigner();
      const readContract = this.getOptionReadContract(optionAddress);
      const reclaimFee = await readContract.getReclaimFee(ownedOption);

      const contract = this.getOptionWriteContract(optionAddress);
      const tx = await contract.reclaimCollateral(ownedOption, { value: reclaimFee });
      const receipt = await tx.wait();

      if (!receipt) {
        throw zendfiErr.contractRevert('loan.reclaimCollateral: no receipt');
      }

      this.client.logger.info('Loan option collateral reclaimed', {
        txHash: receipt.hash,
        optionAddress,
        ownedOption,
        reclaimFee: reclaimFee.toString(),
      });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to reclaim collateral', { error, optionAddress, ownedOption });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════
  // Lending Operations
  // ═══════════════════════════════════════════

  /**
   * Fill a borrower's limit order by providing USDC.
   * Calls OptionFactory.settleQuotation() via the existing SDK module.
   * Ensure USDC is approved to OptionFactory first via client.erc20.ensureAllowance().
   *
   * @param quotationId - The limit order's quotation ID
   * @returns Transaction receipt
   * @throws {SignerRequiredError} If no signer
   * @throws {InsufficientAllowanceError} If USDC not approved
   * @example
   * ```typescript
   * const opps = await client.loan.getLendingOpportunities();
   * const factoryAddr = client.chainConfig.contracts.optionFactory;
   * await client.erc20.ensureAllowance(USDC, factoryAddr, amount);
   * await client.loan.lend(BigInt(opps[0].quotationId));
   * ```
   */
  async lend(quotationId: bigint): Promise<TransactionReceipt> {
    return this.client.optionFactory.settleQuotation(quotationId);
  }

  /**
   * Fetch available lending opportunities (unfilled limit orders) from the Loan indexer.
   *
   * @param options - Optional filters
   * @returns Array of lending opportunities with computed APR and formatted values
   * @example
   * ```typescript
   * const opps = await client.loan.getLendingOpportunities();
   * for (const o of opps) {
   *   console.log(`${o.underlying} | Provide: ${o.lendAmountFormatted} USDC | APR: ${o.apr}%`);
   * }
   * ```
   */
  async getLendingOpportunities(options?: {
    underlying?: LoanUnderlying;
    excludeAddress?: string;
  }): Promise<LoanLendingOpportunity[]> {
    const url = `${LOAN_CONFIG.indexerUrl}/api/state`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw zendfiErr.indexerUnavailable(url, { meta: { status: response.status } });
      }
      const data = await response.json() as { loans?: Record<string, LoanIndexerLoan> | LoanIndexerLoan[] };
      const loans: LoanIndexerLoan[] = Array.isArray(data.loans)
        ? data.loans
        : data.loans ? Object.values(data.loans) : [];

      const now = Math.floor(Date.now() / 1000);
      const results: LoanLendingOpportunity[] = [];

      for (const loan of loans) {
        // r12 indexer no longer surfaces convertToLimitOrder. Treat missing
        // field as eligible; only skip when it's explicitly false. This
        // avoids returning an empty list against an r12 indexer that just
        // dropped the field.
        if (loan.convertToLimitOrder === false) continue;
        if (loan.optionAddress) continue;
        if (loan.status === 'settled' || loan.status === 'cancelled') continue;
        if (loan.expiryTimestamp <= now) continue;

        const ethCollateral = LOAN_CONFIG.assets.ETH.collateral.toLowerCase();
        const btcCollateral = LOAN_CONFIG.assets.BTC.collateral.toLowerCase();
        const collateralLower = loan.collateralToken.toLowerCase();
        let underlying: 'ETH' | 'BTC';
        if (collateralLower === ethCollateral) {
          underlying = 'ETH';
        } else if (collateralLower === btcCollateral) {
          underlying = 'BTC';
        } else {
          // Skip rather than mis-decimalize an unknown collateral token. The
          // previous default-to-BTC branch silently produced garbage APR rows
          // (TNU-AUDIT-0028).
          this.client.logger.warn('Skipping lending opportunity — unknown collateral token', {
            collateralToken: loan.collateralToken,
          });
          continue;
        }

        if (options?.underlying && underlying !== options.underlying) continue;
        if (options?.excludeAddress && loan.requester.toLowerCase() === options.excludeAddress.toLowerCase()) continue;

        const asset = LOAN_CONFIG.assets[underlying as LoanUnderlying];
        const lendAmount = BigInt(loan.minSettlementAmount);
        const collateralBN = BigInt(loan.collateralAmount);
        const strikeBN = BigInt(loan.strike);

        const owe = (collateralBN * strikeBN) / (10n ** BigInt(asset.decimals + LOAN_CONFIG.strikeDecimals - 6));

        const durationSeconds = loan.expiryTimestamp - now;
        if (durationSeconds <= 0) continue;

        const profit = owe - lendAmount;
        // Both `profit` and `lendAmount` are 6-decimal bigints; converting via
        // `formatUnits` first preserves precision for USDC amounts > $9B
        // (TNU-AUDIT-0027).
        const profitFloat = parseFloat(ethers.formatUnits(profit, 6));
        const lendAmountFloat = parseFloat(ethers.formatUnits(lendAmount, 6));
        const apr = lendAmountFloat > 0
          ? (profitFloat / lendAmountFloat) * (365.25 * 86400 / durationSeconds) * 100
          : 0;

        const expiryDate = new Date(loan.expiryTimestamp * 1000);
        const expiryFormatted = expiryDate.toLocaleDateString('en-US', {
          weekday: 'short', month: 'long', day: 'numeric', year: 'numeric',
        });

        results.push({
          quotationId: loan.quotationId,
          requester: loan.requester,
          underlying,
          collateralFormatted: parseFloat(ethers.formatUnits(collateralBN, asset.decimals)).toString(),
          lendAmountFormatted: parseFloat(ethers.formatUnits(lendAmount, 6)).toFixed(2),
          lendAmount,
          strike: Number(strikeBN) / 10 ** LOAN_CONFIG.strikeDecimals,
          expiryTimestamp: loan.expiryTimestamp,
          expiryFormatted,
          apr: Math.round(apr * 100) / 100,
          aprFormatted: apr.toFixed(2),
          raw: loan,
        });
      }

      return results;
    } catch (error) {
      this.client.logger.error('Failed to fetch lending opportunities', { error });
      if (error instanceof Error && 'code' in error) throw error;
      throw zendfiErr.indexerUnavailable('lending opportunities', { cause: error });
    }
  }

  // ═══════════════════════════════════════════
  // Query Operations
  // ═══════════════════════════════════════════

  /**
   * Get a loan's on-chain state from the LoanCoordinator contract.
   *
   * @param quotationId - The quotation ID
   * @returns Loan state including settlement status and option contract address
   */
  async getLoanRequest(quotationId: bigint): Promise<LoanState> {
    const contract = this.getCoordinatorReadContract();

    try {
      const result = await contract.loanRequests(quotationId);
      return {
        requester: result.requester,
        collateralAmount: result.collateralAmount,
        strike: result.strike,
        expiryTimestamp: Number(result.expiryTimestamp),
        collateralToken: result.collateralToken,
        settlementToken: result.settlementToken,
        isSettled: result.isSettled,
        settledOptionContract: result.settledOptionContract,
      };
    } catch (error) {
      this.client.logger.error('Failed to get loan request', { error, quotationId: quotationId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Get all loans for a specific address from the Loan indexer.
   * Returns both active and historical loans.
   *
   * @param address - The borrower's wallet address
   * @returns Array of loans with status, option address, settlement details
   */
  async getUserLoans(address: string): Promise<LoanIndexerLoan[]> {
    validateAddress(address, 'address');
    const url = `${LOAN_CONFIG.indexerUrl}/api/state`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw zendfiErr.indexerUnavailable(url, { meta: { status: response.status } });
      }
      const data = await response.json() as { loans?: Record<string, LoanIndexerLoan> | LoanIndexerLoan[] };
      const loans: LoanIndexerLoan[] = Array.isArray(data.loans)
        ? data.loans
        : data.loans ? Object.values(data.loans) : [];

      return loans.filter(
        (loan) => loan.requester.toLowerCase() === address.toLowerCase(),
      );
    } catch (error) {
      this.client.logger.error('Failed to get user loans', { error, address });
      if (error instanceof Error && 'code' in error) throw error;
      throw zendfiErr.indexerUnavailable('user loans', { cause: error });
    }
  }

  /**
   * Get detailed information about an option contract.
   *
   * @param optionAddress - The option contract address
   * @returns Buyer, seller, collateral, expiry, strikes, settlement status
   */
  async getOptionInfo(optionAddress: string): Promise<LoanOptionInfo> {
    validateAddress(optionAddress, 'optionAddress');
    const option = this.getOptionReadContract(optionAddress);

    try {
      const [buyer, seller, collateralToken, collateralAmount, expiryTimestamp, strikes, isSettled, twap, deliveryAmount, exerciseWindow] =
        await Promise.all([
          option.buyer(),
          option.seller(),
          option.collateralToken(),
          option.collateralAmount(),
          option.expiryTimestamp(),
          option.getStrikes(),
          option.optionSettled(),
          option.getTWAP().catch(() => 0n),
          option.calculateDeliveryAmount().catch(() => 0n),
          option.EXERCISE_WINDOW(),
        ]);

      return {
        buyer,
        seller,
        collateralToken,
        collateralAmount,
        expiryTimestamp: Number(expiryTimestamp),
        strikes: strikes.map((s) => Number(s) / 10 ** LOAN_CONFIG.strikeDecimals),
        isSettled,
        twap: Number(twap),
        deliveryAmount,
        exerciseWindow: Number(exerciseWindow),
      };
    } catch (error) {
      this.client.logger.error('Failed to get option info', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Check if an option is in-the-money based on current TWAP price.
   *
   * @param optionAddress - The option contract address
   * @returns true if the option is ITM
   */
  async isOptionITM(optionAddress: string): Promise<boolean> {
    validateAddress(optionAddress, 'optionAddress');
    const option = this.getOptionReadContract(optionAddress);

    try {
      const twap = await option.getTWAP();
      return option.isITM(twap);
    } catch (error) {
      this.client.logger.error('Failed to check ITM status', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════
  // Pricing Operations
  // ═══════════════════════════════════════════

  /**
   * Fetch raw Deribit-style pricing data for all ETH and BTC options.
   * Results are cached for 30 seconds.
   *
   * @returns Pricing map keyed by asset ('ETH'|'BTC') then instrument name
   */
  async fetchPricing(): Promise<DeribitPricingMap> {
    if (this.pricingCache && Date.now() - this.pricingCache.fetchedAt < this.PRICING_CACHE_TTL) {
      return this.pricingCache.data;
    }

    try {
      const response = await fetch(LOAN_CONFIG.pricingUrl);
      if (!response.ok) {
        throw zendfiErr.pricingUnavailable(`pricing API status ${response.status}`);
      }
      const json: { data?: DeribitPricingMap } = await response.json() as { data?: DeribitPricingMap };
      if (!json || !json.data) {
        throw zendfiErr.pricingUnavailable('invalid pricing data format');
      }

      this.pricingCache = { data: json.data, fetchedAt: Date.now() };
      return json.data;
    } catch (error) {
      this.client.logger.error('Failed to fetch pricing', { error });
      if (error instanceof Error && 'code' in error) throw error;
      throw zendfiErr.pricingUnavailable('fetch failed', { cause: error });
    }
  }

  /**
   * Get available strike options filtered and grouped by expiry date.
   * Only returns OTM put options with valid market data.
   *
   * @param underlying - 'ETH' or 'BTC'
   * @param settings - Filter/sort settings (all optional with sensible defaults)
   * @returns Strike options grouped by expiry date
   * @example
   * ```typescript
   * const groups = await client.loan.getStrikeOptions('ETH');
   * for (const g of groups) {
   *   console.log(g.expiryFormatted);
   *   for (const opt of g.options) {
   *     console.log(`  $${opt.strike} — ${opt.effectiveApr}% APR`);
   *   }
   * }
   * ```
   */
  async getStrikeOptions(
    underlying: LoanUnderlying,
    settings?: Partial<LoanStrikeSettings>,
  ): Promise<LoanStrikeOptionGroup[]> {
    const pricingData = await this.fetchPricing();

    const fullSettings: LoanStrikeSettings = {
      minDurationDays: settings?.minDurationDays ?? 7,
      maxStrikes: settings?.maxStrikes ?? 20,
      sortOrder: settings?.sortOrder ?? 'highestStrike',
      maxApr: settings?.maxApr ?? 20,
    };

    const lookupKey = getPricingKey(underlying);
    const assetData = pricingData[lookupKey];
    if (!assetData) return [];

    const now = Math.floor(Date.now() / 1000);
    const minDurationSeconds = fullSettings.minDurationDays * 86400;

    let underlyingPrice = 0;
    for (const optData of Object.values(assetData)) {
      if (optData?.underlying_price > 0) {
        underlyingPrice = optData.underlying_price;
        break;
      }
    }
    if (underlyingPrice === 0) return [];

    const groups = new Map<string, { expiryTimestamp: number; options: LoanStrikeOption[] }>();

    for (const [key, optData] of Object.entries(assetData)) {
      if (!key.endsWith('-P')) continue;
      const parsed = parseDeribitKey(key);
      if (!parsed) continue;

      const expiryTimestamp = parseExpiryTimestamp(parsed.expiry);

      if (expiryTimestamp - now < minDurationSeconds) continue;
      if (parsed.strike >= underlyingPrice) continue;
      if (!optData || optData.mark_price <= 0) continue;

      const promo = this.isPromoOption(parsed.strike, underlyingPrice, expiryTimestamp);

      const askPriceUsdc = (optData.ask_price || 0) * underlyingPrice;
      const owePerUnit = parsed.strike;
      const optionCostPerUnit = promo && LOAN_CONFIG.promo.optionPremiumWaived ? 0 : askPriceUsdc;
      const apr = promo ? LOAN_CONFIG.promo.borrowingFeePercent : fullSettings.maxApr;
      const durationYears = (expiryTimestamp - now) / (365.25 * 86400);
      const capitalCostPerUnit = owePerUnit * (apr / 100) * durationYears;
      const protocolFeePerUnit = owePerUnit * LOAN_CONFIG.protocolFeeBps / 10000;
      const totalCostsPerUnit = optionCostPerUnit + capitalCostPerUnit + protocolFeePerUnit;
      const receivePerUnit = owePerUnit - totalCostsPerUnit;

      if (receivePerUnit <= 0) continue;

      const effectiveApr = (totalCostsPerUnit / receivePerUnit) * (31536000 / (expiryTimestamp - now)) * 100;

      const option: LoanStrikeOption = {
        strike: parsed.strike,
        strikeFormatted: '$' + parsed.strike.toLocaleString(),
        expiry: expiryTimestamp,
        expiryFormatted: formatExpiryDate(parsed.expiry),
        expiryLabel: parsed.expiry,
        underlyingPrice,
        askPrice: optData.ask_price,
        impliedLoanAmount: receivePerUnit,
        effectiveApr: Math.round(effectiveApr * 100) / 100,
        isPromo: promo,
      };

      if (!groups.has(parsed.expiry)) {
        groups.set(parsed.expiry, { expiryTimestamp, options: [] });
      }
      groups.get(parsed.expiry)!.options.push(option);
    }

    const result: LoanStrikeOptionGroup[] = [];
    for (const [label, group] of groups) {
      let opts = group.options;

      opts.sort((a, b) => a.strike - b.strike);
      opts = opts.slice(0, fullSettings.maxStrikes);

      if (fullSettings.sortOrder === 'highestStrike') {
        opts.sort((a, b) => b.strike - a.strike);
      }

      result.push({
        expiryLabel: label,
        expiryFormatted: formatExpiryDate(label),
        expiryTimestamp: group.expiryTimestamp,
        options: opts,
      });
    }

    if (fullSettings.sortOrder === 'furthestExpiry') {
      result.sort((a, b) => b.expiryTimestamp - a.expiryTimestamp);
    } else {
      result.sort((a, b) => a.expiryTimestamp - b.expiryTimestamp);
    }

    return result;
  }

  /**
   * Calculate exact loan costs using BigInt arithmetic.
   * Includes option premium, borrowing fee, protocol fee, and promo detection.
   *
   * @param params - Calculation inputs (deposit amount, strike, expiry, pricing data)
   * @returns Full cost breakdown with formatted display values, or null if invalid
   * @example
   * ```typescript
   * const calc = client.loan.calculateLoan({
   *   depositAmount: '1.0',
   *   underlying: 'ETH',
   *   strike: 1600,
   *   expiryTimestamp: 1780041600,
   *   askPrice: 0.007,
   *   underlyingPrice: 2328,
   * });
   * if (calc) {
   *   console.log(`Receive: ${calc.formatted.receive} USDC`);
   *   console.log(`APR: ${calc.formatted.apr}%`);
   * }
   * ```
   */
  calculateLoan(params: LoanCalculateParams): LoanCalculation | null {
    const { depositAmount, underlying, strike, expiryTimestamp, askPrice, underlyingPrice } = params;
    const maxApr = params.maxApr ?? 20;

    const asset = getAssetConfig(underlying);
    const deposit = parseFloat(depositAmount);
    if (!deposit || deposit <= 0 || !strike || !expiryTimestamp) return null;

    const depositBN = ethers.parseUnits(depositAmount, asset.decimals);
    const strikeBN = ethers.parseUnits(strike.toString(), LOAN_CONFIG.strikeDecimals);

    const owe = (depositBN * strikeBN) / (10n ** BigInt(asset.decimals + LOAN_CONFIG.strikeDecimals - 6));

    const now = Math.floor(Date.now() / 1000);
    const durationInSeconds = expiryTimestamp - now;
    const durationInYears = durationInSeconds / (365.25 * 86400);

    let optionCost = 0n;
    if (askPrice > 0 && underlyingPrice > 0) {
      const askPriceInUsdc = askPrice * underlyingPrice;
      const askPriceBN = ethers.parseUnits(askPriceInUsdc.toFixed(6), 6);
      optionCost = (askPriceBN * depositBN) / (10n ** BigInt(asset.decimals));
    }

    const promoCapitalCost = (owe * BigInt(Math.floor(LOAN_CONFIG.promo.borrowingFeePercent / 100 * durationInYears * 1e6))) / 1000000n;
    const promoProtocolFee = (owe * BigInt(LOAN_CONFIG.protocolFeeBps)) / 10000n;
    const estimatedBorrowed = owe - promoCapitalCost - promoProtocolFee;
    const estimatedBorrowedUsd = parseFloat(ethers.formatUnits(estimatedBorrowed, 6));
    const isPromo = underlyingPrice > 0 && this.isPromoOption(strike, underlyingPrice, expiryTimestamp, estimatedBorrowedUsd);

    if (isPromo && LOAN_CONFIG.promo.optionPremiumWaived) {
      optionCost = 0n;
    }

    const loanCostAPR = isPromo ? LOAN_CONFIG.promo.borrowingFeePercent / 100 : maxApr / 100;
    let capitalCost = (owe * BigInt(Math.floor(loanCostAPR * durationInYears * 1e6))) / 1000000n;
    if (capitalCost < 10000n) capitalCost = 10000n; // min 0.01 USDC

    const protocolFee = (owe * BigInt(LOAN_CONFIG.protocolFeeBps)) / 10000n;

    const totalCosts = optionCost + capitalCost + protocolFee;
    const finalLoanAmount = owe - totalCosts;

    if (finalLoanAmount <= 0n) return null;

    const effectiveApr = (Number(totalCosts) / Number(finalLoanAmount)) * (31536000 / durationInSeconds) * 100;

    return {
      owe,
      optionCost,
      capitalCost,
      protocolFee,
      totalCosts,
      finalLoanAmount,
      effectiveApr,
      isPromo,
      formatted: {
        receive: parseFloat(ethers.formatUnits(finalLoanAmount, 6)).toFixed(2),
        repay: parseFloat(ethers.formatUnits(owe, 6)).toFixed(2),
        optionCost: parseFloat(ethers.formatUnits(optionCost, 6)).toFixed(4),
        capitalCost: parseFloat(ethers.formatUnits(capitalCost, 6)).toFixed(4),
        protocolFee: parseFloat(ethers.formatUnits(protocolFee, 6)).toFixed(4),
        apr: effectiveApr.toFixed(2),
      },
    };
  }

  /**
   * Check if a strike option qualifies for promotional pricing.
   * Promo requires: >90 days to expiry AND <50% LTV (strike/underlyingPrice).
   *
   * @param strike - Strike price in USD
   * @param underlyingPrice - Current underlying price in USD
   * @param expiryTimestamp - Option expiry (Unix seconds)
   * @param loanAmountUsd - Optional: estimated loan amount for $250k per-person cap
   * @returns true if promo eligible
   */
  isPromoOption(
    strike: number,
    underlyingPrice: number,
    expiryTimestamp: number,
    loanAmountUsd: number = 0,
  ): boolean {
    if (!LOAN_CONFIG.promo.enabled) return false;
    const now = Math.floor(Date.now() / 1000);
    const daysToExpiry = (expiryTimestamp - now) / 86400;
    const ltvPercent = (strike / underlyingPrice) * 100;
    if (daysToExpiry <= LOAN_CONFIG.promo.minDaysToExpiry || ltvPercent >= LOAN_CONFIG.promo.maxLtvPercent) return false;
    if (loanAmountUsd > 0 && loanAmountUsd > LOAN_CONFIG.promo.maxPerPersonUsd) return false;
    return true;
  }

  // ═══════════════════════════════════════════
  // Encoding Methods (for viem/wagmi integration)
  // ═══════════════════════════════════════════

  /**
   * Encode a requestLoan transaction for use with any wallet library.
   * Does NOT auto-wrap ETH — caller must handle WETH wrapping separately.
   *
   * @param params - Loan request parameters
   * @returns Encoded transaction { to, data }
   */
  encodeRequestLoan(params: LoanRequest): { to: string; data: string } {
    // requesterPublicKey is required for offer encryption — without it, no MM can
    // deliver a fillable offer and the loan silently expires (TNU-AUDIT-0013).
    if (!params.requesterPublicKey || params.requesterPublicKey.trim() === '') {
      throw zendfiErr.invalidParam(
        'requesterPublicKey',
        'required for encodeRequestLoan',
        {
          actionable: 'Resolve via `client.rfqKeys.getOrCreateKeyPair()` before encoding.',
        },
      );
    }
    const asset = getAssetConfig(params.underlying);

    const collateralAmount = typeof params.collateralAmount === 'string'
      ? ethers.parseUnits(params.collateralAmount, asset.decimals)
      : params.collateralAmount;

    const strikeBN = ethers.parseUnits(params.strike.toString(), LOAN_CONFIG.strikeDecimals);
    const offerDuration = params.offerDurationSeconds ?? LOAN_CONFIG.defaultOfferDurationSeconds;
    const offerEndTimestamp = Math.floor(Date.now() / 1000) + offerDuration;

    const iface = new Interface(LOAN_COORDINATOR_ABI);
    const data = iface.encodeFunctionData('requestLoan', [{
      collateralToken: asset.collateral,
      priceFeed: asset.priceFeed,
      settlementToken: LOAN_CONFIG.settlement,
      collateralAmount,
      strike: strikeBN,
      expiryTimestamp: params.expiryTimestamp,
      offerEndTimestamp,
      minSettlementAmount: params.minSettlementAmount,
      requesterPublicKey: params.requesterPublicKey,
    }]);

    return { to: LOAN_CONFIG.contracts.loanCoordinator, data };
  }

  /**
   * Encode an acceptOffer transaction.
   *
   * @param quotationId - The RFQ quotation ID
   * @param offerAmount - Decrypted offer amount
   * @param nonce - Offer nonce
   * @param offeror - Market maker's address
   * @returns Encoded transaction { to, data }
   */
  encodeAcceptOffer(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): { to: string; data: string } {
    validateAddress(offeror, 'offeror');
    const iface = new Interface(LOAN_COORDINATOR_ABI);
    const data = iface.encodeFunctionData('settleQuotationEarly', [
      quotationId, offerAmount, nonce, offeror,
    ]);
    return { to: LOAN_CONFIG.contracts.loanCoordinator, data };
  }

  /**
   * Encode a cancelLoan transaction.
   *
   * @param quotationId - The quotation ID to cancel
   * @returns Encoded transaction { to, data }
   */
  encodeCancelLoan(quotationId: bigint): { to: string; data: string } {
    const iface = new Interface(LOAN_COORDINATOR_ABI);
    const data = iface.encodeFunctionData('cancelLoan', [quotationId]);
    return { to: LOAN_CONFIG.contracts.loanCoordinator, data };
  }
}
