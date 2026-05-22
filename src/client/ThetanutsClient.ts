import axios from 'axios';
import type { AxiosInstance } from 'axios';
import type { Signer, Provider } from 'ethers';

import type { ThetanutsClientConfig, SupportedChainId, SupportedNetwork, Environment } from '../types/client.js';
import { CHAIN_CONFIGS_BY_ID, getChainConfigById, isChainIdSupported } from '../chains/index.js';
import type { ChainConfig } from '../chains/index.js';
import { Logger, noopLogger } from '../utils/logger.js';
import { createError } from '../utils/errors.js';
import { validateAddress } from '../utils/validation.js';
import { ERC20Module } from '../modules/erc20.js';
import { OptionBookModule } from '../modules/optionBook.js';
import { APIModule } from '../modules/api.js';
import { OptionFactoryModule } from '../modules/optionFactory.js';
import { OptionModule } from '../modules/option.js';
import { RangerModule } from '../modules/ranger.js';
import { EventsModule } from '../modules/events.js';
import { WebSocketModule } from '../modules/websocket.js';
import { UtilsModule } from '../modules/utils.js';
import { RFQKeyManagerModule } from '../modules/rfqKeyManager.js';
import { MMPricingModule } from '../modules/mmPricing.js';
import { LoanModule } from '../modules/loan.js';
import { CollarModule } from '../modules/collar.js';
import { WheelVaultModule } from '../modules/wheelVault.js';
import { StrategyVaultModule } from '../modules/strategyVault.js';

/**
 * Main client for interacting with Thetanuts Finance V4
 *
 * @example
 * ```typescript
 * import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
 * import { ethers } from 'ethers';
 *
 * const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
 * const signer = new ethers.Wallet(privateKey, provider);
 *
 * const client = new ThetanutsClient({
 *   chainId: 8453,
 *   provider,
 *   signer,
 *   referrer: '0x...',
 * });
 *
 * // Use V4 modules
 * await client.erc20.ensureAllowance(token, spender, amount);
 * await client.optionBook.fillOrder(order, signature, referrer);
 * ```
 */
export class ThetanutsClient {
  /** Chain ID this client is connected to */
  public readonly chainId: SupportedChainId;

  /** Chain configuration */
  public readonly chainConfig: ChainConfig;

  /** Environment (dev/prod) */
  public readonly env: Environment;

  /** Referrer address for fee sharing */
  public readonly referrer: string | undefined;

  /** JSON-RPC provider for read operations */
  public readonly provider: Provider;

  /** Signer for write operations (optional) */
  public readonly signer: Signer | undefined;

  /** Axios instance for API calls */
  public readonly http: AxiosInstance;

  /** Logger instance */
  public readonly logger: Logger;

  /** API base URL (orders) */
  public readonly apiBaseUrl: string;

  /** Indexer API base URL (positions, history, stats) */
  public readonly indexerApiUrl: string;

  /** WebSocket base URL */
  public readonly wsBaseUrl: string;

  /** Pricing API URL */
  public readonly pricingApiUrl: string;

  /** State API URL (RFQ indexer) */
  public readonly stateApiUrl: string;

  // V4 Modules - will be initialized in later phases
  // Placeholder declarations for type safety

  /**
   * ERC20 module - token approvals, balances, transfers
   */
  public readonly erc20: ERC20Module;

  /**
   * OptionBook module - fill orders, cancel orders, fees
   */
  public readonly optionBook: OptionBookModule;

  /**
   * API module - fetch orders, positions, history, stats
   */
  public readonly api: APIModule;

  /**
   * OptionFactory module - RFQ lifecycle
   */
  public readonly optionFactory: OptionFactoryModule;

  /**
   * Option module - position management, payouts
   */
  public readonly option: OptionModule;

  /**
   * Ranger module - zone-bound (RangerOption) position management
   */
  public readonly ranger: RangerModule;

  /**
   * Events module - query contract events
   */
  public readonly events: EventsModule;

  /**
   * WebSocket module - real-time subscriptions
   */
  public readonly ws: WebSocketModule;

  /**
   * Utils module - decimal conversions, payout calculations
   */
  public readonly utils: UtilsModule;

  /**
   * RFQ Key Manager - keypair generation and encryption for sealed-bid auctions
   */
  public readonly rfqKeys: RFQKeyManagerModule;

  /**
   * MM Pricing module - Market Maker pricing with fee adjustments and collateral costs
   */
  public readonly mmPricing: MMPricingModule;

  /**
   * Loan module - Non-liquidatable lending via physically-settled call options
   */
  public readonly loan: LoanModule;

  /**
   * Collar module - Zero-interest collar loans (capped upside, no liquidations).
   * Pricing/estimation works without deployed contracts; write methods require
   * the CollarLoanCoordinator to be deployed on the chain.
   */
  public readonly collar: CollarModule;

  /**
   * WheelVault module - Wheel strategy vaults on Ethereum
   */
  public readonly wheelVault: WheelVaultModule;

  /**
   * StrategyVault module - Fixed-strike + CLVEX directional/condor vaults on Base
   */
  public readonly strategyVault: StrategyVaultModule;

