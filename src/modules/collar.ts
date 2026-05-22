/**
 * Collar Loan Module — Zero-interest, capped-upside loans via Thetanuts V4 RFQ.
 *
 * A collar loan is the borrower's view of a risk reversal:
 *   - Borrower BUYS a put at K_lo (default protection)
 *   - Borrower SELLS a call at K_hi (cap)
 *
 * Day-0 cashflow: MM pays loan L (≈ K_lo · N). Both legs co-fund — the call
 * premium MM earns roughly equals the put premium MM pays.
 *
 * Terminal payoff at expiry (TWAP S):
 *   S < K_lo            → walk away: borrower keeps L, MM keeps N collateral
 *   K_lo ≤ S ≤ K_hi     → repay: borrower pays L, gets N back
 *   S > K_hi            → cap settle: MM pays N · (K_hi − K_lo), keeps N
 *
 * Status: this module ships the pricing math + ABIs ahead of the collar-v12
 * deployment. Read-only methods that only need Deribit data work today; write
 * methods throw `NETWORK_UNSUPPORTED` until contract addresses are populated.
 *
 * @example
 * ```typescript
 * const groups = await client.collar.getCapStrikeOptions('BTC', {
 *   ...client.collar.defaultSettings,
 *   collateralAmount: 0.5,
 * });
 * const est = client.collar.estimateCollar({
 *   underlying: 'BTC',
 *   collateralAmount: 0.5,
 *   capUsd: 150000,
 *   expiryLabel: '26DEC25',
 *   pricingData,
 *   underlyingPrice: 95000,
 * });
 * ```
 */

import { Contract, Interface, ethers } from 'ethers';
import type { ContractTransactionResponse } from 'ethers';

import type { ThetanutsClient } from '../client/ThetanutsClient.js';
import { COLLAR_COORDINATOR_ABI, COLLARED_CALL_OPTION_ABI } from '../abis/collar.js';
import {
  COLLAR_CONFIG,
  COLLAR_DEFAULT_SETTINGS,
  isCollarDeployed,
  type CollarSettings,
  type CollarAssetConfig,
} from '../chains/collar.js';
import { createError } from '../utils/errors.js';
import type { DeribitPricingMap } from '../types/loan.js';

// ─── Public types ───

export type CollarUnderlying = 'ETH' | 'BTC';

export interface CollarEstimate {
  /** Expected USDC loan amount at this cap/expiry. */
  loanUsd: number;
  /** Implied default trigger (put strike K_lo) in USD. */
  triggerUsd: number;
  /** Lender USDC settlement if asset closes above the cap. */
  capPayoutUsd: number;
  /** Per-unit Deribit call premium (in collateral units, e.g. 0.04 BTC). */
  callBtc: number;
  /** Per-unit Deribit put premium (in collateral units). May be 0 in fallback. */
  putBtc: number;
  /** Put strike chosen for K_lo (USD). */
  putStrike: number;
}

export interface CollarCapStrike {
  cap: number;
  expiryLabel: string;
  expiryTimestamp: number;
  estimate: CollarEstimate;
}

export interface CollarCapStrikeGroup {
  expiryLabel: string;
  expiryTimestamp: number;
  caps: CollarCapStrike[];
}

export interface CollarStrikeFilter extends CollarSettings {
  /** Borrower's collateral N (used to size loan and cap payout per row). */
  collateralAmount: number;
}

export interface CollarLoanRequest {
  underlying: CollarUnderlying;
  /** Collateral amount in human-readable units (e.g. '0.5'). */
  collateralAmount: string;
  /** Cap strike in USD (matches Deribit). */
  capUsd: number;
  /** Reserve floor (minLoan) in USD. */
  minLoanUsd: number;
  /** Expiry as unix timestamp (seconds). */
  expiryTimestamp: number;
  /** Offer end (deadline for MM bids). Default = max(now+60, expiry-3600). */
  offerEndTimestamp?: number;
  /** ECDH public key for sealed-bid offers (use `client.rfqKeys` to generate). */
  requesterPublicKey?: string;
}

export interface CollarLoanResult {
  quotationId: bigint;
  txHash: string;
}

// ─── Typed Contract Interfaces ───

