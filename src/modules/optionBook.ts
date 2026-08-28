import { Contract, ZeroAddress, Interface } from 'ethers';
import type { TransactionReceipt, ContractTransactionResponse } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import { OPTION_BOOK_ABI } from '../abis/optionBook.js';
import type { ContractOrder, Eip712Domain } from '../types/optionBook.js';
import type { OrderWithSignature, ClaimableFee, ClaimFeeResult } from '../types/api.js';
import type { CallStaticResult } from '../types/callStatic.js';
import { createError, mapContractError } from '../utils/errors.js';
import { validateAddress, validateHexString } from '../utils/validation.js';

/**
 * Interface for OptionBook contract methods (v2)
 */
interface OptionBookContract {
  fillOrder: {
    (order: ContractOrder, signature: string, referrer: string): Promise<ContractTransactionResponse>;
    (order: ContractOrder, signature: string, referrer: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(order: ContractOrder, signature: string, referrer: string): Promise<bigint>;
  };
  fees(token: string, referrer: string): Promise<bigint>;
  claimFees: {
    (token: string): Promise<ContractTransactionResponse>;
    (token: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(token: string): Promise<bigint>;
  };
  // New read methods
  amountFilled(nonce: bigint): Promise<bigint>;
  referrerFeeSplitBps(referrer: string): Promise<bigint>;
  computeNonce(order: ContractOrder): Promise<bigint>;
  hashOrder(order: ContractOrder): Promise<string>;
  factory(): Promise<string>;
  eip712Domain(): Promise<[string, string, string, bigint, string, string, bigint[]]>;
  PRICE_DECIMALS(): Promise<bigint>;
  LIMIT_ORDER_TYPEHASH(): Promise<string>;
  // New write methods
  swapAndFillOrder: {
    (order: ContractOrder, signature: string, swapRouter: string, swapSrcToken: string, swapSrcAmount: bigint, swapData: string, referrer: string): Promise<ContractTransactionResponse>;
    (order: ContractOrder, signature: string, swapRouter: string, swapSrcToken: string, swapSrcAmount: bigint, swapData: string, referrer: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(order: ContractOrder, signature: string, swapRouter: string, swapSrcToken: string, swapSrcAmount: bigint, swapData: string, referrer: string): Promise<bigint>;
  };
  cancelOrder: {
    (order: ContractOrder): Promise<ContractTransactionResponse>;
    (order: ContractOrder, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(order: ContractOrder): Promise<bigint>;
  };
  setReferrerFeeSplit: {
    (referrer: string, feeBps: bigint): Promise<ContractTransactionResponse>;
    (referrer: string, feeBps: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(referrer: string, feeBps: bigint): Promise<bigint>;
  };
  sweepProtocolFees: {
    (token: string): Promise<ContractTransactionResponse>;
    (token: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(token: string): Promise<bigint>;
  };
}

/**
 * Module for OptionBook contract interactions (v2)
 *
 * Provides methods for filling orders and managing fees.
 *
 * @example
 * ```typescript
 * // Fill an order with 10 USDC worth of contracts
 * const receipt = await client.optionBook.fillOrder(
 *   orderWithSignature,
 *   10_000000n,  // 10 USDC (6 decimals)
 *   '0xYourReferrerAddress'
 * );
 *
 * // Get fee information
 * const fees = await client.optionBook.getFees(tokenAddress, referrerAddress);
 * ```
 */
export class OptionBookModule {
  /** Cached contract instance */
  private _readContract: OptionBookContract | null = null;

  constructor(private readonly client: ThetanutsClient) {}

  /**
   * Get the OptionBook contract address
   */
  get contractAddress(): string {
    return this.client.getContractAddress('optionBook');
  }

  /**
   * Get a read-only contract instance
   */
  private getReadContract(): OptionBookContract {
    if (!this._readContract) {
      this._readContract = new Contract(
        this.contractAddress,
        OPTION_BOOK_ABI,
        this.client.provider
      ) as unknown as OptionBookContract;
    }
    return this._readContract;
  }

  /**
   * Get a contract instance with signer for write operations
   */
  private getWriteContract(): OptionBookContract {
    const signer = this.client.requireSigner();
    return new Contract(
      this.contractAddress,
      OPTION_BOOK_ABI,
      signer
    ) as unknown as OptionBookContract;
  }

  /**
   * Get a contract instance with signer at a specific address
   * Used when the order was signed for a different OptionBook contract
   */
  private getWriteContractAt(address: string): OptionBookContract {
    const signer = this.client.requireSigner();
    return new Contract(
      address,
      OPTION_BOOK_ABI,
      signer
    ) as unknown as OptionBookContract;
  }

  /**
   * Resolve and validate the OptionBook target address from an API order.
   *
   * The API may attach `rawApiData.optionBookAddress` to support orders signed for
   * a non-default OptionBook contract. To prevent a compromised API from redirecting
   * fills to an attacker contract that drains pre-existing allowances, the address
   * MUST match the chain-configured OptionBook for the current network.
   */
  private resolveOptionBookTarget(orderWithSig: OrderWithSignature): string {
    const apiAddress = orderWithSig.rawApiData?.optionBookAddress;
    const canonical = this.contractAddress;
    if (apiAddress === undefined || apiAddress === null) {
      return canonical;
    }
    validateAddress(apiAddress, 'rawApiData.optionBookAddress');
    if (apiAddress.toLowerCase() !== canonical.toLowerCase()) {
      throw createError(
        'INVALID_ORDER',
        `rawApiData.optionBookAddress (${apiAddress}) does not match configured OptionBook (${canonical}) for the current chain`,
      );
    }
    return canonical;
  }

  /**
   * Build ContractOrder from OrderWithSignature and fill amount
   *
   * IMPORTANT: Do NOT modify the order fields from the API - the signature
   * is tied to the exact order parameters. Only numContracts can be set by the caller.
   */
  private buildContractOrder(
    orderWithSig: OrderWithSignature,
    numContracts: bigint
  ): ContractOrder {
    const rawData = orderWithSig.rawApiData;
    if (!rawData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    // Engagement invariant (TNU-AUDIT-0047): zero-address implementations on
    // API responses indicate a misconfigured/rogue feed. The chain registry
    // stores 0x000…000 for not-yet-deployed option implementations (e.g.
    // physical multi-leg); filling against one would build calldata that
    // reverts on-chain. Reject loudly at the SDK boundary.
    if (
      !rawData.implementation ||
      rawData.implementation === '0x0000000000000000000000000000000000000000'
    ) {
      throw createError(
        'INVALID_ORDER',
        'OptionBook fill: order.implementation is zero-address — the option type is not deployed on this chain.'
      );
    }

    return {
      maker: orderWithSig.order.maker,
      orderExpiryTimestamp: BigInt(rawData.orderExpiryTimestamp),
      collateral: rawData.collateral,
      isCall: rawData.isCall,
      priceFeed: rawData.priceFeed,
      implementation: rawData.implementation,
      isLong: rawData.isLong,
      maxCollateralUsable: BigInt(rawData.maxCollateralUsable),
      strikes: rawData.strikes.map(s => BigInt(s)),
      expiry: orderWithSig.order.expiry,
      price: orderWithSig.order.price,
      numContracts: numContracts,
      extraOptionData: rawData.extraOptionData || '0x',
    };
  }

  /**
   * Calculate number of contracts from USDC amount
   *
   * @param usdcAmount - Amount of USDC to spend (6 decimals)
   * @param pricePerContract - Price per contract (8 decimals)
   * @returns Number of contracts (6 decimals for USDC collateral)
   * @throws {ThetanutsError} INVALID_PARAMS if pricePerContract is zero
   */
  calculateNumContracts(usdcAmount: bigint, pricePerContract: bigint): bigint {
    // Validate price is not zero to prevent division by zero
    if (pricePerContract === 0n) {
      throw createError(
        'INVALID_PARAMS',
        'Price per contract cannot be zero (division by zero)'
      );
    }

    // price is in 8 decimals, usdcAmount is in 6 decimals
    // numContracts = usdcAmount / price * 1e8 / 1e6 = usdcAmount * 1e2 / price
    // But we want numContracts in 6 decimals (same as USDC)
    // So: numContracts = (usdcAmount / price) * 1e6
    // Which is: (usdcAmount * 1e6 * 1e6) / (price * 1e8) = usdcAmount * 1e4 / price
    // Simplified: numContracts = usdcAmount * 10000n / pricePerContract

    // Actually looking at the docs more carefully:
    // pricePerContract is in 8 decimals (e.g., 5000000 = 0.05 USDC per contract)
    // usdcAmount is what user wants to spend (6 decimals, e.g., 1000000 = 1 USDC)
    // numContracts should be scaled to 6 decimals

    // If price = 0.05 USDC (5000000 in 8 decimals) and user spends 1 USDC (1000000 in 6 decimals)
    // contractsToBuy = 1 / 0.05 = 20 contracts
    // In 6 decimals: 20000000

    // Formula: numContracts = (usdcAmount * 1e8) / price
    // This gives us contracts in 6 decimals
    return (usdcAmount * 100000000n) / pricePerContract;
  }

  /**
   * Calculate maximum number of contracts that can be filled based on maker's collateral.
   *
   * For PUT options: maxContracts = maxCollateral / strike
   * For CALL options: INVERSE_CALL maxContracts = maxCollateral / decimal_adjustment;
   *                   LINEAR_CALL maxContracts = maxCollateral / strike (same as PUT)
   * For SPREADs: maxContracts = maxCollateral / spreadWidth
   *
   * @param orderWithSig - Order with signature containing rawApiData
   * @returns Maximum number of contracts (6 decimals for USDC collateral)
   */
  calculateMaxContracts(orderWithSig: OrderWithSignature): bigint {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for calculation');
    }

    const maxCollateral = orderWithSig.availableAmount;
    const strikes = orderWithSig.rawApiData.strikes.map(s => BigInt(s));
    const isCall = orderWithSig.rawApiData.isCall;

    // Ensure we have at least one strike
    if (strikes.length === 0) {
      this.client.logger.warn('Order has no strikes, falling back to price-based calculation');
      return this.calculateNumContracts(maxCollateral, orderWithSig.order.price);
    }

    // For PUT options: collateral required = strike * numContracts
    // maxContracts = (maxCollateral * 1e8) / strike
    if (!isCall && strikes.length === 1) {
      // Vanilla PUT
      const strike = strikes[0]!;
      return (maxCollateral * 100000000n) / strike;
    }

    // For single-strike CALL options:
    // - INVERSE_CALL (base collateral, e.g. WETH 18 dec): 1 contract = 1 underlying token
    //   maxContracts = maxCollateral / 1e12 (convert 18-dec to 6-dec numContracts)
    // - LINEAR_CALL (quote collateral, e.g. USDC 6 dec): same formula as PUT
    //   maxContracts = (maxCollateral * 1e8) / strike
    if (isCall && strikes.length === 1) {
      const collateralAddress = orderWithSig.rawApiData.collateral;
      const collateralDecimals = this.getCollateralDecimals(collateralAddress);
      // Quote-vs-base is a property of the token, not its decimal count: USDC is
      // the only quote collateral; everything else (WETH, cbBTC) is base and sizes
      // 1 contract per whole token
      const usdcAddress = this.client.chainConfig.tokens.USDC?.address;
      const isQuoteCollateral =
        usdcAddress !== undefined &&
        collateralAddress.toLowerCase() === usdcAddress.toLowerCase();
      if (!isQuoteCollateral) {
        // INVERSE_CALL: collateral is base token (WETH/cbBTC), 1 contract = 1 token.
        // Scale native collateral (collateralDecimals) down to 6-dec numContracts
        return (maxCollateral * 10n ** 6n) / 10n ** BigInt(collateralDecimals);
      }
      // LINEAR_CALL: collateral is quote token (USDC), same as PUT
      const strike = strikes[0]!;
      return (maxCollateral * 100000000n) / strike;
    }

    // For SPREADS: collateral = spread_width * numContracts
    // spreadWidth = |strike1 - strike2|
    if (strikes.length === 2) {
      const strike0 = strikes[0]!;
      const strike1 = strikes[1]!;
      const spreadWidth = strike0 > strike1 ? strike0 - strike1 : strike1 - strike0;
      // Reject zero-width spreads — would otherwise throw RangeError (TNU-AUDIT-0015).
      if (spreadWidth === 0n) {
        throw createError(
          'INVALID_ORDER',
          'Option structure has zero spread width — invalid strikes',
        );
      }
      return (maxCollateral * 100000000n) / spreadWidth;
    }

    // For BUTTERFLIES and CONDORS (3-4 strikes): use max loss calculation
    // This is more complex - for now, fall back to the widest spread
    if (strikes.length >= 3) {
      const sortedStrikes = [...strikes].sort((a, b) => (a < b ? -1 : 1));
      const firstStrike = sortedStrikes[0]!;
      const lastStrike = sortedStrikes[sortedStrikes.length - 1]!;
      const maxSpread = lastStrike - firstStrike;
      // Reject degenerate (all-equal) strikes — would otherwise throw RangeError (TNU-AUDIT-0015).
      if (maxSpread === 0n) {
        throw createError(
          'INVALID_ORDER',
          'Option structure has zero spread width — invalid strikes',
        );
      }
      return (maxCollateral * 100000000n) / maxSpread;
    }

    // Fallback: shouldn't reach here, but use a safe default
    this.client.logger.warn('Unknown option structure, falling back to price-based calculation');
    return this.calculateNumContracts(maxCollateral, orderWithSig.order.price);
  }

  /**
   * Preview a fill order without executing it.
   * Returns the computed contract parameters so you can inspect costs before committing.
   *
   * @param orderWithSig - Order with signature from API
   * @param usdcAmount - Amount of collateral to spend (6 decimals). If not provided, uses max available.
   * @param referrer - Referrer address for tracking and fee sharing
   * @returns Preview of the fill: numContracts, collateral details, price, referrer
   *
   * @example
   * ```typescript
   * const preview = client.optionBook.previewFillOrder(order, 10_000000n);
   * console.log(`Contracts: ${preview.numContracts}`);
   * console.log(`Collateral: ${preview.collateralToken}`);
   * console.log(`Price: ${preview.pricePerContract}`);
   * ```
   */
  previewFillOrder(
    orderWithSig: OrderWithSignature,
    usdcAmount?: bigint,
    referrer?: string
  ): {
    numContracts: bigint;
    maxContracts: bigint;
    collateralToken: string;
    pricePerContract: bigint;
    totalCollateral: bigint;
    referrer: string;
    maker: string;
    expiry: bigint;
    isCall: boolean;
    strikes: bigint[];
  } {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    // Calculate max contracts based on maker's collateral (not price!)
    const maxContracts = this.calculateMaxContracts(orderWithSig);

    // Calculate number of contracts
    let numContracts: bigint;
    if (usdcAmount !== undefined) {
      // User specified how much to spend - calculate contracts from premium
      numContracts = this.calculateNumContracts(usdcAmount, orderWithSig.order.price);
    } else {
      // Fill max - use all available contracts
      numContracts = maxContracts;
    }

    // Cap at max available
    if (numContracts > maxContracts) {
      numContracts = maxContracts;
    }

    // Calculate total premium (what taker pays)
    const totalPremium = usdcAmount ?? (numContracts * orderWithSig.order.price / 100000000n);
    const ref = referrer ?? this.client.referrer ?? ZeroAddress;

    return {
      numContracts,
      maxContracts,
      collateralToken: orderWithSig.rawApiData.collateral,
      pricePerContract: orderWithSig.order.price,
      totalCollateral: totalPremium,
      referrer: ref,
      maker: orderWithSig.order.maker,
      expiry: orderWithSig.order.expiry,
      isCall: orderWithSig.rawApiData.isCall,
      strikes: orderWithSig.rawApiData.strikes.map(s => BigInt(s)),
    };
  }

  /**
   * Fill an order on the OptionBook contract
   *
   * @param orderWithSig - Order with signature from API
   * @param usdcAmount - Amount of USDC to spend (6 decimals). If not provided, fills max available.
   * @param referrer - Referrer address for tracking and fee sharing
   * @returns Transaction receipt
   *
   * @throws {ThetanutsError} ORDER_EXPIRED if order has expired
   * @throws {ThetanutsError} INVALID_ORDER if order is missing required data
   * @throws {ThetanutsError} SIGNER_REQUIRED if no signer is configured
   *
   * @example
   * ```typescript
   * // Fill with 10 USDC
   * const receipt = await client.optionBook.fillOrder(
   *   orderWithSignature,
   *   10_000000n,  // 10 USDC (6 decimals)
   *   '0xYourReferrerAddress'
   * );
   * ```
   */
  async fillOrder(
    orderWithSig: OrderWithSignature,
    usdcAmount?: bigint,
    referrer?: string
  ): Promise<TransactionReceipt> {
    const currentTimestamp = await this.client.getCurrentTimestamp();

    // Check if order has expired
    if (orderWithSig.order.expiry <= BigInt(currentTimestamp)) {
      throw createError('ORDER_EXPIRED', 'Order has expired');
    }

    // Validate rawApiData exists
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    // Check order expiry timestamp (when the order itself expires)
    if (orderWithSig.rawApiData.orderExpiryTimestamp <= currentTimestamp) {
      throw createError(
        'ORDER_EXPIRED',
        `Order has expired. Order expiry: ${orderWithSig.rawApiData.orderExpiryTimestamp}, current timestamp: ${currentTimestamp}`
      );
    }

    if (referrer) {
      validateAddress(referrer, 'referrer');
    }

    // Calculate max contracts based on maker's collateral
    const maxContracts = this.calculateMaxContracts(orderWithSig);

    // Calculate number of contracts
    let numContracts: bigint;
    if (usdcAmount !== undefined) {
      // User specified premium to spend
      numContracts = this.calculateNumContracts(usdcAmount, orderWithSig.order.price);
    } else {
      // Fill max available
      numContracts = maxContracts;
    }

    // Ensure we don't exceed max available
    if (numContracts > maxContracts) {
      numContracts = maxContracts;
    }

    const targetContract = this.resolveOptionBookTarget(orderWithSig);

    this.client.logger.debug('Filling order', {
      maker: orderWithSig.order.maker,
      numContracts: numContracts.toString(),
      usdcAmount: usdcAmount?.toString() ?? 'max',
      referrer: referrer ?? 'none',
      targetContract,
      defaultContract: this.contractAddress,
      hasCustomOptionBook: !!orderWithSig.rawApiData.optionBookAddress,
    });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContractAt(targetContract);
      const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
      const ref = referrer ?? this.client.referrer ?? ZeroAddress;

      // Estimate gas and add 20% buffer for Account Abstraction wallets (e.g., Coinbase Smart Wallet)
      const gasEstimate = await contract.fillOrder.estimateGas(
        contractOrder,
        orderWithSig.signature,
        ref
      );
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.fillOrder(
        contractOrder,
        orderWithSig.signature,
        ref,
        { gasLimit }
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Order filled successfully', {
        txHash: receipt.hash,
        maker: orderWithSig.order.maker,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to fill order', { error, orderWithSig });
      throw mapContractError(error);
    }
  }

  /**
   * Encode a fillOrder transaction for use with any wallet library
   *
   * This method returns encoded transaction data that can be sent via viem, wagmi,
   * ethers.js, or any other wallet library. This is especially useful for:
   * - Account Abstraction wallets (Coinbase Smart Wallet, Safe, etc.)
   * - Apps using viem/wagmi instead of ethers.js
   * - Custom transaction signing flows
   *
   * @param orderWithSig - Order with signature from API
   * @param usdcAmount - Amount of USDC to spend (6 decimals). If not provided, fills max available.
   * @param referrer - Referrer address for tracking and fee sharing
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   *
   * @throws {ThetanutsError} INVALID_ORDER if order is missing required data
   *
   * @example
   * ```typescript
   * // With viem/wagmi
   * const { to, data } = client.optionBook.encodeFillOrder(order, amount, referrer);
   * const gas = await publicClient.estimateGas({ to, data, account });
   * const hash = await walletClient.sendTransaction({ to, data, gas: (gas * 120n) / 100n });
   *
   * // With ethers.js
   * const { to, data } = client.optionBook.encodeFillOrder(order, amount, referrer);
   * const tx = await signer.sendTransaction({ to, data, gasLimit: estimatedGas });
   * ```
   */
  encodeFillOrder(
    orderWithSig: OrderWithSignature,
    usdcAmount?: bigint,
    referrer?: string
  ): { to: string; data: string } {
    // Validate rawApiData exists
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    if (referrer) {
      validateAddress(referrer, 'referrer');
    }

    // Calculate max contracts based on maker's collateral
    const maxContracts = this.calculateMaxContracts(orderWithSig);

    // Calculate number of contracts
    let numContracts: bigint;
    if (usdcAmount !== undefined) {
      // User specified premium to spend
      numContracts = this.calculateNumContracts(usdcAmount, orderWithSig.order.price);
    } else {
      // Fill max available
      numContracts = maxContracts;
    }

    // Ensure we don't exceed max available
    if (numContracts > maxContracts) {
      numContracts = maxContracts;
    }

    const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
    const ref = referrer ?? this.client.referrer ?? ZeroAddress;

    const iface = new Interface(OPTION_BOOK_ABI);
    const data = iface.encodeFunctionData('fillOrder', [
      contractOrder,
      orderWithSig.signature,
      ref
    ]);

    const targetContract = this.resolveOptionBookTarget(orderWithSig);

    return {
      to: targetContract,
      data,
    };
  }

  /**
   * Get fee amount for a token/referrer pair
   *
   * @param token - Token address
   * @param referrer - Referrer address
   * @returns Fee amount
   *
   * @example
   * ```typescript
   * const feeAmount = await client.optionBook.getFees('0xUSDC', '0xReferrer');
   * ```
   */
  async getFees(token: string, referrer: string): Promise<bigint> {
    validateAddress(token, 'token');
    validateAddress(referrer, 'referrer');

    try {
      const contract = this.getReadContract();
      return await contract.fees(token, referrer);
    } catch (error) {
      this.client.logger.error('Failed to get fees', { error, token, referrer });
      throw mapContractError(error);
    }
  }

  /**
   * Check all claimable referrer fees across every configured collateral token.
   *
   * Calls `getFees(token, address)` for each token in the chain config in parallel
   * (via `Promise.allSettled`) and returns only tokens with a non-zero balance.
   * Saves the caller from manually iterating USDC, WETH, cbBTC, etc.
   *
   * @param address - Referrer address to check
   * @returns Array of `{ token, symbol, decimals, amount }` for each non-zero balance
   *
   * @example
   * ```typescript
   * const claimable = await client.optionBook.getAllClaimableFees('0xMyReferrer');
   * for (const fee of claimable) {
   *   console.log(`${fee.symbol}: ${ethers.formatUnits(fee.amount, fee.decimals)}`);
   * }
   * ```
   */
  async getAllClaimableFees(address: string): Promise<ClaimableFee[]> {
    validateAddress(address, 'address');
    this.client.logger.debug('Checking all claimable fees', { address });

    const tokens = this.client.chainConfig.tokens;
    const entries = Object.entries(tokens);

    // Parallel RPC reads via Promise.allSettled — one rejected call won't block the rest
    const settled = await Promise.allSettled(
      entries.map(async ([symbol, config]) => {
        const amount = await this.getFees(config.address, address);
        return { token: config.address, symbol, decimals: config.decimals, amount };
      })
    );

    const results: ClaimableFee[] = [];
    let rejectedCount = 0;
    const rejectionReasons: unknown[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        if (result.value.amount > 0n) {
          results.push(result.value);
        }
      } else {
        rejectedCount += 1;
        rejectionReasons.push(result.reason);
      }
    }
    // Surface partial-failure visibility — previously rejections were silently
    // swallowed, hiding RPC degradation from callers (TNU-AUDIT-0071).
    if (rejectedCount > 0) {
      this.client.logger.warn('getAllClaimableFees: some token reads failed', {
        rejectedCount,
        totalQueried: entries.length,
        firstError: rejectionReasons[0],
      });
      if (rejectedCount === entries.length) {
        throw createError(
          'NETWORK_UNSUPPORTED',
          `All ${entries.length} token fee reads failed; check RPC connectivity.`,
        );
      }
    }

    return results;
  }

  /**
   * Claim accumulated referrer fees
   *
   * @param token - Token address to claim fees for
   * @returns Transaction receipt
   *
   * @throws {ThetanutsError} SIGNER_REQUIRED if no signer is configured
   *
   * @example
   * ```typescript
   * const receipt = await client.optionBook.claimFees('0xUSDC');
   * ```
   */
  async claimFees(token: string): Promise<TransactionReceipt> {
    validateAddress(token, 'token');

    this.client.logger.debug('Claiming fees', { token });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract();

      // Estimate gas and add 20% buffer for Account Abstraction wallets (e.g., Coinbase Smart Wallet)
      const gasEstimate = await contract.claimFees.estimateGas(token);
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.claimFees(token, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Fees claimed successfully', {
        txHash: receipt.hash,
        token,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to claim fees', { error, token });
      throw mapContractError(error);
    }
  }

  /**
   * Claim all accumulated referrer fees across every collateral token.
   *
   * Calls `getAllClaimableFees()` to find non-zero balances, then calls
   * `claimFees()` for each one sequentially (write txs need to be mined
   * before the next one can use accurate gas estimation).
   *
   * If one token's claim fails (gas spike, RPC timeout), the error is recorded
   * and remaining tokens are still claimed. Each result has either a `receipt`
   * (success) or `error` (failure), so the caller knows exactly what happened.
   *
   * @param address - Referrer address to check. If omitted, uses the signer's address.
   * @returns Array of `{ symbol, amount, receipt?, error? }` for each token attempted
   *
   * @throws {ThetanutsError} SIGNER_REQUIRED if no signer is configured and no address provided
   *
   * @example
   * ```typescript
   * const results = await client.optionBook.claimAllFees();
   * for (const r of results) {
   *   if (r.receipt) {
   *     console.log(`Claimed ${r.symbol}: tx ${r.receipt.hash}`);
   *   } else {
   *     console.log(`Failed ${r.symbol}: ${r.error?.message}`);
   *   }
   * }
   * ```
   */
  async claimAllFees(address?: string): Promise<ClaimFeeResult[]> {
    const referrer = address ?? await this.client.signer?.getAddress();
    if (!referrer) {
      throw createError('SIGNER_REQUIRED', 'Signer required to determine referrer address');
    }

    const claimable = await this.getAllClaimableFees(referrer);
    if (claimable.length === 0) {
      this.client.logger.info('No claimable fees found', { referrer });
      return [];
    }

    const results: ClaimFeeResult[] = [];
    for (const fee of claimable) {
      try {
        const receipt = await this.claimFees(fee.token);
        results.push({ symbol: fee.symbol, amount: fee.amount, receipt });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.client.logger.warn('Failed to claim fees for token', { symbol: fee.symbol, error: error.message });
        results.push({ symbol: fee.symbol, amount: fee.amount, error });
      }
    }

    return results;
  }

  /**
   * Swap tokens and fill an order in one transaction
   *
   * @param orderWithSig - Order with signature from API
   * @param swapRouter - Swap router address
   * @param swapSrcToken - Source token to swap from
   * @param swapSrcAmount - Amount of source token to swap
   * @param swapData - Encoded swap calldata
   * @param referrer - Referrer address
   * @returns Transaction receipt
   */
  async swapAndFillOrder(
    orderWithSig: OrderWithSignature,
    swapRouter: string,
    swapSrcToken: string,
    swapSrcAmount: bigint,
    swapData: string,
    referrer?: string
  ): Promise<TransactionReceipt> {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    validateAddress(swapRouter, 'swapRouter');
    validateAddress(swapSrcToken, 'swapSrcToken');
    this.validateSwapParams(swapRouter, swapSrcToken, swapSrcAmount, swapData);
    if (referrer) {
      validateAddress(referrer, 'referrer');
    }

    const numContracts = this.calculateMaxContracts(orderWithSig);
    const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
    const ref = referrer ?? this.client.referrer ?? ZeroAddress;

    this.client.logger.debug('Swap and fill order', {
      maker: orderWithSig.order.maker,
      swapRouter,
      swapSrcToken,
      swapSrcAmount: swapSrcAmount.toString(),
    });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract();
      const gasEstimate = await contract.swapAndFillOrder.estimateGas(
        contractOrder, orderWithSig.signature, swapRouter, swapSrcToken, swapSrcAmount, swapData, ref
      );
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.swapAndFillOrder(
        contractOrder, orderWithSig.signature, swapRouter, swapSrcToken, swapSrcAmount, swapData, ref,
        { gasLimit }
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Swap and fill order completed', { txHash: receipt.hash });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to swap and fill order', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Encode a swapAndFillOrder transaction for use with any wallet library
   *
   * @param orderWithSig - Order with signature from API
   * @param swapRouter - Swap router address
   * @param swapSrcToken - Source token to swap from
   * @param swapSrcAmount - Amount of source token to swap
   * @param swapData - Encoded swap calldata
   * @param referrer - Referrer address
   * @returns Object with `to` and `data` for the transaction
   */
  encodeSwapAndFillOrder(
    orderWithSig: OrderWithSignature,
    swapRouter: string,
    swapSrcToken: string,
    swapSrcAmount: bigint,
    swapData: string,
    referrer?: string
  ): { to: string; data: string } {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }
    validateAddress(swapRouter, 'swapRouter');
    validateAddress(swapSrcToken, 'swapSrcToken');
    if (referrer) {
      validateAddress(referrer, 'referrer');
    }
    this.validateSwapParams(swapRouter, swapSrcToken, swapSrcAmount, swapData);

    const numContracts = this.calculateMaxContracts(orderWithSig);
    const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
    const ref = referrer ?? this.client.referrer ?? ZeroAddress;

    const iface = new Interface(OPTION_BOOK_ABI);
    const data = iface.encodeFunctionData('swapAndFillOrder', [
      contractOrder, orderWithSig.signature, swapRouter, swapSrcToken, swapSrcAmount, swapData, ref
    ]);

    return { to: this.contractAddress, data };
  }

  private validateSwapParams(
    swapRouter: string,
    swapSrcToken: string,
    swapSrcAmount: bigint,
    swapData: string,
  ): void {
    validateAddress(swapRouter, 'swapRouter');
    validateAddress(swapSrcToken, 'swapSrcToken');
    if (swapSrcAmount <= 0n) {
      throw createError('INVALID_PARAMS', 'swapSrcAmount must be positive');
    }
    validateHexString(swapData, 'swapData');
    if (swapData === '0x') {
      throw createError('INVALID_PARAMS', 'swapData cannot be empty for swapAndFillOrder');
    }
  }

  /**
   * Cancel an existing order (maker only)
   *
   * @param orderWithSig - Order with signature from API
   * @returns Transaction receipt
   */
  async cancelOrder(orderWithSig: OrderWithSignature): Promise<TransactionReceipt> {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    this.client.logger.debug('Cancelling order', { maker: orderWithSig.order.maker });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract();
      const numContracts = this.calculateMaxContracts(orderWithSig);
      const contractOrder = this.buildContractOrder(orderWithSig, numContracts);

      const gasEstimate = await contract.cancelOrder.estimateGas(contractOrder);
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.cancelOrder(contractOrder, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Order cancelled', { txHash: receipt.hash });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to cancel order', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the amount filled for a given nonce
   *
   * @param nonce - Order nonce
   * @returns Amount filled
   */
  async getAmountFilled(nonce: bigint): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.amountFilled(nonce);
    } catch (error) {
      this.client.logger.error('Failed to get amount filled', { error, nonce: nonce.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Get the referrer fee split in basis points
   *
   * @param referrer - Referrer address
   * @returns Fee split in basis points
   */
  async getReferrerFeeSplit(referrer: string): Promise<bigint> {
    validateAddress(referrer, 'referrer');

    try {
      const contract = this.getReadContract();
      return await contract.referrerFeeSplitBps(referrer);
    } catch (error) {
      this.client.logger.error('Failed to get referrer fee split', { error, referrer });
      throw mapContractError(error);
    }
  }

  /**
   * Set the referrer fee split (admin only)
   *
   * @param referrer - Referrer address
   * @param feeBps - Fee in basis points
   * @returns Transaction receipt
   *
   * @remarks Requires factory owner authorization. Reverts for non-owner callers.
   */
  async setReferrerFeeSplit(referrer: string, feeBps: bigint): Promise<TransactionReceipt> {
    validateAddress(referrer, 'referrer');

    this.client.logger.debug('Setting referrer fee split', { referrer, feeBps: feeBps.toString() });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract();
      const gasEstimate = await contract.setReferrerFeeSplit.estimateGas(referrer, feeBps);
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.setReferrerFeeSplit(referrer, feeBps, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Referrer fee split set', { txHash: receipt.hash });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to set referrer fee split', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Sweep protocol fees (admin only)
   *
   * @param token - Token address to sweep
   * @returns Transaction receipt
   *
   * @remarks Sends accumulated fees to the factory owner. Callable by anyone but only benefits the owner.
   */
  async sweepProtocolFees(token: string): Promise<TransactionReceipt> {
    validateAddress(token, 'token');

    this.client.logger.debug('Sweeping protocol fees', { token });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract();
      const gasEstimate = await contract.sweepProtocolFees.estimateGas(token);
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.sweepProtocolFees(token, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Protocol fees swept', { txHash: receipt.hash });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to sweep protocol fees', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the factory address
   *
   * @returns Factory contract address
   */
  async getFactory(): Promise<string> {
    try {
      const contract = this.getReadContract();
      return await contract.factory();
    } catch (error) {
      this.client.logger.error('Failed to get factory', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the PRICE_DECIMALS constant
   *
   * @returns Price decimals value
   */
  async getPriceDecimals(): Promise<bigint> {
    try {
      const contract = this.getReadContract();
      return await contract.PRICE_DECIMALS();
    } catch (error) {
      this.client.logger.error('Failed to get price decimals', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Compute the nonce for an order
   *
   * @param orderWithSig - Order with signature from API
   * @returns Computed nonce
   */
  async computeNonce(orderWithSig: OrderWithSignature): Promise<bigint> {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    try {
      const contract = this.getReadContract();
      const numContracts = this.calculateMaxContracts(orderWithSig);
      const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
      return await contract.computeNonce(contractOrder);
    } catch (error) {
      this.client.logger.error('Failed to compute nonce', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Hash an order for EIP-712 signing
   *
   * @param orderWithSig - Order with signature from API
   * @returns EIP-712 hash
   */
  async hashOrder(orderWithSig: OrderWithSignature): Promise<string> {
    if (!orderWithSig.rawApiData) {
      throw createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call');
    }

    try {
      const contract = this.getReadContract();
      const numContracts = this.calculateMaxContracts(orderWithSig);
      const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
      return await contract.hashOrder(contractOrder);
    } catch (error) {
      this.client.logger.error('Failed to hash order', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Get the EIP-712 domain information
   *
   * @returns EIP-712 domain
   */
  async getEip712Domain(): Promise<Eip712Domain> {
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
   * Get the LIMIT_ORDER_TYPEHASH constant
   *
   * @returns Typehash bytes32
   */
  async getLimitOrderTypehash(): Promise<string> {
    try {
      const contract = this.getReadContract();
      return await contract.LIMIT_ORDER_TYPEHASH();
    } catch (error) {
      this.client.logger.error('Failed to get limit order typehash', { error });
      throw mapContractError(error);
    }
  }

  // ============ Call Static Methods (transaction simulation) ============

  /**
   * Simulate filling an order without submitting the transaction.
   *
   * Uses ethers.js v6 staticCall to verify the transaction would succeed
   * and estimate gas without spending any gas.
   *
   * @param orderWithSig - Order with signature from API
   * @param usdcAmount - Amount of USDC to spend (6 decimals). If not provided, fills max available.
   * @param referrer - Referrer address
   * @returns CallStaticResult indicating if the transaction would succeed
   *
   * @example
   * ```typescript
   * const result = await client.optionBook.callStaticFillOrder(order, 10_000000n);
   * if (result.success) {
   *   console.log('Fill would succeed, gas estimate:', result.gasEstimate);
   *   const receipt = await client.optionBook.fillOrder(order, 10_000000n);
   * } else {
   *   console.error('Fill would fail:', result.error?.message);
   * }
   * ```
   */
  async callStaticFillOrder(
    orderWithSig: OrderWithSignature,
    usdcAmount?: bigint,
    referrer?: string
  ): Promise<CallStaticResult<void>> {
    if (!orderWithSig.rawApiData) {
      return {
        success: false,
        error: createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call'),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }

    if (referrer) {
      validateAddress(referrer, 'referrer');
    }

    // Calculate max contracts based on maker's collateral
    const maxContracts = this.calculateMaxContracts(orderWithSig);

    // Calculate number of contracts
    let numContracts: bigint;
    if (usdcAmount !== undefined) {
      numContracts = this.calculateNumContracts(usdcAmount, orderWithSig.order.price);
    } else {
      numContracts = maxContracts;
    }

    // Ensure we don't exceed max available
    if (numContracts > maxContracts) {
      numContracts = maxContracts;
    }

    const targetContract = this.resolveOptionBookTarget(orderWithSig);

    this.client.logger.debug('Simulating fillOrder (callStatic)', {
      maker: orderWithSig.order.maker,
      numContracts: numContracts.toString(),
    });

    try {
      await this.client.assertNetwork();
      const signer = this.client.requireSigner();
      const contract = new Contract(targetContract, OPTION_BOOK_ABI, signer);
      const contractOrder = this.buildContractOrder(orderWithSig, numContracts);
      const ref = referrer ?? this.client.referrer ?? ZeroAddress;

      // Use staticCall to simulate
      await contract.getFunction('fillOrder').staticCall(
        contractOrder,
        orderWithSig.signature,
        ref
      );

      // Get gas estimate
      const gasEstimate = await contract.getFunction('fillOrder').estimateGas(
        contractOrder,
        orderWithSig.signature,
        ref
      );

      return {
        success: true,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticFillOrder failed - transaction would revert', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  /**
   * Simulate cancelling an order without submitting the transaction.
   *
   * @param orderWithSig - Order with signature from API
   * @returns CallStaticResult indicating if the transaction would succeed
   */
  async callStaticCancelOrder(
    orderWithSig: OrderWithSignature
  ): Promise<CallStaticResult<void>> {
    if (!orderWithSig.rawApiData) {
      return {
        success: false,
        error: createError('INVALID_ORDER', 'Order is missing rawApiData required for contract call'),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }

    this.client.logger.debug('Simulating cancelOrder (callStatic)', {
      maker: orderWithSig.order.maker,
    });

    try {
      await this.client.assertNetwork();
      const signer = this.client.requireSigner();
      const contract = new Contract(this.contractAddress, OPTION_BOOK_ABI, signer);
      const numContracts = this.calculateMaxContracts(orderWithSig);
      const contractOrder = this.buildContractOrder(orderWithSig, numContracts);

      // Use staticCall to simulate
      await contract.getFunction('cancelOrder').staticCall(contractOrder);

      // Get gas estimate
      const gasEstimate = await contract.getFunction('cancelOrder').estimateGas(contractOrder);

      return {
        success: true,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticCancelOrder failed', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  /**
   * Look up collateral token decimals from chain config.
   * Falls back to 18 if not found (safe default for INVERSE_CALL).
   */
  private getCollateralDecimals(collateralAddress: string): number {
    const tokens = this.client.chainConfig.collateralTokens;
    for (const token of Object.values(tokens)) {
      if (token.address.toLowerCase() === collateralAddress.toLowerCase()) {
        return token.decimals;
      }
    }
    return 18;
  }
}
