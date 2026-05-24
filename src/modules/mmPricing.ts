import axios from 'axios';
import type { AxiosInstance } from 'axios';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import type {
  RawOptionPricing,
  MMAllPricingResponse,
  MMVanillaPricing,
  MMPositionPricing,
  MMSpreadPricing,
  MMCondorPricing,
  MMButterflyPricing,
  MMCollateralPricing,
  ParsedTicker,
  PositionPricingParams,
  SpreadPricingParams,
  CondorPricingParams,
  ButterflyPricingParams,
} from '../types/mmPricing.js';
import { COLLATERAL_APR, DEFAULT_CARRY_RATE, FEE_MULTIPLIER } from '../types/mmPricing.js';
import { mapHttpError } from '../utils/errors.js';
import { NotFoundError } from '../types/errors.js';
import { floatToBigInt, FLOAT_SCALE } from '../utils/decimals.js';

/**
 * Month abbreviation to number mapping for ticker parsing
 */
const MONTH_MAP: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Parse an option ticker string into its components.
 *
 * @param ticker - Ticker string, e.g., "ETH-16FEB26-1800-P"
 * @returns Parsed ticker information
 *
 * @example
 * ```typescript
 * const parsed = parseTicker('ETH-16FEB26-1800-P');
 * // { underlying: 'ETH', expiry: 1771113600, strike: 1800, isCall: false, ticker: 'ETH-16FEB26-1800-P' }
 * ```
 */
export function parseTicker(ticker: string): ParsedTicker {
  const parts = ticker.split('-');
  if (parts.length !== 4) {
    throw new Error(`Invalid ticker format: ${ticker}. Expected format: ASSET-DDMMMYY-STRIKE-C/P`);
  }

  const [underlying, dateStr, strikeStr, optionType] = parts;

  // Validate underlying
  if (!underlying || !['ETH', 'BTC'].includes(underlying)) {
    throw new Error(`Invalid underlying: ${underlying}. Expected ETH or BTC`);
  }

  // Parse date: "16FEB26" or "4MAR26" -> day, month, year
  // Day can be 1 or 2 digits, month is 3 letters, year is 2 digits
  if (!dateStr || dateStr.length < 6) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }

  // Find where month starts by looking for first letter
  const monthStartIdx = dateStr.search(/[A-Za-z]/);
  if (monthStartIdx === -1 || monthStartIdx > 2) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }

  const day = parseInt(dateStr.slice(0, monthStartIdx), 10);
  const monthStr = dateStr.slice(monthStartIdx, monthStartIdx + 3).toUpperCase();
  const yearStr = dateStr.slice(monthStartIdx + 3);

  if (isNaN(day) || day < 1 || day > 31) {
    throw new Error(`Invalid day in ticker: ${dateStr}`);
  }

  const month = MONTH_MAP[monthStr];
  if (month === undefined) {
    throw new Error(`Invalid month in ticker: ${monthStr}`);
  }

  // Parse year (2-digit year, assume 2000s)
  const year = 2000 + parseInt(yearStr, 10);
  if (isNaN(year)) {
    throw new Error(`Invalid year in ticker: ${yearStr}`);
  }

  // Create expiry timestamp (08:00 UTC on expiry day, standard for options)
  const expiryDate = new Date(Date.UTC(year, month, day, 8, 0, 0));
  const expiry = Math.floor(expiryDate.getTime() / 1000);

  // Parse strike — require strictly numeric input. `parseFloat("123abc")` returns
  // 123 (silent truncation), so reject anything that isn't a clean decimal
  // (TNU-AUDIT-0057).
  if (!strikeStr || !/^\d+(\.\d+)?$/.test(strikeStr)) {
    throw new Error(`Invalid strike price: ${strikeStr}`);
  }
  const strike = parseFloat(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) {
    throw new Error(`Invalid strike price: ${strikeStr}`);
  }

  // Parse option type
  const isCall = optionType?.toUpperCase() === 'C';
  if (optionType?.toUpperCase() !== 'C' && optionType?.toUpperCase() !== 'P') {
    throw new Error(`Invalid option type: ${optionType}. Expected C or P`);
  }

  return {
    underlying: underlying,
    expiry,
    strike,
    isCall,
    ticker,
  };
}

/**
 * Build a ticker string from components.
 *
 * @param underlying - Asset symbol (ETH, BTC)
 * @param expiry - Expiry timestamp (Unix seconds)
 * @param strike - Strike price (number or bigint with 8 decimals)
 * @param isCall - True for call, false for put
 * @returns Ticker string
 */
export function buildTicker(
  underlying: string,
  expiry: number,
  strike: number | bigint,
  isCall: boolean
): string {
  const date = new Date(expiry * 1000);
  // No leading zero for day - matches API format (e.g., "8MAR26" not "08MAR26")
  const day = date.getUTCDate().toString();
  const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = monthNames[date.getUTCMonth()];
  const year = (date.getUTCFullYear() % 100).toString();

  // Handle bigint strike (8 decimals)
  const strikeNum = typeof strike === 'bigint' ? Number(strike / 10n ** 8n) : strike;

  return `${underlying}-${day}${month}${year}-${strikeNum}-${isCall ? 'C' : 'P'}`;
}