interface CollarRequestParams {
  collateralToken: string;
  priceFeed: string;
  settlementToken: string;
  collateralAmount: bigint;
  capStrike: bigint;
  expiryTimestamp: number;
  offerEndTimestamp: number;
  minLoan: bigint;
  requesterPublicKey: string;
}

interface CollarCoordinatorContract {
  tryGetMaxCapStrike(
    underlying: string,
    feed: string,
    settlement: string,
  ): Promise<[boolean, bigint]>;
  getMaxCapStrike(underlying: string, feed: string, settlement: string): Promise<bigint>;
  previewKLo(
    loanAmount: bigint,
    collateralToken: string,
    settlementToken: string,
    N: bigint,
  ): Promise<bigint>;
  loanRequests(quotationId: bigint): Promise<{
    requester: string;
    collateralAmount: bigint;
    capStrike: bigint;
    expiryTimestamp: bigint;
    collateralToken: string;
    settlementToken: string;
    isSettled: boolean;
    settledOptionContract: string;
    loanClaimed: boolean;
  }>;
  fee(): Promise<bigint>;
  optionFactory(): Promise<string>;
  requestLoan(params: CollarRequestParams): Promise<ContractTransactionResponse>;
  settleQuotationEarly(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): Promise<ContractTransactionResponse>;
  cancelLoan(quotationId: bigint): Promise<ContractTransactionResponse>;
}

interface CollaredOptionContract {
  exercise(): Promise<ContractTransactionResponse>;
  doNotExercise(): Promise<ContractTransactionResponse>;
  buyer(): Promise<string>;
  seller(): Promise<string>;
  collateralToken(): Promise<string>;
  collateralAmount(): Promise<bigint>;
  expiryTimestamp(): Promise<bigint>;
  capStrike(): Promise<bigint>;
  triggerStrike(): Promise<bigint>;
  getTWAP(): Promise<bigint>;
  settlementToken(): Promise<string>;
  loanAmount(): Promise<bigint>;
  settled(): Promise<boolean>;
}

// ─── Module ───

export class CollarModule {
  public readonly defaultSettings: CollarSettings = COLLAR_DEFAULT_SETTINGS;

  constructor(private readonly client: ThetanutsClient) {}

  // ─── Capability checks ───

  /** True when CollarLoanCoordinator is populated (collar-v12 deployed). */
  isDeployed(): boolean {
    return isCollarDeployed();
  }

  private requireDeployed(): void {
    if (!this.isDeployed()) {
      throw createError(
        'NETWORK_UNSUPPORTED',
        'CollarLoanCoordinator is not yet deployed on this chain. ' +
          'Pricing/read methods work; write methods are blocked until contracts ship.',
      );
    }
  }

  // ─── Typed Contract Accessors ───

  private getCoordinatorReadContract(): CollarCoordinatorContract {
    return new Contract(
      COLLAR_CONFIG.contracts.collarCoordinator,
      COLLAR_COORDINATOR_ABI,
      this.client.provider,
    ) as unknown as CollarCoordinatorContract;
  }

  private getCoordinatorWriteContract(): CollarCoordinatorContract {
    const signer = this.client.requireSigner();
    return new Contract(
      COLLAR_CONFIG.contracts.collarCoordinator,
      COLLAR_COORDINATOR_ABI,
      signer,
    ) as unknown as CollarCoordinatorContract;
  }

  private getOptionReadContract(optionAddress: string): CollaredOptionContract {
    return new Contract(
      optionAddress,
      COLLARED_CALL_OPTION_ABI,
      this.client.provider,
    ) as unknown as CollaredOptionContract;
  }

  private getOptionWriteContract(optionAddress: string): CollaredOptionContract {
    const signer = this.client.requireSigner();
    return new Contract(
      optionAddress,
      COLLARED_CALL_OPTION_ABI,
      signer,
    ) as unknown as CollaredOptionContract;
  }

  // ─── Pricing helpers ───

