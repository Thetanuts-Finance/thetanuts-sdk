/**
 * WheelVault Module — Wheel strategy vaults on Ethereum mainnet
 *
 * Wraps multi-series wheel strategy vault contracts. Each asset
 * (WBTC, XAUt, SPYon) has its own Vault, Markets, and MarketsLens contracts.
 * Shared infrastructure includes the Router, Lens, Multicall3, and Uniswap V3 NPM.
 *
 * @example
 * ```typescript
 * const client = new ThetanutsClient({ chainId: 1, provider, signer });
 *
 * // Read aggregated vault state via multicall
 * const state = await client.wheelVault.getVaultState(vaultAddress, 0);
 *
 * // Deposit into a vault series
 * const result = await client.wheelVault.deposit(vaultAddress, 0, baseAmt, quoteAmt, expectedPrice);
 *
 * // Buy options via markets
 * await client.wheelVault.marketFill(marketsAddress, fillParams);
 * ```
 */

import { Contract, Interface, ZeroAddress } from 'ethers';
import type { TransactionReceipt, ContractTransactionResponse } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import {
  WHEEL_VAULT_ABI,
  VAULT_MATH_ABI,
  WHEEL_MARKETS_ABI,
  WHEEL_MARKETS_LENS_ABI,
  WHEEL_VAULT_ROUTER_ABI,
  WHEEL_VAULT_LENS_ABI,
  MULTICALL3_ABI,
  UNISWAP_NPM_ABI,
} from '../abis/wheelVault.js';
import { WHEEL_VAULT_CONFIG } from '../chains/wheelVault.js';
import { createError, mapContractError } from '../utils/errors.js';
import { validateAddress } from '../utils/validation.js';
import type {
  VaultState,
  VaultSeries,
  ShareSnapshot,
  DepthChartResult,
  DeficitPreview,
  BucketPreview,
  FillPremiumPreview,
  FillTranche,
  BuyerOption,
  SellerPosition,
  ClaimableSummary,
  ExercisePreview,
  DepositPreview,
  WithdrawPreview,
  DepositSplitEstimate,
  VaultDepositResult,
  VaultWithdrawResult,
  DepositSingleParams,
  DepositDualParams,
  WithdrawSingleParams,
  WithdrawSingleWithPermitParams,
  MarketFillParams,
  DepositToBucketParams,
  UniswapV3Position,
} from '../types/wheelVault.js';

// ─── Multicall Tuple ───

interface MulticallCall {
  target: string;
  callData: string;
}

// ─── Typed Contract Interfaces ───

interface Multicall3Contract {
  aggregate(calls: MulticallCall[]): Promise<[bigint, string[]]>;
}

interface VaultReadContract {
  series(seriesId: number): Promise<{
    strike: bigint; epochExpiry: bigint; strategy: bigint; totalShares: bigint;
    idleBase: bigint; idleQuote: bigint; contributionLiq: [bigint, bigint, bigint]; active: boolean;
  }>;
  seriesCount(): Promise<bigint>;
  getSnapshotRange(seriesId: number, fromIndex: number, toIndex: number): Promise<Array<{
    basePerShare: bigint; quotePerShare: bigint; priceAtRoll: bigint; timestamp: bigint; epoch: bigint;
  }>>;
  getEpochExpiries(seriesId: number): Promise<bigint[]>;
  getShareValueInQuote(seriesId: number, shares: bigint): Promise<bigint>;
}

