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
 * methods throw `ZendfiError` with `code === 'PRICING_ONLY_MODE'` until contract
 * addresses are populated. Branch at compile time with `isWriteEnabled()`:
 *
 * ```ts
 * if (client.collar.isWriteEnabled()) {
 *   await client.collar.requestLoan(req); // narrowed to write-enabled
 * } else {
 *   showBanner(client.collar.capability().missingContracts);
 * }
 * ```
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
  type CollarSettings,
  type CollarAssetConfig,
} from '../chains/collar.js';
import { validateAddress } from '../utils/validation.js';
import { parseDeribitExpiry } from '../utils/expiry.js';
import type { DeribitPricingMap } from '../types/loan.js';
import { zendfiErr } from '../types/zendfi-errors.js';

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

/**
 * On-chain shape of `CollarLoanCoordinator.loanRequests(quotationId)`.
 * Surfaced as a named type so `CollarModule.getLoanRequest` can declare
 * its return shape without re-typing the struct inline (which made TS
 * 5.x fail to infer the method's return type — TNU-23).
 */
export interface CollarLoanRequestRecord {
  requester: string;
  collateralAmount: bigint;
  capStrike: bigint;
  expiryTimestamp: bigint;
  collateralToken: string;
  settlementToken: string;
  isSettled: boolean;
  settledOptionContract: string;
  loanClaimed: boolean;
}

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
  loanRequests(quotationId: bigint): Promise<CollarLoanRequestRecord>;
  fee(): Promise<bigint>;
  optionFactory(): Promise<string>;
  requestLoan: {
    (params: CollarRequestParams): Promise<ContractTransactionResponse>;
    (params: CollarRequestParams, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(params: CollarRequestParams): Promise<bigint>;
  };
  settleQuotationEarly: {
    (
      quotationId: bigint,
      offerAmount: bigint,
      nonce: bigint,
      offeror: string,
    ): Promise<ContractTransactionResponse>;
    (
      quotationId: bigint,
      offerAmount: bigint,
      nonce: bigint,
      offeror: string,
      overrides: { gasLimit: bigint },
    ): Promise<ContractTransactionResponse>;
    estimateGas(
      quotationId: bigint,
      offerAmount: bigint,
      nonce: bigint,
      offeror: string,
    ): Promise<bigint>;
  };
  cancelLoan: {
    (quotationId: bigint): Promise<ContractTransactionResponse>;
    (quotationId: bigint, overrides: { gasLimit: bigint }): Promise<ContractTransactionResponse>;
    estimateGas(quotationId: bigint): Promise<bigint>;
  };
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

// ─── Capability surface ───

/**
 * Describes the runtime capability of a {@link CollarModule} on the
 * current chain. Lets consumers branch at compile time over whether the
 * write methods (`requestLoan`, `cancelLoan`, …) are usable.
 *
 * - `mode: 'full'` — the CollarLoanCoordinator (and friends) are deployed
 *   and the write methods will reach a signer. Inside a
 *   `client.collar.isWriteEnabled()` block, TypeScript narrows
 *   `client.collar` to {@link CollarModuleWriteEnabled} so write methods
 *   show up on the type without a non-null assertion.
 * - `mode: 'pricing-only'` — collar-v12 has not shipped on this chain
 *   yet. Read-only / Deribit-pricing methods still work; the write
 *   methods throw a typed `ZendfiError` with `code === 'PRICING_ONLY_MODE'`.
 *
 * The shape is intentionally minimal; chain id is included so consumers
 * can pin error UI to the active chain without re-reading client config.
 */
export interface CollarCapability {
  readonly mode: 'pricing-only' | 'full';
  readonly chainId: number;
  /**
   * Sorted, deduplicated list of collar contract slots that are still
   * placeholder zero-addresses on the current chain. Populated only when
   * `mode === 'pricing-only'`; an empty list means `mode === 'full'`.
   *
   * Stable subset of `keyof typeof COLLAR_CONFIG.contracts`, but typed
   * as `readonly string[]` so future contract additions don't force a
   * breaking change to consumers reading this field.
   */
  readonly missingContracts?: readonly string[];
}

/**
 * `CollarModule` narrowed to the surface that's actually callable when
 * the collar contracts are deployed. Returned by the type guard
 * {@link CollarModule.isWriteEnabled} so consumers can use the write
 * methods without runtime asserts.
 *
 * ```ts
 * if (client.collar.isWriteEnabled()) {
 *   const { quotationId } = await client.collar.requestLoan(req);
 * }
 * ```
 */
export interface CollarModuleWriteEnabled extends CollarModule {
  requestLoan(req: CollarLoanRequest): Promise<CollarLoanResult>;
  cancelLoan(qid: bigint): Promise<ContractTransactionResponse>;
  acceptOffer(
    qid: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): Promise<ContractTransactionResponse>;
  exerciseCollar(optionAddress: string): Promise<ContractTransactionResponse>;
  walkAwayCollar(optionAddress: string): Promise<ContractTransactionResponse>;
}

// ─── Module ───

export class CollarModule {
  public readonly defaultSettings: CollarSettings = COLLAR_DEFAULT_SETTINGS;

  constructor(private readonly client: ThetanutsClient) {}

  // ─── Capability checks ───

  /**
   * Inspect the runtime capability surface on the current chain.
   *
   * Returns `{ mode: 'full' }` when the CollarLoanCoordinator is
   * populated (collar-v12 deployed); otherwise `{ mode: 'pricing-only' }`
   * with `missingContracts` listing the slots that are still zero
   * placeholders.
   *
   * Pricing / read-only methods work in either mode. Write methods
   * (`requestLoan`, `cancelLoan`, `acceptOffer`, `exerciseCollar`,
   * `walkAwayCollar`) throw `ZendfiError` with `code === 'PRICING_ONLY_MODE'`
   * when called in `pricing-only` mode.
   *
   * @example
   * ```ts
   * const cap = client.collar.capability();
   * if (cap.mode === 'pricing-only') {
   *   showBanner(`Collar contracts not yet on chain ${cap.chainId}`);
   * }
   * ```
   */
  capability(): CollarCapability {
    const missing: string[] = [];
    for (const [slot, addr] of Object.entries(COLLAR_CONFIG.contracts)) {
      if (addr === ethers.ZeroAddress) missing.push(slot);
    }
    if (missing.length === 0) {
      return { mode: 'full', chainId: this.client.chainId };
    }
    return {
      mode: 'pricing-only',
      chainId: this.client.chainId,
      missingContracts: Object.freeze(missing.slice().sort()),
    };
  }

  /**
   * Type guard: narrows `this` to {@link CollarModuleWriteEnabled} when
   * the collar contracts are deployed. Lets consumers gate write calls
   * at compile time without runtime asserts.
   */
  isWriteEnabled(): this is CollarModuleWriteEnabled {
    return this.capability().mode === 'full';
  }

  /**
   * Convenience: `true` exactly when {@link capability} returns
   * `pricing-only`. Equivalent to `!isWriteEnabled()` but reads better
   * at call sites that want the affirmative form.
   */
  isPricingOnly(): boolean {
    return this.capability().mode === 'pricing-only';
  }

  /**
   * @deprecated Use {@link capability} or {@link isWriteEnabled} instead.
   * Kept as a back-compat shim — returns the same boolean as before
   * (`true` when collar-v12 is deployed on the current chain).
   */
  isDeployed(): boolean {
    return this.capability().mode === 'full';
  }

  private requireNonZeroAddress(address: string, fieldName: string): void {
    validateAddress(address, fieldName);
    if (address === ethers.ZeroAddress) {
      throw zendfiErr.invalidParam(fieldName, 'zero address');
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

    // 3. Fallback: cheapest OTM put on the book if call premium is too small (TNU-AUDIT-0025).
    if (bestKLo === null) {
      for (const key of Object.keys(slot)) {
        if (!key.endsWith('-P')) continue;
        const parts = key.split('-');
        if (parts.length !== 4) continue;
        const expiryPart = parts[1];
        const strikePart = parts[2];
        if (expiryPart !== params.expiryLabel || !strikePart) continue;
        const k = parseInt(strikePart, 10);
        if (!Number.isFinite(k) || k <= 0 || k >= spot) continue;
        const putData = slot[key];
        if (!putData) continue;
        const rawPx = putData.ask_price ?? putData.mark_price;
        if (rawPx == null) continue;
        const px = typeof rawPx === 'string' ? parseFloat(rawPx) : Number(rawPx);
        if (!Number.isFinite(px) || px < 0) continue;
        // Pick minimum premium (true "cheapest"), not lowest strike.
        if (bestPutBtc === null || px < bestPutBtc) {
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
      // Explicit Number.isFinite check (NaN is falsy, but defensive — TNU-AUDIT-0060).
      if (!Number.isFinite(strike) || strike <= 0) continue;
      const ts = parseDeribitExpiry(expiry);
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

  async getLoanRequest(quotationId: bigint): Promise<CollarLoanRequestRecord> {
    if (!this.isWriteEnabled()) throw zendfiErr.pricingOnlyMode('getLoanRequest');
    const coordinator = this.getCoordinatorReadContract();
    return coordinator.loanRequests(quotationId);
  }

  // ─── On-chain writes ───

  async requestLoan(req: CollarLoanRequest): Promise<CollarLoanResult> {
    if (!this.isWriteEnabled()) throw zendfiErr.pricingOnlyMode('requestLoan');
    const asset = COLLAR_CONFIG.assets[req.underlying];

    // Pre-flight validation — fail fast before any approval gas is spent (TNU-AUDIT-0012).
    const now = Math.floor(Date.now() / 1000);
    if (req.expiryTimestamp <= now) {
      throw zendfiErr.expiryInPast(req.expiryTimestamp, now);
    }
    if (!req.offerEndTimestamp && req.expiryTimestamp - now < 3600) {
      throw zendfiErr.expiryTooSoon(req.expiryTimestamp, now + 3600);
    }
    if (BigInt(req.capUsd) <= 0n) {
      throw zendfiErr.invalidCap(req.capUsd);
    }

    const N = ethers.parseUnits(req.collateralAmount, asset.decimals);
    const cap = BigInt(req.capUsd) * 10n ** BigInt(COLLAR_CONFIG.strikeDecimals);
    const minLoanBN = ethers.parseUnits(
      req.minLoanUsd.toFixed(COLLAR_CONFIG.settlementDecimals),
      COLLAR_CONFIG.settlementDecimals,
    );
    // Auction window now tracks the configured duration, not expiry proximity (TNU-AUDIT-0011).
    const offerEnd =
      req.offerEndTimestamp ?? now + COLLAR_CONFIG.defaultOfferDurationSeconds;

    // Approve collateral
    await this.client.erc20.ensureAllowance(asset.collateral, COLLAR_CONFIG.contracts.collarCoordinator, N);

    const coordinator = this.getCoordinatorWriteContract();
    const requestParams = {
      collateralToken: asset.collateral,
      priceFeed: asset.priceFeed,
      settlementToken: COLLAR_CONFIG.settlement,
      collateralAmount: N,
      capStrike: cap,
      expiryTimestamp: req.expiryTimestamp,
      offerEndTimestamp: offerEnd,
      minLoan: minLoanBN,
      requesterPublicKey: req.requesterPublicKey ?? '',
    };
    // Apply estimateGas + 20% buffer for Base (TNU-AUDIT-0026).
    const gasEstimate = await coordinator.requestLoan.estimateGas(requestParams);
    const gasLimit = (gasEstimate * 120n) / 100n;
    const tx = await coordinator.requestLoan(requestParams, { gasLimit });
    const receipt = await tx.wait();
    if (!receipt) throw zendfiErr.contractRevert('collar.requestLoan', 'receipt missing');

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
    throw zendfiErr.contractRevert('collar.requestLoan', 'LoanRequested event missing in receipt');
  }

  async cancelLoan(quotationId: bigint): Promise<ContractTransactionResponse> {
    if (!this.isWriteEnabled()) throw zendfiErr.pricingOnlyMode('cancelLoan');
    const coordinator = this.getCoordinatorWriteContract();
    // Apply estimateGas + 20% buffer for Base (TNU-AUDIT-0026).
    const gasEstimate = await coordinator.cancelLoan.estimateGas(quotationId);
    const gasLimit = (gasEstimate * 120n) / 100n;
    return coordinator.cancelLoan(quotationId, { gasLimit });
  }

  async acceptOffer(
    quotationId: bigint,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): Promise<ContractTransactionResponse> {
    if (!this.isWriteEnabled()) throw zendfiErr.pricingOnlyMode('acceptOffer');
    // Defensive coercion for callers passing `number` literals > 2^53 (TNU-AUDIT-0032).
    const nonceBig = BigInt(nonce);
    const coordinator = this.getCoordinatorWriteContract();
    // Apply estimateGas + 20% buffer for Base (TNU-AUDIT-0026).
    const gasEstimate = await coordinator.settleQuotationEarly.estimateGas(
      quotationId,
      offerAmount,
      nonceBig,
      offeror,
    );
    const gasLimit = (gasEstimate * 120n) / 100n;
    return coordinator.settleQuotationEarly(quotationId, offerAmount, nonceBig, offeror, {
      gasLimit,
    });
  }

  // ─── Option contract helpers ───

  async exerciseCollar(optionAddress: string): Promise<ContractTransactionResponse> {
    if (!this.isWriteEnabled()) throw zendfiErr.pricingOnlyMode('exerciseCollar');
    this.requireNonZeroAddress(optionAddress, 'optionAddress');
    const opt = this.getOptionWriteContract(optionAddress);
    return opt.exercise();
  }

  async walkAwayCollar(optionAddress: string): Promise<ContractTransactionResponse> {
    if (!this.isWriteEnabled()) throw zendfiErr.pricingOnlyMode('walkAwayCollar');
    this.requireNonZeroAddress(optionAddress, 'optionAddress');
    const opt = this.getOptionWriteContract(optionAddress);
    return opt.doNotExercise();
  }

  /** Read-only handle on a deployed CollaredCallOption proxy. */
  getOptionInfo(optionAddress: string) {
    this.requireNonZeroAddress(optionAddress, 'optionAddress');
    return this.getOptionReadContract(optionAddress);
  }

  // ─── Pricing fetch ───

  /**
   * Fetch the Deribit-style pricing map. Delegates to {@link LoanModule.fetchPricing}
   * so the collar and loan modules share a single 30s-cached call against
   * `pricing.thetanuts.finance/all`.
   */
  async fetchPricing(): Promise<DeribitPricingMap> {
    return this.client.loan.fetchPricing();
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