  /**
   * Estimate the collar parameters from current Deribit data.
   *
   * Math (zero-rate limit, MM zero-NPV):
   *   target_put_premium = call_premium × (1 − mm_margin)
   *   K_lo = highest OTM put strike at the same expiry whose ask ≤ target
   *   L    = K_lo · N
   *   capPayout = (K_hi − K_lo) · N
   */
  estimateCollar(params: {
    underlying: CollarUnderlying;
    collateralAmount: number;
    capUsd: number;
    expiryLabel: string;
    pricingData: DeribitPricingMap;
    underlyingPrice: number;
    mmMarginPct?: number;
  }): CollarEstimate | null {
    const margin = (params.mmMarginPct ?? COLLAR_DEFAULT_SETTINGS.mmMarginPct) / 100;
    const slot = params.pricingData[params.underlying];
    if (!slot || !params.underlyingPrice || !params.collateralAmount || !params.capUsd) return null;

    // 1. Find the matching call (= the leg MM buys from us).
    const callKey = `${params.underlying}-${params.expiryLabel}-${params.capUsd}-C`;
    const callData = slot[callKey];
    if (!callData) return null;
    const callBtc = Number(callData.bid_price ?? callData.mark_price);
    if (!Number.isFinite(callBtc) || callBtc <= 0) return null;

    const targetPutBtc = callBtc * (1 - margin);
    const spot = params.underlyingPrice;

    // 2. Walk OTM puts, pick the highest strike whose ask fits the budget.
    let bestKLo: number | null = null;
    let bestPutBtc: number | null = null;
    for (const key of Object.keys(slot)) {
      if (!key.endsWith('-P')) continue;
      const parts = key.split('-');
      if (parts.length !== 4) continue;
      const expiryPart = parts[1];
      const strikePart = parts[2];
      if (expiryPart !== params.expiryLabel || !strikePart) continue;
      const k = parseInt(strikePart, 10);
      if (!k || k >= spot) continue; // OTM only
      const putData = slot[key];
      if (!putData) continue;
      const putBtc = Number(putData.ask_price ?? putData.mark_price);
      if (!Number.isFinite(putBtc) || putBtc < 0) continue;
      if (putBtc <= targetPutBtc && (bestKLo === null || k > bestKLo)) {
        bestKLo = k;
        bestPutBtc = putBtc;
      }
    }

    // 3. Fallback: cheapest OTM put on the book if call premium is too small.
    if (bestKLo === null) {
      for (const key of Object.keys(slot)) {
        if (!key.endsWith('-P')) continue;
        const parts = key.split('-');
        if (parts.length !== 4) continue;
        const expiryPart = parts[1];
        const strikePart = parts[2];
        if (expiryPart !== params.expiryLabel || !strikePart) continue;
        const k = parseInt(strikePart, 10);
        if (!k || k >= spot) continue;
        const putData = slot[key];
        const px = Number(putData?.ask_price ?? putData?.mark_price ?? 0);
        if (bestKLo === null || k < bestKLo) {
          bestKLo = k;
          bestPutBtc = px;
        }
      }
      if (bestKLo === null) return null;
    }

    return {
      loanUsd: bestKLo * params.collateralAmount,
      triggerUsd: bestKLo,
      capPayoutUsd: Math.max(0, (params.capUsd - bestKLo) * params.collateralAmount),
      callBtc,
      putBtc: bestPutBtc ?? 0,
      putStrike: bestKLo,
    };
  }