/**
 * Apply fee adjustment to bid/ask prices.
 * Formula: min(0.0004, price * 0.125) - matches v4-webapp
 *
 * @param bid - Original bid price
 * @param ask - Original ask price
 * @param markPrice - Mark price (used for whitelisted users)
 * @param isWhitelisted - Whether user is whitelisted
 * @returns [adjustedBid, adjustedAsk]
 */
export function applyFeeAdjustment(
  bid: number,
  ask: number,
  markPrice: number = 0,
  isWhitelisted: boolean = false
): [number, number] {
  let adjustedBid = bid;
  let adjustedAsk = ask;

  // Whitelisted users use mark price for both bid and ask
  if (isWhitelisted && markPrice > 0) {
    adjustedBid = markPrice;
    adjustedAsk = markPrice;
  }

  // Fee: min(0.0004, price * 0.125) - matches v4-webapp
  const bidFee = adjustedBid > 0 ? Math.min(0.0004, adjustedBid * 0.125) : 0;
  const askFee = adjustedAsk > 0 ? Math.min(0.0004, adjustedAsk * 0.125) : 0;

  return [Math.max(0, adjustedBid - bidFee), adjustedAsk + askFee];
}

/**
 * Calculate collateral cost in collateral-native units.
 *
 * @param collateralAsset - Collateral asset type (BTC, ETH, USD)
 * @param collateralAmount - Amount of collateral per contract
 * @param timeToExpiryYears - Time to expiry in years
 * @returns Collateral cost in collateral units
 */
export function calculateCollateralCost(
  collateralAsset: string,
  collateralAmount: number,
  timeToExpiryYears: number
): number {
  if (timeToExpiryYears <= 0) {
    return 0;
  }
  const rate = COLLATERAL_APR[collateralAsset] ?? DEFAULT_CARRY_RATE;
  return collateralAmount * rate * timeToExpiryYears;
}

/**
 * Convert collateral cost to per-unit-of-underlying terms.
 * All prices are fractions of the underlying, so collateral cost
 * must be expressed in the same units.
 *
 * @param collateralCost - Raw collateral cost
 * @param collateralAsset - Collateral asset type
 * @param underlyingPrice - Current underlying price in USD
 * @returns Collateral cost per unit of underlying
 */
export function collateralCostPerUnderlying(
  collateralCost: number,
  collateralAsset: string,
  underlyingPrice: number
): number {
  if (collateralAsset === 'USD') {
    // USD collateral: divide by underlying price to get native terms
    return underlyingPrice > 0 ? collateralCost / underlyingPrice : 0;
  }
  // Native collateral (BTC, ETH): already in underlying units
  return collateralCost;
}

/**
 * Calculate collateral cost for spread-level structures (spreads, condors, butterflies).
 * Uses USD APR since these structures are collateralized by USDC based on max loss (width).
 *
 * This function differs from calculateCollateralCost() which is for vanilla options.
 * Spread structures only require collateral equal to the max loss (spread width),
 * not the full strike value of each leg.
 *
 * @param widthUsd - Spread width in USD (max loss per contract)
 * @param timeToExpiryYears - Time to expiry in years
 * @returns Collateral cost in USD
 *
 * @example
 * ```typescript
 * // Put spread K1=1800, K2=2000, T=0.25y
 * const cc = calculateSpreadCollateralCost(200, 0.25);
 * // Returns: 200 * 0.07 * 0.25 = 3.5 USD
 * ```
 */
export function calculateSpreadCollateralCost(
  widthUsd: number,
  timeToExpiryYears: number
): number {
  if (widthUsd <= 0 || timeToExpiryYears <= 0) {
    return 0;
  }
  const usdApr = COLLATERAL_APR['USD'] ?? 0.07;
  return widthUsd * usdApr * timeToExpiryYears;
}

/**
 * Compute MM prices for a specific collateral type.
 *
 * @param adjBid - Fee-adjusted bid price
 * @param adjAsk - Fee-adjusted ask price
 * @param wlAdjBid - Whitelisted fee-adjusted bid price
 * @param wlAdjAsk - Whitelisted fee-adjusted ask price
 * @param collateralAsset - Collateral asset type
 * @param collateralAmount - Amount of collateral per contract
 * @param underlyingPrice - Current underlying price in USD
 * @param timeToExpiryYears - Time to expiry in years
 * @returns MMCollateralPricing object
 */
