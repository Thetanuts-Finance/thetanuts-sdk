import { ZeroAddress } from 'ethers';
import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import type {
  OrderWithSignature,
  OdetteRawOrderData,
  OrderFilters,
  Position,
  PositionSettlement,
  PositionPnL,
  OptionStatusType,
  TradeHistory,
  ProtocolStats,
  MarketPrices,
  MarketPrice,
  MarketDataResponse,
  ReferrerStats,
  FactoryReferrerStats,
  IndexerHealth,
  FactoryStats,
  FactoryOptionDetail,
  BookOptionDetail,
  ProtocolStatsResponse,
  DailyStatsResponse,
} from '../types/api.js';
import type {
  StateApiResponse,
  StateRfq,
  StateOffer,
  StateOption,
} from '../types/stateApi.js';
import type { Order } from '../types/optionBook.js';
import { mapHttpError } from '../utils/errors.js';
import { validateAddress } from '../utils/validation.js';

// Known price feed addresses on Base mainnet
const BTC_PRICE_FEED = '0x64c911996d3c6ac71f9b455b1e8e7266bcbd848f';
const ETH_PRICE_FEED = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70';

// Token addresses on Base mainnet
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const WBTC_ADDRESS = '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c'; // cbBTC on Base

// Mapping from price feed to underlying token
const PRICE_FEED_TO_UNDERLYING: Record<string, string> = {
  [BTC_PRICE_FEED.toLowerCase()]: WBTC_ADDRESS,
  [ETH_PRICE_FEED.toLowerCase()]: WETH_ADDRESS,
};

/**
 * Derive underlying token address from price feed address
 */
function deriveUnderlyingFromPriceFeed(priceFeed: string): string {
  return PRICE_FEED_TO_UNDERLYING[priceFeed.toLowerCase()] ?? ZeroAddress;
}

/**
 * Coerce a JSON numeric field to a finite `number`, returning a fallback on
 * null/undefined and throwing on `NaN` / `Infinity` (TNU-AUDIT-0058).
 *
 * NOTE: this still silently truncates values beyond `2^53` because the
 * underlying JSON value has already been parsed by V8. For uint64-shaped
 * fields (block numbers, large counters) prefer `BigInt(raw)` from the raw
 * string when the indexer emits one — but a defensive finite-number gate is
 * a strict improvement over the previous bare `Number(...)` call.
 */
function safeNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`API field was not a finite number: ${String(value)}`);
  }
  return n;
}

/**
 * Module for API interactions
 *
 * Provides methods for fetching orders, positions, history, and stats.
 * Methods are organized by data source:
 * - **Book API** (indexer.thetanuts.finance/api/v1/book): `*FromIndexer` suffix
 * - **Factory/State API** (indexer.thetanuts.finance): `*FromRfq` suffix
 *
 * @example
 * ```typescript
 * // Fetch all orders
 * const orders = await client.api.fetchOrders();
 *
 * // Get user positions from Indexer
 * const positions = await client.api.getUserPositionsFromIndexer('0x...');
 *
 * // Get protocol stats from Indexer
 * const stats = await client.api.getStatsFromIndexer();
 *
 * // Get user options from RFQ system
 * const options = await client.api.getUserOptionsFromRfq('0x...');
 * ```
 */
export class APIModule {
  constructor(private readonly client: ThetanutsClient) {}

  /**
   * Make an API request with error handling
   */
  private async request<T>(endpoint: string, options?: { params?: Record<string, string | number> }): Promise<T> {
    try {
      const response = await this.client.http.get<T>(endpoint, options);
      return response.data;
    } catch (error) {
      this.client.logger.error('API request failed', { endpoint, error });
      throw mapHttpError(error);
    }
  }

  /**
   * Make an indexer API request with error handling
   */
  private async indexerRequest<T>(endpoint: string, options?: { params?: Record<string, string | number> }): Promise<T> {
    try {
      const url = `${this.client.indexerApiUrl}${endpoint}`;
      const response = await this.client.http.get<T>(url, options);
      return response.data;
    } catch (error) {
      this.client.logger.error('Indexer API request failed', { endpoint, error });
      throw mapHttpError(error);
    }
  }

  /**
   * Fetch all available orders from Odette API
   *
   * @returns Array of orders with signatures
   *
   * @example
   * ```typescript
   * const orders = await client.api.fetchOrders();
   * console.log(`Found ${orders.length} orders`);
   *
   * // Filter by asset using rawApiData
   * const btcOrders = orders.filter(o =>
   *   o.rawApiData?.priceFeed === '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F'
   * );
   * ```
   */
  async fetchOrders(): Promise<OrderWithSignature[]> {
    this.client.logger.debug('Fetching orders from Odette API');

    // Fetch from root endpoint - API returns { data: { orders: [...], market_data: {...} } }
    const response = await this.request<{
      data?: {
        orders: Array<Record<string, unknown>>;
        market_data?: Record<string, number>;
      };
      orders?: Array<Record<string, unknown>>;
    }>('/');

    // Handle both wrapped (data.orders) and unwrapped (orders) response formats
    const orders = response.data?.orders ?? response.orders ?? [];
    return orders.map((raw) => this.normalizeOdetteOrder(raw));
  }

  /**
   * Get market data (asset prices) from Odette API
   *
   * @returns Market prices for all supported assets with metadata
   *
   * @example
   * ```typescript
   * const marketData = await client.api.getMarketData();
   * console.log(`BTC: $${marketData.prices.BTC}`);
   * console.log(`ETH: $${marketData.prices.ETH}`);
   * console.log(`SOL: $${marketData.prices.SOL}`);
   * console.log(`Last updated: ${new Date(marketData.metadata.lastUpdated)}`);
   * ```
   */
  async getMarketData(): Promise<MarketDataResponse> {
    this.client.logger.debug('Fetching market data from Odette API');

    const response = await this.request<{
      data?: {
        orders: unknown[];
        market_data?: Record<string, number>;
      };
      metadata?: {
        last_updated?: number;
        current_time?: number;
      };
    }>('/');

    const marketData = response.data?.market_data ?? {};
    const metadata = response.metadata ?? {};

    return {
      prices: {
        ETH: marketData['ETH'] ?? 0,
        BTC: marketData['BTC'] ?? 0,
        SOL: marketData['SOL'] ?? 0,
        XRP: marketData['XRP'] ?? 0,
        BNB: marketData['BNB'] ?? 0,
        AVAX: marketData['AVAX'] ?? 0,
        ...marketData,
      },
      metadata: {
        lastUpdated: metadata['last_updated'] ?? 0,
        currentTime: metadata['current_time'] ?? 0,
      },
    };
  }

