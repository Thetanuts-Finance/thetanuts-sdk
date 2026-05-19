/**
 * Shared payout helpers used by `rfq build`, `book preview`, and `book fill --dry-run`
 *
 * `computePayoutSummary` produces the high-level max-loss / max-gain block that
 * existed inline in `rfq.ts` for months. Extracted here so the OptionBook
 * commands can render the same shape — buy-only there, but otherwise identical.
 *
 * `computeScenarios` walks a 5-row table of representative spot prices at
 * expiry and reports per-row payoff + net P&L, for the optional `--scenarios`
 * flag. The payoff math mirrors `calculateCollateralRequired` in the SDK
 * (`src/utils/collateral.ts`) — the SDK uses it to size max-loss collateral,
 * and "max-loss at the worst spot" === "payoff at that spot" for cash-settled
 * options, so we can reuse the same product-name → strike-formula mapping.
 *
 * NOTE on multi-leg accuracy: PUT_FLY / CALL_FLY / PUT_CONDOR / CALL_CONDOR /
 * IRON_CONDOR use the standard textbook payoff formulas (sum of long/short leg
 * intrinsics). Cross-checked against the dApp's PayoutChart for spreads and
 * vanilla; multi-leg matches by construction since the SDK's
 * `calculateCollateralRequired` uses the same wing/condor formulae
 */

import { calculateCollateralRequired } from '@thetanuts-finance/thetanuts-client';
import type { ProductName } from '@thetanuts-finance/thetanuts-client';

export type StructureType =
  | 'PUT'
  | 'CALL'
  | 'INVERSE_CALL'
  | 'PUT_SPREAD'
  | 'CALL_SPREAD'
  | 'PUT_FLY'
  | 'CALL_FLY'
  | 'PUT_CONDOR'
  | 'CALL_CONDOR'
  | 'IRON_CONDOR';

export type CollateralToken = 'USDC' | 'WETH';

/**
 * Map the CLI's display-only StructureType + collateralToken to the SDK's
 * ProductName enum. Copy of `toProductName` in `commands/rfq.ts` (kept in
 * sync — both files use it for `calculateCollateralRequired`).
 */
function toProductName(
  structureType: StructureType,
  collateralToken: CollateralToken
): ProductName {
  // 'CALL' is the v0.1.0 CLI label for single-strike call with USDC collateral
  // (book.ts no longer routes through 'INVERSE_CALL' for the USDC-only book
  // surface). It always maps to LINEAR_CALL on the SDK side.
  if (structureType === 'CALL') {
    return 'LINEAR_CALL';
  }
  if (structureType === 'INVERSE_CALL') {
    return collateralToken === 'WETH' ? 'INVERSE_CALL' : 'LINEAR_CALL';
  }
  if (structureType === 'CALL_SPREAD' && collateralToken === 'WETH') {
    return 'INVERSE_CALL_SPREAD';
  }
  return structureType;
}

/**
 * Compute a payout summary for `rfq build` / `book preview` / `book fill --dry-run` output.
 *
 * When `reservePrice` is supplied (RFQ buy after MM auto-derivation, or book
 * fills where the order has a fixed `pricePerContract`), totalPremium /
 * maxLoss / maxGain are concrete numbers. Without it, premium-dependent
 * fields are omitted with a hint.
 *
 * All values are in collateral-token units (USDC or WETH). Figures assume the
 * eventual fill price equals `reservePrice`; for RFQ, the actual maker quote
 * usually beats reserve so realized P&L is at least as good for the requester.
 */