function computeMMPrices(
  adjBid: number,
  adjAsk: number,
  wlAdjBid: number,
  wlAdjAsk: number,
  collateralAsset: string,
  collateralAmount: number,
  underlyingPrice: number,
  timeToExpiryYears: number
): MMCollateralPricing {
  const ccRaw = calculateCollateralCost(collateralAsset, collateralAmount, timeToExpiryYears);
  const cc = collateralCostPerUnderlying(ccRaw, collateralAsset, underlyingPrice);

  const mmAsk = adjAsk + cc;
  const mmBid = Math.max(0, adjBid - cc);
  const mmWlAsk = wlAdjAsk + cc;
  const mmWlBid = Math.max(0, wlAdjBid - cc);

  return {
    collateralAsset,
    collateralAmount,
    collateralCostPerUnit: cc,
    mmBidPrice: mmBid,
    mmAskPrice: mmAsk,
    mmWlBidPrice: mmWlBid,
    mmWlAskPrice: mmWlAsk,
    mmBidPriceBuffered: Math.max(0, mmBid / FEE_MULTIPLIER),
    mmAskPriceBuffered: mmAsk * FEE_MULTIPLIER,
    mmWlBidPriceBuffered: Math.max(0, mmWlBid / FEE_MULTIPLIER),
    mmWlAskPriceBuffered: mmWlAsk * FEE_MULTIPLIER,
  };
}

/**
 * Module for fetching Thetanuts Market Maker pricing.
 *
 * MM pricing includes fee adjustments and collateral costs,
 * typically resulting in prices 10-20% worse than raw exchange prices
 * (Deribit/Binance).
 *
 * @example
 * ```typescript
 * // Get all ETH option pricing with MM adjustments
 * const pricing = await client.mmPricing.getAllPricing('ETH');
 *
 * // Get specific ticker pricing
 * const price = await client.mmPricing.getTickerPricing('ETH-16FEB26-1800-P');
 * console.log('MM ask (USD collateral):', price.byCollateral.USD.mmAskPrice);
 * console.log('MM ask (ETH collateral):', price.byCollateral.ETH.mmAskPrice);
 * ```
 */
export class MMPricingModule {
  /** HTTP client for pricing API */
  private readonly pricingHttp: AxiosInstance;

  /** Cached pricing data */
  private cachedData: MMAllPricingResponse | null = null;
  private cacheExpiry: number = 0;