  /**
   * Group of valid (cap, expiry) tuples ready to display to a borrower.
   * Caps are OTM call strikes above spot, capped by the on-chain ceiling,
   * deduped by implied K_lo (only the highest cap per trigger is kept).
   */
  filterCapStrikes(
    pricingData: DeribitPricingMap,
    underlying: CollarUnderlying,
    underlyingPrice: number,
    settings: CollarStrikeFilter,
    maxCapUsd: number = Infinity,
  ): CollarCapStrikeGroup[] {
    const slot = pricingData[underlying];
    if (!slot || !underlyingPrice) return [];
    const now = Math.floor(Date.now() / 1000);
    const minDurSec = settings.minDurationDays * 86400;

    // Collect candidate (expiry → set of cap strikes).
    const combos = new Map<string, Set<number>>();
    const expiryTs = new Map<string, number>();
    for (const key of Object.keys(slot)) {
      if (!key.endsWith('-C')) continue;
      const parts = key.split('-');
      if (parts.length !== 4) continue;
      const expiry = parts[1];
      const strikeStr = parts[2];
      if (!expiry || !strikeStr) continue;
      const strike = parseInt(strikeStr, 10);
      if (!strike) continue;
      const ts = parseExpiryTimestamp(expiry);
      if (!ts || ts - now < minDurSec) continue;
      if (strike <= underlyingPrice) continue;
      if (strike > maxCapUsd) continue;
      if (settings.minCapStrikeUsd > 0 && strike < settings.minCapStrikeUsd) continue;
      const o = slot[key];
      if (!o || !((o.mark_price ?? 0) > 0 || (o.ask_price ?? 0) > 0)) continue;
      expiryTs.set(expiry, ts);
      if (!combos.has(expiry)) combos.set(expiry, new Set());
      combos.get(expiry)!.add(strike);
    }

    const expiries = [...combos.keys()].sort((a, b) => (expiryTs.get(a) ?? 0) - (expiryTs.get(b) ?? 0));
    const groups: CollarCapStrikeGroup[] = [];

    for (const expiry of expiries) {
      const ordered = [...combos.get(expiry)!].sort((x, y) => y - x); // highest cap first
      const dedup: CollarCapStrike[] = [];
      const seenKLo = new Set<number>();
      const minGap = settings.minCapGapPct / 100;
      for (const cap of ordered) {
        const est = this.estimateCollar({
          underlying,
          collateralAmount: settings.collateralAmount,
          capUsd: cap,
          expiryLabel: expiry,
          pricingData,
          underlyingPrice,
          mmMarginPct: settings.mmMarginPct,
        });
        if (!est) continue;
        if ((cap - est.putStrike) / est.putStrike < minGap) continue;
        if (seenKLo.has(est.putStrike)) continue;
        seenKLo.add(est.putStrike);
        dedup.push({
          cap,
          expiryLabel: expiry,
          expiryTimestamp: expiryTs.get(expiry)!,
          estimate: est,
        });
        if (dedup.length >= settings.maxStrikesPerExpiry) break;
      }
      if (dedup.length > 0) {
        groups.push({
          expiryLabel: expiry,
          expiryTimestamp: expiryTs.get(expiry)!,
          caps: dedup,
        });
      }
    }
    return groups;
  }

  /**
   * Convenience: fetch Deribit pricing via the SDK's pricing url and return
   * cap-strike groups ready for UI display.
   */
  async getCapStrikeOptions(
    underlying: CollarUnderlying,
    settings: CollarStrikeFilter,
    overrides?: { pricingData?: DeribitPricingMap; underlyingPrice?: number; maxCapUsd?: number },
  ): Promise<CollarCapStrikeGroup[]> {
    const pricingData = overrides?.pricingData ?? (await this.fetchPricing());
    const underlyingPrice =
      overrides?.underlyingPrice ?? this.extractUnderlyingPrice(pricingData, underlying);
    if (!underlyingPrice) return [];
    return this.filterCapStrikes(pricingData, underlying, underlyingPrice, settings, overrides?.maxCapUsd);
  }

  // ─── On-chain reads ───

  /**
   * Per-asset coordinator-enforced ceiling on cap strikes. Returns null when
   * the coordinator is unavailable (placeholder address) or the call fails.
   */
  async getMaxCapStrike(underlying: CollarUnderlying): Promise<bigint | null> {
    if (!this.isDeployed()) return null;
    const asset = COLLAR_CONFIG.assets[underlying];
    try {
      const coordinator = this.getCoordinatorReadContract();
      const [ok, max] = await coordinator.tryGetMaxCapStrike(
        asset.collateral,
        asset.priceFeed,
        COLLAR_CONFIG.settlement,
      );
      return ok && max !== 0n ? max : null;
    } catch {
      return null;
    }
  }

  async getLoanRequest(quotationId: bigint) {
    this.requireDeployed();
    const coordinator = this.getCoordinatorReadContract();
    return coordinator.loanRequests(quotationId);
  }

  // ─── On-chain writes ───