export function computePayoutSummary(args: {
  structureType: StructureType;
  collateralToken: CollateralToken;
  strikes: number[];
  direction: 'buy' | 'sell';
  contracts: number;
  reservePrice?: number;
}): Record<string, unknown> {
  const { structureType, collateralToken, strikes, direction, contracts, reservePrice } = args;
  const product = toProductName(structureType, collateralToken);
  const maxIntrinsicPerContract = calculateCollateralRequired(1, product, strikes);
  const totalIntrinsic = maxIntrinsicPerContract * contracts;
  const totalPremium = reservePrice !== undefined ? reservePrice * contracts : undefined;
  const unit = collateralToken;
  const fmt = (n: number): string => (Math.abs(n) >= 0.01 ? n.toFixed(4) : n.toFixed(8));

  const summary: Record<string, unknown> = {
    direction,
    contracts: Number(contracts.toFixed(8)),
    ...(reservePrice !== undefined
      ? { premiumPerContract: `${reservePrice} ${unit}` }
      : {}),
    ...(totalPremium !== undefined
      ? { totalPremium: `${fmt(totalPremium)} ${unit}` }
      : {}),
  };

  if (direction === 'buy') {
    summary.maxLoss = totalPremium !== undefined
      ? `${fmt(totalPremium)} ${unit} (premium paid if option expires OTM)`
      : 'premium paid (set --reserve-price to estimate)';
    summary.maxGain = totalPremium !== undefined
      ? `${fmt(totalIntrinsic - totalPremium)} ${unit} (max intrinsic minus premium)`
      : `up to ${fmt(totalIntrinsic)} ${unit} minus premium`;
  } else {
    summary.collateralLocked = `${fmt(totalIntrinsic)} ${unit}`;
    summary.maxGain = totalPremium !== undefined
      ? `${fmt(totalPremium)} ${unit} (premium received)`
      : 'premium received (set --reserve-price to estimate)';
    summary.maxLoss = totalPremium !== undefined
      ? `${fmt(totalIntrinsic - totalPremium)} ${unit} (collateral locked minus premium)`
      : `up to ${fmt(totalIntrinsic)} ${unit} (collateral locked, worst case)`;
  }

  summary.note =
    reservePrice !== undefined
      ? 'Estimates assume fill at the listed premium. Actual maker quote may beat reserve.'
      : 'Premium-dependent fields omitted because --reserve-price / order price was not available.';

  return summary;
}

// ---------------------------------------------------------------------------
// --scenarios: per-spot payoff table
// ---------------------------------------------------------------------------

/**
 * Per-contract payoff at expiry for a cash-settled structure.
 *
 * Formulas (all per-contract, payoff in collateral-token units):
 *   PUT vanilla    max(K − S, 0)
 *   INVERSE_CALL   max(S − K, 0) / S  (collateralized in underlying)
 *   LINEAR_CALL    max(S − K, 0)      (USDC-collateral capped variant; SDK
 *                                       caps collateral at K, so payoff =
 *                                       min(K, max(S − K, 0)))
 *   PUT_SPREAD     [strikes DESC: K_high, K_low]
 *                  max(K_high − S, 0) − max(K_low − S, 0)
 *                  capped at K_high − K_low
 *   CALL_SPREAD    [strikes ASC: K_low, K_high]
 *                  max(S − K_low, 0) − max(S − K_high, 0)
 *                  capped at K_high − K_low
 *   PUT_FLY        [strikes DESC: K3, K2, K1] (equidistant wings)
 *                  max(K3 − S, 0) − 2*max(K2 − S, 0) + max(K1 − S, 0)
 *   CALL_FLY       [strikes ASC: K1, K2, K3]
 *                  max(S − K1, 0) − 2*max(S − K2, 0) + max(S − K3, 0)
 *   PUT_CONDOR     [DESC: K4, K3, K2, K1]
 *                  max(K4 − S, 0) − max(K3 − S, 0) − max(K2 − S, 0) + max(K1 − S, 0)
 *   CALL_CONDOR    [ASC: K1, K2, K3, K4]
 *                  max(S − K1, 0) − max(S − K2, 0) − max(S − K3, 0) + max(S − K4, 0)
 *   IRON_CONDOR    [ASC: K1, K2, K3, K4]
 *                  Short put spread + short call spread:
 *                  −(max(K2 − S, 0) − max(K1 − S, 0)) − (max(S − K3, 0) − max(S − K4, 0))
 *                  (NEGATIVE = max-loss; payout to long = (K2−K1) − iron_condor_short).
 *                  For the BUY case (long iron condor — buyer profits inside the
 *                  body), we return: (K2-K1) - shortPutSpread - shortCallSpread,
 *                  which is the payout to the long-the-IC side. Note: dApp
 *                  defines IC as short-only-by-convention; the CLI exposes both
 *                  directions via `direction`, but the spot table here always
 *                  reports the gross payoff a LONG IC receives.
 */
