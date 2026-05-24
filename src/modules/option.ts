import { Contract } from 'ethers';
import type { ContractTransactionResponse, TransactionReceipt } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import { BASE_OPTION_ABI } from '../abis/option.js';
import type {
  OptionInfo,
  FullOptionInfo,
  ClosePositionResult,
  TransferPositionResult,
  SplitPositionResult,
  PayoutCalculation,
  PayoutResult,
  UnpackedOptionType,
} from '../types/option.js';
import type { TransactionResult } from '../types/optionBook.js';
import { createError, mapContractError } from '../utils/errors.js';
import { validateAddress } from '../utils/validation.js';

/**
 * Interface for BaseOption contract methods (matches ABI exactly)
 */
interface OptionContract {
  // === View Functions ===
  PRICE_DECIMALS(): Promise<bigint>;
  buyer(): Promise<string>;
  seller(): Promise<string>;
  buyerAllowance(owner: string, spender: string): Promise<boolean>;
  sellerAllowance(owner: string, spender: string): Promise<boolean>;
  collateralToken(): Promise<string>;
  collateralAmount(): Promise<bigint>;
  chainlinkPriceFeed(): Promise<string>;
  historicalTWAPConsumer(): Promise<string>;
  expiryTimestamp(): Promise<bigint>;
  twapPeriod(): Promise<bigint>;
  numContracts(): Promise<bigint>;
  optionSettled(): Promise<boolean>;
  optionType(): Promise<bigint>;
  getStrikes(): Promise<bigint[]>;
  strikes(index: bigint): Promise<bigint>;
  getImplementation(): Promise<string>;
  factory(): Promise<string>;
  rescueAddress(): Promise<string>;
  getTWAP(): Promise<bigint>;
  calculatePayout(price: bigint): Promise<bigint>;
  calculateRequiredCollateral(strikes: bigint[], numContracts: bigint): Promise<bigint>;
  simulatePayout(price: bigint, strikes: bigint[], numContracts: bigint): Promise<bigint>;
  packExtraOptionData(): Promise<string>;
  unpackOptionType(): Promise<[boolean, boolean, number, number]>;

  // === r12 fee views ===
  getSplitFee(): Promise<bigint>;
  /**
   * Returns the fee (in chain-native units) the contract will demand as
   * msg.value when reclaiming collateral from the option at `ownedOption`.
   * The fee is a property of the option being reclaimed, not the caller.
   */
  getReclaimFee(ownedOption: string): Promise<bigint>;

  // === Write Functions ===
  close(): Promise<ContractTransactionResponse>;
  // Removed in audit fix (TNU-AUDIT-0046): zero-arg `payout()` is not present
  // on the r12 BaseOption canonical ABI. Settlement on r12 is initiated via
  // factory-side `notifyTradeSettled` callbacks; the SDK no longer surfaces
  // a `payout()` write entry.
  split(splitCollateralAmount: bigint, overrides?: { value?: bigint }): Promise<ContractTransactionResponse>;
  /**
   * Reclaim collateral from an owned option position. Sends `getReclaimFee(ownedOption)`
   * as `msg.value` per the r12 payable signature (TNU-AUDIT-0070).
   */
  reclaimCollateral(
    ownedOption: string,
    overrides?: { value?: bigint }
  ): Promise<ContractTransactionResponse>;
  transfer(isBuyer: boolean, target: string): Promise<ContractTransactionResponse>;
  approveTransfer(isBuyer: boolean, target: string, isApproved: boolean): Promise<ContractTransactionResponse>;
  rescueERC20(token: string): Promise<ContractTransactionResponse>;
  validateParams(strikes: bigint[]): Promise<void>;
}

/**
 * Module for BaseOption contract interactions
 *
 * Provides methods for managing option positions:
 * - Close positions
 * - Transfer positions
 * - Split positions
 * - Calculate payouts
 * - Query option state
 * - Approve transfers
 * - Execute payouts
 *
 * @example
 * ```typescript
 * // Get option info
 * const info = await client.option.getOptionInfo(optionAddress);
 *
 * // Close position
 * const result = await client.option.close(optionAddress);
 *
 * // Execute payout after expiry
 * const payout = await client.option.payout(optionAddress);
 * ```
 */