  constructor(private readonly client: ThetanutsClient) {
    this.pricingHttp = axios.create({
      baseURL: this.client.pricingApiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Fetch all pricing data from the API.
   * Results are cached based on the API's cache_ttl.
   *
   * @returns All pricing data
   */
  private async fetchAllPricingData(): Promise<MMAllPricingResponse> {
    const now = Date.now();

    // Return cached data if still valid
    if (this.cachedData && this.cacheExpiry > now) {
      return this.cachedData;
    }

    this.client.logger.debug('Fetching MM pricing data from /all');

    try {
      const response = await this.pricingHttp.get<MMAllPricingResponse>('/all');
      this.cachedData = response.data;

      // Set cache expiry based on API response
      const ttl = response.data.metadata?.cache_ttl ?? 60000;
      this.cacheExpiry = now + ttl;

      return response.data;
    } catch (error) {
      this.client.logger.error('Failed to fetch MM pricing data', { error });
      throw mapHttpError(error);
    }
  }

  /**
   * Convert raw API pricing to MMVanillaPricing with fee adjustments and collateral costs.
   *
   * @param ticker - Option ticker
   * @param raw - Raw pricing data from API
   * @param now - Current timestamp (for testing)
   * @returns MM-adjusted pricing with all collateral types
   */
  private toMMVanillaPricing(
    ticker: string,
    raw: RawOptionPricing,
    now: Date = new Date()
  ): MMVanillaPricing | null {
    const parsed = parseTicker(ticker);

    // Calculate time to expiry
    const timeToExpirySeconds = parsed.expiry - Math.floor(now.getTime() / 1000);
    if (timeToExpirySeconds <= 0) {
      return null; // Expired
    }
    const timeToExpiryYears = timeToExpirySeconds / (365 * 24 * 3600);

    const bid = raw.bid_price;
    const ask = raw.ask_price;
    const mark = raw.mark_price;
    const underlyingPrice = raw.underlying_price;
    const strike = raw.strike;

    if (underlyingPrice <= 0 || strike <= 0) {
      return null;
    }

    // Fee-adjusted prices (regular and whitelisted)
    const [adjBid, adjAsk] = applyFeeAdjustment(bid, ask, mark, false);
    const [wlAdjBid, wlAdjAsk] = applyFeeAdjustment(bid, ask, mark, true);

    // Compute MM prices for all possible collateral types:
    // - Native (1 unit per contract)
    // - USD (strike per contract)
    const collateralConfigs: Record<string, number> = {
      [parsed.underlying]: 1.0, // Native collateral: 1 unit per contract
      USD: strike, // USD collateral: strike per contract
    };

    const byCollateral: Record<string, MMCollateralPricing> = {};
    for (const [collAsset, collAmount] of Object.entries(collateralConfigs)) {
      byCollateral[collAsset] = computeMMPrices(
        adjBid,
        adjAsk,
        wlAdjBid,
        wlAdjAsk,
        collAsset,
        collAmount,
        underlyingPrice,
        timeToExpiryYears
      );
    }

    return {
      ticker,
      rawBidPrice: bid,
      rawAskPrice: ask,
      feeAdjustedBid: adjBid,
      feeAdjustedAsk: adjAsk,
      markPrice: mark,
      underlyingPrice,
      strike,
      expiry: parsed.expiry,
      isCall: parsed.isCall,
      underlying: parsed.underlying,
      passesToleranceCheck: raw.passesToleranceCheck,
      timeToExpiryYears,
      feeMultiplier: FEE_MULTIPLIER,
      byCollateral,
    };
  }

  /**
   * Get all MM pricing for an underlying asset.
   *
   * @param underlying - Asset symbol ('ETH' or 'BTC')
   * @returns Record of ticker to MM pricing
   *
   * @example
   * ```typescript
   * const allEth = await client.mmPricing.getAllPricing('ETH');
   * console.log('Number of ETH options:', Object.keys(allEth).length);
   * ```
   */
  async getAllPricing(underlying: 'ETH' | 'BTC'): Promise<Record<string, MMVanillaPricing>> {
    this.client.logger.debug('Getting all MM pricing', { underlying });

    const data = await this.fetchAllPricingData();
    const rawData = data.data[underlying];

    if (!rawData) {
      return {};
    }

    const result: Record<string, MMVanillaPricing> = {};
    const now = new Date();

    for (const [ticker, raw] of Object.entries(rawData)) {
      try {
        const pricing = this.toMMVanillaPricing(ticker, raw, now);
        if (pricing) {
          result[ticker] = pricing;
        }
      } catch (error) {
        // Skip invalid tickers
        this.client.logger.debug('Skipping invalid ticker', { ticker, error });
      }
    }

    return result;
  }

  /**
   * Get MM pricing for a specific ticker.
   *
   * @param ticker - Option ticker, e.g., "ETH-16FEB26-1800-P"
   * @returns MM-adjusted pricing with all collateral types
   *
   * @example
   * ```typescript
   * const price = await client.mmPricing.getTickerPricing('ETH-16FEB26-1800-P');
   * console.log('Raw ask:', price.rawAskPrice);
   * console.log('Fee-adjusted ask:', price.feeAdjustedAsk);
   * console.log('MM ask (USD coll):', price.byCollateral.USD.mmAskPrice);
   * console.log('MM ask buffered:', price.byCollateral.USD.mmAskPriceBuffered);
   * ```
   */
  async getTickerPricing(ticker: string): Promise<MMVanillaPricing> {
    this.client.logger.debug('Getting ticker MM pricing', { ticker });

    const parsed = parseTicker(ticker);
    const data = await this.fetchAllPricingData();
    const rawData = data.data[parsed.underlying as 'ETH' | 'BTC'];

    if (!rawData || !rawData[ticker]) {
      this.client.logger.warn('Ticker pricing data not found', {
        ticker,
        availableTickers: rawData ? Object.keys(rawData).slice(0, 20) : [],
      });
      throw new NotFoundError(
        `Ticker not found in pricing data: ${ticker}. The exchange may not list this strike/expiry.`,
        undefined,
        { ticker },
      );
    }

    const pricing = this.toMMVanillaPricing(ticker, rawData[ticker]);
    if (!pricing) {
      throw new NotFoundError(
        `Option expired or invalid: ${ticker}`,
        undefined,
        { ticker },
      );
    }

    return pricing;
  }

  /**
   * Get position-aware MM pricing with collateral cost included.
   * This is the full pricing that a market maker would quote for an RFQ.
   *
   * @param params - Position pricing parameters
   * @returns Position pricing including collateral cost
   *
   * @example
   * ```typescript
   * const position = await client.mmPricing.getPositionPricing({
   *   ticker: 'ETH-16FEB26-1800-P',
   *   isLong: true,  // User buying long
   *   numContracts: 10n * 10n**18n,
   *   collateralToken: 'USDC',
   * });
   * console.log('Total price:', position.totalPrice);
   * ```
   */
  async getPositionPricing(params: PositionPricingParams): Promise<MMPositionPricing> {
    this.client.logger.debug('Getting position MM pricing', { params });

    const vanilla = await this.getTickerPricing(params.ticker);

    // Map collateral token to asset
    let collateralAsset: string;
    if (params.collateralToken === 'USDC') {
      collateralAsset = 'USD';
    } else if (params.collateralToken === 'WETH') {
      collateralAsset = 'ETH';
    } else if (params.collateralToken === 'cbBTC') {
      collateralAsset = 'BTC';
    } else {
      collateralAsset = 'USD';
    }

    const collPricing = vanilla.byCollateral[collateralAsset];
    if (!collPricing) {
      throw new Error(`No pricing for collateral: ${collateralAsset}`);
    }

    // Determine decimals for collateral token
    const decimals = params.collateralToken === 'USDC' ? 6 : params.collateralToken === 'WETH' ? 18 : 8;
    const decimalScale = 10n ** BigInt(decimals);

    /* 
      Scale float API values to bigint early to avoid float precision loss
      FLOAT_SCALE (1e12) gives 12 decimal places — sufficient for pricing
    */
    const numContractsBig = BigInt(params.numContracts);
    const collateralPerContractScaled = floatToBigInt(collPricing.collateralAmount);
    const collateralCostPerUnitScaled = floatToBigInt(collPricing.collateralCostPerUnit);
    const underlyingPriceScaled = floatToBigInt(vanilla.underlyingPrice);

    /*
      Calculate collateral required (in collateral token's smallest unit)
      collateralPerContract is in underlying terms (e.g., 1800 for a $1800 strike put with USD collateral)
      Formula: collateralPerContract * numContracts * 10^decimals
      All math in bigint to prevent float overflow for large numContracts or high decimals
    */
    const collateralRequired = (collateralPerContractScaled * numContractsBig * decimalScale) / FLOAT_SCALE;

    // Calculate collateral cost (in collateral token's smallest unit)
    // collateralCostPerUnit is dimensionless (fraction of underlying)
    const collateralCost = (collateralCostPerUnitScaled * numContractsBig * underlyingPriceScaled * decimalScale) / (FLOAT_SCALE * FLOAT_SCALE);

    // Calculate base premium (in collateral token's smallest unit)
    // basePrice is dimensionless (fraction of underlying)
    // For long position (user buying), use ask price; for short, use bid
    const basePrice = params.isLong ? vanilla.feeAdjustedAsk : vanilla.feeAdjustedBid;
    const basePriceScaled = floatToBigInt(basePrice);
    const basePremium =
      (basePriceScaled * numContractsBig * underlyingPriceScaled * decimalScale)
      / (FLOAT_SCALE * FLOAT_SCALE);

    // Total price
    let totalPrice: bigint;
    if (params.isLong) {
      // User buying (MM selling): add collateral cost
      totalPrice = basePremium + collateralCost;
    } else {
      // User selling (MM buying): subtract collateral cost
      totalPrice = basePremium > collateralCost ? basePremium - collateralCost : 0n;
    }

    return {
      ...vanilla,
      isLong: params.isLong,
      numContracts: params.numContracts,
      collateralRequired,
      collateralCost,
      basePremium,
      totalPrice,
      timeToExpiryYears: vanilla.timeToExpiryYears,
      collateralToken: params.collateralToken,
    };
  }

  /**
   * Get MM pricing for a spread (two strikes).
   *
   * Uses spread-level collateral cost (width-based) instead of summing per-leg
   * vanilla collateral costs. This matches the mm_bot.py production implementation.
   *
   * @param params - Spread pricing parameters
   * @returns Spread pricing with both legs and pricing breakdown
   */
  async getSpreadPricing(params: SpreadPricingParams): Promise<MMSpreadPricing> {
    this.client.logger.debug('Getting spread MM pricing', { params });

    const [strike1, strike2] = params.strikes;
    const strike1Num = Number(strike1 / 10n ** 8n);
    const strike2Num = Number(strike2 / 10n ** 8n);

    // Build tickers for both legs
    const ticker1 = buildTicker(params.underlying, params.expiry, strike1Num, params.isCall);
    const ticker2 = buildTicker(params.underlying, params.expiry, strike2Num, params.isCall);

    // Fetch pricing for both legs
    let near: MMVanillaPricing;
    let far: MMVanillaPricing;
    try {
      [near, far] = await Promise.all([
        this.getTickerPricing(ticker1),
        this.getTickerPricing(ticker2),
      ]);
    } catch (error) {
      this.client.logger.error('Failed to get pricing for spread leg', {
        tickers: [ticker1, ticker2],
        strikes: [strike1Num, strike2Num],
        isCall: params.isCall,
        underlying: params.underlying,
      });
      throw error;
    }

    // Calculate spread width (max loss) in USD
    const widthUsd = Math.abs(strike2Num - strike1Num);

    // Calculate spread-level collateral cost (NOT per-leg!)
    // This is the key fix: use width-based CC instead of sum of vanilla leg CCs
    const spreadCollateralCostUsd = calculateSpreadCollateralCost(widthUsd, near.timeToExpiryYears);

    // Convert CC to underlying terms (prices are in underlying units)
    const spreadCCPerUnderlying = near.underlyingPrice > 0
      ? spreadCollateralCostUsd / near.underlyingPrice
      : 0;

    // Calculate net spread prices using fee-adjusted prices (NO collateral cost embedded)
    // This is different from the old buggy code that used mmAskPrice/mmBidPrice
    //
    // Strike ordering convention (matches mm_bot.py):
    // - CALL_SPREAD: strikes[0] < strikes[1] (ascending, buy lower, sell higher)
    // - PUT_SPREAD: strikes[0] > strikes[1] (descending, buy higher, sell lower)
    //
    // So for both types, we BUY strike1 (near) and SELL strike2 (far)
    // When user goes LONG (we sell spread): spread_price = near_ask - far_bid
    // When user goes SHORT (we buy spread): spread_price = near_bid - far_ask
    const netSpreadPriceAsk = near.feeAdjustedAsk - far.feeAdjustedBid;
    const netSpreadPriceBid = near.feeAdjustedBid - far.feeAdjustedAsk;

    // Apply single spread-level CC + FEE_MULTIPLIER to get final MM prices
    // ASK: (price + CC) * FEE_MULTIPLIER (user pays more when buying long)
    // BID: (price - CC) / FEE_MULTIPLIER (user receives less when selling short)
    const netMmAskPrice = (netSpreadPriceAsk + spreadCCPerUnderlying) * FEE_MULTIPLIER;
    const rawBidPrice = (netSpreadPriceBid - spreadCCPerUnderlying) / FEE_MULTIPLIER;
    const netMmBidPrice = Math.max(0, rawBidPrice);
    if (rawBidPrice < 0) {
      this.client.logger.debug('Spread bid price floored to 0', {
        rawBidPrice, netSpreadPriceBid, spreadCCPerUnderlying, ticker1, ticker2,
      });
    }

    // For transparency, return the ask-side spread price (most common use case)
    const netSpreadPrice = netSpreadPriceAsk;

    // Calculate collateral required — pure bigint to avoid float overflow
    const numContracts = params.numContracts ?? BigInt(10 ** 18);
    const widthScaled = floatToBigInt(widthUsd);
    const collateral = (widthScaled * numContracts) / (FLOAT_SCALE * (10n ** 12n));

    return {
      nearLeg: near,
      farLeg: far,
      netSpreadPrice,
      spreadCollateralCost: spreadCollateralCostUsd,
      widthUsd,
      netMmBidPrice,
      netMmAskPrice,
      maxLoss: widthUsd,
      collateral,
      type: params.isCall ? 'call_spread' : 'put_spread',
    };
  }

  /**
   * Get MM pricing for a condor (four strikes).
   *
   * Uses spread-level collateral cost (width-based) instead of summing per-leg
   * vanilla collateral costs. This matches the mm_bot.py production implementation.
   */
  async getCondorPricing(params: CondorPricingParams): Promise<MMCondorPricing> {
    this.client.logger.debug('Getting condor MM pricing', { params });

    const [s1, s2, s3, s4] = params.strikes;
    const strike1 = Number(s1 / 10n ** 8n);
    const strike2 = Number(s2 / 10n ** 8n);
    const strike3 = Number(s3 / 10n ** 8n);
    const strike4 = Number(s4 / 10n ** 8n);

    // Validate strikes are in ascending order
    if (!(strike1 < strike2 && strike2 < strike3 && strike3 < strike4)) {
      throw new Error('Condor strikes must be in ascending order');
    }

    // Validate equal spread widths
    const widthUsd = strike2 - strike1;
    const width2 = strike4 - strike3;
    if (Math.abs(widthUsd - width2) > 0.01) {
      throw new Error(`Condor spread widths must be equal. Got ${widthUsd} and ${width2}`);
    }

    // Determine option types for each leg
    const isCall = params.type === 'call';

    // Build tickers
    let tickers: string[];
    if (params.type === 'iron') {
      // Iron condor: puts for lower strikes, calls for upper strikes
      tickers = [
        buildTicker(params.underlying, params.expiry, strike1, false), // Put
        buildTicker(params.underlying, params.expiry, strike2, false), // Put
        buildTicker(params.underlying, params.expiry, strike3, true), // Call
        buildTicker(params.underlying, params.expiry, strike4, true), // Call
      ];
    } else {
      tickers = [strike1, strike2, strike3, strike4].map((s) => buildTicker(params.underlying, params.expiry, s, isCall));
    }

    // Fetch pricing for all legs
    let legs: [MMVanillaPricing, MMVanillaPricing, MMVanillaPricing, MMVanillaPricing];
    try {
      legs = await Promise.all(tickers.map((t) => this.getTickerPricing(t))) as [
        MMVanillaPricing,
        MMVanillaPricing,
        MMVanillaPricing,
        MMVanillaPricing,
      ];
    } catch (error) {
      this.client.logger.error('Failed to get pricing for condor leg(s)', {
        tickers,
        strikes: [strike1, strike2, strike3, strike4],
        type: params.type,
        underlying: params.underlying,
      });
      throw error;
    }

    // Calculate spread-level collateral cost (NOT per-leg!)
    const spreadCollateralCostUsd = calculateSpreadCollateralCost(widthUsd, legs[0].timeToExpiryYears);

    // Convert CC to underlying terms
    const spreadCCPerUnderlying = legs[0].underlyingPrice > 0
      ? spreadCollateralCostUsd / legs[0].underlyingPrice
      : 0;

    // Calculate separate buy/sell nets using fee-adjusted prices (matches v4-webapp)
    // Condor: +1 at K1, -1 at K2, -1 at K3, +1 at K4
    // Buy net (user buys condor): use ask for bought legs, bid for sold legs
    const buyNet =
      legs[0].feeAdjustedAsk - legs[1].feeAdjustedBid -
      legs[2].feeAdjustedBid + legs[3].feeAdjustedAsk;
    // Sell net (user sells condor): use bid for bought legs, ask for sold legs
    const sellNet =
      legs[0].feeAdjustedBid - legs[1].feeAdjustedAsk -
      legs[2].feeAdjustedAsk + legs[3].feeAdjustedBid;

    // For backward compat, netCondorPrice = buy-side net
    const netCondorPrice = buyNet;

    // Apply CC + FEE_MULTIPLIER (matches v4-webapp calculateCallCondorParams.ts)
    const netMmAskPrice = (buyNet + spreadCCPerUnderlying) * FEE_MULTIPLIER;
    const rawBidPrice = (sellNet - spreadCCPerUnderlying) / FEE_MULTIPLIER;
    const netMmBidPrice = Math.max(0, rawBidPrice);
    if (rawBidPrice < 0) {
      this.client.logger.debug('Condor bid price floored to 0', {
        rawBidPrice, sellNet, spreadCCPerUnderlying, tickers,
      });
    }

    // Calculate collateral — pure bigint to avoid float overflow
    const numContracts = params.numContracts ?? BigInt(10 ** 18);
    const widthScaled = floatToBigInt(widthUsd);
    const collateral = (widthScaled * numContracts) / (FLOAT_SCALE * (10n ** 12n));

    let condorType: 'call_condor' | 'put_condor' | 'iron_condor';
    if (params.type === 'iron') {
      condorType = 'iron_condor';
    } else if (isCall) {
      condorType = 'call_condor';
    } else {
      condorType = 'put_condor';
    }

    return {
      legs,
      netCondorPrice,
      spreadCollateralCost: spreadCollateralCostUsd,
      netMmBidPrice,
      netMmAskPrice,
      spreadWidth: widthUsd,
      collateral,
      type: condorType,
    };
  }

  /**
   * Get MM pricing for a butterfly (three strikes).
   *
   * Uses spread-level collateral cost (width-based) instead of summing per-leg
   * vanilla collateral costs. This matches the mm_bot.py production implementation.
   */
  async getButterflyPricing(params: ButterflyPricingParams): Promise<MMButterflyPricing> {
    this.client.logger.debug('Getting butterfly MM pricing', { params });

    const [s1, s2, s3] = params.strikes;
    const strike1 = Number(s1 / 10n ** 8n);
    const strike2 = Number(s2 / 10n ** 8n);
    const strike3 = Number(s3 / 10n ** 8n);

    // Validate strikes are equidistant
    const widthUsd = strike2 - strike1;
    const width2 = strike3 - strike2;
    if (Math.abs(widthUsd - width2) > 0.01) {
      throw new Error(`Butterfly strikes must be equidistant. Got widths ${widthUsd} and ${width2}`);
    }

    // Build tickers
    const tickers = [strike1, strike2, strike3].map((s) =>
      buildTicker(params.underlying, params.expiry, s, params.isCall)
    );

    // Fetch pricing for all legs
    let legs: [MMVanillaPricing, MMVanillaPricing, MMVanillaPricing];
    try {
      legs = await Promise.all(tickers.map((t) => this.getTickerPricing(t))) as [
        MMVanillaPricing,
        MMVanillaPricing,
        MMVanillaPricing,
      ];
    } catch (error) {
      this.client.logger.error('Failed to get pricing for butterfly leg(s)', {
        tickers,
        strikes: [strike1, strike2, strike3],
        isCall: params.isCall,
        underlying: params.underlying,
      });
      throw error;
    }

    // Calculate spread-level collateral cost (NOT per-leg!)
    const spreadCollateralCostUsd = calculateSpreadCollateralCost(widthUsd, legs[0].timeToExpiryYears);

    // Convert CC to underlying terms
    const spreadCCPerUnderlying = legs[0].underlyingPrice > 0
      ? spreadCollateralCostUsd / legs[0].underlyingPrice
      : 0;

    // Calculate separate buy/sell nets using fee-adjusted prices (matches v4-webapp)
    // Butterfly: +1 at lower, -2 at middle, +1 at upper
    // Buy net: use ask for bought legs (+1), bid for sold legs (-2)
    const buyNet =
      legs[0].feeAdjustedAsk - 2 * legs[1].feeAdjustedBid + legs[2].feeAdjustedAsk;
    // Sell net: use bid for bought legs (+1), ask for sold legs (-2)
    const sellNet =
      legs[0].feeAdjustedBid - 2 * legs[1].feeAdjustedAsk + legs[2].feeAdjustedBid;

    // For backward compat
    const netButterflyPrice = buyNet;

    // Apply CC + FEE_MULTIPLIER (matches v4-webapp)
    const netMmAskPrice = (buyNet + spreadCCPerUnderlying) * FEE_MULTIPLIER;
    const rawBidPrice = (sellNet - spreadCCPerUnderlying) / FEE_MULTIPLIER;
    const netMmBidPrice = Math.max(0, rawBidPrice);
    if (rawBidPrice < 0) {
      this.client.logger.debug('Butterfly bid price floored to 0', {
        rawBidPrice, sellNet, spreadCCPerUnderlying, tickers,
      });
    }

    // Calculate collateral (width between middle and outer) — pure bigint to avoid float overflow
    const numContracts = params.numContracts ?? BigInt(10 ** 18);
    const widthScaled = floatToBigInt(widthUsd);
    const collateral = (widthScaled * numContracts) / (FLOAT_SCALE * (10n ** 12n));

    return {
      legs,
      netButterflyPrice,
      spreadCollateralCost: spreadCollateralCostUsd,
      netMmBidPrice,
      netMmAskPrice,
      width: widthUsd,
      collateral,
      type: params.isCall ? 'call_butterfly' : 'put_butterfly',
    };
  }

  /**
   * Invalidate the pricing cache.
   * Call this to force a fresh fetch on the next request.
   */
  invalidateCache(): void {
    this.cachedData = null;
    this.cacheExpiry = 0;
  }

  // ============================================================
  // Utility Methods for Filtering & Sorting
  // ============================================================

  /**
   * Filter out expired options from pricing array.
   *
   * @param pricing - Array of MM pricing objects
   * @returns Filtered array with only non-expired options
   *
   * @example
   * ```typescript
   * const allPricing = await client.mmPricing.getAllPricing('ETH');
   * const active = client.mmPricing.filterExpired(Object.values(allPricing));
   * console.log('Active options:', active.length);
   * ```
   */
  filterExpired(pricing: MMVanillaPricing[]): MMVanillaPricing[] {
    const now = Math.floor(Date.now() / 1000);
    return pricing.filter(p => p.expiry > now);
  }

  /**
   * Sort pricing by expiry then strike.
   *
   * @param pricing - Array of MM pricing objects
   * @returns Sorted array (ascending expiry, then ascending strike)
   *
   * @example
   * ```typescript
   * const allPricing = await client.mmPricing.getAllPricing('ETH');
   * const sorted = client.mmPricing.sortByExpiryAndStrike(Object.values(allPricing));
   * ```
   */
  sortByExpiryAndStrike(pricing: MMVanillaPricing[]): MMVanillaPricing[] {
    return [...pricing].sort((a, b) => {
      if (a.expiry !== b.expiry) return a.expiry - b.expiry;
      return a.strike - b.strike;
    });
  }

  /**
   * Get unique expiry dates as ISO date strings.
   *
   * @param pricing - Array of MM pricing objects
   * @returns Sorted array of unique expiry dates (YYYY-MM-DD format)
   *
   * @example
   * ```typescript
   * const allPricing = await client.mmPricing.getAllPricing('ETH');
   * const expiries = client.mmPricing.getUniqueExpiries(Object.values(allPricing));
   * // ['2025-02-16', '2025-03-16', ...]
   * ```
   */
  getUniqueExpiries(pricing: MMVanillaPricing[]): string[] {
    const expiries = new Set<string>();
    for (const p of pricing) {
      const dateStr = new Date(p.expiry * 1000).toISOString().split('T')[0];
      if (dateStr) {
        expiries.add(dateStr);
      }
    }
    return Array.from(expiries).sort();
  }

  /**
   * Filter pricing by option type (calls or puts).
   *
   * @param pricing - Array of MM pricing objects
   * @param isCall - True for calls, false for puts
   * @returns Filtered array
   *
   * @example
   * ```typescript
   * const allPricing = await client.mmPricing.getAllPricing('ETH');
   * const puts = client.mmPricing.filterByType(Object.values(allPricing), false);
   * ```
   */
  filterByType(pricing: MMVanillaPricing[], isCall: boolean): MMVanillaPricing[] {
    return pricing.filter(p => p.isCall === isCall);
  }

  /**
   * Filter pricing by expiry date.
   *
   * @param pricing - Array of MM pricing objects
   * @param expiry - Expiry timestamp (Unix seconds) or date string (YYYY-MM-DD)
   * @returns Filtered array
   *
   * @example
   * ```typescript
   * const allPricing = await client.mmPricing.getAllPricing('ETH');
   * const feb16 = client.mmPricing.filterByExpiry(Object.values(allPricing), '2025-02-16');
   * ```
   */
  filterByExpiry(pricing: MMVanillaPricing[], expiry: number | string): MMVanillaPricing[] {
    if (typeof expiry === 'string') {
      // Match by date string (YYYY-MM-DD)
      return pricing.filter(p => {
        const pDate = new Date(p.expiry * 1000).toISOString().split('T')[0];
        return pDate === expiry;
      });
    }
    // Match by exact timestamp
    return pricing.filter(p => p.expiry === expiry);
  }

  /**
   * Filter pricing by strike range.
   *
   * @param pricing - Array of MM pricing objects
   * @param minStrike - Minimum strike (inclusive)
   * @param maxStrike - Maximum strike (inclusive)
   * @returns Filtered array
   *
   * @example
   * ```typescript
   * const allPricing = await client.mmPricing.getAllPricing('ETH');
   * const nearATM = client.mmPricing.filterByStrikeRange(Object.values(allPricing), 1800, 2200);
   * ```
   */
  filterByStrikeRange(pricing: MMVanillaPricing[], minStrike: number, maxStrike: number): MMVanillaPricing[] {
    return pricing.filter(p => p.strike >= minStrike && p.strike <= maxStrike);
  }

  /**
   * Get pricing as an array (convenience method).
   *
   * @param underlying - Asset symbol ('ETH' or 'BTC')
   * @returns Array of MM pricing objects (non-expired, sorted by expiry/strike)
   *
   * @example
   * ```typescript
   * const pricing = await client.mmPricing.getPricingArray('ETH');
   * console.log('First option:', pricing[0].ticker);
   * ```
   */
  async getPricingArray(underlying: 'ETH' | 'BTC'): Promise<MMVanillaPricing[]> {
    const allPricing = await this.getAllPricing(underlying);
    const values = Object.values(allPricing);
    const active = this.filterExpired(values);
    return this.sortByExpiryAndStrike(active);
  }
}