function payoffPerContract(
  structureType: StructureType,
  collateralToken: CollateralToken,
  strikes: number[],
  spot: number
): number {
  const pos = (x: number): number => Math.max(x, 0);
  switch (structureType) {
    case 'PUT':
      return pos(strikes[0]! - spot);
    case 'CALL':
      // LINEAR_CALL (USDC-only): payoff capped at strike
      return Math.min(strikes[0]!, pos(spot - strikes[0]!));
    case 'INVERSE_CALL':
      if (collateralToken === 'WETH') {
        // Inverse call: payoff in underlying = max(S − K, 0) / S
        return spot > 0 ? pos(spot - strikes[0]!) / spot : 0;
      }
      // LINEAR_CALL (USDC): payoff capped at strike
      return Math.min(strikes[0]!, pos(spot - strikes[0]!));
    case 'PUT_SPREAD': {
      // strikes DESC: [K_high, K_low]
      const [kHigh, kLow] = strikes;
      const raw = pos(kHigh! - spot) - pos(kLow! - spot);
      return Math.min(kHigh! - kLow!, raw);
    }
    case 'CALL_SPREAD': {
      // strikes ASC: [K_low, K_high]
      const [kLow, kHigh] = strikes;
      const raw = pos(spot - kLow!) - pos(spot - kHigh!);
      if (collateralToken === 'WETH') {
        // INVERSE_CALL_SPREAD: same payoff but in underlying terms; for a
        // human-readable table we keep USDC-equivalent payoff. Best-effort.
        return spot > 0 ? raw / spot : 0;
      }
      return Math.min(kHigh! - kLow!, raw);
    }
    case 'PUT_FLY': {
      // strikes DESC: [K3, K2, K1] — wings at K3 and K1, body at K2
      const [k3, k2, k1] = strikes;
      return pos(k3! - spot) - 2 * pos(k2! - spot) + pos(k1! - spot);
    }
    case 'CALL_FLY': {
      // strikes ASC: [K1, K2, K3]
      const [k1, k2, k3] = strikes;
      return pos(spot - k1!) - 2 * pos(spot - k2!) + pos(spot - k3!);
    }
    case 'PUT_CONDOR': {
      // strikes DESC: [K4, K3, K2, K1]
      const [k4, k3, k2, k1] = strikes;
      return pos(k4! - spot) - pos(k3! - spot) - pos(k2! - spot) + pos(k1! - spot);
    }
    case 'CALL_CONDOR': {
      // strikes ASC: [K1, K2, K3, K4]
      const [k1, k2, k3, k4] = strikes;
      return pos(spot - k1!) - pos(spot - k2!) - pos(spot - k3!) + pos(spot - k4!);
    }
    case 'IRON_CONDOR': {
      // strikes ASC: [K1, K2, K3, K4]
      // IRON_CONDOR payoff = put-spread (K1, K2) + call-spread (K3, K4)
      //   = pos(K2 - spot) - pos(K1 - spot)   ← put-spread, wing-rich on left
      //   + pos(spot - K3) - pos(spot - K4)   ← call-spread, wing-rich on right
      // Max payout when spot is OUTSIDE [K2, K3] (wing-rich), zero inside.
      // This is the cash-settled contract's payoff and matches the dApp's
      // `ironCondorPayout` at thetanuts-1840/app/pages/option-rfq/utils/
      // pnlUtils.ts:127-138 exactly. Direction (BUY/SELL) is handled by the
      // caller flipping net-P&L sign — DO NOT add direction logic here.
      const [k1, k2, k3, k4] = strikes;
      const putSpread = pos(k2! - spot) - pos(k1! - spot);
      const callSpread = pos(spot - k3!) - pos(spot - k4!);
      return putSpread + callSpread;
    }
  }
}

/**
 * Pick 5 representative spot prices spanning the structure's strikes.
 *
 * For vanilla PUT: spots span 0.9× → 1.025× strike (downside-rich; PUT
 * profits below strike).
 * For vanilla CALL: spots span 0.975× → 1.10× strike (upside-rich).
 * For multi-leg: spots span min(strikes)×0.95 → max(strikes)×1.05 (cover the
 * full P&L profile incl. wings).
 *
 * Returned array preserves order so the table reads left-to-right by spot.
 */