  constructor(config: ThetanutsClientConfig) {
    // Validate required parameters
    this.validateConfig(config);

    // Set basic properties
    this.chainId = config.chainId;
    this.env = config.env ?? 'prod';
    this.referrer = config.referrer;

    // Get chain configuration
    this.chainConfig = getChainConfigById(config.chainId);

    // Set up provider
    this.provider = config.provider;

    // Set up signer (optional)
    this.signer = config.signer;

    // Set up logger
    this.logger = new Logger(config.logger ?? noopLogger);

    // Set up URLs from config or chain defaults
    this.apiBaseUrl = config.apiBaseUrl ?? this.chainConfig.apiBaseUrl;
    this.indexerApiUrl = config.indexerApiUrl ?? this.chainConfig.indexerApiUrl;
    this.wsBaseUrl = config.wsUrl ?? this.chainConfig.wsBaseUrl;
    this.pricingApiUrl = config.pricingApiUrl ?? this.chainConfig.pricingApiUrl;
    this.stateApiUrl = config.stateApiUrl ?? this.chainConfig.stateApiUrl;

    // Set up HTTP client
    this.http = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.info('ThetanutsClient V4 initialized', {
      chainId: this.chainId,
      env: this.env,
      apiBaseUrl: this.apiBaseUrl,
      hasSigner: !!this.signer,
    });

    // Initialize V4 modules
    this.erc20 = new ERC20Module(this);
    this.optionBook = new OptionBookModule(this);
    this.api = new APIModule(this);
    this.optionFactory = new OptionFactoryModule(this);
    this.option = new OptionModule(this);
    this.ranger = new RangerModule(this);
    this.events = new EventsModule(this);
    this.ws = new WebSocketModule(this);
    this.utils = new UtilsModule(this);
    this.rfqKeys = new RFQKeyManagerModule(this, config.keyStorageProvider, config.rfqKeyPrefix);
    this.mmPricing = new MMPricingModule(this);
    this.loan = new LoanModule(this);
    this.collar = new CollarModule(this);
    this.wheelVault = new WheelVaultModule(this);
    this.strategyVault = new StrategyVaultModule(this);
  }

  /**
   * Validate client configuration
   */
  private validateConfig(config: ThetanutsClientConfig): void {
    // Check for chainId
    if (config.chainId === undefined || config.chainId === null) {
      throw createError('INVALID_PARAMS', 'chainId is required');
    }

    // Validate chainId is supported
    if (!isChainIdSupported(config.chainId)) {
      const supported = Object.values(CHAIN_CONFIGS_BY_ID)
        .map((c) => `${c.chainId} (${c.name})`)
        .join(', ');
      throw createError(
        'NETWORK_UNSUPPORTED',
        `Chain ID ${String(config.chainId)} is not supported. Supported chains: ${supported}`,
      );
    }

    // Check for provider
    if (!config.provider) {
      throw createError('INVALID_PARAMS', 'provider is required');
    }

    // Validate referrer address if provided
    if (config.referrer) {
      validateAddress(config.referrer, 'referrer');
    }
  }

  /**
   * Check if signer is available
   */
  hasSigner(): boolean {
    return !!this.signer;
  }

  /**
   * Get the signer, throwing if not available
   */
  requireSigner(): Signer {
    if (!this.signer) {
      throw createError('SIGNER_REQUIRED', 'Signer is required for this operation');
    }
    return this.signer;
  }

  /**
   * Get the current signer address
   */
  async getSignerAddress(): Promise<string> {
    return this.requireSigner().getAddress();
  }

  /**
   * Get the current block number
   */
  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * Get the current timestamp from the blockchain
   */
  async getCurrentTimestamp(): Promise<number> {
    const block = await this.provider.getBlock('latest');
    return block?.timestamp ?? Math.floor(Date.now() / 1000);
  }

  /**
   * Get contract address from chain config.
   * Throws if the contract is not deployed on the current chain.
   */
  getContractAddress(contract: 'optionBook' | 'optionFactory'): string {
    const address = this.chainConfig.contracts[contract];
    if (!address) {
      throw createError(
        'NETWORK_UNSUPPORTED',
        `${contract} is not deployed on ${this.chainConfig.name} (chain ${this.chainId})`
      );
    }
    return address;
  }

  /**
   * Get token config by symbol
   */
  getTokenConfig(symbol: string) {
    return this.chainConfig.tokens[symbol];
  }

  // ============================================
  // Backward compatibility properties (deprecated)
  // These will be removed in Phase 11
  // ============================================

  /**
   * @deprecated Use chainConfig.contracts.optionBook instead
   */
  get optionBookAddress(): string {
    return this.getContractAddress('optionBook');
  }

  /**
   * @deprecated Use referrer instead
   */
  get referrerAddress(): string | undefined {
    return this.referrer;
  }

  /**
   * @deprecated Use chainConfig.name instead
   */
  get network(): SupportedNetwork {
    // Map chainId to legacy network name
    const chainIdToNetwork: Partial<Record<SupportedChainId, SupportedNetwork>> = {
      8453: 'base',
      1: 'ethereum',
    };
    const network = chainIdToNetwork[this.chainId];
    if (!network) {
      throw createError('NETWORK_UNSUPPORTED', `No legacy network name for chain ${this.chainId}`);
    }
    return network;
  }

  /**
   * @deprecated No longer supported - slippage should be handled per-transaction
   */
  get slippageBps(): number {
    return 100; // Default 1%
  }
}