  /**
   * Filter orders by criteria
   *
   * @param filters - Filter criteria
   * @returns Filtered array of orders
   *
   * @example
   * ```typescript
   * const ethOrders = await client.api.filterOrders({
   *   asset: 'ETH',
   *   type: 'call',
   * });
   * ```
   */
  async filterOrders(filters: OrderFilters): Promise<OrderWithSignature[]> {
    this.client.logger.debug('Filtering orders', { filters });

    const params: Record<string, string | number> = {};

    if (filters.asset) params['asset'] = filters.asset;
    if (filters.type) params['type'] = filters.type;
    if (filters.collateral) params['collateral'] = filters.collateral;
    if (filters.minExpiry) params['min_expiry'] = filters.minExpiry;
    if (filters.maxExpiry) params['max_expiry'] = filters.maxExpiry;

    const response = await this.request<{ orders: Array<Record<string, unknown>> }>('/orders', {
      params,
    });

    return response.orders.map((raw) => this.normalizeOrder(raw));
  }

  /**
   * Get user's open positions from the Indexer API (OptionBook)
   *
   * @param address - User address
   * @returns Array of positions
   *
   * @example
   * ```typescript
   * const positions = await client.api.getUserPositionsFromIndexer('0x...');
   * for (const pos of positions) {
   *   console.log(`Position: ${pos.amount} contracts, PnL: ${pos.pnl}`);
   * }
   * ```
   */
  async getUserPositionsFromIndexer(address: string): Promise<Position[]> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching user positions', { address });

    const response = await this.indexerRequest<{ data: Record<string, unknown>[] }>(
      `/user/${address}/positions`
    );
    const rawPositions = response.data;