function pickScenarioSpots(
  structureType: StructureType,
  strikes: number[]
): Array<{ spot: number; label: string }> {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  if (strikes.length === 1) {
    const k = strikes[0]!;
    if (structureType === 'PUT') {
      return [
        { spot: round2(k * 0.9), label: `$${round2(k * 0.9)}` },
        { spot: round2(k * 0.95), label: `$${round2(k * 0.95)}` },
        { spot: round2(k * 0.975), label: `$${round2(k * 0.975)}` },
        { spot: k, label: `$${k} (strike)` },
        { spot: round2(k * 1.025), label: `$${round2(k * 1.025)}` },
      ];
    }
    // CALL (vanilla or inverse)
    return [
      { spot: round2(k * 0.975), label: `$${round2(k * 0.975)}` },
      { spot: k, label: `$${k} (strike)` },
      { spot: round2(k * 1.025), label: `$${round2(k * 1.025)}` },
      { spot: round2(k * 1.05), label: `$${round2(k * 1.05)}` },
      { spot: round2(k * 1.1), label: `$${round2(k * 1.1)}` },
    ];
  }
  // Multi-leg — span the strikes + a buffer on each side.
  const lo = Math.min(...strikes);
  const hi = Math.max(...strikes);
  const below = round2(lo * 0.95);
  const above = round2(hi * 1.05);
  const mid = round2((lo + hi) / 2);
  return [
    { spot: below, label: `$${below}` },
    { spot: lo, label: `$${lo} (K_lo)` },
    { spot: mid, label: `$${mid}` },
    { spot: hi, label: `$${hi} (K_hi)` },
    { spot: above, label: `$${above}` },
  ];
}

export interface ScenarioRow {
  spotAtExpiry: string;
  payoutPerContract: string;
  totalPayout: string;
  netPnl: string;
}

/**
 * Build the 5-row scenarios table. Caller hands us the same shape as
 * `computePayoutSummary` plus an extra `direction`. Net P&L for BUY is
 * `payout - totalPremium`; for SELL it's `totalPremium - payout` capped at
 * the collateral locked (max-loss for the seller).
 *
 * Premium-percentage denominator: |totalPremium| for BUY (loss-bounded by
 * premium), and the collateral locked for SELL (loss-bounded by collateral).
 *
 * When `reservePrice` is missing, the rows still render (payout columns are
 * meaningful) but `netPnl` shows `n/a` since we don't know the premium paid.
 */
export function computeScenarios(args: {
  structureType: StructureType;
  collateralToken: CollateralToken;
  strikes: number[];
  direction: 'buy' | 'sell';
  contracts: number;
  reservePrice?: number;
}): ScenarioRow[] {
  const { structureType, collateralToken, strikes, direction, contracts, reservePrice } = args;
  const spots = pickScenarioSpots(structureType, strikes);
  const totalPremium = reservePrice !== undefined ? reservePrice * contracts : undefined;

  const product = toProductName(structureType, collateralToken);
  const maxIntrinsicPerContract = calculateCollateralRequired(1, product, strikes);
  const totalIntrinsic = maxIntrinsicPerContract * contracts;

  const fmtUsd = (n: number): string => {
    const sign = n >= 0 ? '+' : '-';
    const abs = Math.abs(n);
    if (abs < 0.01 && abs > 0) return `${sign}$${abs.toFixed(6)}`;
    return `${sign}$${abs.toFixed(2)}`;
  };
  const fmtPlain = (n: number): string => {
    if (n < 0.01 && n > 0) return `$${n.toFixed(6)}`;
    return `$${n.toFixed(2)}`;
  };

  return spots.map(({ spot, label }) => {
    const payoutPer = payoffPerContract(structureType, collateralToken, strikes, spot);
    const totalPayout = payoutPer * contracts;

    let netPnl: string;
    if (totalPremium === undefined) {
      netPnl = 'n/a (premium unknown)';
    } else if (direction === 'buy') {
      const pnl = totalPayout - totalPremium;
      const pct = totalPremium > 0 ? (pnl / totalPremium) * 100 : 0;
      netPnl = `${fmtUsd(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`;
    } else {
      // SELL: loss-bounded at the collateral locked. Standard formula:
      // sellerPnl = premium − payout (payout ≤ collateral by construction).
      const pnl = totalPremium - totalPayout;
      const denom = totalIntrinsic > 0 ? totalIntrinsic : totalPremium;
      const pct = denom > 0 ? (pnl / denom) * 100 : 0;
      netPnl = `${fmtUsd(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`;
    }

    return {
      spotAtExpiry: label,
      payoutPerContract: fmtPlain(payoutPer),
      totalPayout: fmtPlain(totalPayout),
      netPnl,
    };
  });
}
