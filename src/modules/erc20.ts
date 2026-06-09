import { Contract, Interface } from 'ethers';
import type { TransactionReceipt, ContractTransactionResponse } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import { ERC20_ABI } from '../abis/erc20.js';
import type { CallStaticResult } from '../types/callStatic.js';
import { createError, mapContractError } from '../utils/errors.js';
import { validateAddress } from '../utils/validation.js';

/**
 * Interface for ERC20 contract methods
 */
interface ERC20Contract {
  approve: {
    (spender: string, amount: bigint): Promise<ContractTransactionResponse>;
    (spender: string, amount: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(spender: string, amount: bigint): Promise<bigint>;
  };
  transfer: {
    (to: string, amount: bigint): Promise<ContractTransactionResponse>;
    (to: string, amount: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(to: string, amount: bigint): Promise<bigint>;
  };
  allowance(owner: string, spender: string): Promise<bigint>;
  balanceOf(account: string): Promise<bigint>;
  decimals(): Promise<number>;
  symbol(): Promise<string>;
  name(): Promise<string>;
}

/**
 * Module for ERC20 token operations
 *
 * Provides methods for checking balances, allowances, and performing
 * token approvals and transfers.
 *
 * @example
 * ```typescript
 * // Check balance
 * const balance = await client.erc20.getBalance(tokenAddress);
 *
 * // Approve spending
 * const receipt = await client.erc20.approve(tokenAddress, spenderAddress, amount);
 *
 * // Ensure sufficient allowance (approves if needed)
 * const result = await client.erc20.ensureAllowance(tokenAddress, spenderAddress, amount);
 * ```
 */
export class ERC20Module {
  /** Cache for token decimals to avoid repeated RPC calls */
  private decimalsCache: Map<string, number> = new Map();

  constructor(private readonly client: ThetanutsClient) {}

  /**
   * Get an ERC20 contract instance for read operations
   */
  private getReadContract(tokenAddress: string): ERC20Contract {
    return new Contract(tokenAddress, ERC20_ABI, this.client.provider) as unknown as ERC20Contract;
  }

  /**
   * Get an ERC20 contract instance for write operations (requires signer)
   */
  private getWriteContract(tokenAddress: string): ERC20Contract {
    const signer = this.client.requireSigner();
    return new Contract(tokenAddress, ERC20_ABI, signer) as unknown as ERC20Contract;
  }

  /**
   * Approve a spender to spend tokens on behalf of the signer
   *
   * @param token - Token contract address
   * @param spender - Address to approve for spending
   * @param amount - Amount to approve (in token's smallest unit)
   * @returns Transaction receipt
   *
   * @throws {ThetanutsError} SIGNER_REQUIRED if no signer is configured
   * @throws {ThetanutsError} INVALID_PARAMS if addresses are invalid
   *
   * @example
   * ```typescript
   * const receipt = await client.erc20.approve(
   *   '0xTokenAddress',
   *   '0xSpenderAddress',
   *   1000000n // 1 USDC (6 decimals)
   * );
   * ```
   */
  async approve(
    token: string,
    spender: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    validateAddress(token, 'token');
    validateAddress(spender, 'spender');

    this.client.logger.debug('Approving token spend', { token, spender, amount: amount.toString() });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract(token);

      // Estimate gas and add 20% buffer for Account Abstraction wallets (e.g., Coinbase Smart Wallet)
      const gasEstimate = await contract.approve.estimateGas(spender, amount);
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.approve(spender, amount, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Token approval successful', {
        token,
        spender,
        amount: amount.toString(),
        txHash: receipt.hash,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Token approval failed', { error, token, spender });
      throw mapContractError(error);
    }
  }

  /**
   * Get the current allowance for a spender
   *
   * @param token - Token contract address
   * @param owner - Token owner address
   * @param spender - Spender address to check
   * @returns Current allowance as bigint
   *
   * @example
   * ```typescript
   * const allowance = await client.erc20.getAllowance(
   *   '0xTokenAddress',
   *   '0xOwnerAddress',
   *   '0xSpenderAddress'
   * );
   * ```
   */
  async getAllowance(
    token: string,
    owner: string,
    spender: string
  ): Promise<bigint> {
    validateAddress(token, 'token');
    validateAddress(owner, 'owner');
    validateAddress(spender, 'spender');

    this.client.logger.debug('Getting allowance', { token, owner, spender });

    try {
      const contract = this.getReadContract(token);
      const allowance = await contract.allowance(owner, spender);
      return allowance;
    } catch (error) {
      this.client.logger.error('Failed to get allowance', { error, token, owner, spender });
      throw mapContractError(error);
    }
  }

  /**
   * Ensure sufficient allowance exists, approving if necessary
   *
   * This is a convenience method that checks the current allowance
   * and only sends an approval transaction if the allowance is insufficient.
   *
   * @param token - Token contract address
   * @param spender - Spender address to approve
   * @param amount - Required minimum allowance
   * @returns Transaction receipt if approval was needed, null otherwise
   *
   * @example
   * ```typescript
   * const receipt = await client.erc20.ensureAllowance(
   *   '0xTokenAddress',
   *   '0xOptionBookAddress',
   *   1000000n
   * );
   * if (receipt) {
   *   console.log('Approval tx:', receipt.hash);
   * } else {
   *   console.log('Sufficient allowance already exists');
   * }
   * ```
   */
  async ensureAllowance(
    token: string,
    spender: string,
    amount: bigint
  ): Promise<TransactionReceipt | null> {
    const owner = await this.client.getSignerAddress();

    this.client.logger.debug('Ensuring allowance', { token, spender, amount: amount.toString(), owner });

    const currentAllowance = await this.getAllowance(token, owner, spender);

    if (currentAllowance >= amount) {
      this.client.logger.debug('Sufficient allowance exists', {
        currentAllowance: currentAllowance.toString(),
        required: amount.toString(),
      });
      return null;
    }

    this.client.logger.info('Insufficient allowance, approving', {
      currentAllowance: currentAllowance.toString(),
      required: amount.toString(),
    });

    // USDT-style tokens (USDT, OMG, KNC-legacy) revert when approve is called
    // with a non-zero target while the current allowance is also non-zero.
    // Zero-reset first to stay compatible if integrators wire such a token
    // through this helper (TNU-AUDIT-0062). The current Base chain config
    // does not include USDT-style tokens; this is defensive.
    if (currentAllowance > 0n) {
      this.client.logger.debug('Zeroing existing allowance before top-up', {
        currentAllowance: currentAllowance.toString(),
      });
      await this.approve(token, spender, 0n);
    }

    return this.approve(token, spender, amount);
  }

  /**
   * Get the token balance for an address
   *
   * @param token - Token contract address
   * @param address - Address to check balance for (defaults to signer address)
   * @returns Balance as bigint in token's smallest unit
   *
   * @example
   * ```typescript
   * // Get signer's balance
   * const myBalance = await client.erc20.getBalance('0xTokenAddress');
   *
   * // Get another address's balance
   * const otherBalance = await client.erc20.getBalance('0xTokenAddress', '0xOtherAddress');
   * ```
   */
  async getBalance(token: string, address?: string): Promise<bigint> {
    validateAddress(token, 'token');

    const targetAddress = address ?? (await this.client.getSignerAddress());
    validateAddress(targetAddress, 'address');

    this.client.logger.debug('Getting balance', { token, address: targetAddress });

    try {
      const contract = this.getReadContract(token);
      const balance = await contract.balanceOf(targetAddress);
      return balance;
    } catch (error) {
      this.client.logger.error('Failed to get balance', { error, token, address: targetAddress });
      throw mapContractError(error);
    }
  }

  /**
   * Get the decimals for a token (cached)
   *
   * Results are cached to avoid repeated RPC calls for the same token.
   *
   * @param token - Token contract address
   * @returns Number of decimals
   *
   * @example
   * ```typescript
   * const decimals = await client.erc20.getDecimals('0xUSDCAddress');
   * console.log(decimals); // 6
   * ```
   */
  async getDecimals(token: string): Promise<number> {
    validateAddress(token, 'token');

    // Check cache first
    const cached = this.decimalsCache.get(token.toLowerCase());
    if (cached !== undefined) {
      return cached;
    }

    this.client.logger.debug('Getting decimals (not cached)', { token });

    try {
      const contract = this.getReadContract(token);
      const decimals = await contract.decimals();

      // Cache the result
      this.decimalsCache.set(token.toLowerCase(), decimals);

      return decimals;
    } catch (error) {
      this.client.logger.error('Failed to get decimals', { error, token });
      throw mapContractError(error);
    }
  }

  /**
   * Get the symbol for a token
   *
   * @param token - Token contract address
   * @returns Token symbol (e.g., "USDC", "WETH")
   */
  async getSymbol(token: string): Promise<string> {
    validateAddress(token, 'token');

    try {
      const contract = this.getReadContract(token);
      return await contract.symbol();
    } catch (error) {
      this.client.logger.error('Failed to get symbol', { error, token });
      throw mapContractError(error);
    }
  }

  /**
   * Transfer tokens to another address
   *
   * @param token - Token contract address
   * @param to - Recipient address
   * @param amount - Amount to transfer (in token's smallest unit)
   * @returns Transaction receipt
   *
   * @throws {ThetanutsError} SIGNER_REQUIRED if no signer is configured
   * @throws {ThetanutsError} INSUFFICIENT_BALANCE if sender doesn't have enough tokens
   *
   * @example
   * ```typescript
   * const receipt = await client.erc20.transfer(
   *   '0xTokenAddress',
   *   '0xRecipientAddress',
   *   1000000n // 1 USDC
   * );
   * ```
   */
  async transfer(
    token: string,
    to: string,
    amount: bigint
  ): Promise<TransactionReceipt> {
    validateAddress(token, 'token');
    validateAddress(to, 'to');

    if (amount <= 0n) {
      throw createError('INVALID_PARAMS', 'Transfer amount must be positive');
    }

    this.client.logger.debug('Transferring tokens', { token, to, amount: amount.toString() });

    try {
      await this.client.assertNetwork();
      const contract = this.getWriteContract(token);

      // Estimate gas and add 20% buffer for Account Abstraction wallets (e.g., Coinbase Smart Wallet)
      const gasEstimate = await contract.transfer.estimateGas(to, amount);
      const gasLimit = (gasEstimate * 120n) / 100n;

      const tx = await contract.transfer(to, amount, { gasLimit });
      const receipt = await tx.wait();

      if (!receipt) {
        throw createError('CONTRACT_REVERT', 'Transaction failed - no receipt returned');
      }

      this.client.logger.info('Token transfer successful', {
        token,
        to,
        amount: amount.toString(),
        txHash: receipt.hash,
      });

      return receipt;
    } catch (error) {
      this.client.logger.error('Token transfer failed', { error, token, to });
      throw mapContractError(error);
    }
  }

  /**
   * Encode an approve transaction for use with any wallet library
   *
   * This method returns encoded transaction data that can be sent via viem, wagmi,
   * ethers.js, or any other wallet library. This is especially useful for:
   * - Account Abstraction wallets (Coinbase Smart Wallet, Safe, etc.)
   * - Apps using viem/wagmi instead of ethers.js
   * - Custom transaction signing flows
   *
   * @param token - Token contract address
   * @param spender - Address to approve for spending
   * @param amount - Amount to approve (in token's smallest unit)
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   *
   * @example
   * ```typescript
   * // With viem/wagmi
   * const { to, data } = client.erc20.encodeApprove(tokenAddress, spenderAddress, amount);
   * const hash = await walletClient.sendTransaction({ to, data, gas: estimatedGas });
   *
   * // With ethers.js
   * const { to, data } = client.erc20.encodeApprove(tokenAddress, spenderAddress, amount);
   * const tx = await signer.sendTransaction({ to, data, gasLimit: estimatedGas });
   * ```
   */
  encodeApprove(
    token: string,
    spender: string,
    amount: bigint
  ): { to: string; data: string } {
    validateAddress(token, 'token');
    validateAddress(spender, 'spender');

    const iface = new Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('approve', [spender, amount]);

    return { to: token, data };
  }

  /**
   * Encode a transfer transaction for use with any wallet library
   *
   * This method returns encoded transaction data that can be sent via viem, wagmi,
   * ethers.js, or any other wallet library.
   *
   * @param token - Token contract address
   * @param to - Recipient address
   * @param amount - Amount to transfer (in token's smallest unit)
   * @returns Object with `to` (contract address) and `data` (encoded calldata)
   *
   * @example
   * ```typescript
   * // With viem/wagmi
   * const encoded = client.erc20.encodeTransfer(tokenAddress, recipientAddress, amount);
   * const hash = await walletClient.sendTransaction({
   *   to: encoded.to,
   *   data: encoded.data,
   *   gas: estimatedGas
   * });
   * ```
   */
  encodeTransfer(
    token: string,
    to: string,
    amount: bigint
  ): { to: string; data: string } {
    validateAddress(token, 'token');
    validateAddress(to, 'to');

    const iface = new Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('transfer', [to, amount]);

    return { to: token, data };
  }

  /**
   * Clear the decimals cache
   *
   * Useful if you need to refresh decimals values (rare).
   */
  clearDecimalsCache(): void {
    this.decimalsCache.clear();
  }

  // ============ Call Static Methods (transaction simulation) ============

  /**
   * Simulate a token approval without submitting the transaction.
   *
   * Uses ethers.js v6 staticCall to verify the transaction would succeed
   * and get the return value (boolean) without spending gas.
   *
   * @param token - Token contract address
   * @param spender - Address to approve for spending
   * @param amount - Amount to approve (in token's smallest unit)
   * @returns CallStaticResult with boolean indicating approval success
   *
   * @example
   * ```typescript
   * const result = await client.erc20.callStaticApprove(token, spender, amount);
   * if (result.success) {
   *   console.log('Approval would succeed, gas estimate:', result.gasEstimate);
   *   const receipt = await client.erc20.approve(token, spender, amount);
   * }
   * ```
   */
  async callStaticApprove(
    token: string,
    spender: string,
    amount: bigint
  ): Promise<CallStaticResult<boolean>> {
    validateAddress(token, 'token');
    validateAddress(spender, 'spender');

    this.client.logger.debug('Simulating approve (callStatic)', { token, spender, amount: amount.toString() });

    try {
      const signer = this.client.requireSigner();
      const contract = new Contract(token, ERC20_ABI, signer);

      // Use staticCall to simulate and get return value
      const returnValue = await contract.getFunction('approve').staticCall(spender, amount) as boolean;

      // Get gas estimate
      const gasEstimate = await contract.getFunction('approve').estimateGas(spender, amount);

      return {
        success: true,
        returnValue,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticApprove failed', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }

  /**
   * Simulate a token transfer without submitting the transaction.
   *
   * @param token - Token contract address
   * @param to - Recipient address
   * @param amount - Amount to transfer (in token's smallest unit)
   * @returns CallStaticResult with boolean indicating transfer success
   */
  async callStaticTransfer(
    token: string,
    to: string,
    amount: bigint
  ): Promise<CallStaticResult<boolean>> {
    validateAddress(token, 'token');
    validateAddress(to, 'to');

    if (amount <= 0n) {
      return {
        success: false,
        error: createError('INVALID_PARAMS', 'Transfer amount must be positive'),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }

    this.client.logger.debug('Simulating transfer (callStatic)', { token, to, amount: amount.toString() });

    try {
      const signer = this.client.requireSigner();
      const contract = new Contract(token, ERC20_ABI, signer);

      // Use staticCall to simulate and get return value
      const returnValue = await contract.getFunction('transfer').staticCall(to, amount) as boolean;

      // Get gas estimate
      const gasEstimate = await contract.getFunction('transfer').estimateGas(to, amount);

      return {
        success: true,
        returnValue,
        gasEstimate,
        gasLimitWithBuffer: (gasEstimate * 120n) / 100n,
      };
    } catch (error) {
      this.client.logger.warn('callStaticTransfer failed', { error });
      return {
        success: false,
        error: mapContractError(error),
        gasEstimate: 0n,
        gasLimitWithBuffer: 0n,
      };
    }
  }
}