export class OptionModule {
  /** Cache for contract instances */
  private contractCache: Map<string, OptionContract> = new Map();

  constructor(private readonly client: ThetanutsClient) {}

  /**
   * Get a read-only contract instance for an option
   */
  private getReadContract(optionAddress: string): OptionContract {
    const cacheKey = `read-${optionAddress.toLowerCase()}`;
    let contract = this.contractCache.get(cacheKey);

    if (!contract) {
      contract = new Contract(
        optionAddress,
        BASE_OPTION_ABI,
        this.client.provider
      ) as unknown as OptionContract;
      this.contractCache.set(cacheKey, contract);
    }

    return contract;
  }

  /**
   * Get a contract instance with signer for write operations
   */
  private getWriteContract(optionAddress: string): OptionContract {
    const signer = this.client.requireSigner();
    return new Contract(
      optionAddress,
      BASE_OPTION_ABI,
      signer
    ) as unknown as OptionContract;
  }

  // ============================================================
  // Write Functions
  // ============================================================

  /**
   * Close a position on an option contract
   *
   * @param optionAddress - Option contract address
   * @returns Close position result
   */
  async close(optionAddress: string): Promise<ClosePositionResult> {
    validateAddress(optionAddress, 'optionAddress');

    this.client.logger.debug('Closing position', { optionAddress });

    try {
      const contract = this.getWriteContract(optionAddress);
      const tx = await contract.close();

      this.client.logger.info('Position closed successfully', {
        txHash: tx.hash,
        optionAddress,
      });

      return {
        txHash: tx.hash,
        tx,
        optionAddress,
        wait: (confirmations?: number) => tx.wait(confirmations).then((receipt) => {
          if (!receipt) {
            throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
          }
          return receipt;
        }),
      };
    } catch (error) {
      this.client.logger.error('Failed to close position', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Transfer a position to another address.
   * BaseOption ABI: transfer(isBuyer: bool, target: address)
   *
   * @param optionAddress - Option contract address
   * @param isBuyer - Whether transferring buyer (true) or seller (false) position
   * @param target - Recipient address
   * @returns Transfer position result
   */
  async transfer(
    optionAddress: string,
    isBuyer: boolean,
    target: string
  ): Promise<TransferPositionResult> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(target, 'target');

    this.client.logger.debug('Transferring position', {
      optionAddress,
      target,
      isBuyer,
    });

    try {
      const contract = this.getWriteContract(optionAddress);
      const tx = await contract.transfer(isBuyer, target);

      this.client.logger.info('Position transferred successfully', {
        txHash: tx.hash,
        optionAddress,
        target,
        isBuyer,
      });

      return {
        txHash: tx.hash,
        tx,
        optionAddress,
        to: target,
        isBuyer,
        amount: 0n, // Full position transfer in BaseOption
        wait: (confirmations?: number) => tx.wait(confirmations).then((receipt) => {
          if (!receipt) {
            throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
          }
          return receipt;
        }),
      };
    } catch (error) {
      this.client.logger.error('Failed to transfer position', { error, optionAddress, target });
      throw mapContractError(error);
    }
  }

  /**
   * Split a position by collateral amount.
   * BaseOption ABI: split(splitCollateralAmount: uint256) returns (address)
   *
   * @param optionAddress - Option contract address
   * @param splitCollateralAmount - Collateral amount to split off
   * @returns Split position result
   */
  async split(optionAddress: string, splitCollateralAmount: bigint): Promise<SplitPositionResult> {
    validateAddress(optionAddress, 'optionAddress');

    if (splitCollateralAmount <= 0n) {
      throw createError('INVALID_PARAMS', 'Split collateral amount must be positive');
    }

    this.client.logger.debug('Splitting position', {
      optionAddress,
      splitCollateralAmount: splitCollateralAmount.toString(),
    });

    try {
      // r12 split() is payable: caller must forward the on-chain split fee
      // as msg.value. Fetch fresh per call so the SDK never sends stale fee.
      const readContract = this.getReadContract(optionAddress);
      const splitFee = await readContract.getSplitFee();

      const contract = this.getWriteContract(optionAddress);
      const tx = await contract.split(splitCollateralAmount, { value: splitFee });

      this.client.logger.info('Position split successfully', {
        txHash: tx.hash,
        optionAddress,
        splitFee: splitFee.toString(),
      });

      return {
        txHash: tx.hash,
        tx,
        optionAddress,
        amounts: [splitCollateralAmount],
        wait: (confirmations?: number) => tx.wait(confirmations).then((receipt) => {
          if (!receipt) {
            throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
          }
          return receipt;
        }),
      };
    } catch (error) {
      this.client.logger.error('Failed to split position', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Reclaim collateral from an owned option position.
   *
   * The r12 `BaseOption.reclaimCollateral(address ownedOption)` is `payable`:
   * the contract demands `getReclaimFee(ownedOption)` as `msg.value`, with the
   * fee keyed on the option being reclaimed (not on the caller). Reclaimed
   * collateral is sent to `msg.sender`.
   *
   * Mirrors `RangerModule.reclaimCollateral` so callers do not need to drop
   * down to raw `Contract` instances and risk forgetting the `value` field
   * (TNU-AUDIT-0070; companion informational TNU-AUDIT-0081).
   *
   * @param optionAddress - The option contract to call `reclaimCollateral` on
   * @param ownedOption - The address of the option position whose collateral is being reclaimed
   * @returns Transaction receipt
   */
  async reclaimCollateral(
    optionAddress: string,
    ownedOption: string,
  ): Promise<TransactionReceipt> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(ownedOption, 'ownedOption');
    this.client.requireSigner();

    try {
      const readContract = this.getReadContract(optionAddress);
      const reclaimFee = await readContract.getReclaimFee(ownedOption);

      const contract = this.getWriteContract(optionAddress);
      const tx = await contract.reclaimCollateral(ownedOption, { value: reclaimFee });
      const receipt = await tx.wait();
      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Option collateral reclaimed', {
        optionAddress,
        ownedOption,
        reclaimFee: reclaimFee.toString(),
        txHash: receipt.hash,
      });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to reclaim collateral', {
        error,
        optionAddress,
        ownedOption,
      });
      throw mapContractError(error);
    }
  }