  async requestLoan(req: CollarLoanRequest): Promise<CollarLoanResult> {
    this.requireDeployed();
    const asset = COLLAR_CONFIG.assets[req.underlying];
    const N = ethers.parseUnits(req.collateralAmount, asset.decimals);
    const cap = BigInt(req.capUsd) * 10n ** BigInt(COLLAR_CONFIG.strikeDecimals);
    const minLoanBN = ethers.parseUnits(req.minLoanUsd.toFixed(6), 6);
    const offerEnd =
      req.offerEndTimestamp ??
      Math.min(
        req.expiryTimestamp - 3600,
        Math.floor(Date.now() / 1000) + COLLAR_CONFIG.defaultOfferDurationSeconds,
      );

    // Approve collateral
    await this.client.erc20.ensureAllowance(asset.collateral, COLLAR_CONFIG.contracts.collarCoordinator, N);

    const coordinator = this.getCoordinatorWriteContract();
    const tx = await coordinator.requestLoan({
      collateralToken: asset.collateral,
      priceFeed: asset.priceFeed,
      settlementToken: COLLAR_CONFIG.settlement,
      collateralAmount: N,
      capStrike: cap,
      expiryTimestamp: req.expiryTimestamp,
      offerEndTimestamp: offerEnd,
      minLoan: minLoanBN,
      requesterPublicKey: req.requesterPublicKey ?? '',
    });
    const receipt = await tx.wait();
    if (!receipt) throw createError('CONTRACT_REVERT', 'requestLoan receipt missing');

    const iface = new Interface(COLLAR_COORDINATOR_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'LoanRequested') {
          return {
            quotationId: parsed.args.quotationId as bigint,
            txHash: receipt.hash,
          };
        }
      } catch {
        // not our log
      }
    }
    throw createError('CONTRACT_REVERT', 'LoanRequested event not in receipt');
  }

  async cancelLoan(quotationId: bigint): Promise<ContractTransactionResponse> {
    this.requireDeployed();
    const coordinator = this.getCoordinatorWriteContract();
    return coordinator.cancelLoan(quotationId);
  }

  async acceptOffer(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): Promise<ContractTransactionResponse> {
    this.requireDeployed();
    const coordinator = this.getCoordinatorWriteContract();
    return coordinator.settleQuotationEarly(quotationId, offerAmount, nonce, offeror);
  }

  // ─── Option contract helpers ───

  async exerciseCollar(optionAddress: string): Promise<ContractTransactionResponse> {
    const opt = this.getOptionWriteContract(optionAddress);
    return opt.exercise();
  }

  async walkAwayCollar(optionAddress: string): Promise<ContractTransactionResponse> {
    const opt = this.getOptionWriteContract(optionAddress);
    return opt.doNotExercise();
  }

  /** Read-only handle on a deployed CollaredCallOption proxy. */
  getOptionInfo(optionAddress: string) {
    return this.getOptionReadContract(optionAddress);
  }

  // ─── Pricing fetch ───

  async fetchPricing(): Promise<DeribitPricingMap> {
    const r = await fetch(COLLAR_CONFIG.pricingUrl);
    if (!r.ok) throw createError('HTTP_ERROR', `Pricing API ${r.status}`);
    const json = (await r.json()) as { data: DeribitPricingMap };
    if (!json?.data) throw createError('HTTP_ERROR', 'Invalid pricing data');
    return json.data;
  }

  extractUnderlyingPrice(pricingData: DeribitPricingMap, underlying: CollarUnderlying): number {
    const slot = pricingData[underlying];
    if (!slot) return 0;
    for (const k of Object.keys(slot)) {
      const entry = slot[k];
      const p = Number(entry?.underlying_price ?? 0);
      if (p > 0) return p;
    }
    return 0;
  }

  // ─── Public accessors ───

  get config() {
    return COLLAR_CONFIG;
  }

  asset(underlying: CollarUnderlying): CollarAssetConfig {
    return COLLAR_CONFIG.assets[underlying];
  }
}

// ─── Helpers ───

const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseExpiryTimestamp(expiry: string): number | null {
  try {
    const day = parseInt(expiry.slice(0, -5), 10);
    const month = expiry.slice(-5, -2);
    const year = parseInt('20' + expiry.slice(-2), 10);
    const m = MONTH_MAP[month];
    if (m === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    return Math.floor(Date.UTC(year, m, day, 8, 0, 0) / 1000);
  } catch {
    return null;
  }
}