    return rawPositions.map((raw) => this.normalizePosition(raw));
  }

  /**
   * Get user's trade history from the Indexer API (OptionBook)
   *
   * @param address - User address
   * @returns Array of trade history entries
   *
   * @example
   * ```typescript
   * const history = await client.api.getUserHistoryFromIndexer('0x...');
   * ```
   */
  async getUserHistoryFromIndexer(address: string): Promise<TradeHistory[]> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching user history', { address });

    const response = await this.indexerRequest<{ data: Record<string, unknown>[] }>(
      `/user/${address}/history`
    );
    const rawTrades = response.data;

    return rawTrades.map((raw) => this.normalizeTradeHistory(raw));
  }

  /**
   * Trigger indexer refresh
   *
   * @example
   * ```typescript
   * await client.api.triggerIndexerUpdate();
   * ```
   */
  async triggerIndexerUpdate(): Promise<void> {
    this.client.logger.debug('Triggering indexer update');

    try {
      const url = `${this.client.indexerApiUrl}/update`;
      await this.client.http.post(url);
      this.client.logger.info('Indexer update triggered');
    } catch (error) {
      this.client.logger.error('Failed to trigger indexer update', { error });
      throw mapHttpError(error);
    }
  }

  /**
   * Get protocol statistics from the Indexer API (OptionBook)
   *
   * @returns Protocol stats
   *
   * @example
   * ```typescript
   * const stats = await client.api.getStatsFromIndexer();
   * console.log('Unique Users:', stats.uniqueUsers);
   * console.log('Open Positions:', stats.openPositions);
   * ```
   */
  async getStatsFromIndexer(): Promise<ProtocolStats> {
    this.client.logger.debug('Fetching protocol stats');

    const response = await this.indexerRequest<Record<string, unknown>>('/stats');

    // Extract positions breakdown
    const positions = (response['positions'] as Record<string, number>) ?? {};

    return {
      // Use `safeNumber` to reject NaN/Infinity at the boundary (TNU-AUDIT-0058).
      totalOptionsTracked: safeNumber(response['totalOptionsTracked']),
      openPositions: safeNumber(response['openPositions']),
      settledPositions: safeNumber(response['settledPositions']),
      closedPositions: safeNumber(response['closedPositions']),
      uniqueUsers: safeNumber(response['uniqueUsers']),
      lastProcessedBlock: safeNumber(response['lastProcessedBlock']),
      lastUpdateTimestamp: safeNumber(response['lastUpdateTimestamp']),
      positions: {
        total: Number(positions['total'] ?? 0),
        open: Number(positions['open'] ?? 0),
        settled: Number(positions['settled'] ?? 0),
        closed: Number(positions['closed'] ?? 0),
        pendingInit: Number(positions['pendingInit'] ?? 0),
      },
    };
  }

  /**
   * Get aggregated statistics for a referrer address from the Indexer API
   *
   * @param address - Referrer address
   * @returns Referrer statistics including positions and metrics
   *
   * @example
   * ```typescript
   * const stats = await client.api.getReferrerStatsFromIndexer('0x...');
   * console.log('Positions referred:', Object.keys(stats.positions).length);
   * console.log('Last updated:', stats.lastUpdateTimestamp);
   * ```
   */
  async getReferrerStatsFromIndexer(address: string): Promise<ReferrerStats> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching referrer stats', { address });

    const response = await this.indexerRequest<ReferrerStats>(
      `/referrer/${address}/state`
    );

    return response;
  }

  /**
   * Get current market prices
   *
   * @returns Market prices for all assets
   *
   * @example
   * ```typescript
   * const prices = await client.api.getMarketPrices();
   * console.log('ETH price:', prices['ETH'].price);
   * ```
   */
  async getMarketPrices(): Promise<MarketPrices> {
    this.client.logger.debug('Fetching market prices');

    const response = await this.request<Record<string, Record<string, unknown>>>('/prices');
    const prices: MarketPrices = {};

    for (const [asset, data] of Object.entries(response)) {
      prices[asset] = this.normalizeMarketPrice(data);
    }

    return prices;
  }

  /**
   * Make a state API request with error handling
   */
  private async stateRequest<T>(endpoint: string): Promise<T> {
    try {
      const url = `${this.client.stateApiUrl}${endpoint}`;
      const response = await this.client.http.get<T>(url);
      return response.data;
    } catch (error) {
      this.client.logger.error('State API request failed', { endpoint, error });
      throw mapHttpError(error);
    }
  }

  /**
   * Lower-cased current factory address (or `''` if not configured on this
   * chain — e.g. Ethereum mainnet, which is vault-only). Used by every
   * by-id and by-user indexer reader to filter out rows from predecessor
   * factory deployments. See class-level note about "multi-factory bug".
   *
   * Rationale (the bug this guards against): the indexer's
   * `/api/v1/factory/rfqs/{id}` endpoint is factory-agnostic and returns
   * the oldest-indexed row when the id collides across deployments. The
   * by-user endpoints accept an address with no factory scope, so they
   * happen to return current-factory rows only because no address has
   * activity on multiple factories yet — but that's coincidence, not
   * correctness. We filter client-side until the indexer fixes it.
   */
  private currentFactoryLc(): string {
    return (this.client.chainConfig.contracts.optionFactory ?? '').toLowerCase();
  }

  /**
   * Throw `RFQ_FACTORY_MISMATCH` when a single-row indexer payload belongs
   * to a different factory than the SDK is configured for.
   *
   * Used by every "by-id" indexer reader so the LLM (or any consumer)
   * cannot silently act on a stale row from a predecessor deployment.
   */
  private assertCurrentFactory(
    row: { factoryAddress?: string },
    context: { kind: string; id: string },
  ): void {
    const current = this.currentFactoryLc();
    if (!current) return; // chain has no factory (Ethereum) — nothing to enforce
    const got = row.factoryAddress?.toLowerCase();
    if (!got) return; // pre-bugfix indexer or unrelated payload — be permissive
    if (got !== current) {
      throw mapHttpError(
        Object.assign(
          new Error(
            `${context.kind} ${context.id} belongs to factory ${got} but the SDK is configured for ${current}. ` +
            `This is the known indexer-by-id bug — the same id exists on a predecessor factory deployment and the ` +
            `indexer returned the wrong row. Use the on-chain reader (e.g. optionFactory.getQuotation(id)) for ` +
            `authoritative state. If you really want the predecessor-factory row, fetch via a chain config pointed ` +
            `at that factory.`,
          ),
          {
            response: { status: 409 },
            config: { url: `${context.kind}/${context.id}` },
            // Surface structured fields so the MCP catch block (and any
            // other consumer) can render a useful error instead of a
            // generic 500.
            code: 'RFQ_FACTORY_MISMATCH',
            expectedFactory: current,
            actualFactory: got,
          },
        ),
      );
    }
  }

  /**
   * Drop rows whose `factoryAddress` doesn't match the current chain
   * config. Used by list/user endpoints where mixed-factory output is
   * possible and silent-truncation is the right semantics ("rows on the
   * current chain config" — the alternative is to return mixed rows and
   * leave the consumer to do this filter, which is what was happening
   * before this guard).
   */
  private filterToCurrentFactory<T extends { factoryAddress?: string }>(rows: T[]): T[] {
    const current = this.currentFactoryLc();
    if (!current) return rows;
    return rows.filter(r => {
      const got = r.factoryAddress?.toLowerCase();
      // Permissive on missing factoryAddress — older indexer versions or
      // unrelated payloads don't carry it. Strict mode would drop them.
      return !got || got === current;
    });
  }


  // ============================================================
  // State/RFQ API Methods
  // ============================================================

  /**
   * Get the full RFQ state from the State API
   *
   * Returns all RFQs, offers, options, user mappings, protocol stats, and referrals.
   *
   * @returns Full state API response
   *
   * @example
   * ```typescript
   * const state = await client.api.getStateFromRfq();
   * console.log('Total RFQs:', state.protocolStats.totalRfqs);
   * console.log('Active RFQs:', state.protocolStats.activeRfqs);
   * ```
   */
  async getStateFromRfq(): Promise<StateApiResponse> {
    this.client.logger.debug('Fetching full state from state API');
    return this.stateRequest<StateApiResponse>('/api/state');
  }

  /**
   * Get indexer health status
   *
   * @returns Health check with block lag, heartbeat, and status
   *
   * @example
   * ```typescript
   * const health = await client.api.getHealth();
   * console.log('Status:', health.status);
   * console.log('Block lag:', health.lagBlocks);
   * ```
   */
  async getHealth(): Promise<IndexerHealth> {
    this.client.logger.debug('Fetching indexer health');

    const response = await this.stateRequest<Record<string, unknown>>('/health');

    return {
      status: (response['status'] as 'ok' | 'unhealthy') ?? 'unhealthy',
      // safeNumber rejects NaN/Infinity at the API boundary (TNU-AUDIT-0058).
      chainId: safeNumber(response['chain_id']),
      lastIndexedBlock: safeNumber(response['last_indexed_block']),
      headBlock: safeNumber(response['head_block']),
      lagBlocks: safeNumber(response['lag_blocks']),
      lastPing: safeNumber(response['last_ping']),
      secondsSincePing: response['seconds_since_ping'] != null
        ? safeNumber(response['seconds_since_ping'])
        : null,
      timestamp: safeNumber(response['timestamp']),
    };
  }

  /**
   * Get all RFQs with optional status filter
   *
   * @param status - Optional status filter
   * @returns Complete array of RFQs
   *
   * @example
   * ```typescript
   * const allRfqs = await client.api.getFactoryRfqs();
   * const activeOnly = await client.api.getFactoryRfqs('active');
   * ```
   */
  async getFactoryRfqs(status?: 'active' | 'settled' | 'cancelled'): Promise<StateRfq[]> {
    this.client.logger.debug('Fetching factory RFQs', { status });

    const statusParam = status ? `?status=${status}` : '';
    const response = await this.stateRequest<{ data: StateRfq[] }>(`/api/v1/factory/rfqs${statusParam}`);
    // Strip predecessor-factory rows before applying any status re-filter.
    let data = this.filterToCurrentFactory(response.data);

    // Client-side re-filter: indexer may return RFQs whose is_active flag
    // disagrees with their derived status (e.g. cancelled RFQ with is_active=true)
    if (status) {
      data = data.filter((rfq) => rfq.status === status);
    }
    return data;
  }

  /** @deprecated Use `getFactoryRfqs()` instead */
  async getAllFactoryRfqs(status?: 'active' | 'settled' | 'cancelled'): Promise<StateRfq[]> {
    return this.getFactoryRfqs(status);
  }

  /**
   * Get all offers
   *
   * @returns Complete array of offers
   *
   * @example
   * ```typescript
   * const allOffers = await client.api.getFactoryOffers();
   * ```
   */
  async getFactoryOffers(): Promise<StateOffer[]> {
    this.client.logger.debug('Fetching factory offers');
    const response = await this.stateRequest<{ data: StateOffer[] }>('/api/v1/factory/offers');
    return this.filterToCurrentFactory(response.data);
  }

  /** @deprecated Use `getFactoryOffers()` instead */
  async getAllFactoryOffers(): Promise<StateOffer[]> {
    return this.getFactoryOffers();
  }

  /**
   * Get all options
   *
   * @returns Complete array of options
   *
   * @example
   * ```typescript
   * const allOptions = await client.api.getFactoryOptions();
   * ```
   */
  async getFactoryOptions(): Promise<StateOption[]> {
    this.client.logger.debug('Fetching factory options');
    const response = await this.stateRequest<{ data: StateOption[] }>('/api/v1/factory/options');
    return this.filterToCurrentFactory(response.data);
  }

  /** @deprecated Use `getFactoryOptions()` instead */
  async getAllFactoryOptions(): Promise<StateOption[]> {
    return this.getFactoryOptions();
  }

  /**
   * Get factory (RFQ) protocol statistics
   *
   * @returns Factory stats including RFQ counts, offer counts, and block info
   *
   * @example
   * ```typescript
   * const stats = await client.api.getFactoryStats();
   * console.log('Total RFQs:', stats.totalRfqs);
   * console.log('Active:', stats.activeRfqs);
   * ```
   */
  async getFactoryStats(): Promise<FactoryStats> {
    this.client.logger.debug('Fetching factory stats');
    return this.stateRequest<FactoryStats>('/api/v1/factory/stats');
  }

  /**
   * Get the full book state blob (all positions + user index)
   *
   * Returns all OptionBook positions, user position mappings, and metadata.
   * For user-specific data, prefer `getUserPositionsFromIndexer()` instead.
   *
   * @returns Full book state
   *
   * @example
   * ```typescript
   * const state = await client.api.getBookState();
   * console.log('Positions:', Object.keys(state.positions).length);
   * ```
   */
  async getBookState(): Promise<Record<string, unknown>> {
    this.client.logger.debug('Fetching full book state');
    return this.stateRequest<Record<string, unknown>>('/api/v1/book/state');
  }

  /**
   * Get a specific RFQ by ID from the State API
   *
   * @param id - Quotation ID
   * @returns RFQ data
   *
   * @example
   * ```typescript
   * const rfq = await client.api.getRfq('42');
   * console.log('Status:', rfq.status);
   * console.log('Requester:', rfq.requester);
   * ```
   */
  async getRfq(id: string): Promise<StateRfq> {
    this.client.logger.debug('Fetching RFQ from state API', { id });

    const result = await this.stateRequest<StateRfq & { error?: string }>(`/api/v1/factory/rfqs/${id}`);

    if (result.error) {
      throw mapHttpError(
        Object.assign(new Error(`RFQ ${id} not found`), {
          response: { status: 404 },
          config: { url: `/api/v1/factory/rfqs/${id}` },
        })
      );
    }

    // Guard against the multi-factory indexer bug. The endpoint returns
    // the oldest-indexed RFQ for any given id, so on collision we'd
    // hand back a predecessor-factory row pretending to be the current
    // one. Refuse the result rather than silently lie.
    this.assertCurrentFactory(result, { kind: 'RFQ', id });

    return result;
  }

  /**
   * Get the requester's ECDH public key for a quotation, as stored on
   * `StateRfq.requesterPublicKey`. This is what an offeror needs to encrypt
   * a sealed-bid offer to the requester (via `client.rfqKeys.encryptOffer`).
   *
   * Source of truth: the `QuotationRequested` event's `requesterPublicKey`
   * arg, hydrated by the State API indexer.
   *
   * @param quotationId - Quotation ID (decimal string)
   * @returns Compressed public key as hex string (e.g. `0x02abc...`)
   * @throws if the quotation is missing or has no recorded public key
   */
  async getRequesterPublicKey(quotationId: string): Promise<string> {
    const rfq = await this.getRfq(quotationId);
    if (!rfq.requesterPublicKey) {
      throw mapHttpError(
        Object.assign(new Error(`RFQ ${quotationId} has no requesterPublicKey`), {
          response: { status: 404 },
          config: { url: `/api/v1/factory/rfqs/${quotationId}` },
        })
      );
    }
    return rfq.requesterPublicKey;
  }

  /**
   * Get a specific offeror's offer on a quotation, including the encrypted
   * payload (`signedOfferForRequester`) and the offeror's ephemeral
   * `signingKey`. The requester uses these to decrypt and reconstruct
   * `(offerAmount, nonce)` for `settleQuotationEarly`.
   *
   * @param quotationId - Quotation ID (decimal string)
   * @param offeror     - Offeror's wallet address
   * @returns The matching `StateOffer`
   * @throws if the quotation is missing or has no offer from this offeror
   */
  async getOffer(quotationId: string, offeror: string): Promise<StateOffer> {
    validateAddress(offeror, 'offeror');
    const rfq = await this.getRfq(quotationId);
    const offers = rfq.offers ?? {};
    const target = offeror.toLowerCase();
    const offer = offers[offeror] ?? offers[target] ?? Object.values(offers).find(
      (entry) => entry.offeror?.toLowerCase() === target,
    );
    if (!offer) {
      throw mapHttpError(
        Object.assign(new Error(`No offer from ${offeror} on RFQ ${quotationId}`), {
          response: { status: 404 },
          config: { url: `/api/v1/factory/rfqs/${quotationId}` },
        })
      );
    }
    return offer;
  }

  /**
   * Get all RFQs for a user address from the State API
   *
   * @param address - User address
   * @returns Array of RFQs requested by the user
   *
   * @example
   * ```typescript
   * const rfqs = await client.api.getUserRfqs('0x...');
   * console.log(`User has ${rfqs.length} RFQs`);
   * ```
   */
  async getUserRfqs(address: string): Promise<StateRfq[]> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching user RFQs from state API', { address });

    const response = await this.stateRequest<{ data: StateRfq[] }>(`/api/v1/factory/user/${address}/rfqs`);
    // Filter to current-factory rows only. The indexer doesn't scope by
    // factory on the by-user endpoint; today this is a no-op because no
    // single address has RFQs on both factories, but that's coincidence
    // — the filter prevents silently-mixed output the moment any user
    // does. See `filterToCurrentFactory` for the rationale.
    return this.filterToCurrentFactory(response.data);
  }

  /**
   * Get all offers for a user address from the State/RFQ API
   *
   * @param address - User address
   * @returns Array of offers made by the user
   *
   * @example
   * ```typescript
   * const offers = await client.api.getUserOffersFromRfq('0x...');
   * for (const offer of offers) {
   *   console.log(`Offer on RFQ ${offer.quotationId}`);
   * }
   * ```
   */
  async getUserOffersFromRfq(address: string): Promise<StateOffer[]> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching user offers from state API', { address });

    const response = await this.stateRequest<{ data: StateOffer[] }>(`/api/v1/factory/user/${address}/offers`);
    return this.filterToCurrentFactory(response.data);
  }

  /**
   * Get all options for a user address from the State/RFQ API
   *
   * @param address - User address
   * @returns Array of options held by the user
   *
   * @example
   * ```typescript
   * const options = await client.api.getUserOptionsFromRfq('0x...');
   * for (const opt of options) {
   *   console.log(`Option at ${opt.address}, expires ${opt.expiry}`);
   * }
   * ```
   */
  async getUserOptionsFromRfq(address: string): Promise<StateOption[]> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching user options from state API', { address });

    const response = await this.stateRequest<{ data: StateOption[] }>(`/api/v1/factory/user/${address}/positions`);
    return this.filterToCurrentFactory(response.data);
  }

  /**
   * Get a single factory option with PnL data
   *
   * @param optionAddress - Option contract address
   * @returns Factory option detail including RFQs, events, status, settlement, and PnL
   */
  async getFactoryOption(optionAddress: string): Promise<FactoryOptionDetail> {
    validateAddress(optionAddress, 'optionAddress');
    this.client.logger.debug('Fetching factory option', { optionAddress });
    const response = await this.stateRequest<{ data: FactoryOptionDetail }>(
      `/api/v1/factory/option/${optionAddress}`
    );
    return response.data;
  }

  /**
   * Get referrer statistics scoped to the factory/RFQ side.
   *
   * Returns all RFQs credited to this referrer, the referral IDs used,
   * and a factory protocol stats snapshot.
   *
   * This is the factory counterpart to `getReferrerStatsFromIndexer()`,
   * which targets the book API. The response shapes differ: factory is
   * RFQ-centric (`rfqs` + `protocolStats`), book is position-centric
   * (`positions` + `summary`).
   *
   * @param address - Referrer address
   * @returns Factory referrer stats (rfqs, referralIds, protocolStats)
   *
   * @example
   * ```typescript
   * const stats = await client.api.getFactoryReferrerStats('0x...');
   * console.log('RFQs referred:', Object.keys(stats.rfqs).length);
   * console.log('Referral IDs:', stats.referralIds);
   * ```
   */
  async getFactoryReferrerStats(address: string): Promise<FactoryReferrerStats> {
    validateAddress(address, 'address');
    this.client.logger.debug('Fetching factory referrer stats', { address });

    return this.stateRequest<FactoryReferrerStats>(
      `/api/v1/factory/referrer/${address}/state`
    );
  }

  /**
   * Get a single book option with PnL data
   *
   * @param optionAddress - Option contract address
   * @returns Book option detail including position, events, status, settlement, and PnL
   */
  async getBookOption(optionAddress: string): Promise<BookOptionDetail> {
    validateAddress(optionAddress, 'optionAddress');
    this.client.logger.debug('Fetching book option', { optionAddress });
    const response = await this.stateRequest<{ data: BookOptionDetail }>(
      `/api/v1/book/option/${optionAddress}`
    );
    return response.data;
  }

  // ============================================================
  // Protocol Stats Methods (unified indexer)
  // ============================================================

  /**
   * Get book (OptionBook) protocol statistics with time windows and implementation breakdowns
   *
   * @returns Book protocol stats including 24h/7d/30d windows, per-token volumes, and per-implementation breakdowns
   *
   * @example
   * ```typescript
   * const stats = await client.api.getBookProtocolStats();
   * console.log('Total volume:', stats.stats.totalVolumeUsd);
   * console.log('24h positions:', stats.stats['24h'].positions);
   * ```
   */
  async getBookProtocolStats(): Promise<ProtocolStatsResponse> {
    this.client.logger.debug('Fetching book protocol stats');
    return this.stateRequest<ProtocolStatsResponse>('/api/v1/book/stats/protocol');
  }

  /**
   * Get factory (OptionFactory/RFQ) protocol statistics with time windows
   *
   * Includes factory-specific fields like avgTimeToFill and avgOffersPerRfq.
   *
   * @returns Factory protocol stats
   *
   * @example
   * ```typescript
   * const stats = await client.api.getFactoryProtocolStats();
   * console.log('Total RFQs:', stats.stats.totalPositions);
   * console.log('Avg time to fill:', stats.stats.avgTimeToFill);
   * ```
   */
  async getFactoryProtocolStats(): Promise<ProtocolStatsResponse> {
    this.client.logger.debug('Fetching factory protocol stats');
    return this.stateRequest<ProtocolStatsResponse>('/api/v1/factory/stats/protocol');
  }

  /**
   * Get combined book + factory protocol statistics
   *
   * Returns merged totals across both trading mechanisms.
   *
   * @returns Combined protocol stats
   *
   * @example
   * ```typescript
   * const stats = await client.api.getProtocolStats();
   * console.log('Total positions:', stats.stats.totalPositions);
   * console.log('Total volume:', stats.stats.totalVolumeUsd);
   * ```
   */
  async getProtocolStats(): Promise<ProtocolStatsResponse> {
    this.client.logger.debug('Fetching combined protocol stats');
    return this.stateRequest<ProtocolStatsResponse>('/api/v1/stats/protocol');
  }

  // ============================================================
  // Daily Stats Methods (unified indexer)
  // ============================================================

  /**
   * Get book (OptionBook) daily trading time series
   *
   * @returns Daily entries with trades, volume, premium, fees per day (by token + USD)
   *
   * @example
   * ```typescript
   * const daily = await client.api.getBookDailyStats();
   * for (const day of daily.daily) {
   *   console.log(`${day.date}: ${day.trades} trades, $${day.volumeUsd} volume`);
   * }
   * ```
   */
  async getBookDailyStats(): Promise<DailyStatsResponse> {
    this.client.logger.debug('Fetching book daily stats');
    return this.stateRequest<DailyStatsResponse>('/api/v1/book/stats/daily');
  }

  /**
   * Get factory (OptionFactory/RFQ) daily trading time series
   *
   * @returns Daily entries with trades, volume, premium, fees per day
   *
   * @example
   * ```typescript
   * const daily = await client.api.getFactoryDailyStats();
   * console.log(`${daily.daily.length} days of factory data`);
   * ```
   */
  async getFactoryDailyStats(): Promise<DailyStatsResponse> {
    this.client.logger.debug('Fetching factory daily stats');
    return this.stateRequest<DailyStatsResponse>('/api/v1/factory/stats/daily');
  }

  /**
   * Get combined book + factory daily trading time series
   *
   * @returns Daily entries with merged trades, volume, premium, fees per day
   *
   * @example
   * ```typescript
   * const daily = await client.api.getDailyStats();
   * console.log(`${daily.daily.length} days of combined data`);
   * ```
   */
  async getDailyStats(): Promise<DailyStatsResponse> {
    this.client.logger.debug('Fetching combined daily stats');
    return this.stateRequest<DailyStatsResponse>('/api/v1/stats/daily');
  }

  /**
   * Normalize raw order data from legacy API format
   */
  private normalizeOrder(raw: Record<string, unknown>): OrderWithSignature {
    const rawOrder = raw['order'] as Record<string, unknown>;

    const order: Order = {
      maker: String(rawOrder['maker'] ?? ''),
      taker: String(rawOrder['taker'] ?? '0x0000000000000000000000000000000000000000'),
      option: String(rawOrder['option'] ?? ''),
      isBuyer: Boolean(rawOrder['isBuyer'] ?? rawOrder['is_buyer']),
      numContracts: BigInt(String(rawOrder['numContracts'] ?? rawOrder['num_contracts'] ?? '0')),
      price: BigInt(String(rawOrder['price'] ?? '0')),
      expiry: BigInt(String(rawOrder['expiry'] ?? '0')),
      nonce: rawOrder['nonce'] != null ? BigInt(String(rawOrder['nonce'])) : 0n,
    };

    return {
      order,
      signature: String(raw['signature'] ?? ''),
      availableAmount: BigInt(String(raw['availableAmount'] ?? raw['available_amount'] ?? '0')),
      makerAddress: order.maker,
    };
  }

  /**
   * Normalize order data from Odette API format
   *
   * Maps Odette API fields to SDK Order structure:
   * - collateral -> stored in rawApiData
   * - priceFeed -> stored in rawApiData (BTC/ETH)
   * - implementation -> stored in rawApiData (determines product type)
   * - strikes -> stored in rawApiData
   * - isCall -> stored in rawApiData
   * - isLong -> mapped to !isBuyer (isLong=true means maker sells)
   * - maxCollateralUsable -> used to calculate availableAmount
   */
  private normalizeOdetteOrder(raw: Record<string, unknown>): OrderWithSignature {
    const rawOrder = raw['order'] as Record<string, unknown>;

    // Extract strikes array
    const strikesRaw = (rawOrder['strikes'] as Array<string | number>) ?? [];
    const strikes = strikesRaw.map((s) => String(s));

    // Extract contract-required fields from API data
    const priceFeed = String(rawOrder['priceFeed'] ?? '');
    const collateral = String(rawOrder['collateral'] ?? '');
    const isCall = Boolean(rawOrder['isCall']);
    const expiryTimestamp = BigInt(String(rawOrder['expiry'] ?? '0'));

    // Map Odette API fields to SDK Order structure
    const order: Order = {
      maker: String(rawOrder['maker'] ?? ''),
      taker: '0x0000000000000000000000000000000000000000', // Odette doesn't have taker
      option: '', // Option address not provided in API, will be created on fill
      isBuyer: !(rawOrder['isLong'] as boolean), // isLong=true means maker sells, so taker buys
      numContracts: BigInt(String(rawOrder['numContracts'] ?? '0')),
      price: BigInt(String(rawOrder['price'] ?? '0')),
      expiry: expiryTimestamp,
      nonce: raw['nonce'] != null ? BigInt(String(raw['nonce'])) : 0n,
      // Contract-required fields
      optionType: isCall ? 0 : 1, // 0 = call, 1 = put
      strikes: strikes.map((s) => BigInt(s)), // All strikes as bigint array
      strikePrice: strikes.length > 0 ? BigInt(strikes[0] ?? '0') : 0n, // Deprecated: first strike only
      collateralToken: collateral,
      underlyingToken: deriveUnderlyingFromPriceFeed(priceFeed),
      deadline: expiryTimestamp, // Use expiry as deadline
    };

    // Calculate available amount from maxCollateralUsable
    // For spreads: maxCollateralUsable is the max USDC that can be used
    const maxCollateralUsable = String(rawOrder['maxCollateralUsable'] ?? '0');

    // Build raw API data for filtering
    // Include optionBookAddress from API response (the contract the order was signed for)
    const optionBookAddress = raw['optionBookAddress'] as string | undefined;

    const rawApiData: OdetteRawOrderData = {
      collateral,
      priceFeed,
      implementation: String(rawOrder['implementation'] ?? ''),
      strikes,
      isCall,
      isLong: Boolean(rawOrder['isLong']),
      orderExpiryTimestamp: Number(rawOrder['orderExpiryTimestamp'] ?? 0),
      extraOptionData: String(rawOrder['extraOptionData'] ?? '0x'),
      maxCollateralUsable,
      // Only include optionBookAddress if defined (exactOptionalPropertyTypes compatibility)
      ...(optionBookAddress && { optionBookAddress }),
      // Include greeks from API if available
      ...(raw['greeks'] != null
        ? {
            greeks: raw['greeks'] as {
              delta: number;
              iv: number;
              gamma: number;
              theta: number;
              vega: number;
            },
          }
        : {}),
    };

    return {
      order,
      signature: String(raw['signature'] ?? ''),
      availableAmount: BigInt(maxCollateralUsable),
      makerAddress: order.maker,
      rawApiData,
    };
  }

  /**
   * Normalize raw position data from API
   *
   * API returns flat structure with fields like:
   * - address: option contract address
   * - status: "open" | "settled" | "closed"
   * - buyer/seller: addresses
   * - numContracts: position size
   * - entryPremium: premium paid
   * - underlyingAsset, collateralToken, strikes, expiryTimestamp, optionType
   */
  private normalizePosition(raw: Record<string, unknown>): Position {
    // Handle both nested option object (legacy) and flat structure (current API)
    const rawOption = (raw['option'] ?? {}) as Record<string, unknown>;
    const hasNestedOption = Object.keys(rawOption).length > 0;

    // Determine side based on whether user is buyer or seller
    // If 'side' is provided directly, use it; otherwise default to 'buyer'
    const side = String(raw['side'] ?? 'buyer') as 'buyer' | 'seller';

    // Get strikes from flat structure or nested option
    const strikes = hasNestedOption
      ? (Array.isArray(rawOption['strikes'])
          ? (rawOption['strikes'] as Array<string | number | bigint>).map((s) => BigInt(String(s)))
          : [])
      : (Array.isArray(raw['strikes'])
          ? (raw['strikes'] as Array<string | number | bigint>).map((s) => BigInt(String(s)))
          : []);

    // Parse settlement data if present
    const rawSettlement = raw['settlement'] as Record<string, unknown> | undefined;
    const settlement: PositionSettlement | undefined = rawSettlement ? {
      settlementPrice: BigInt(String(rawSettlement['settlementPrice'] ?? '0')),
      payoutBuyer: BigInt(String(rawSettlement['payoutBuyer'] ?? '0')),
      collateralReturnedSeller: BigInt(String(rawSettlement['collateralReturnedSeller'] ?? '0')),
      exercised: Boolean(rawSettlement['exercised']),
      deliveryAmount: BigInt(String(rawSettlement['deliveryAmount'] ?? '0')),
      deliveryCollateral: BigInt(String(rawSettlement['deliveryCollateral'] ?? '0')),
      explicitDecision: Boolean(rawSettlement['explicitDecision']),
      oracleFailure: Boolean(rawSettlement['oracleFailure']),
      oracleFailureReason: String(rawSettlement['oracleFailureReason'] ?? ''),
    } : undefined;

    return {
      id: String(raw['id'] ?? raw['address'] ?? ''),
      optionAddress: String(raw['optionAddress'] ?? raw['option_address'] ?? raw['address'] ?? ''),
      side,
      amount: BigInt(String(raw['amount'] ?? raw['numContracts'] ?? '0')),
      entryPrice: BigInt(String(raw['entryPrice'] ?? raw['entry_price'] ?? raw['entryPremium'] ?? '0')),
      currentValue: BigInt(String(raw['currentValue'] ?? raw['current_value'] ?? '0')),
      pnl: BigInt(String(raw['pnl'] ?? '0')),
      option: {
        underlying: String(hasNestedOption ? rawOption['underlying'] : (raw['underlyingAsset'] ?? raw['underlying'] ?? '')),
        collateral: String(hasNestedOption ? rawOption['collateral'] : (raw['collateralToken'] ?? raw['collateral'] ?? '')),
        strikes,
        expiry: Number(hasNestedOption ? (rawOption['expiry'] ?? 0) : (raw['expiryTimestamp'] ?? raw['expiry'] ?? 0)),
        optionType: Number(hasNestedOption ? (rawOption['optionType'] ?? rawOption['option_type'] ?? 0) : (raw['optionType'] ?? raw['optionTypeRaw'] ?? 0)),
      },
      status: String(raw['status'] ?? ''),
      buyer: String(raw['buyer'] ?? ''),
      seller: String(raw['seller'] ?? ''),
      referrer: String(raw['referrer'] ?? ''),
      createdBy: String(raw['createdBy'] ?? ''),
      entryTimestamp: BigInt(String(raw['entryTimestamp'] ?? '0')),
      entryTxHash: String(raw['entryTxHash'] ?? ''),
      entryBlock: BigInt(String(raw['entryBlock'] ?? '0')),
      entryFeePaid: BigInt(String(raw['entryFeePaid'] ?? '0')),
      collateralAmount: BigInt(String(raw['collateralAmount'] ?? '0')),
      collateralSymbol: String(raw['collateralSymbol'] ?? ''),
      collateralDecimals: Number(raw['collateralDecimals'] ?? 0),
      priceFeed: String(raw['priceFeed'] ?? ''),
      closeTimestamp: BigInt(String(raw['closeTimestamp'] ?? '0')),
      closeTxHash: String(raw['closeTxHash'] ?? ''),
      closeBlock: BigInt(String(raw['closeBlock'] ?? '0')),
      optionTypeRaw: Number(raw['optionTypeRaw'] ?? raw['optionType'] ?? 0),
      explicitClose: Boolean(raw['explicitClose']),
      ...(settlement && { settlement }),
      ...(raw['optionStatus'] ? { optionStatus: raw['optionStatus'] as OptionStatusType } : {}),
      ...(Array.isArray(raw['pnlEntries']) ? {
        pnlEntries: (raw['pnlEntries'] as Record<string, unknown>[]).map(e => ({
          side: String(e['side'] || 'buyer') as 'buyer' | 'seller',
          entryRfqId: String(e['entryRfqId'] ?? ''),
          exitType: String(e['exitType'] ?? '') as PositionPnL['exitType'],
          exitRfqId: e['exitRfqId'] ? String(e['exitRfqId']) : null,
          cost: e['cost'] != null ? String(e['cost']) : null,
          value: e['value'] != null ? String(e['value']) : null,
          pnl: e['pnl'] != null ? String(e['pnl']) : null,
          collateralToken: e['collateralToken'] != null ? String(e['collateralToken']) : null,
          collateralCost: e['collateralCost'] != null ? String(e['collateralCost']) : null,
          collateralValue: e['collateralValue'] != null ? String(e['collateralValue']) : null,
          collateralPnl: e['collateralPnl'] != null ? String(e['collateralPnl']) : null,
          deliveryToken: e['deliveryToken'] != null ? String(e['deliveryToken']) : null,
          deliveryCost: e['deliveryCost'] != null ? String(e['deliveryCost']) : null,
          deliveryValue: e['deliveryValue'] != null ? String(e['deliveryValue']) : null,
          deliveryPnl: e['deliveryPnl'] != null ? String(e['deliveryPnl']) : null,
          costUsd: e['costUsd'] != null ? String(e['costUsd']) : null,
          valueUsd: e['valueUsd'] != null ? String(e['valueUsd']) : null,
          pnlUsd: e['pnlUsd'] != null ? String(e['pnlUsd']) : null,
          pnlPct: e['pnlPct'] != null ? String(e['pnlPct']) : null,
        })),
      } : {}),
      ...(raw['pnlUsd'] != null ? { pnlUsd: String(raw['pnlUsd']) } : {}),
      ...(raw['pnlPct'] != null ? { pnlPct: String(raw['pnlPct']) } : {}),
      ...(raw['implementationName'] ? { implementationName: String(raw['implementationName']) } : {}),
      ...(raw['implementationType'] ? { implementationType: String(raw['implementationType']) } : {}),
      ...(raw['bookAddress'] ? { bookAddress: String(raw['bookAddress']) } : {}),
    };
  }

  /**
   * Normalize raw trade history data from API
   *
   * API returns position-like structure for history with fields like:
   * - address: option contract address
   * - status: "settled" | "closed"
   * - entryTimestamp: when trade was made
   * - entryTxHash: transaction hash
   * - numContracts: trade size
   * - entryPremium: price paid
   * - underlyingAsset, expiryTimestamp, etc.
   */
  private normalizeTradeHistory(raw: Record<string, unknown>): TradeHistory {
    // Handle both nested option object (legacy) and flat structure (current API)
    const rawOption = (raw['option'] ?? {}) as Record<string, unknown>;
    const hasNestedOption = Object.keys(rawOption).length > 0;

    // Determine trade type based on status or explicit type field
    const status = String(raw['status'] ?? '');
    let tradeType: TradeHistory['type'] = 'fill';
    if (raw['type']) {
      tradeType = String(raw['type']) as TradeHistory['type'];
    } else if (status === 'settled') {
      tradeType = 'settle';
    } else if (status === 'closed' || raw['explicitClose']) {
      tradeType = 'close';
    }

    // Get strikes from flat structure or nested option
    const strikes = hasNestedOption
      ? (Array.isArray(rawOption['strikes'])
          ? (rawOption['strikes'] as Array<string | number | bigint>).map((s) => BigInt(String(s)))
          : [])
      : (Array.isArray(raw['strikes'])
          ? (raw['strikes'] as Array<string | number | bigint>).map((s) => BigInt(String(s)))
          : []);

    // Parse settlement data if present
    const rawSettlement = raw['settlement'] as Record<string, unknown> | undefined;
    const settlement: PositionSettlement | undefined = rawSettlement ? {
      settlementPrice: BigInt(String(rawSettlement['settlementPrice'] ?? '0')),
      payoutBuyer: BigInt(String(rawSettlement['payoutBuyer'] ?? '0')),
      collateralReturnedSeller: BigInt(String(rawSettlement['collateralReturnedSeller'] ?? '0')),
      exercised: Boolean(rawSettlement['exercised']),
      deliveryAmount: BigInt(String(rawSettlement['deliveryAmount'] ?? '0')),
      deliveryCollateral: BigInt(String(rawSettlement['deliveryCollateral'] ?? '0')),
      explicitDecision: Boolean(rawSettlement['explicitDecision']),
      oracleFailure: Boolean(rawSettlement['oracleFailure']),
      oracleFailureReason: String(rawSettlement['oracleFailureReason'] ?? ''),
    } : undefined;

    return {
      id: String(raw['id'] ?? raw['address'] ?? ''),
      timestamp: Number(raw['timestamp'] ?? raw['entryTimestamp'] ?? 0),
      txHash: String(raw['txHash'] ?? raw['tx_hash'] ?? raw['entryTxHash'] ?? ''),
      type: tradeType,
      amount: BigInt(String(raw['amount'] ?? raw['numContracts'] ?? '0')),
      price: BigInt(String(raw['price'] ?? raw['entryPremium'] ?? '0')),
      option: {
        address: String(hasNestedOption ? rawOption['address'] : (raw['address'] ?? '')),
        underlying: String(hasNestedOption ? rawOption['underlying'] : (raw['underlyingAsset'] ?? raw['underlying'] ?? '')),
        expiry: Number(hasNestedOption ? (rawOption['expiry'] ?? 0) : (raw['expiryTimestamp'] ?? raw['expiry'] ?? 0)),
      },
      status,
      buyer: String(raw['buyer'] ?? ''),
      seller: String(raw['seller'] ?? ''),
      referrer: String(raw['referrer'] ?? ''),
      createdBy: String(raw['createdBy'] ?? ''),
      entryBlock: BigInt(String(raw['entryBlock'] ?? '0')),
      entryFeePaid: BigInt(String(raw['entryFeePaid'] ?? '0')),
      collateralAmount: BigInt(String(raw['collateralAmount'] ?? '0')),
      collateralSymbol: String(raw['collateralSymbol'] ?? ''),
      collateralDecimals: Number(raw['collateralDecimals'] ?? 0),
      priceFeed: String(raw['priceFeed'] ?? ''),
      optionTypeRaw: Number(raw['optionTypeRaw'] ?? raw['optionType'] ?? 0),
      strikes,
      explicitClose: Boolean(raw['explicitClose']),
      closeTimestamp: BigInt(String(raw['closeTimestamp'] ?? '0')),
      closeTxHash: String(raw['closeTxHash'] ?? ''),
      closeBlock: BigInt(String(raw['closeBlock'] ?? '0')),
      ...(settlement && { settlement }),
    };
  }

  /**
   * Normalize raw market price data
   */
  private normalizeMarketPrice(raw: Record<string, unknown>): MarketPrice {
    return {
      price: BigInt(String(raw['price'] ?? '0')),
      change24h: Number(raw['change24h'] ?? raw['change_24h'] ?? 0),
      timestamp: Number(raw['timestamp'] ?? 0),
    };
  }

}