  /**
   * @deprecated Removed in audit fix TNU-AUDIT-0046.
   *
   * The pre-r12 BaseOption contract exposed a zero-arg `payout()` write
   * entrypoint. On the r12 deployment (canonical `BaseOption.json`) this
   * function does not exist — only `calculatePayout(uint256)` (view) and
   * `simulatePayout(...)` (pure). Settlement is automatic via the factory's
   * `notifyTradeSettled` callback; there is no user-callable settlement
   * trigger on the option contract itself.
   *
   * This method now throws `INVALID_PARAMS` instead of silently broadcasting
   * a guaranteed-revert transaction. Callers should:
   *  - Query settlement status via `getOptionInfo(optionAddress).settled`;
   *  - For payout amount, call `calculatePayout(optionAddress, ...)` (view).
   *
   * The method signature is retained (vs. deletion) to preserve API surface
   * and produce a clear error path for downstream code that was previously
   * burning gas on the revert.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- preserves async signature for API back-compat; throws synchronously into the Promise chain.
  async payout(optionAddress: string): Promise<PayoutResult> {
    validateAddress(optionAddress, 'optionAddress');
    this.client.logger.warn('OptionModule.payout removed (TNU-AUDIT-0046)', {
      optionAddress,
    });
    throw createError(
      'INVALID_PARAMS',
      'OptionModule.payout() is not available on the r12 deployment. ' +
        'Settlement on r12 is triggered automatically via factory callbacks; ' +
        'there is no user-callable payout() entrypoint on BaseOption. ' +
        'See TNU-AUDIT-0046 in SECURITY_AUDIT_BETA.md.'
    );
  }

  /**
   * Approve an address to receive a transfer of buyer or seller position.
   *
   * @param optionAddress - Option contract address
   * @param isBuyer - True to approve buyer transfer, false for seller
   * @param target - Address to approve
   * @param isApproved - True to approve, false to revoke
   * @returns Transaction result
   */
  async approveTransfer(
    optionAddress: string,
    isBuyer: boolean,
    target: string,
    isApproved: boolean
  ): Promise<TransactionResult> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(target, 'target');