interface VaultWriteContract {
  'deposit(uint256,uint256,uint256,uint256)': {
    (seriesId: number, baseAmt: bigint, quoteAmt: bigint, expectedPrice: bigint): Promise<ContractTransactionResponse>;
    (seriesId: number, baseAmt: bigint, quoteAmt: bigint, expectedPrice: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(seriesId: number, baseAmt: bigint, quoteAmt: bigint, expectedPrice: bigint): Promise<bigint>;
  };
  'withdraw(uint256,uint256)': {
    (seriesId: number, sharesToBurn: bigint): Promise<ContractTransactionResponse>;
    (seriesId: number, sharesToBurn: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(seriesId: number, sharesToBurn: bigint): Promise<bigint>;
  };
  withdrawIdle: {
    (seriesId: number, sharesToBurn: bigint): Promise<ContractTransactionResponse>;
    (seriesId: number, sharesToBurn: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(seriesId: number, sharesToBurn: bigint): Promise<bigint>;
  };
  poke: {
    (): Promise<ContractTransactionResponse>;
    (overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(): Promise<bigint>;
  };
  trigger: {
    (): Promise<ContractTransactionResponse>;
    (overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(): Promise<bigint>;
  };
}

interface VaultMathContract {
  bsBaseDelta(spot: bigint, strike: bigint, ivBps: bigint, tteSeconds: bigint): Promise<bigint>;
}

interface RouterContract {
  depositSingle: {
    (vault: string, seriesId: number, depositToken: string, depositAmount: bigint, aggregator: string, swapData: string, expectedPrice: bigint, minShares: bigint): Promise<ContractTransactionResponse>;
    (vault: string, seriesId: number, depositToken: string, depositAmount: bigint, aggregator: string, swapData: string, expectedPrice: bigint, minShares: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(vault: string, seriesId: number, depositToken: string, depositAmount: bigint, aggregator: string, swapData: string, expectedPrice: bigint, minShares: bigint): Promise<bigint>;
  };
  depositDual: {
    (vault: string, seriesId: number, baseAmt: bigint, quoteAmt: bigint, expectedPrice: bigint, minShares: bigint): Promise<ContractTransactionResponse>;
    (vault: string, seriesId: number, baseAmt: bigint, quoteAmt: bigint, expectedPrice: bigint, minShares: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(vault: string, seriesId: number, baseAmt: bigint, quoteAmt: bigint, expectedPrice: bigint, minShares: bigint): Promise<bigint>;
  };
  withdrawSingle: {
    (vault: string, seriesId: number, shares: bigint, targetToken: string, aggregator: string, swapData: string, minOut: bigint): Promise<ContractTransactionResponse>;
    (vault: string, seriesId: number, shares: bigint, targetToken: string, aggregator: string, swapData: string, minOut: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(vault: string, seriesId: number, shares: bigint, targetToken: string, aggregator: string, swapData: string, minOut: bigint): Promise<bigint>;
  };
  withdrawSingleWithPermit: {
    (vault: string, seriesId: number, shares: bigint, targetToken: string, aggregator: string, swapData: string, minOut: bigint, deadline: bigint, v: number, r: string, s: string): Promise<ContractTransactionResponse>;
    (vault: string, seriesId: number, shares: bigint, targetToken: string, aggregator: string, swapData: string, minOut: bigint, deadline: bigint, v: number, r: string, s: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(vault: string, seriesId: number, shares: bigint, targetToken: string, aggregator: string, swapData: string, minOut: bigint, deadline: bigint, v: number, r: string, s: string): Promise<bigint>;
  };
}

interface LensContract {
  estimateDepositSplit(vault: string, seriesId: number, token: string, amount: bigint): Promise<[bigint, bigint]>;
  previewDeposit(vault: string, seriesId: number, baseAmt: bigint, quoteAmt: bigint): Promise<bigint>;
  previewWithdraw(vault: string, seriesId: number, shares: bigint): Promise<[bigint, bigint, bigint, bigint]>;
  getSeriesAssets(vault: string, seriesId: number): Promise<[bigint, bigint, bigint]>;
}

type SwapTuple = [string, string, bigint, bigint, string];

interface MarketsContract {
  marketFill: {
    (seriesId: number, isCall: boolean, sharesToFill: bigint, maxIvBps: number, minCollateralOut: bigint, maxPremium: bigint, maxStructDeficitQuote: bigint, maxExecutionTopupQuote: bigint, deadline: bigint, useSwap: boolean, swap: SwapTuple): Promise<ContractTransactionResponse>;
    (seriesId: number, isCall: boolean, sharesToFill: bigint, maxIvBps: number, minCollateralOut: bigint, maxPremium: bigint, maxStructDeficitQuote: bigint, maxExecutionTopupQuote: bigint, deadline: bigint, useSwap: boolean, swap: SwapTuple, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(seriesId: number, isCall: boolean, sharesToFill: bigint, maxIvBps: number, minCollateralOut: bigint, maxPremium: bigint, maxStructDeficitQuote: bigint, maxExecutionTopupQuote: bigint, deadline: bigint, useSwap: boolean, swap: SwapTuple): Promise<bigint>;
  };
  depositToBucket: {
    (seriesId: number, ivBps: number, shares: bigint, minAcceptableBps: number, expiryType: number, expiryParam: bigint): Promise<ContractTransactionResponse>;
    (seriesId: number, ivBps: number, shares: bigint, minAcceptableBps: number, expiryType: number, expiryParam: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(seriesId: number, ivBps: number, shares: bigint, minAcceptableBps: number, expiryType: number, expiryParam: bigint): Promise<bigint>;
  };
  cancelDeposit: {
    (entryId: bigint): Promise<ContractTransactionResponse>;
    (entryId: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(entryId: bigint): Promise<bigint>;
  };
  claim: {
    (token: string): Promise<ContractTransactionResponse>;
    (token: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(token: string): Promise<bigint>;
  };
  exercise: {
    (optionId: bigint): Promise<ContractTransactionResponse>;
    (optionId: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(optionId: bigint): Promise<bigint>;
  };
  expire: {
    (optionId: bigint): Promise<ContractTransactionResponse>;
    (optionId: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(optionId: bigint): Promise<bigint>;
  };
  swapAndExercise: {
    (optionId: bigint, swapTarget: string, swapData: string): Promise<ContractTransactionResponse>;
    (optionId: bigint, swapTarget: string, swapData: string, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(optionId: bigint, swapTarget: string, swapData: string): Promise<bigint>;
  };
}

interface MarketsLensContract {
  getDepthChart(seriesId: number, isCall: boolean, maxIvBps: number): Promise<[
    {
      lockPerShareBase: bigint; spotPrice: bigint; hedgingCostPerShareQuote: bigint;
      intrinsicPerShareQuote: bigint; effectiveDeficitPerShareQuote: bigint; tte: bigint; strike: bigint;
    },
    Array<{
      ivBps: bigint; premiumPerUnitQuote: bigint; premiumPerShareQuote: bigint;
      cutoffBps: bigint; sellerNetPerShareQuote: bigint; fillableShares: bigint;
      contributorsAvailable: bigint; scannedCount: bigint; bucketActive: boolean;
    }>,
  ]>;
  previewFillPremium(seriesId: number, isCall: boolean, sharesToFill: bigint, maxIvBps: number): Promise<{
    totalPremiumQuote: bigint; totalSharesFilled: bigint; trancheCount: bigint;
    tranches: Array<{ ivBps: bigint; sharesFilled: bigint; premiumQuote: bigint; premiumPerShareQuote: bigint }>;
  }>;
  getBuyerOptions(buyer: string, fromId: bigint, maxCount: bigint): Promise<Array<{
    optionId: bigint; side: bigint; status: bigint; seriesId: bigint;
    expiry: bigint; notionalBase: bigint; lockAmount: bigint; strike18: bigint;
  }>>;
  getSellerPositions(seller: string, seriesId: number, maxIvBps: number, maxEntries: number): Promise<Array<{
    entryId: bigint; ivBps: bigint; shares: bigint; minAcceptableBps: bigint; isExpired: boolean;
  }>>;
  getClaimableSummary(seller: string, seriesIds: number[]): Promise<[bigint, bigint, bigint[]]>;
  previewExercise(optionId: bigint): Promise<{
    isCall: boolean; lockAmount: bigint; strikePayment: bigint; spotValue: bigint;
    exerciseProfit: bigint; expiry: bigint; canExercise: boolean; isExpired: boolean;
  }>;
}

export class WheelVaultModule {
  private readonly _disabled: boolean;

  constructor(private readonly client: ThetanutsClient) {
    this._disabled = client.chainId !== WHEEL_VAULT_CONFIG.chainId;
  }

  // ─── Guard ───

  private ensureEnabled(): void {
    if (this._disabled) {
      throw createError(
        'NETWORK_UNSUPPORTED',
        `WheelVault module requires chainId ${WHEEL_VAULT_CONFIG.chainId} (Ethereum), but client is on chainId ${this.client.chainId}`,
      );
    }
  }

  private validateConfiguredAddress(address: string, label: string, allowed: readonly string[]): void {
    validateAddress(address, label);
    const normalized = address.toLowerCase();
    if (!allowed.some((allowedAddress) => allowedAddress.toLowerCase() === normalized)) {
      throw createError(
        'INVALID_PARAMS',
        `${label} is not a configured wheel vault contract address`
      );
    }
  }

  private validateConfiguredVault(address: string): void {
    this.validateConfiguredAddress(
      address,
      'vaultAddress',
      Object.values(WHEEL_VAULT_CONFIG.assets).map((asset) => asset.vault)
    );
  }

  private validateConfiguredMarkets(address: string): void {
    this.validateConfiguredAddress(
      address,
      'marketsAddress',
      Object.values(WHEEL_VAULT_CONFIG.assets).map((asset) => asset.markets)
    );
  }

  private validateConfiguredMarketsLens(address: string): void {
    this.validateConfiguredAddress(
      address,
      'lensAddress',
      Object.values(WHEEL_VAULT_CONFIG.assets).map((asset) => asset.marketsLens)
    );
  }

  private validateConfiguredSwapRouter(address: string, label: string): void {
    this.validateConfiguredAddress(address, label, [
      WHEEL_VAULT_CONFIG.swapAggregatorRouter,
      ZeroAddress,
    ]);
  }

  // ─── Private Contract Accessors ───

  private getMulticall3(): Multicall3Contract {
    return new Contract(
      WHEEL_VAULT_CONFIG.contracts.multicall3,
      MULTICALL3_ABI,
      this.client.provider,
    ) as unknown as Multicall3Contract;
  }

  private getVaultRead(vaultAddress: string): VaultReadContract {
    return new Contract(vaultAddress, WHEEL_VAULT_ABI, this.client.provider) as unknown as VaultReadContract;
  }

  private getVaultWrite(vaultAddress: string): VaultWriteContract {
    const signer = this.client.requireSigner();
    return new Contract(vaultAddress, WHEEL_VAULT_ABI, signer) as unknown as VaultWriteContract;
  }

  private getVaultMath(address: string): VaultMathContract {
    return new Contract(address, VAULT_MATH_ABI, this.client.provider) as unknown as VaultMathContract;
  }

  private getRouter(): RouterContract {
    const signer = this.client.requireSigner();
    return new Contract(
      WHEEL_VAULT_CONFIG.contracts.router,
      WHEEL_VAULT_ROUTER_ABI,
      signer,
    ) as unknown as RouterContract;
  }

  private getLens(): LensContract {
    return new Contract(
      WHEEL_VAULT_CONFIG.contracts.lens,
      WHEEL_VAULT_LENS_ABI,
      this.client.provider,
    ) as unknown as LensContract;
  }

  private getMarkets(marketsAddress: string): MarketsContract {
    const signer = this.client.requireSigner();
    return new Contract(marketsAddress, WHEEL_MARKETS_ABI, signer) as unknown as MarketsContract;
  }

  private getMarketsLens(lensAddress: string): MarketsLensContract {
    return new Contract(lensAddress, WHEEL_MARKETS_LENS_ABI, this.client.provider) as unknown as MarketsLensContract;
  }

  // ═══════════════════════════════════════════════════════
  // Multicall Utility
  // ═══════════════════════════════════════════════════════

  /**
   * Batch multiple read calls via Multicall3.aggregate.
   *
   * @param calls - Array of { target, callData } tuples
   * @returns Array of raw return data bytes (one per call)
   */
  async multicall(calls: MulticallCall[]): Promise<string[]> {
    this.ensureEnabled();

    const multicall3 = this.getMulticall3();

    try {
      const [, returnData] = await multicall3.aggregate(calls);
      return returnData;
    } catch (error) {
      this.client.logger.error('Multicall aggregate failed', { error });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Vault Reads
  // ═══════════════════════════════════════════════════════

  /**
   * Get aggregated vault state via a single batched multicall.
   * Fetches 14 fields in one RPC round-trip: seriesCount, series struct,
   * currentPrice, totalAssets, ivBps, seriesToken, seriesTotalValue,
   * epochExpiries, vaultMath, base, baseDecimals, quoteDecimals, baseIsToken0, paused.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Which series to query
   * @returns Aggregated VaultState
   */
  async getVaultState(vaultAddress: string, seriesId: number): Promise<VaultState> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const iface = new Interface(WHEEL_VAULT_ABI);

    const calls: MulticallCall[] = [
      { target: vaultAddress, callData: iface.encodeFunctionData('seriesCount') },                  // 0
      { target: vaultAddress, callData: iface.encodeFunctionData('series', [seriesId]) },           // 1
      { target: vaultAddress, callData: iface.encodeFunctionData('getCurrentPrice') },              // 2
      { target: vaultAddress, callData: iface.encodeFunctionData('totalAssets') },                  // 3
      { target: vaultAddress, callData: iface.encodeFunctionData('ivBps') },                        // 4
      { target: vaultAddress, callData: iface.encodeFunctionData('seriesToken', [seriesId]) },      // 5
      { target: vaultAddress, callData: iface.encodeFunctionData('seriesTotalValue', [seriesId]) }, // 6
      { target: vaultAddress, callData: iface.encodeFunctionData('getEpochExpiries', [seriesId]) }, // 7
      { target: vaultAddress, callData: iface.encodeFunctionData('vaultMath') },                    // 8
      { target: vaultAddress, callData: iface.encodeFunctionData('base') },                         // 9
      { target: vaultAddress, callData: iface.encodeFunctionData('baseDecimals') },                 // 10
      { target: vaultAddress, callData: iface.encodeFunctionData('quoteDecimals') },                // 11
      { target: vaultAddress, callData: iface.encodeFunctionData('baseIsToken0') },                 // 12
      { target: vaultAddress, callData: iface.encodeFunctionData('paused') },                       // 13
    ];

    try {
      const returnData = await this.multicall(calls);

      // Decode each result — returnData indices match calls above
      const seriesCount = Number(iface.decodeFunctionResult('seriesCount', returnData[0]!)[0]);

      const seriesResult = iface.decodeFunctionResult('series', returnData[1]!);
      const series: VaultSeries = {
        strike: BigInt(seriesResult[0] as bigint),
        epochExpiry: BigInt(seriesResult[1] as bigint),
        strategy: BigInt(seriesResult[2] as bigint),
        totalShares: BigInt(seriesResult[3] as bigint),
        idleBase: BigInt(seriesResult[4] as bigint),
        idleQuote: BigInt(seriesResult[5] as bigint),
        contributionLiq: [
          BigInt((seriesResult[6] as bigint[])[0]!),
          BigInt((seriesResult[6] as bigint[])[1]!),
          BigInt((seriesResult[6] as bigint[])[2]!),
        ],
        active: Boolean(seriesResult[7]),
      };

      const currentPrice = BigInt(iface.decodeFunctionResult('getCurrentPrice', returnData[2]!)[0] as bigint);

      const totalAssetsResult = iface.decodeFunctionResult('totalAssets', returnData[3]!);
      const totalBaseAmt = BigInt(totalAssetsResult[0] as bigint);
      const totalQuoteAmt = BigInt(totalAssetsResult[1] as bigint);

      const ivBps = Number(iface.decodeFunctionResult('ivBps', returnData[4]!)[0]);

      const seriesTokenAddress = String(iface.decodeFunctionResult('seriesToken', returnData[5]!)[0]);

      const seriesValueResult = iface.decodeFunctionResult('seriesTotalValue', returnData[6]!);
      const baseValueInQuote = BigInt(seriesValueResult[0] as bigint);
      const tvl = BigInt(seriesValueResult[1] as bigint);

      const epochExpiriesRaw = iface.decodeFunctionResult('getEpochExpiries', returnData[7]!)[0] as bigint[];
      const epochExpiries = epochExpiriesRaw.map((e) => Number(e));

      const vaultMathAddress = String(iface.decodeFunctionResult('vaultMath', returnData[8]!)[0]);

      const baseAddress = String(iface.decodeFunctionResult('base', returnData[9]!)[0]);
      const baseDecimals = Number(iface.decodeFunctionResult('baseDecimals', returnData[10]!)[0]);
      const quoteDecimals = Number(iface.decodeFunctionResult('quoteDecimals', returnData[11]!)[0]);
      const baseIsToken0 = Boolean(iface.decodeFunctionResult('baseIsToken0', returnData[12]!)[0]);
      const paused = Boolean(iface.decodeFunctionResult('paused', returnData[13]!)[0]);

      // quote address is USDC (shared)
      const quoteAddress = WHEEL_VAULT_CONFIG.contracts.usdc;

      this.client.logger.info('Vault state loaded via multicall', {
        vaultAddress,
        seriesId,
        seriesCount,
        tvl: tvl.toString(),
        currentPrice: currentPrice.toString(),
      });

      return {
        seriesCount,
        series,
        currentPrice,
        tvl,
        baseValueInQuote,
        totalBaseAmt,
        totalQuoteAmt,
        ivBps,
        baseDecimals,
        quoteDecimals,
        baseAddress,
        quoteAddress,
        baseIsToken0,
        seriesTokenAddress,
        vaultMathAddress,
        epochExpiries,
        paused,
      };
    } catch (error) {
      this.client.logger.error('Failed to load vault state', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Get a single series struct from the vault.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @returns VaultSeries struct
   */
  async getSeries(vaultAddress: string, seriesId: number): Promise<VaultSeries> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultRead(vaultAddress);

    try {
      const result = await vault.series(seriesId);
      return {
        strike: BigInt(result.strike),
        epochExpiry: BigInt(result.epochExpiry),
        strategy: BigInt(result.strategy),
        totalShares: BigInt(result.totalShares),
        idleBase: BigInt(result.idleBase),
        idleQuote: BigInt(result.idleQuote),
        contributionLiq: [
          BigInt(result.contributionLiq[0]),
          BigInt(result.contributionLiq[1]),
          BigInt(result.contributionLiq[2]),
        ],
        active: Boolean(result.active),
      };
    } catch (error) {
      this.client.logger.error('Failed to get series', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Get the number of series in the vault.
   *
   * @param vaultAddress - The vault contract address
   * @returns Series count
   */
  async getSeriesCount(vaultAddress: string): Promise<number> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultRead(vaultAddress);

    try {
      const result = await vault.seriesCount();
      return Number(result);
    } catch (error) {
      this.client.logger.error('Failed to get series count', { error, vaultAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get historical share snapshots for a series within a range of epoch indices.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param fromIndex - Start index (inclusive)
   * @param toIndex - End index (exclusive)
   * @returns Array of ShareSnapshot
   */
  async getSnapshots(
    vaultAddress: string,
    seriesId: number,
    fromIndex: number,
    toIndex: number,
  ): Promise<ShareSnapshot[]> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultRead(vaultAddress);

    try {
      const results = await vault.getSnapshotRange(seriesId, fromIndex, toIndex);
      return results.map((snap) => ({
        basePerShare: BigInt(snap.basePerShare),
        quotePerShare: BigInt(snap.quotePerShare),
        priceAtRoll: BigInt(snap.priceAtRoll),
        timestamp: Number(snap.timestamp),
        epoch: Number(snap.epoch),
      }));
    } catch (error) {
      this.client.logger.error('Failed to get snapshots', { error, vaultAddress, seriesId, fromIndex, toIndex });
      throw mapContractError(error);
    }
  }

  /**
   * Get epoch expiry timestamps for a series.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @returns Array of epoch expiry timestamps (unix seconds)
   */
  async getEpochExpiries(vaultAddress: string, seriesId: number): Promise<number[]> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultRead(vaultAddress);

    try {
      const result = await vault.getEpochExpiries(seriesId);
      return result.map((e) => Number(e));
    } catch (error) {
      this.client.logger.error('Failed to get epoch expiries', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Compute the quote-denominated value of a share amount.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param shares - Number of shares
   * @returns Value in quote token units
   */
  async getShareValueInQuote(vaultAddress: string, seriesId: number, shares: bigint): Promise<bigint> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultRead(vaultAddress);

    try {
      const result = await vault.getShareValueInQuote(seriesId, shares);
      return BigInt(result);
    } catch (error) {
      this.client.logger.error('Failed to get share value', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Compute the Black-Scholes base delta using VaultMath.
   *
   * @param vaultMathAddress - The VaultMathExternal contract address
   * @param spot - Spot price (quote-decimals scaled)
   * @param strike - Strike price
   * @param ivBps - Implied volatility in basis points
   * @param tteSeconds - Time to expiry in seconds
   * @returns Delta as 18-decimal value (1e18 = 100% base)
   */
  async bsBaseDelta(
    vaultMathAddress: string,
    spot: bigint,
    strike: bigint,
    ivBps: bigint,
    tteSeconds: bigint,
  ): Promise<bigint> {
    this.ensureEnabled();
    validateAddress(vaultMathAddress, 'vaultMathAddress');

    const mathContract = this.getVaultMath(vaultMathAddress);

    try {
      const result = await mathContract.bsBaseDelta(spot, strike, ivBps, tteSeconds);
      return BigInt(result);
    } catch (error) {
      this.client.logger.error('Failed to compute bsBaseDelta', { error, vaultMathAddress });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Vault Writes
  // ═══════════════════════════════════════════════════════

  /**
   * Deposit base and quote tokens into a vault series.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param baseAmt - Amount of base token
   * @param quoteAmt - Amount of quote token
   * @param expectedPrice - Expected price for slippage check
   * @returns Transaction receipt and shares minted
   */
  async deposit(
    vaultAddress: string,
    seriesId: number,
    baseAmt: bigint,
    quoteAmt: bigint,
    expectedPrice: bigint,
  ): Promise<VaultDepositResult> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultWrite(vaultAddress);

    try {
      const gasEstimate = await vault['deposit(uint256,uint256,uint256,uint256)'].estimateGas(
        seriesId, baseAmt, quoteAmt, expectedPrice,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await vault['deposit(uint256,uint256,uint256,uint256)'](
        seriesId, baseAmt, quoteAmt, expectedPrice, { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from deposit');
      }

      // Parse Deposit event for sharesToMint
      const iface = new Interface(WHEEL_VAULT_ABI);
      let sharesToMint = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === 'Deposit') {
            sharesToMint = BigInt(parsed.args[4] as bigint); // shares is the 5th arg
            break;
          }
        } catch {
          // Not a vault event
        }
      }

      this.client.logger.info('Vault deposit successful', {
        txHash: receipt.hash,
        vaultAddress,
        seriesId,
        sharesToMint: sharesToMint.toString(),
      });

      return { receipt, sharesToMint };
    } catch (error) {
      this.client.logger.error('Failed to deposit into vault', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Withdraw from a vault series by burning shares.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param sharesToBurn - Number of shares to redeem
   * @returns Transaction receipt and amounts returned
   */
  async withdraw(
    vaultAddress: string,
    seriesId: number,
    sharesToBurn: bigint,
  ): Promise<VaultWithdrawResult> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultWrite(vaultAddress);

    try {
      const gasEstimate = await vault['withdraw(uint256,uint256)'].estimateGas(seriesId, sharesToBurn);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await vault['withdraw(uint256,uint256)'](
        seriesId, sharesToBurn, { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from withdraw');
      }

      // Parse Withdraw event for baseOut and quoteOut
      const iface = new Interface(WHEEL_VAULT_ABI);
      let baseOut = 0n;
      let quoteOut = 0n;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === 'Withdraw') {
            baseOut = BigInt(parsed.args[3] as bigint);  // baseOut
            quoteOut = BigInt(parsed.args[4] as bigint); // quoteOut
            break;
          }
        } catch {
          // Not a vault event
        }
      }

      this.client.logger.info('Vault withdraw successful', {
        txHash: receipt.hash,
        vaultAddress,
        seriesId,
        baseOut: baseOut.toString(),
        quoteOut: quoteOut.toString(),
      });

      return { receipt, baseOut, quoteOut };
    } catch (error) {
      this.client.logger.error('Failed to withdraw from vault', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Withdraw only the idle (undeployed) portion of shares.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param sharesToBurn - Number of shares to burn
   * @returns Transaction receipt
   */
  async withdrawIdle(
    vaultAddress: string,
    seriesId: number,
    sharesToBurn: bigint,
  ): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultWrite(vaultAddress);

    try {
      const gasEstimate = await vault.withdrawIdle.estimateGas(seriesId, sharesToBurn);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await vault.withdrawIdle(seriesId, sharesToBurn, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from withdrawIdle');
      }

      this.client.logger.info('Vault withdrawIdle successful', {
        txHash: receipt.hash,
        vaultAddress,
        seriesId,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to withdrawIdle', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Trigger vault rebalance (reposition Uniswap V3 LP).
   * Anyone can call this; the vault pays a small ETH reward.
   *
   * @param vaultAddress - The vault contract address
   * @returns Transaction receipt
   */
  async poke(vaultAddress: string): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultWrite(vaultAddress);

    try {
      const gasEstimate = await vault.poke.estimateGas();
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await vault.poke({ gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from poke');
      }

      this.client.logger.info('Vault poke successful', { txHash: receipt.hash, vaultAddress });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to poke vault', { error, vaultAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Trigger epoch roll (admin/keeper operation).
   *
   * @param vaultAddress - The vault contract address
   * @returns Transaction receipt
   */
  async trigger(vaultAddress: string): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const vault = this.getVaultWrite(vaultAddress);

    try {
      const gasEstimate = await vault.trigger.estimateGas();
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await vault.trigger({ gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from trigger');
      }

      this.client.logger.info('Vault trigger successful', { txHash: receipt.hash, vaultAddress });
      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to trigger vault', { error, vaultAddress });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Router Operations (shared Router address from config)
  // ═══════════════════════════════════════════════════════

  /**
   * Deposit a single token via the Router (swaps internally to match vault ratio).
   *
   * @param params - Deposit parameters including swap routing data
   * @returns Transaction receipt
   */
  async depositSingle(params: DepositSingleParams): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(params.vaultAddress);
    validateAddress(params.depositToken, 'depositToken');
    this.validateConfiguredSwapRouter(params.aggregator, 'aggregator');

    const router = this.getRouter();

    try {
      const gasEstimate = await router.depositSingle.estimateGas(
        params.vaultAddress,
        params.seriesId,
        params.depositToken,
        params.depositAmount,
        params.aggregator,
        params.swapData,
        params.expectedPrice,
        params.minShares,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await router.depositSingle(
        params.vaultAddress,
        params.seriesId,
        params.depositToken,
        params.depositAmount,
        params.aggregator,
        params.swapData,
        params.expectedPrice,
        params.minShares,
        { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from depositSingle');
      }

      this.client.logger.info('Router depositSingle successful', {
        txHash: receipt.hash,
        vaultAddress: params.vaultAddress,
        seriesId: params.seriesId,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to depositSingle via router', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Deposit both base and quote tokens via the Router.
   *
   * @param params - Deposit parameters
   * @returns Transaction receipt
   */
  async depositDual(params: DepositDualParams): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(params.vaultAddress);

    const router = this.getRouter();

    try {
      const gasEstimate = await router.depositDual.estimateGas(
        params.vaultAddress,
        params.seriesId,
        params.baseAmt,
        params.quoteAmt,
        params.expectedPrice,
        params.minShares,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await router.depositDual(
        params.vaultAddress,
        params.seriesId,
        params.baseAmt,
        params.quoteAmt,
        params.expectedPrice,
        params.minShares,
        { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from depositDual');
      }

      this.client.logger.info('Router depositDual successful', {
        txHash: receipt.hash,
        vaultAddress: params.vaultAddress,
        seriesId: params.seriesId,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to depositDual via router', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Withdraw to a single token via the Router (swaps internally).
   *
   * @param params - Withdraw parameters including swap routing data
   * @returns Transaction receipt
   */
  async withdrawSingle(params: WithdrawSingleParams): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(params.vaultAddress);
    validateAddress(params.targetToken, 'targetToken');
    this.validateConfiguredSwapRouter(params.aggregator, 'aggregator');

    const router = this.getRouter();

    try {
      const gasEstimate = await router.withdrawSingle.estimateGas(
        params.vaultAddress,
        params.seriesId,
        params.shares,
        params.targetToken,
        params.aggregator,
        params.swapData,
        params.minOut,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await router.withdrawSingle(
        params.vaultAddress,
        params.seriesId,
        params.shares,
        params.targetToken,
        params.aggregator,
        params.swapData,
        params.minOut,
        { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from withdrawSingle');
      }

      this.client.logger.info('Router withdrawSingle successful', {
        txHash: receipt.hash,
        vaultAddress: params.vaultAddress,
        seriesId: params.seriesId,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to withdrawSingle via router', { error });
      throw mapContractError(error);
    }
  }

  /**
   * Withdraw to a single token via the Router using ERC-2612 permit (gasless approval).
   *
   * @param params - Withdraw parameters with permit signature
   * @returns Transaction receipt
   */
  async withdrawSingleWithPermit(params: WithdrawSingleWithPermitParams): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredVault(params.vaultAddress);
    validateAddress(params.targetToken, 'targetToken');
    this.validateConfiguredSwapRouter(params.aggregator, 'aggregator');

    const router = this.getRouter();

    try {
      const gasEstimate = await router.withdrawSingleWithPermit.estimateGas(
        params.vaultAddress,
        params.seriesId,
        params.shares,
        params.targetToken,
        params.aggregator,
        params.swapData,
        params.minOut,
        params.deadline,
        params.v,
        params.r,
        params.s,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await router.withdrawSingleWithPermit(
        params.vaultAddress,
        params.seriesId,
        params.shares,
        params.targetToken,
        params.aggregator,
        params.swapData,
        params.minOut,
        params.deadline,
        params.v,
        params.r,
        params.s,
        { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from withdrawSingleWithPermit');
      }

      this.client.logger.info('Router withdrawSingleWithPermit successful', {
        txHash: receipt.hash,
        vaultAddress: params.vaultAddress,
        seriesId: params.seriesId,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to withdrawSingleWithPermit via router', { error });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Lens Operations (shared Lens address from config)
  // ═══════════════════════════════════════════════════════

  /**
   * Estimate the optimal split for a single-token deposit.
   * Returns how much to swap and how much to keep.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param token - The deposit token address
   * @param amount - Total deposit amount
   * @returns Swap and keep amounts
   */
  async estimateDepositSplit(
    vaultAddress: string,
    seriesId: number,
    token: string,
    amount: bigint,
  ): Promise<DepositSplitEstimate> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);
    validateAddress(token, 'token');

    const lens = this.getLens();

    try {
      const result = await lens.estimateDepositSplit(vaultAddress, seriesId, token, amount);
      return {
        swapAmt: BigInt(result[0]),
        keepAmt: BigInt(result[1]),
      };
    } catch (error) {
      this.client.logger.error('Failed to estimate deposit split', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Preview a dual-token deposit (compute shares to mint).
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param baseAmt - Base token amount
   * @param quoteAmt - Quote token amount
   * @returns Preview with sharesToMint
   */
  async previewDeposit(
    vaultAddress: string,
    seriesId: number,
    baseAmt: bigint,
    quoteAmt: bigint,
  ): Promise<DepositPreview> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const lens = this.getLens();

    try {
      const result = await lens.previewDeposit(vaultAddress, seriesId, baseAmt, quoteAmt);
      return {
        sharesToMint: BigInt(result),
      };
    } catch (error) {
      this.client.logger.error('Failed to preview deposit', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Preview a withdrawal (compute base/quote out and fees).
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @param shares - Shares to burn
   * @returns Withdrawal preview with amounts and fees
   */
  async previewWithdraw(
    vaultAddress: string,
    seriesId: number,
    shares: bigint,
  ): Promise<WithdrawPreview> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const lens = this.getLens();

    try {
      const result = await lens.previewWithdraw(vaultAddress, seriesId, shares);
      return {
        baseOut: BigInt(result[0]),
        quoteOut: BigInt(result[1]),
        baseFee: BigInt(result[2]),
        quoteFee: BigInt(result[3]),
      };
    } catch (error) {
      this.client.logger.error('Failed to preview withdraw', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Get total base, quote, and share amounts for a series.
   *
   * @param vaultAddress - The vault contract address
   * @param seriesId - Series index
   * @returns Base amount, quote amount, and total shares
   */
  async getSeriesAssets(
    vaultAddress: string,
    seriesId: number,
  ): Promise<{ baseAmt: bigint; quoteAmt: bigint; totalShares: bigint }> {
    this.ensureEnabled();
    this.validateConfiguredVault(vaultAddress);

    const lens = this.getLens();

    try {
      const result = await lens.getSeriesAssets(vaultAddress, seriesId);
      return {
        baseAmt: BigInt(result[0]),
        quoteAmt: BigInt(result[1]),
        totalShares: BigInt(result[2]),
      };
    } catch (error) {
      this.client.logger.error('Failed to get series assets', { error, vaultAddress, seriesId });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Markets Write Operations
  // ═══════════════════════════════════════════════════════

  /**
   * Fill an option order from the depth book. Buyer pays premium,
   * receives an option NFT backed by vault shares.
   *
   * @param marketsAddress - The Markets contract address for this asset
   * @param params - Fill parameters (seriesId, side, size, premium limits, etc.)
   * @returns Transaction receipt
   */
  async marketFill(marketsAddress: string, params: MarketFillParams): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);
    if (params.useSwap) {
      this.validateConfiguredSwapRouter(params.swap.router, 'swap.router');
      this.validateConfiguredSwapRouter(params.swap.approvalTarget, 'swap.approvalTarget');
    }

    const markets = this.getMarkets(marketsAddress);
    const swapTuple: SwapTuple = [
      params.swap.router,
      params.swap.approvalTarget,
      params.swap.minAmountOut,
      params.swap.deadline,
      params.swap.data,
    ];

    try {
      const gasEstimate = await markets.marketFill.estimateGas(
        params.seriesId,
        params.isCall,
        params.sharesToFill,
        params.maxIvBps,
        params.minCollateralOut,
        params.maxPremium,
        params.maxStructDeficitQuote,
        params.maxExecutionTopupQuote,
        params.deadline,
        params.useSwap,
        swapTuple,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.marketFill(
        params.seriesId,
        params.isCall,
        params.sharesToFill,
        params.maxIvBps,
        params.minCollateralOut,
        params.maxPremium,
        params.maxStructDeficitQuote,
        params.maxExecutionTopupQuote,
        params.deadline,
        params.useSwap,
        swapTuple,
        { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from marketFill');
      }

      this.client.logger.info('MarketFill successful', {
        txHash: receipt.hash,
        marketsAddress,
        seriesId: params.seriesId,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to execute marketFill', { error, marketsAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Deposit vault shares into an IV bucket as a market maker.
   *
   * @param marketsAddress - The Markets contract address
   * @param params - Bucket deposit parameters
   * @returns Transaction receipt
   */
  async depositToBucket(marketsAddress: string, params: DepositToBucketParams): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);

    const markets = this.getMarkets(marketsAddress);

    try {
      const gasEstimate = await markets.depositToBucket.estimateGas(
        params.seriesId,
        params.ivBps,
        params.shares,
        params.minAcceptableBps,
        params.expiryType,
        params.expiryParam,
      );
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.depositToBucket(
        params.seriesId,
        params.ivBps,
        params.shares,
        params.minAcceptableBps,
        params.expiryType,
        params.expiryParam,
        { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from depositToBucket');
      }

      this.client.logger.info('DepositToBucket successful', {
        txHash: receipt.hash,
        marketsAddress,
        seriesId: params.seriesId,
        ivBps: params.ivBps,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to depositToBucket', { error, marketsAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Cancel a pending bucket deposit entry.
   *
   * @param marketsAddress - The Markets contract address
   * @param entryId - The deposit entry ID to cancel
   * @returns Transaction receipt
   */
  async cancelDeposit(marketsAddress: string, entryId: bigint): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);

    const markets = this.getMarkets(marketsAddress);

    try {
      const gasEstimate = await markets.cancelDeposit.estimateGas(entryId);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.cancelDeposit(entryId, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from cancelDeposit');
      }

      this.client.logger.info('CancelDeposit successful', {
        txHash: receipt.hash,
        marketsAddress,
        entryId: entryId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to cancelDeposit', { error, marketsAddress, entryId: entryId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Claim accrued premiums or collateral for a specific token.
   *
   * @param marketsAddress - The Markets contract address
   * @param tokenAddress - Token to claim (base or quote)
   * @returns Transaction receipt
   */
  async claim(marketsAddress: string, tokenAddress: string): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);
    validateAddress(tokenAddress, 'tokenAddress');

    const markets = this.getMarkets(marketsAddress);

    try {
      const gasEstimate = await markets.claim.estimateGas(tokenAddress);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.claim(tokenAddress, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from claim');
      }

      this.client.logger.info('Claim successful', {
        txHash: receipt.hash,
        marketsAddress,
        tokenAddress,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to claim', { error, marketsAddress, tokenAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Exercise an in-the-money option.
   *
   * @param marketsAddress - The Markets contract address
   * @param optionId - The option NFT ID
   * @returns Transaction receipt
   */
  async exercise(marketsAddress: string, optionId: bigint): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);

    const markets = this.getMarkets(marketsAddress);

    try {
      const gasEstimate = await markets.exercise.estimateGas(optionId);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.exercise(optionId, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from exercise');
      }

      this.client.logger.info('Exercise successful', {
        txHash: receipt.hash,
        marketsAddress,
        optionId: optionId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to exercise option', { error, marketsAddress, optionId: optionId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Expire an out-of-the-money option after the exercise window.
   *
   * @param marketsAddress - The Markets contract address
   * @param optionId - The option NFT ID
   * @returns Transaction receipt
   */
  async expire(marketsAddress: string, optionId: bigint): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);

    const markets = this.getMarkets(marketsAddress);

    try {
      const gasEstimate = await markets.expire.estimateGas(optionId);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.expire(optionId, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from expire');
      }

      this.client.logger.info('Expire successful', {
        txHash: receipt.hash,
        marketsAddress,
        optionId: optionId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to expire option', { error, marketsAddress, optionId: optionId.toString() });
      throw mapContractError(error);
    }
  }

  /**
   * Swap collateral via DEX aggregator and then exercise an option.
   *
   * @param marketsAddress - The Markets contract address
   * @param optionId - The option NFT ID
   * @param swapTarget - DEX aggregator router address
   * @param swapData - Encoded swap calldata
   * @returns Transaction receipt
   */
  async swapAndExercise(
    marketsAddress: string,
    optionId: bigint,
    swapTarget: string,
    swapData: string,
  ): Promise<TransactionReceipt> {
    this.ensureEnabled();
    this.validateConfiguredMarkets(marketsAddress);
    this.validateConfiguredSwapRouter(swapTarget, 'swapTarget');

    const markets = this.getMarkets(marketsAddress);

    try {
      const gasEstimate = await markets.swapAndExercise.estimateGas(optionId, swapTarget, swapData);
      const gasLimit = (gasEstimate * 120n) / 100n;
      const tx = await markets.swapAndExercise(
        optionId, swapTarget, swapData, { gasLimit },
      );
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'No receipt returned from swapAndExercise');
      }

      this.client.logger.info('SwapAndExercise successful', {
        txHash: receipt.hash,
        marketsAddress,
        optionId: optionId.toString(),
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Failed to swapAndExercise', { error, marketsAddress, optionId: optionId.toString() });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Markets Lens Reads
  // ═══════════════════════════════════════════════════════

  /**
   * Get the full depth chart for an option series.
   * Returns a deficit preview and an array of bucket previews ordered by IV.
   *
   * @param lensAddress - The MarketsLens contract address for this asset
   * @param seriesId - Series index
   * @param isCall - true for call options, false for puts
   * @param maxIvBps - Maximum IV bucket to scan (in basis points)
   * @returns Depth chart with deficit and bucket previews
   */
  async getDepthChart(
    lensAddress: string,
    seriesId: number,
    isCall: boolean,
    maxIvBps: number,
  ): Promise<DepthChartResult> {
    this.ensureEnabled();
    this.validateConfiguredMarketsLens(lensAddress);

    const lens = this.getMarketsLens(lensAddress);

    try {
      const [deficitRaw, bucketsRaw] = await lens.getDepthChart(seriesId, isCall, maxIvBps);

      const deficitPreview: DeficitPreview = {
        lockPerShareBase: BigInt(deficitRaw.lockPerShareBase),
        spotPrice: BigInt(deficitRaw.spotPrice),
        hedgingCostPerShareQuote: BigInt(deficitRaw.hedgingCostPerShareQuote),
        intrinsicPerShareQuote: BigInt(deficitRaw.intrinsicPerShareQuote),
        effectiveDeficitPerShareQuote: BigInt(deficitRaw.effectiveDeficitPerShareQuote),
        tte: BigInt(deficitRaw.tte),
        strike: BigInt(deficitRaw.strike),
      };

      const bucketPreviews: BucketPreview[] = bucketsRaw.map((b) => ({
        ivBps: Number(b.ivBps),
        premiumPerUnitQuote: BigInt(b.premiumPerUnitQuote),
        premiumPerShareQuote: BigInt(b.premiumPerShareQuote),
        cutoffBps: Number(b.cutoffBps),
        sellerNetPerShareQuote: BigInt(b.sellerNetPerShareQuote),
        fillableShares: BigInt(b.fillableShares),
        contributorsAvailable: Number(b.contributorsAvailable),
        scannedCount: Number(b.scannedCount),
        bucketActive: Boolean(b.bucketActive),
      }));

      return { deficitPreview, bucketPreviews };
    } catch (error) {
      this.client.logger.error('Failed to get depth chart', { error, lensAddress, seriesId, isCall, maxIvBps });
      throw mapContractError(error);
    }
  }

  /**
   * Preview the premium for filling a given number of shares across IV buckets.
   *
   * @param lensAddress - The MarketsLens contract address
   * @param seriesId - Series index
   * @param isCall - true for call, false for put
   * @param sharesToFill - Number of shares to fill
   * @param maxIvBps - Maximum IV bucket to fill from
   * @returns Premium preview with per-tranche breakdown
   */
  async previewFillPremium(
    lensAddress: string,
    seriesId: number,
    isCall: boolean,
    sharesToFill: bigint,
    maxIvBps: number,
  ): Promise<FillPremiumPreview> {
    this.ensureEnabled();
    this.validateConfiguredMarketsLens(lensAddress);

    const lens = this.getMarketsLens(lensAddress);

    try {
      const result = await lens.previewFillPremium(seriesId, isCall, sharesToFill, maxIvBps);

      const tranches: FillTranche[] = result.tranches.map((t) => ({
        ivBps: Number(t.ivBps),
        sharesFilled: BigInt(t.sharesFilled),
        premiumQuote: BigInt(t.premiumQuote),
        premiumPerShareQuote: BigInt(t.premiumPerShareQuote),
      }));

      return {
        totalPremiumQuote: BigInt(result.totalPremiumQuote),
        totalSharesFilled: BigInt(result.totalSharesFilled),
        trancheCount: Number(result.trancheCount),
        tranches,
      };
    } catch (error) {
      this.client.logger.error('Failed to preview fill premium', { error, lensAddress, seriesId, isCall });
      throw mapContractError(error);
    }
  }

  /**
   * Get a buyer's active options.
   *
   * @param lensAddress - The MarketsLens contract address
   * @param buyer - Buyer wallet address
   * @param fromId - Start scanning from this option ID
   * @param maxCount - Maximum number of results
   * @returns Array of buyer option summaries
   */
  async getBuyerOptions(
    lensAddress: string,
    buyer: string,
    fromId: bigint,
    maxCount: bigint,
  ): Promise<BuyerOption[]> {
    this.ensureEnabled();
    this.validateConfiguredMarketsLens(lensAddress);
    validateAddress(buyer, 'buyer');

    const lens = this.getMarketsLens(lensAddress);

    try {
      const results = await lens.getBuyerOptions(buyer, fromId, maxCount);

      return results.map((opt) => ({
        optionId: BigInt(opt.optionId),
        side: Number(opt.side),
        status: Number(opt.status),
        seriesId: Number(opt.seriesId),
        expiry: Number(opt.expiry),
        notionalBase: BigInt(opt.notionalBase),
        lockAmount: BigInt(opt.lockAmount),
        strike18: BigInt(opt.strike18),
      }));
    } catch (error) {
      this.client.logger.error('Failed to get buyer options', { error, lensAddress, buyer });
      throw mapContractError(error);
    }
  }

  /**
   * Get a seller's bucket deposit positions.
   *
   * @param lensAddress - The MarketsLens contract address
   * @param seller - Seller wallet address
   * @param seriesId - Series index
   * @param maxIvBps - Maximum IV bucket to scan
   * @param maxEntries - Maximum entries to return
   * @returns Array of seller positions
   */
  async getSellerPositions(
    lensAddress: string,
    seller: string,
    seriesId: number,
    maxIvBps: number,
    maxEntries: number,
  ): Promise<SellerPosition[]> {
    this.ensureEnabled();
    this.validateConfiguredMarketsLens(lensAddress);
    validateAddress(seller, 'seller');

    const lens = this.getMarketsLens(lensAddress);

    try {
      const results = await lens.getSellerPositions(seller, seriesId, maxIvBps, maxEntries);

      return results.map((pos) => ({
        entryId: Number(pos.entryId),
        ivBps: Number(pos.ivBps),
        shares: BigInt(pos.shares),
        minAcceptableBps: Number(pos.minAcceptableBps),
        isExpired: Boolean(pos.isExpired),
      }));
    } catch (error) {
      this.client.logger.error('Failed to get seller positions', { error, lensAddress, seller, seriesId });
      throw mapContractError(error);
    }
  }

  /**
   * Get a summary of claimable premiums/collateral across multiple series.
   *
   * @param lensAddress - The MarketsLens contract address
   * @param seller - Seller wallet address
   * @param seriesIds - Array of series IDs to aggregate
   * @returns Claimable base, quote, and per-series share amounts
   */
  async getClaimableSummary(
    lensAddress: string,
    seller: string,
    seriesIds: number[],
  ): Promise<ClaimableSummary> {
    this.ensureEnabled();
    this.validateConfiguredMarketsLens(lensAddress);
    validateAddress(seller, 'seller');

    const lens = this.getMarketsLens(lensAddress);

    try {
      const result = await lens.getClaimableSummary(seller, seriesIds);

      return {
        claimableBase: BigInt(result[0]),
        claimableQuote: BigInt(result[1]),
        claimableShares: result[2].map((s) => BigInt(s)),
      };
    } catch (error) {
      this.client.logger.error('Failed to get claimable summary', { error, lensAddress, seller });
      throw mapContractError(error);
    }
  }

  /**
   * Preview the result of exercising an option.
   *
   * @param lensAddress - The MarketsLens contract address
   * @param optionId - The option NFT ID
   * @returns Exercise preview with profit/loss details
   */
  async previewExercise(lensAddress: string, optionId: bigint): Promise<ExercisePreview> {
    this.ensureEnabled();
    this.validateConfiguredMarketsLens(lensAddress);

    const lens = this.getMarketsLens(lensAddress);

    try {
      const result = await lens.previewExercise(optionId);

      const canExercise = Boolean(result.canExercise);
      const exerciseProfit = BigInt(result.exerciseProfit);

      return {
        isCall: Boolean(result.isCall),
        lockAmount: BigInt(result.lockAmount),
        strikePayment: BigInt(result.strikePayment),
        spotValue: BigInt(result.spotValue),
        exerciseProfit,
        expiry: BigInt(result.expiry),
        canExercise,
        shouldExercise: canExercise && exerciseProfit > 0n,
        isExpired: Boolean(result.isExpired),
      };
    } catch (error) {
      this.client.logger.error('Failed to preview exercise', { error, lensAddress, optionId: optionId.toString() });
      throw mapContractError(error);
    }
  }

  // ═══════════════════════════════════════════════════════
  // Uniswap V3 Position Query
  // ═══════════════════════════════════════════════════════

  /**
   * Query Uniswap V3 positions by token IDs.
   * Uses multicall for efficiency when querying multiple positions.
   *
   * @param positionIds - Array of Uniswap V3 NFT position token IDs
   * @returns Array of position details
   */
  async getUniswapPositions(positionIds: bigint[]): Promise<UniswapV3Position[]> {
    this.ensureEnabled();

    if (positionIds.length === 0) {
      return [];
    }

    const npmAddress = WHEEL_VAULT_CONFIG.contracts.npm;
    const iface = new Interface(UNISWAP_NPM_ABI);

    const calls: MulticallCall[] = positionIds.map((tokenId) => ({
      target: npmAddress,
      callData: iface.encodeFunctionData('positions', [tokenId]),
    }));

    try {
      const returnData = await this.multicall(calls);

      return returnData.map((data) => {
        const result = iface.decodeFunctionResult('positions', data);
        return {
          nonce: BigInt(result[0] as bigint),
          operator: String(result[1]),
          token0: String(result[2]),
          token1: String(result[3]),
          fee: Number(result[4]),
          tickLower: Number(result[5]),
          tickUpper: Number(result[6]),
          liquidity: BigInt(result[7] as bigint),
          feeGrowthInside0LastX128: BigInt(result[8] as bigint),
          feeGrowthInside1LastX128: BigInt(result[9] as bigint),
          tokensOwed0: BigInt(result[10] as bigint),
          tokensOwed1: BigInt(result[11] as bigint),
        };
      });
    } catch (error) {
      this.client.logger.error('Failed to get Uniswap positions', { error, positionIds: positionIds.map(String) });
      throw mapContractError(error);
    }
  }
}