    this.client.logger.debug('Approving transfer', { optionAddress, isBuyer, target, isApproved });

    try {
      const contract = this.getWriteContract(optionAddress);
      const tx = await contract.approveTransfer(isBuyer, target, isApproved);

      this.client.logger.info('Transfer approval set', {
        txHash: tx.hash,
        optionAddress,
        isBuyer,
        target,
        isApproved,
      });

      return {
        txHash: tx.hash,
        tx,
        wait: (confirmations?: number) => tx.wait(confirmations).then((receipt) => {
          if (!receipt) {
            throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
          }
          return receipt;
        }),
      };
    } catch (error) {
      this.client.logger.error('Failed to approve transfer', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Rescue stuck ERC20 tokens from the option contract (emergency function).
   *
   * @param optionAddress - Option contract address
   * @param token - Token address to rescue
   * @returns Transaction result
   */
  async rescueERC20(optionAddress: string, token: string): Promise<TransactionResult> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(token, 'token');

    this.client.logger.debug('Rescuing ERC20 tokens', { optionAddress, token });

    try {
      const contract = this.getWriteContract(optionAddress);
      const tx = await contract.rescueERC20(token);

      this.client.logger.info('ERC20 tokens rescued', {
        txHash: tx.hash,
        optionAddress,
        token,
      });

      return {
        txHash: tx.hash,
        tx,
        wait: (confirmations?: number) => tx.wait(confirmations).then((receipt) => {
          if (!receipt) {
            throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
          }
          return receipt;
        }),
      };
    } catch (error) {
      this.client.logger.error('Failed to rescue ERC20', { error, optionAddress, token });
      throw mapContractError(error);
    }
  }

  // ============================================================
  // Read Functions
  // ============================================================

  /**
   * Get option contract information
   *
   * @param optionAddress - Option contract address
   * @returns Option info (uses getStrikes() and expiryTimestamp() per BaseOption ABI)
   */
  async getOptionInfo(optionAddress: string): Promise<OptionInfo> {
    validateAddress(optionAddress, 'optionAddress');

    this.client.logger.debug('Getting option info', { optionAddress });

    try {
      const contract = this.getReadContract(optionAddress);

      const [optionType, strikes, expiry, collateralToken] = await Promise.all([
        contract.optionType(),
        contract.getStrikes(),
        contract.expiryTimestamp(),
        contract.collateralToken(),
      ]);

      return {
        address: optionAddress,
        optionType: Number(optionType),
        strikes,
        expiry,
        collateralToken,
        underlyingToken: '', // BaseOption does not have underlyingToken() - derive from price feed if needed
      };
    } catch (error) {
      this.client.logger.error('Failed to get option info', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Calculate the payout for an option at a given settlement price
   *
   * @param optionAddress - Option contract address
   * @param settlementPrice - Settlement price (8 decimals)
   * @returns Payout calculation result
   */
  async calculatePayout(optionAddress: string, settlementPrice: bigint): Promise<PayoutCalculation> {
    validateAddress(optionAddress, 'optionAddress');

    this.client.logger.debug('Calculating payout', {
      optionAddress,
      settlementPrice: settlementPrice.toString(),
    });

    try {
      const contract = this.getReadContract(optionAddress);
      const payout = await contract.calculatePayout(settlementPrice);
      return {
        payout,
        settlementPrice,
        optionAddress,
      };
    } catch (error) {
      this.client.logger.error('Failed to calculate payout', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Calculate the required collateral for given strikes and number of contracts.
   * BaseOption ABI: calculateRequiredCollateral(strikes[], numContracts) -> uint256
   *
   * @param optionAddress - Option contract address
   * @param strikes - Strike prices array (8 decimals)
   * @param numContracts - Number of contracts
   * @returns Required collateral amount
   */
  async calculateRequiredCollateral(
    optionAddress: string,
    strikes: bigint[],
    numContracts: bigint
  ): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.calculateRequiredCollateral(strikes, numContracts);
    } catch (error) {
      this.client.logger.error('Failed to calculate required collateral', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Simulate payout for given parameters (pure function on-chain).
   * BaseOption ABI: simulatePayout(price, strikes[], numContracts) -> uint256
   *
   * @param optionAddress - Option contract address
   * @param price - Settlement price (8 decimals)
   * @param strikes - Strike prices array
   * @param numContracts - Number of contracts
   * @returns Simulated payout amount
   */
  async simulatePayout(
    optionAddress: string,
    price: bigint,
    strikes: bigint[],
    numContracts: bigint
  ): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    this.client.logger.debug('Simulating payout on-chain', {
      optionAddress,
      price: price.toString(),
      numContracts: numContracts.toString(),
    });

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.simulatePayout(price, strikes, numContracts);
    } catch (error) {
      this.client.logger.error('Failed to simulate payout', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the strikes for an option
   *
   * @param optionAddress - Option contract address
   * @returns Array of strike prices
   */
  async getStrikes(optionAddress: string): Promise<bigint[]> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.getStrikes();
    } catch (error) {
      this.client.logger.error('Failed to get strikes', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get strike price at a specific index
   *
   * @param optionAddress - Option contract address
   * @param index - Strike index
   * @returns Strike price at index
   */
  async getStrikeAtIndex(optionAddress: string, index: bigint): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.strikes(index);
    } catch (error) {
      this.client.logger.error('Failed to get strike at index', { error, optionAddress, index: index.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Get the expiry timestamp for an option
   *
   * @param optionAddress - Option contract address
   * @returns Expiry timestamp
   */
  async getExpiry(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.expiryTimestamp();
    } catch (error) {
      this.client.logger.error('Failed to get expiry', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Check if an option has expired
   *
   * @param optionAddress - Option contract address
   * @returns True if expired
   */
  async isExpired(optionAddress: string): Promise<boolean> {
    const expiry = await this.getExpiry(optionAddress);
    const currentTimestamp = await this.client.getCurrentTimestamp();
    return expiry <= BigInt(currentTimestamp);
  }

  /**
   * Check if an option has been settled
   *
   * @param optionAddress - Option contract address
   * @returns True if settled
   */
  async isSettled(optionAddress: string): Promise<boolean> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.optionSettled();
    } catch (error) {
      this.client.logger.error('Failed to check settlement status', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the option type
   *
   * @param optionAddress - Option contract address
   * @returns Option type (packed uint256)
   */
  async getOptionType(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.optionType();
    } catch (error) {
      this.client.logger.error('Failed to get option type', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Unpack the option type into its component flags
   *
   * @param optionAddress - Option contract address
   * @returns Unpacked option type details
   */
  async unpackOptionType(optionAddress: string): Promise<UnpackedOptionType> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      const [isQuoteCollateral, isPhysicallySettled, optionStyle, optionStructure] =
        await contract.unpackOptionType();

      return {
        isQuoteCollateral,
        isPhysicallySettled,
        optionStyle,
        optionStructure,
      };
    } catch (error) {
      this.client.logger.error('Failed to unpack option type', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the buyer address
   *
   * @param optionAddress - Option contract address
   * @returns Buyer address
   */
  async getBuyer(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.buyer();
    } catch (error) {
      this.client.logger.error('Failed to get buyer', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the seller address
   *
   * @param optionAddress - Option contract address
   * @returns Seller address
   */
  async getSeller(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.seller();
    } catch (error) {
      this.client.logger.error('Failed to get seller', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Check if an address is approved to receive buyer position transfer
   *
   * @param optionAddress - Option contract address
   * @param owner - Current buyer address
   * @param spender - Address to check approval for
   * @returns True if approved
   */
  async getBuyerAllowance(optionAddress: string, owner: string, spender: string): Promise<boolean> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(owner, 'owner');
    validateAddress(spender, 'spender');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.buyerAllowance(owner, spender);
    } catch (error) {
      this.client.logger.error('Failed to get buyer allowance', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Check if an address is approved to receive seller position transfer
   *
   * @param optionAddress - Option contract address
   * @param owner - Current seller address
   * @param spender - Address to check approval for
   * @returns True if approved
   */
  async getSellerAllowance(optionAddress: string, owner: string, spender: string): Promise<boolean> {
    validateAddress(optionAddress, 'optionAddress');
    validateAddress(owner, 'owner');
    validateAddress(spender, 'spender');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.sellerAllowance(owner, spender);
    } catch (error) {
      this.client.logger.error('Failed to get seller allowance', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the collateral token address
   *
   * @param optionAddress - Option contract address
   * @returns Collateral token address
   */
  async getCollateralToken(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.collateralToken();
    } catch (error) {
      this.client.logger.error('Failed to get collateral token', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the collateral amount
   *
   * @param optionAddress - Option contract address
   * @returns Collateral amount
   */
  async getCollateralAmount(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.collateralAmount();
    } catch (error) {
      this.client.logger.error('Failed to get collateral amount', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the number of contracts
   *
   * @param optionAddress - Option contract address
   * @returns Number of contracts
   */
  async getNumContracts(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.numContracts();
    } catch (error) {
      this.client.logger.error('Failed to get num contracts', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the Chainlink price feed address
   *
   * @param optionAddress - Option contract address
   * @returns Price feed address
   */
  async getChainlinkPriceFeed(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.chainlinkPriceFeed();
    } catch (error) {
      this.client.logger.error('Failed to get price feed', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the historical TWAP consumer contract address
   *
   * @param optionAddress - Option contract address
   * @returns TWAP consumer address
   */
  async getHistoricalTWAPConsumer(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.historicalTWAPConsumer();
    } catch (error) {
      this.client.logger.error('Failed to get TWAP consumer', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the current TWAP (Time-Weighted Average Price)
   *
   * @param optionAddress - Option contract address
   * @returns TWAP price (8 decimals)
   */
  async getTWAP(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.getTWAP();
    } catch (error) {
      this.client.logger.error('Failed to get TWAP', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the TWAP period in seconds
   *
   * @param optionAddress - Option contract address
   * @returns TWAP period
   */
  async getTwapPeriod(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.twapPeriod();
    } catch (error) {
      this.client.logger.error('Failed to get TWAP period', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the implementation address (proxy pattern)
   *
   * @param optionAddress - Option contract address
   * @returns Implementation address
   */
  async getImplementation(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.getImplementation();
    } catch (error) {
      this.client.logger.error('Failed to get implementation', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the factory contract address that created this option
   *
   * @param optionAddress - Option contract address
   * @returns Factory address
   */
  async getFactory(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.factory();
    } catch (error) {
      this.client.logger.error('Failed to get factory', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the rescue address for emergency token recovery
   *
   * @param optionAddress - Option contract address
   * @returns Rescue address
   */
  async getRescueAddress(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.rescueAddress();
    } catch (error) {
      this.client.logger.error('Failed to get rescue address', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the PRICE_DECIMALS constant
   *
   * @param optionAddress - Option contract address
   * @returns Price decimals (typically 8)
   */
  async getPriceDecimals(optionAddress: string): Promise<bigint> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.PRICE_DECIMALS();
    } catch (error) {
      this.client.logger.error('Failed to get price decimals', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the packed extra option data
   *
   * @param optionAddress - Option contract address
   * @returns Packed extra option data (bytes)
   */
  async packExtraOptionData(optionAddress: string): Promise<string> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      return await contract.packExtraOptionData();
    } catch (error) {
      this.client.logger.error('Failed to pack extra option data', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Validate strike params (pure function, will revert on invalid)
   *
   * @param optionAddress - Option contract address
   * @param strikes - Strike prices to validate
   */
  async validateParams(optionAddress: string, strikes: bigint[]): Promise<void> {
    validateAddress(optionAddress, 'optionAddress');

    try {
      const contract = this.getReadContract(optionAddress);
      await contract.validateParams(strikes);
    } catch (error) {
      this.client.logger.error('Failed to validate params', { error, optionAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Clear the contract cache
   */
  clearCache(): void {
    this.contractCache.clear();
  }

  // ============================================================
  // Aggregated Methods
  // ============================================================

  /**
   * Get complete option information in a single call.
   *
   * This method fetches all common option data, avoiding the need for
   * 6+ separate contract calls. Useful for displaying option details
   * in UIs or for MCP server responses.
   *
   * @param optionAddress - Option contract address
   * @param options - Optional configuration
   * @param options.sequential - If true, makes calls sequentially instead of in parallel.
   *                             Use this for RPC providers with strict batch limits (e.g., public RPCs).
   *                             Default: false (parallel calls for better performance)
   * @returns Complete option information
   *
   * @example
   * ```typescript
   * // Parallel (default, faster but may hit RPC batch limits)
   * const fullInfo = await client.option.getFullOptionInfo(optionAddress);
   *
   * // Sequential (slower but works with limited RPC providers)
   * const fullInfo = await client.option.getFullOptionInfo(optionAddress, { sequential: true });
   *
   * console.log('Buyer:', fullInfo.buyer);
   * console.log('Seller:', fullInfo.seller);
   * console.log('Expired:', fullInfo.isExpired);
   * console.log('Settled:', fullInfo.isSettled);
   * console.log('Contracts:', fullInfo.numContracts);
   * console.log('Collateral:', fullInfo.collateralAmount);
   * ```
   */
  async getFullOptionInfo(
    optionAddress: string,
    options?: { sequential?: boolean }
  ): Promise<FullOptionInfo> {
    validateAddress(optionAddress, 'optionAddress');

    this.client.logger.debug('Getting full option info', {
      optionAddress,
      sequential: options?.sequential ?? false,
    });

    const safeCall = <T>(fn: () => Promise<T>): Promise<T | null> =>
      fn().catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.client.logger.debug('Option sub-call failed', { optionAddress, error: errorMessage });
        return null;
      });

    let info: OptionInfo | null;
    let buyer: string | null;
    let seller: string | null;
    let isExpired: boolean | null;
    let isSettled: boolean | null;
    let numContracts: bigint | null;
    let collateralAmount: bigint | null;

    if (options?.sequential) {
      // Sequential calls for RPC providers with batch limits
      info = await safeCall(() => this.getOptionInfo(optionAddress));
      buyer = await safeCall(() => this.getBuyer(optionAddress));
      seller = await safeCall(() => this.getSeller(optionAddress));
      isExpired = await safeCall(() => this.isExpired(optionAddress));
      isSettled = await safeCall(() => this.isSettled(optionAddress));
      numContracts = await safeCall(() => this.getNumContracts(optionAddress));
      collateralAmount = await safeCall(() => this.getCollateralAmount(optionAddress));
    } else {
      // Parallel calls (default) for better performance
      [info, buyer, seller, isExpired, isSettled, numContracts, collateralAmount] =
        await Promise.all([
          safeCall(() => this.getOptionInfo(optionAddress)),
          safeCall(() => this.getBuyer(optionAddress)),
          safeCall(() => this.getSeller(optionAddress)),
          safeCall(() => this.isExpired(optionAddress)),
          safeCall(() => this.isSettled(optionAddress)),
          safeCall(() => this.getNumContracts(optionAddress)),
          safeCall(() => this.getCollateralAmount(optionAddress)),
        ]);
    }

    // If nothing at all responds, the contract is completely incompatible
    if (info === null && buyer === null && seller === null) {
      throw mapContractError(
        new Error(`Option contract ${optionAddress} does not respond to any known functions`)
      );
    }

    return { info, buyer, seller, isExpired, isSettled, numContracts, collateralAmount };
  }
}
