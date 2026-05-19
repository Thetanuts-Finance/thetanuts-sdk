import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { Contract, Interface, MaxUint256 } from 'ethers';
import {
  OPTION_FACTORY_ABI,
  calculateNumContracts,
  validateButterfly,
  validateCondor,
  validateIronCondor,
} from '@thetanuts-finance/thetanuts-client';
import type { ProductName, QuotationParameters, RFQRequest } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { jsonReplacer, render, renderError, buildTxReceiptPayload, fetchEthUsdSafe } from '../output.js';
import { confirm } from '../confirm.js';
import { computePayoutSummary, computeScenarios } from '../payout.js';

// ----------------------------------------------------------------------------
// RFQ Constants
// ----------------------------------------------------------------------------

const DEFAULT_DEADLINE_MINUTES = 0.75;
const PLACEHOLDER_REQUESTER = '0x0000000000000000000000000000000000000001';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

type Underlying = 'ETH' | 'BTC';
type OptionType = 'PUT' | 'CALL';
type StructureType =
  | 'PUT'
  | 'INVERSE_CALL'
  | 'PUT_SPREAD'
  | 'CALL_SPREAD'
  | 'PUT_FLY'
  | 'CALL_FLY'
  | 'PUT_CONDOR'
  | 'CALL_CONDOR'
  | 'IRON_CONDOR';

interface BuildInputs {
  underlying: Underlying;
  type: OptionType;
  strikes: number[];
  expiry: number;
  contracts: number;
  direction: 'buy' | 'sell';
  requester: string;
  collateralToken: 'USDC' | 'WETH';
  deadlineMinutes: number;
  reservePrice?: number;
  referralId?: bigint;
  isIronCondor: boolean;
  requesterPublicKey?: string;
}

/**
 * Map (strikeCount, optionType, isIronCondor) → on-screen structure label.
 *
 * Verbatim port of OpenClaw build-rfq.ts:52-67 cross-checked against
 * src/modules/optionFactory.ts:1730-1764 (private getImplementationForStructure).
 * For display only — the SDK's buildRFQParams owns the actual implementation
 * address resolution, so this stays a pure label function.
 */
function getStructureType(strikeCount: number, optionType: OptionType, isIronCondor: boolean): StructureType {
  if (isIronCondor) {
    if (strikeCount !== 4) {
      throw new Error(`--structure iron-condor requires exactly 4 strikes (got ${strikeCount})`);
    }
    return 'IRON_CONDOR';
  }
  switch (strikeCount) {
    case 1:
      return optionType === 'PUT' ? 'PUT' : 'INVERSE_CALL';
    case 2:
      return optionType === 'PUT' ? 'PUT_SPREAD' : 'CALL_SPREAD';
    case 3:
      return optionType === 'PUT' ? 'PUT_FLY' : 'CALL_FLY';
    case 4:
      return optionType === 'PUT' ? 'PUT_CONDOR' : 'CALL_CONDOR';
    default:
      throw new Error(`Invalid strike count: ${strikeCount}. Must be 1-4.`);
  }
}

/**
 * Validate user-supplied strike ordering. Returns {valid:false, message} for
 * the CLI to print and exit 4 cleanly, instead of letting the SDK builder do
 * the silent re-sort
 *
 * Rule recap:
 *   1 strike  — no ordering required
 *   2-3, PUT  — DESCENDING (high→low)
 *   2-3, CALL — ASCENDING  (low→high)
 *   4 strikes — ALWAYS ASCENDING  (includes iron condor, put condor, call condor)
 */
function validateStrikeOrdering(
  strikes: number[],
  optionType: OptionType
): { valid: true } | { valid: false; message: string } {
  if (strikes.length === 1) return { valid: true };
  const isAscending = strikes.every((v, i) => i === 0 || v > strikes[i - 1]!);
  const isDescending = strikes.every((v, i) => i === 0 || v < strikes[i - 1]!);

  if (strikes.length === 4) {
    if (!isAscending) {
      return {
        valid: false,
        message: `Condor (4 strikes) requires ASCENDING order. Got: [${strikes.join(', ')}]. Should be: [${[...strikes].sort((a, b) => a - b).join(', ')}]`,
      };
    }
    return { valid: true };
  }
  if (optionType === 'PUT') {
    if (!isDescending) {
      return {
        valid: false,
        message: `PUT structures require DESCENDING order (high→low). Got: [${strikes.join(', ')}]. Should be: [${[...strikes].sort((a, b) => b - a).join(', ')}]`,
      };
    }
    return { valid: true };
  }
  if (!isAscending) {
    return {
      valid: false,
      message: `CALL structures require ASCENDING order (low→high). Got: [${strikes.join(', ')}]. Should be: [${[...strikes].sort((a, b) => a - b).join(', ')}]`,
    };
  }
  return { valid: true };
}

/**
 * v0.1.0 is USDC-only across all structures on the CLI surface. The SDK still
 * supports WETH collateral for the inverse-CALL family, but the CLI rejects
 * non-USDC up front (see buildFromFlags). Always default to USDC so the
 * default code path doesn't trip the new validator.
 *
 * Structure → implementation mapping (collateral is what swings this):
 *   single-strike CALL + USDC           → LINEAR_CALL  (cash, capped payoff)
 *   single-strike CALL + WETH           → INVERSE_CALL (cash, payoff (S−K)/S in ETH)
 *   single-strike CALL + WETH +physical → PHYSICAL_CALL
 *   PUT / spread / fly / condor + USDC  → linear cash-settled impl
 */
function defaultCollateral(_type: OptionType, _strikeCount: number): 'USDC' | 'WETH' {
  return 'USDC';
}

/**
 * Map the CLI's display-only StructureType + collateralToken to the SDK's
 * ProductName enum used by `calculateNumContracts` / `calculateCollateralRequired`.
 *
 * Only the INVERSE_CALL family swings with collateral choice:
 *   single-strike CALL + WETH  → INVERSE_CALL  (1:1 underlying collateral)
 *   single-strike CALL + USDC  → LINEAR_CALL   (capped-at-2×-strike, USDC collat)
 *   two-strike CALL  + WETH  → INVERSE_CALL_SPREAD
 *   everything else passes straight through.
 */
function toProductName(
  structureType: StructureType,
  collateralToken: 'USDC' | 'WETH'
): ProductName {
  if (structureType === 'INVERSE_CALL') {
    return collateralToken === 'WETH' ? 'INVERSE_CALL' : 'LINEAR_CALL';
  }
  if (structureType === 'CALL_SPREAD' && collateralToken === 'WETH') {
    return 'INVERSE_CALL_SPREAD';
  }
  return structureType;
}

/**
 * Map collateral token (USDC/WETH) to the asset key used in
 * `MMVanillaPricing.byCollateral`. The SDK keys vanilla pricing by collateral
 * ASSET ('USD' for USDC, the underlying symbol for native), so we have to
 * translate the user-facing token name here.
 */
function collateralAssetKey(
  collateralToken: 'USDC' | 'WETH',
  underlying: Underlying
): string {
  if (collateralToken === 'USDC') return 'USD';
  // WETH: only valid for ETH-collateralized inverse CALL family; the SDK still
  // keys it by the underlying symbol though, so propagate that.
  return underlying;
}

/**
 * Is the structure base-collateralized? (matches dApp's `isBaseCollateral`,
 * which controls whether `premiumPerContract = mmPrice` (BASE) or
 * `mmPrice * spot` (QUOTE/USDC). Anything quoted in WETH is BASE; USDC is QUOTE.
 */
function isBaseCollateral(collateralToken: 'USDC' | 'WETH'): boolean {
  return collateralToken === 'WETH';
}

/**
 * Fetch the MM ask price per contract (in underlying terms for vanilla, or
 * underlying-denominated net price for multi-leg) for a build that the user
 * left without an explicit `--reserve-price`. Matches the dApp's
 * `useRfqPricing.fetchPricing` dispatch (vanilla → getTickerPricing,
 * 2-leg → getSpreadPricing, 3-leg → getButterflyPricing, 4-leg → getCondorPricing).
 *
 * Returns `{ mmAsk, spot }` where:
 *   - `mmAsk` is in underlying terms (fraction of underlying)
 *   - `spot` is the underlying USD price (for quote-collateral conversions)
 *
 * Throws with exitCode=4 if the live MM API doesn't have a quote for this
 * structure (e.g. strike not listed, multi-leg leg missing from feed). The
 * user can pass `--reserve-price` explicitly to skip this.
 */
async function fetchMmAskForBuild(args: {
  client: GetClientResult['client'];
  structureType: StructureType;
  underlying: Underlying;
  optionType: OptionType;
  strikes: number[];
  expiry: number;
  collateralToken: 'USDC' | 'WETH';
  isIronCondor: boolean;
}): Promise<{ mmAsk: number; spot: number }> {
  const { client, structureType, underlying, optionType, strikes, expiry, collateralToken, isIronCondor } = args;

  const wrapErr = (e: unknown, hint: string): never => {
    const msg = (e as Error)?.message ?? String(e);
    const err = new Error(
      `No live MM quote for this ${structureType} (${hint}). ` +
        `Pass --reserve-price explicitly, or pick strikes/expiry that the MM is actively pricing. ` +
        `Underlying error: ${msg}`
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  };

  // Vanilla: single-strike call/put
  if (strikes.length === 1) {
    try {
      const v = await client.mmPricing.getTickerPricing(
        formatTicker(underlying, expiry, strikes, optionType)
      );
      const assetKey = collateralAssetKey(collateralToken, underlying);
      const coll = v.byCollateral[assetKey];
      // Prefer buffered (matches dApp); fall back to feeAdjustedAsk only if the
      // per-collateral branch is missing (shouldn't happen for USD/native).
      const mmAsk = coll?.mmAskPriceBuffered ?? v.feeAdjustedAsk;
      if (!Number.isFinite(mmAsk) || mmAsk <= 0) {
        wrapErr(new Error(`Got non-positive ask price ${mmAsk}`), 'vanilla');
      }
      return { mmAsk, spot: v.underlyingPrice };
    } catch (e) {
      wrapErr(e, 'vanilla');
    }
  }

  // Multi-leg: strikes in human units → bigints (8 decimals) per dApp convention.
  const toBig8 = (s: number): bigint => BigInt(Math.round(s * 1e8));
  const isCall = optionType === 'CALL';

  try {
    if (strikes.length === 2) {
      const r = await client.mmPricing.getSpreadPricing({
        underlying,
        strikes: [toBig8(strikes[0]!), toBig8(strikes[1]!)],
        expiry,
        isCall,
      });
      const spot = r.nearLeg.underlyingPrice;
      const mmAsk = r.netMmAskPrice;
      if (!Number.isFinite(mmAsk) || mmAsk <= 0) {
        wrapErr(new Error(`Got non-positive net ask ${mmAsk}`), 'spread');
      }
      return { mmAsk, spot };
    }

    if (strikes.length === 3) {
      const r = await client.mmPricing.getButterflyPricing({
        underlying,
        strikes: [toBig8(strikes[0]!), toBig8(strikes[1]!), toBig8(strikes[2]!)],
        expiry,
        isCall,
      });
      const spot = r.legs[0].underlyingPrice;
      const mmAsk = r.netMmAskPrice;
      if (!Number.isFinite(mmAsk) || mmAsk <= 0) {
        wrapErr(new Error(`Got non-positive net ask ${mmAsk}`), 'butterfly');
      }
      return { mmAsk, spot };
    }

    if (strikes.length === 4) {
      // For condor/iron-condor, the dApp passes ascending strikes. We re-sort
      // here defensively since the SDK validates the order anyway.
      const sorted = [...strikes].sort((a, b) => a - b);
      const condorType: 'call' | 'put' | 'iron' = isIronCondor ? 'iron' : isCall ? 'call' : 'put';
      const r = await client.mmPricing.getCondorPricing({
        underlying,
        strikes: [toBig8(sorted[0]!), toBig8(sorted[1]!), toBig8(sorted[2]!), toBig8(sorted[3]!)],
        expiry,
        type: condorType,
      });
      const spot = r.legs[0].underlyingPrice;
      const mmAsk = r.netMmAskPrice;
      if (!Number.isFinite(mmAsk) || mmAsk <= 0) {
        wrapErr(new Error(`Got non-positive net ask ${mmAsk}`), `condor (${condorType})`);
      }
      return { mmAsk, spot };
    }

    wrapErr(new Error(`Unsupported strike count ${strikes.length}`), structureType);
  } catch (e) {
    // Re-throw if already wrapped, otherwise wrap.
    if ((e as Error & { exitCode?: number }).exitCode === 4) throw e;
    wrapErr(e, structureType);
  }

  // Unreachable — wrapErr always throws.
  throw new Error('unreachable');
}

/**
 * Derive `--contracts` from `--collateral-amount` for both directions.
 *
 *   BUY (with --reserve-price)    — contracts = budget / reservePrice (pure division)
 *   BUY (no --reserve-price)      — fetch fresh MM quote, set reservePrice =
 *                                   mmAskPriceBuffered (vanilla) or netMmAskPrice
 *                                   (multi-leg), then divide. Matches the dApp.
 *   SELL — contracts = collateral / maxLossPerContract  (SDK structure-aware,
 *                                                       offline)
 *
 * On BUY without a user-supplied price ceiling, this hits the MM pricing API.
 * Returns the derived contracts AND (when fetched) the per-contract reservePrice
 * so the caller can stamp it into the build inputs.
 */
async function deriveContractsFromCollateral(args: {
  collateralAmount: number;
  direction: 'buy' | 'sell';
  structureType: StructureType;
  collateralToken: 'USDC' | 'WETH';
  strikes: number[];
  reservePrice?: number;
  // Required only when the BUY branch needs to fetch MM pricing:
  client: GetClientResult['client'];
  underlying: Underlying;
  optionType: OptionType;
  expiry: number;
  isIronCondor: boolean;
}): Promise<{ contracts: number; derivedReservePrice?: number }> {
  const { collateralAmount, direction, structureType, collateralToken, strikes, reservePrice } = args;
  if (collateralAmount <= 0) {
    throw new Error(`--collateral-amount must be > 0 (got ${collateralAmount})`);
  }
  if (direction === 'buy') {
    // Explicit user-supplied reserve price wins — no oracle call.
    if (reservePrice !== undefined && reservePrice > 0) {
      return { contracts: collateralAmount / reservePrice };
    }

    // No reserve-price → fetch live MM ask and derive both contracts AND
    // reservePrice. This mirrors the dApp's auto-fill of `reservePrice` from
    // `mmAskPriceBuffered * numContracts` (then split back per-contract for
    // the SDK builder, which re-multiplies internally).
    const { mmAsk, spot } = await fetchMmAskForBuild({
      client: args.client,
      structureType,
      underlying: args.underlying,
      optionType: args.optionType,
      strikes,
      expiry: args.expiry,
      collateralToken,
      isIronCondor: args.isIronCondor,
    });

    // premiumPerContract in collateral-token units:
    //   BASE collateral (WETH on CALL): premium = mmAsk (already in underlying)
    //   QUOTE collateral (USDC):        premium = mmAsk * spot (USD per contract)
    const baseColl = isBaseCollateral(collateralToken);
    const premiumPerContract = baseColl ? mmAsk : mmAsk * spot;
    if (!Number.isFinite(premiumPerContract) || premiumPerContract <= 0) {
      const err = new Error(
        `Derived premiumPerContract=${premiumPerContract} from MM quote (mmAsk=${mmAsk}, spot=${spot}). ` +
          'Pass --reserve-price explicitly to override.'
      );
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
    const contracts = collateralAmount / premiumPerContract;
    return { contracts, derivedReservePrice: premiumPerContract };
  }

  // SELL path: unchanged. Structure-aware contracts from SDK, reservePrice stays
  // wherever the user put it (typically unset → 0 at submit time).
  const product = toProductName(structureType, collateralToken);
  const contracts = calculateNumContracts({
    tradeAmount: collateralAmount,
    product,
    strikes,
    isBuy: false,
  });
  if (!Number.isFinite(contracts) || contracts <= 0) {
    throw new Error(
      `Could not derive --contracts from --collateral-amount ${collateralAmount} for ${structureType} ` +
        `(got ${contracts}). Pass --contracts directly, or check that strikes describe a valid structure.`
    );
  }
  return { contracts };
}

// `computePayoutSummary` moved to `../payout.ts` so book.ts can reuse the
// same shape. Local `toProductName` is still used elsewhere in this file
// (e.g. `deriveContractsFromCollateral`).

function formatTicker(underlying: string, expirySec: number, strikes: number[], type: OptionType): string {
  const d = new Date(expirySec * 1000);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear().toString().slice(-2);
  const strikeStr = strikes.length === 1 ? `${strikes[0]}` : strikes.join('/');
  return `${underlying}-${day}${month}${year}-${strikeStr}-${type === 'PUT' ? 'P' : 'C'}`;
}

// ----------------------------------------------------------------------------
// Flag parsers
// ----------------------------------------------------------------------------

function parseStrikes(strikeFlag: string | undefined, strikesFlag: string | undefined): number[] {
  if (strikesFlag !== undefined && strikesFlag !== '') {
    const parts = strikesFlag.split(',').map((s) => Number.parseFloat(s.trim()));
    if (parts.some((n) => Number.isNaN(n) || n <= 0)) {
      throw new Error(`--strikes must be a comma-separated list of positive numbers (got "${strikesFlag}")`);
    }
    return parts;
  }
  if (strikeFlag !== undefined && strikeFlag !== '') {
    const n = Number.parseFloat(strikeFlag);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`--strike must be a positive number (got "${strikeFlag}")`);
    }
    return [n];
  }
  throw new Error('Either --strike or --strikes is required');
}

function parseUnsignedInt(name: string, raw: string | undefined): number {
  if (raw === undefined || raw === '') throw new Error(`${name} is required`);
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  return n;
}

function parseBigIntStrict(name: string, raw: string | undefined): bigint {
  if (raw === undefined || raw === '') throw new Error(`${name} is required`);
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be a decimal integer (got "${raw}")`);
  }
}

// Block submissions for (strike, expiry, type) combinations that aren't in the MM's live quote grid
async function assertStrikeExpiryAvailable(args: {
  client: GetClientResult['client'];
  underlying: 'ETH' | 'BTC';
  optionType: OptionType;
  strikes: number[];
  expiry: number;
}): Promise<void> {
  let grid;
  try {
    grid = await args.client.mmPricing.getPricingArray(args.underlying);
  } catch (e) {
    const err = new Error(
      `unable to verify MM quote availability for ${args.underlying} ${args.optionType} ` +
        `(${(e as Error).message ?? String(e)}). Retry, or pass --reserve-price to bypass the grid check.`
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  const wantCall = args.optionType === 'CALL';
  const matches = (strike: number): boolean =>
    grid.some((q) => q.strike === strike && q.expiry === args.expiry && q.isCall === wantCall);
  const missing = args.strikes.filter((s) => !matches(s));
  if (missing.length > 0) {
    const expiryIso = new Date(args.expiry * 1000).toISOString().slice(0, 10);
    const verb = missing.length === 1 ? 'is' : 'are';
    const err = new Error(
      `strike${missing.length === 1 ? '' : 's'} ${missing.join(', ')} / expiry ${expiryIso} ` +
        `(${args.underlying} ${args.optionType}) ${verb} not in the MM's current quote grid. ` +
        `Run 'thetanuts rfq quote --underlying ${args.underlying} --type ${args.optionType.toLowerCase()}' ` +
        `to see what's tradeable.`
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
}

async function resolveRequester(_opts: ReturnType<typeof getGlobalOpts>, result: GetClientResult, explicit?: string): Promise<string> {
  if (explicit) {
    if (!ADDRESS_REGEX.test(explicit)) {
      throw new Error(`--requester must be a 0x-prefixed 40-char hex address (got "${explicit}")`);
    }
    return explicit;
  }
  if (result.hasSigner) {
    return result.client.getSignerAddress();
  }
  return PLACEHOLDER_REQUESTER;
}

// ----------------------------------------------------------------------------
// Build pipeline — shared by `rfq build` and `rfq encode-request`
// ----------------------------------------------------------------------------

interface BuildResult {
  inputs: BuildInputs;
  structureType: StructureType;
  rfqRequest: RFQRequest;
  ticker: string;
  deadlineSeconds: number;
}

async function buildFromFlags(
  result: GetClientResult,
  local: Record<string, string | undefined>,
  globalOpts: ReturnType<typeof getGlobalOpts>
): Promise<BuildResult> {
  const underlying = (local.underlying ?? '').toUpperCase();
  if (!['ETH', 'BTC'].includes(underlying)) throw new Error('--underlying must be ETH or BTC');

  const type = (local.type ?? '').toUpperCase();
  if (!['PUT', 'CALL'].includes(type)) throw new Error('--type must be PUT or CALL');

  const strikes = parseStrikes(local.strike, local.strikes);
  const expiry = parseUnsignedInt('--expiry', local.expiry);
  // Expiry sanity bounds
  const nowSeconds = Math.floor(Date.now() / 1000);
  const FOUR_YEARS_SECONDS = 4 * 365 * 24 * 3600;
  if (expiry > nowSeconds + FOUR_YEARS_SECONDS) {
    const suggestion = nowSeconds + 86400 * 30;
    const err = new Error(
      `expiry ${expiry} is more than 4 years out — looks like milliseconds? Pass a Unix timestamp in seconds (e.g. ${suggestion})`
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  if (expiry < nowSeconds) {
    const err = new Error('expiry must be in the future');
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  const direction = (local.direction ?? '').toLowerCase();
  if (!['buy', 'sell'].includes(direction)) throw new Error('--direction must be buy or sell');

  const isIronCondor = local.structure === 'iron-condor';
  if (local.structure !== undefined && !isIronCondor) {
    throw new Error(`--structure must be one of: iron-condor (got "${local.structure}")`);
  }

  const ordering = validateStrikeOrdering(strikes, type as OptionType);
  if (!ordering.valid) {
    const err = new Error(ordering.message);
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }

  const structureType = getStructureType(strikes.length, type as OptionType, isIronCondor);

  // Structure-specific strike validation — the on-chain implementations
  // require equidistant butterfly wings and equal condor spread widths.
  // Catching it client-side beats the silent on-chain revert + the SDK's
  // wider-than-needed numContracts derivation in the collateral-amount path.
  if (isIronCondor) {
    const ic = validateIronCondor(strikes);
    if (!ic.valid) {
      const err = new Error(ic.error ?? 'Invalid iron condor strikes');
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
  } else if (strikes.length === 3) {
    const fly = validateButterfly(strikes);
    if (!fly.valid) {
      const err = new Error(`${fly.error ?? 'Invalid butterfly strikes'}. Got: [${strikes.join(', ')}]`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
  } else if (strikes.length === 4) {
    const cnd = validateCondor(strikes);
    if (!cnd.valid) {
      const err = new Error(`${cnd.error ?? 'Invalid condor strikes'}. Got: [${strikes.join(', ')}]`);
      (err as Error & { exitCode?: number }).exitCode = 4;
      throw err;
    }
  }
  const collateralToken =
    (local.collateralToken?.toUpperCase() as 'USDC' | 'WETH' | undefined) ??
    defaultCollateral(type as OptionType, strikes.length);
  if (!['USDC', 'WETH'].includes(collateralToken)) {
    throw new Error('--collateral-token must be USDC or WETH');
  }

  // v0.1.0 is USDC-only on the CLI. The SDK still supports WETH collateral for
  // the inverse-CALL family, but it's not exposed here; reject any non-USDC
  // collateral up front so users don't get a clean-looking build artifact
  // they can't submit.
  if (collateralToken !== 'USDC') {
    const err = new Error(
      'v0.1.0 supports USDC collateral only — WETH/cbBTC will be enabled in a future release'
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }

  // Grid-availability gate — refuse any (strike, expiry) the MM isn't quoting,
  // regardless of direction or sizing path. The BUY-without-reserve-price flow
  // would catch this later via fetchMmAskForBuild, but BUY-with-reserve-price,
  // SELL, and direct --contracts paths previously had no gate at all and could
  // strand on-chain escrow on a useless RFQ.
  await assertStrikeExpiryAvailable({
    client: result.client,
    underlying: underlying as 'ETH' | 'BTC',
    optionType: type as OptionType,
    strikes,
    expiry,
  });

  const deadlineMinutes = local.deadlineMinutes !== undefined && local.deadlineMinutes !== ''
    ? Number.parseFloat(local.deadlineMinutes)
    : DEFAULT_DEADLINE_MINUTES;
  if (!Number.isFinite(deadlineMinutes) || deadlineMinutes <= 0) {
    throw new Error(`--deadline-minutes must be > 0 (got "${local.deadlineMinutes}")`);
  }

  const reservePrice = local.reservePrice !== undefined && local.reservePrice !== ''
    ? Number.parseFloat(local.reservePrice)
    : undefined;
  if (reservePrice !== undefined && (!Number.isFinite(reservePrice) || reservePrice < 0)) {
    throw new Error(`--reserve-price must be >= 0 (got "${local.reservePrice}")`);
  }

  // Resolve contract count from EITHER --contracts (direct) OR --collateral-amount
  // (derived from USDC budget for buy, or collateral deposit for sell). Mutex.
  const rawContracts = local.contracts !== undefined && local.contracts !== ''
    ? local.contracts
    : undefined;
  const rawCollateralAmount = local.collateralAmount !== undefined && local.collateralAmount !== ''
    ? local.collateralAmount
    : undefined;
  if (rawContracts !== undefined && rawCollateralAmount !== undefined) {
    const err = new Error(
      '--contracts and --collateral-amount are mutually exclusive. Pass exactly one ' +
        '(--collateral-amount derives --contracts from your spend budget).'
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
  if (rawContracts === undefined && rawCollateralAmount === undefined) {
    throw new Error(
      'Must pass either --contracts (direct contract count) or --collateral-amount (USDC spend; CLI derives contracts).'
    );
  }
  let contractsNum: number;
  // Mutated when BUY+--collateral-amount triggered an MM fetch and we picked
  // up a fresh per-contract reservePrice from the live ask. Stamped into the
  // build inputs below so the SDK builder receives it.
  let effectiveReservePrice: number | undefined = reservePrice;
  if (rawContracts !== undefined) {
    contractsNum = Number.parseFloat(rawContracts);
    if (!Number.isFinite(contractsNum) || contractsNum <= 0) {
      throw new Error(`--contracts must be a positive number (got "${rawContracts}")`);
    }
  } else {
    const budget = Number.parseFloat(rawCollateralAmount!);
    if (!Number.isFinite(budget) || budget <= 0) {
      throw new Error(`--collateral-amount must be a positive number (got "${rawCollateralAmount}")`);
    }
    const derived = await deriveContractsFromCollateral({
      collateralAmount: budget,
      direction: direction as 'buy' | 'sell',
      structureType,
      collateralToken,
      strikes,
      reservePrice,
      client: result.client,
      underlying: underlying as Underlying,
      optionType: type as OptionType,
      expiry,
      isIronCondor,
    });
    contractsNum = derived.contracts;
    if (derived.derivedReservePrice !== undefined) {
      effectiveReservePrice = derived.derivedReservePrice;
    }
  }

  const referralId = local.referralId !== undefined && local.referralId !== ''
    ? parseBigIntStrict('--referral-id', local.referralId)
    : undefined;

  const requester = await resolveRequester(globalOpts, result, local.requester);

  // Optional: stamp the requester's RFQ public key into the request body. The
  // CLI does NOT auto-load the keystore here — `rfq build` is supposed to be
  // a pure off-chain construction, and not every build is ready to be sent.
  // `rfq request` (commit 3) will fill this in from the keystore.
  let requesterPublicKey: string | undefined = local.requesterPublicKey;
  if (requesterPublicKey === '') requesterPublicKey = undefined;

  const inputs: BuildInputs = {
    underlying: underlying as Underlying,
    type: type as OptionType,
    strikes,
    expiry,
    contracts: contractsNum,
    direction: direction as 'buy' | 'sell',
    requester,
    collateralToken,
    deadlineMinutes,
    ...(effectiveReservePrice !== undefined ? { reservePrice: effectiveReservePrice } : {}),
    ...(referralId !== undefined ? { referralId } : {}),
    isIronCondor,
    ...(requesterPublicKey !== undefined ? { requesterPublicKey } : {}),
  };

  // Defer to SDK — this is where strike sorting / impl resolution / decimal
  // conversion actually happens. The OpenClaw equality test in §6 #1 only
  // passes because the CLI hands the SDK the same human inputs OpenClaw does.
  const { client } = result;
  const rfqRequest = isIronCondor
    ? client.optionFactory.buildIronCondorRFQ({
        requester: inputs.requester as `0x${string}`,
        underlying: inputs.underlying,
        strike1: inputs.strikes[0]!,
        strike2: inputs.strikes[1]!,
        strike3: inputs.strikes[2]!,
        strike4: inputs.strikes[3]!,
        expiry: inputs.expiry,
        numContracts: inputs.contracts,
        isLong: inputs.direction === 'buy',
        collateralToken: inputs.collateralToken,
        offerDeadlineMinutes: inputs.deadlineMinutes,
        ...(inputs.reservePrice !== undefined ? { reservePrice: inputs.reservePrice } : {}),
        ...(inputs.referralId !== undefined ? { referralId: inputs.referralId } : {}),
        ...(inputs.requesterPublicKey !== undefined ? { requesterPublicKey: inputs.requesterPublicKey } : {}),
      })
    : client.optionFactory.buildRFQRequest({
        requester: inputs.requester as `0x${string}`,
        underlying: inputs.underlying,
        optionType: inputs.type,
        strikes: inputs.strikes.length === 1 ? inputs.strikes[0]! : inputs.strikes,
        expiry: inputs.expiry,
        numContracts: inputs.contracts,
        isLong: inputs.direction === 'buy',
        collateralToken: inputs.collateralToken,
        offerDeadlineMinutes: inputs.deadlineMinutes,
        ...(inputs.reservePrice !== undefined ? { reservePrice: inputs.reservePrice } : {}),
        ...(inputs.referralId !== undefined ? { referralId: inputs.referralId } : {}),
        ...(inputs.requesterPublicKey !== undefined ? { requesterPublicKey: inputs.requesterPublicKey } : {}),
      });

  const ticker = formatTicker(inputs.underlying, inputs.expiry, inputs.strikes, inputs.type);
  const deadlineSeconds = Math.round(inputs.deadlineMinutes * 60);

  return { inputs, structureType, rfqRequest, ticker, deadlineSeconds };
}

function attachBuildFlags(cmd: Command, { allFlagsOptional = false }: { allFlagsOptional?: boolean } = {}): Command {
  // When a sibling flag like --from-build-file can supersede the build args,
  // commander's requiredOption would block legitimate alternative paths. The
  // body of `buildFromFlags` performs the same validation at runtime, so
  // letting them be optional at the commander layer is safe.
  const requireUnderlying = allFlagsOptional ? cmd.option.bind(cmd) : cmd.requiredOption.bind(cmd);
  const requireType = allFlagsOptional ? cmd.option.bind(cmd) : cmd.requiredOption.bind(cmd);
  const requireExpiry = allFlagsOptional ? cmd.option.bind(cmd) : cmd.requiredOption.bind(cmd);
  const requireDirection = allFlagsOptional ? cmd.option.bind(cmd) : cmd.requiredOption.bind(cmd);

  requireUnderlying('--underlying <asset>', 'ETH or BTC');
  requireType('--type <type>', 'PUT or CALL');
  cmd.option('--strike <n>', 'single strike (vanilla only)');
  cmd.option('--strikes <csv>', 'comma-separated strikes (2-4 values for spread/butterfly/condor)');
  requireExpiry('--expiry <ts>', 'unix expiry timestamp');
  // --contracts and --collateral-amount are mutex; runtime enforces "exactly one"
  cmd.option('--contracts <n>', 'contract count (human-readable). Mutually exclusive with --collateral-amount.');
  cmd.option(
    '--collateral-amount <n>',
    'USDC budget for BUY (requires --reserve-price as price ceiling) OR collateral deposit for SELL. ' +
      'CLI derives --contracts automatically. Mutually exclusive with --contracts.'
  );
  requireDirection('--direction <buy|sell>', 'buy = long position, sell = short position');
  return cmd

    .option(
      '--collateral-token <USDC>',
      'collateral token (v0.1.0: USDC only; WETH/cbBTC planned for a future release)'
    )
    .option(
      '--deadline-minutes <n>',
      `offer-end deadline in minutes (default ${DEFAULT_DEADLINE_MINUTES} = ${DEFAULT_DEADLINE_MINUTES * 60}s, matches OpenClaw)`
    )
    .option('--reserve-price <n>', 'reserve premium per contract (in collateral units), optional')
    .option('--referral-id <n>', 'referral ID to attach (default 0)')
    .option('--structure <kind>', 'override structure detection (only valid value: iron-condor)')
    .option('--requester <addr>', 'requester address (default: signer or 0x...01 placeholder)')
    .option('--requester-public-key <hex>', 'compressed pubkey to stamp into the request (default: empty)');
}

function serializeRfqRequest(req: RFQRequest, extras: Record<string, unknown> = {}): Record<string, unknown> {
  // Mirror OpenClaw build-rfq.ts output shape so anyone porting between the two
  // can grep for the same field names. `transaction` is added separately by
  // callers that want encode output.
  return {
    ...extras,
    request: req,
  };
}

// ----------------------------------------------------------------------------
// register()
// ----------------------------------------------------------------------------

export function register(program: Command): void {
  const grp = program
    .command('rfq')
    .description(
      'Request-for-Quotation lifecycle: build / encode / submit / inspect quotations and referrals. ' +
        'Numeric defaults (0.75min deadline, single-strike-CALL→WETH collateral) match OpenClaw build-rfq.ts.'
    );

  registerBuild(grp);
  registerQuote(grp);
  registerViews(grp);
  registerRequest(grp);
  registerCancel(grp);
  registerOffers(grp);
  registerAccept(grp);
  registerSettle(grp);
  registerStatus(grp);
}

// ----- rfq quote -----------------------------------------------------------
//
// Discovery surface for the dApp's "available expiries / strikes" picker. Hits
// `client.mmPricing.getPricingArray(underlying)` (the same source the dApp's
// useRfqPricing.ts:45 uses), optionally filters by type/expiry, and projects
// the flat row shape a trader needs to pick strikes for a follow-up
// `rfq build` / `rfq request`.
//
// Empty-result path (`getPricingArray` → []) prints an info line to stderr and
// exits 0 — there's nothing wrong with the CLI, the MM just isn't quoting.

function registerQuote(grp: Command): void {
  grp
    .command('quote')
    .description(
      'List live MM quotes for an underlying (ETH or BTC). VANILLA (single-strike) only — ' +
        'the MM publishes a single-strike grid, not multi-leg structures. ' +
        'For multi-leg pricing (spread, butterfly, condor, iron condor), use `pricing spread`, ' +
        '`pricing butterfly`, or `pricing condor` with explicit --strikes. ' +
        'Use these single-strike results to pick the legs for a multi-leg `rfq build`.'
    )
    .requiredOption('--underlying <asset>', 'ETH or BTC')
    .option('--type <type>', 'filter to PUT or CALL only (vanilla only — see description above for multi-leg)')
    .option('--expiry <ts>', 'filter to one expiry (unix seconds)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ underlying: string; type?: string; expiry?: string }>();
      try {
        const underlying = local.underlying.toUpperCase();
        if (!['ETH', 'BTC'].includes(underlying)) {
          throw new Error('--underlying must be ETH or BTC');
        }
        let typeFilter: 'PUT' | 'CALL' | undefined;
        if (local.type !== undefined && local.type !== '') {
          const t = local.type.toUpperCase();
          if (t !== 'PUT' && t !== 'CALL' && t !== 'P' && t !== 'C') {
            // Detect common multi-leg attempts so the error is actionable, not
            // a dead-end. The MM doesn't publish multi-leg structures in a
            // grid — they're constructed on-demand from vanilla strikes.
            const isMultiLegAttempt = /SPREAD|FLY|CONDOR|IRON|BUTTERFLY/i.test(t);
            if (isMultiLegAttempt) {
              throw new Error(
                `--type "${local.type}" is a multi-leg structure. \`rfq quote\` lists VANILLA strikes only ` +
                  `(that's what the MM grid contains). For ${t.toLowerCase()} pricing, use the dedicated commands:\n` +
                  `  thetanuts pricing spread    --underlying ${underlying} --strikes <s1,s2>          --expiry <ts> --type put\n` +
                  `  thetanuts pricing butterfly --underlying ${underlying} --strikes <s1,s2,s3>       --expiry <ts> --type call\n` +
                  `  thetanuts pricing condor    --underlying ${underlying} --strikes <s1,s2,s3,s4>   --expiry <ts> --type iron\n` +
                  `Pick legs from \`rfq quote --underlying ${underlying} --type put\` (vanilla strikes), then build your structure.`
              );
            }
            throw new Error('--type must be PUT or CALL (vanilla only). Use `pricing spread/butterfly/condor` for multi-leg.');
          }
          typeFilter = t === 'P' || t === 'PUT' ? 'PUT' : 'CALL';
        }
        let expiryFilter: number | undefined;
        if (local.expiry !== undefined && local.expiry !== '') {
          expiryFilter = parseUnsignedInt('--expiry', local.expiry);
        }

        const { client } = getClient(opts);
        const pricing = await client.mmPricing.getPricingArray(underlying as 'ETH' | 'BTC');

        let filtered = pricing;
        if (typeFilter !== undefined) {
          const wantCall = typeFilter === 'CALL';
          filtered = filtered.filter((p) => p.isCall === wantCall);
        }
        if (expiryFilter !== undefined) {
          filtered = filtered.filter((p) => p.expiry === expiryFilter);
        }

        if (filtered.length === 0) {
          const noteParts: string[] = [`underlying=${underlying}`];
          if (typeFilter) noteParts.push(`type=${typeFilter}`);
          if (expiryFilter) noteParts.push(`expiry=${expiryFilter}`);
          process.stderr.write(
            `No live MM quotes for ${underlying} right now (filters: ${noteParts.join(', ')}). ` +
              `Try without filters, or check again later — the MM bot may be idle.\n`
          );
          render([], { output: opts.output, noColor: !opts.color });
          return;
        }

        // Already sorted by getPricingArray (filterExpired → sortByExpiryAndStrike).
        // For JSON output, dump the full rows so scripts can pick whatever fields they want.
        const wantJson = (opts.output ?? 'table') === 'json';
        if (wantJson) {
          render(filtered, { output: opts.output, noColor: !opts.color });
          return;
        }

        // Table output: project to the columns the dApp's picker uses.
        const rows = filtered.map((p) => ({
          expiry: p.expiry,
          date: new Date(p.expiry * 1000).toISOString().split('T')[0],
          strike: p.strike,
          type: p.isCall ? 'C' : 'P',
          ticker: p.ticker,
          bid: Number(p.feeAdjustedBid.toFixed(8)),
          ask: Number(p.feeAdjustedAsk.toFixed(8)),
          mark: Number(p.markPrice.toFixed(8)),
          usdcAsk: p.byCollateral['USD']?.mmAskPriceBuffered !== undefined
            ? Number(p.byCollateral['USD']!.mmAskPriceBuffered.toFixed(8))
            : null,
          wethAsk: p.byCollateral[underlying]?.mmAskPriceBuffered !== undefined
            ? Number(p.byCollateral[underlying]!.mmAskPriceBuffered.toFixed(8))
            : null,
        }));
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}

// ----- rfq build ------------------------------------------------------------

function registerBuild(grp: Command): void {
  attachBuildFlags(
    grp
      .command('build')
      .description(
        'Build an RFQRequest off-chain from human-readable inputs and print the structured result. ' +
          'No RPC writes. With --out, also saves a JSON file that `rfq request --from-build-file` can read.'
      )
  )
    .option('--out <path>', 'also save the build artifact to this JSON file')
    .option(
      '--scenarios',
      'print a 5-row table of (spot at expiry, payout, net P&L) after the main output'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const localRaw = cmd.opts() as Record<string, string | boolean | undefined>;
      // commander represents `--scenarios` as boolean; strip it before passing
      // the rest to `buildFromFlags`, which only handles string flag values.
      const scenarios = Boolean(localRaw.scenarios);
      const { scenarios: _omit, ...localStrings } = localRaw as Record<string, unknown>;
      const local = localStrings as Record<string, string | undefined>;
      try {
        const result = getClient(opts);
        const built = await buildFromFlags(result, local, opts);
        const encoded = result.client.optionFactory.encodeRequestForQuotation(built.rfqRequest);

        const payoutArgs = {
          structureType: built.structureType,
          collateralToken: built.inputs.collateralToken,
          strikes: built.inputs.strikes,
          direction: built.inputs.direction,
          contracts: built.inputs.contracts,
          ...(built.inputs.reservePrice !== undefined ? { reservePrice: built.inputs.reservePrice } : {}),
        };
        const payout = computePayoutSummary(payoutArgs);

        const payload = {
          rfq: {
            ticker: built.ticker,
            underlying: built.inputs.underlying,
            type: built.inputs.type,
            structureType: built.structureType,
            strikes: built.inputs.strikes,
            strikeCount: built.inputs.strikes.length,
            expiry: built.inputs.expiry,
            expiryDate: new Date(built.inputs.expiry * 1000).toISOString(),
            contracts: built.inputs.contracts,
            direction: built.inputs.direction,
            isBuy: built.inputs.direction === 'buy',
            collateral: built.inputs.collateralToken,
            deadlineSeconds: built.deadlineSeconds,
            referralId: built.inputs.referralId?.toString() ?? '0',
            isIronCondor: built.inputs.isIronCondor,
          },
          payout,
          ...serializeRfqRequest(built.rfqRequest),
          transaction: {
            to: encoded.to,
            data: encoded.data,
            value: '0',
          },
        };

        if (local.out && local.out.length > 0) {
          const dest = path.resolve(local.out);
          await writeFile(dest, JSON.stringify(payload, jsonReplacer, 2) + '\n');
          process.stderr.write(`Build artifact written to ${dest}\n`);
        }

        // `payload` mixes flat rfq summary fields with deeply nested sub-objects
        // (`payout`, `params`, `tracking`, `transaction.data` calldata blob).
        // Rendering as a 2-col table crams 2KB+ of JSON into single cells; the
        // result wraps off-screen and is unreadable. Default to pretty JSON
        // when the user didn't explicitly pick a format — mirrors the
        // auto-switch in `market stats`. Explicit `-o table` still works for
        // anyone who really wants the legacy view.
        const explicitOutput = process.argv.includes('-o') || process.argv.includes('--output');
        render(payload, {
          output: explicitOutput ? opts.output : 'json',
          noColor: !opts.color,
        });

        // Optional follow-up: per-spot scenarios table. Opt-in via --scenarios;
        // rendered as a separate array so table mode actually formats it as a
        // 4-column table (the main payload renders as JSON by default).
        if (scenarios) {
          const rows = computeScenarios(payoutArgs);
          process.stdout.write('\nScenarios at expiry:\n');
          render(rows, { output: 'table', noColor: !opts.color });
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit === 0 ? 1 : exit);
      }
    });
}

// ----- rfq get / tracking / count / fee ------------------------------------

function registerViews(grp: Command): void {
  grp
    .command('get')
    .description('Read a quotation by ID (params + state).')
    .requiredOption('--id <quotationId>', 'quotation ID')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ id: string }>();
      try {
        const { client } = getClient(opts);
        const id = parseBigIntStrict('--id', local.id);
        const quotation = await client.optionFactory.getQuotation(id);
        // `getQuotation` returns nested params (strikes[], tracking{}, state)
        // — same readability problem as `rfq build`. Auto-switch to JSON when
        // the user didn't pick a format explicitly.
        const explicitOutput = process.argv.includes('-o') || process.argv.includes('--output');
        render(quotation, {
          output: explicitOutput ? opts.output : 'json',
          noColor: !opts.color,
        });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

}

// ----------------------------------------------------------------------------
// Build-file deserializer — reads a JSON saved by `rfq build --out` and
// reconstructs the bigint-typed fields the SDK requires.
// ----------------------------------------------------------------------------

function toBigIntField(v: unknown, fieldName: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && v.length > 0) {
    try {
      return BigInt(v);
    } catch {
      throw new Error(`Build file field ${fieldName} is not a decimal integer string: "${v}"`);
    }
  }
  throw new Error(`Build file field ${fieldName} is missing or not a number/bigint (got ${typeof v})`);
}

function parseQuotationParameters(raw: unknown): QuotationParameters {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Build file missing `request.params` object');
  }
  const r = raw as Record<string, unknown>;
  const strikes = Array.isArray(r.strikes)
    ? r.strikes.map((s, i) => toBigIntField(s, `request.params.strikes[${i}]`))
    : (() => { throw new Error('Build file `request.params.strikes` must be an array'); })();
  return {
    requester: String(r.requester ?? ''),
    existingOptionAddress: String(r.existingOptionAddress ?? '0x0000000000000000000000000000000000000000'),
    collateral: String(r.collateral ?? ''),
    collateralPriceFeed: String(r.collateralPriceFeed ?? ''),
    implementation: String(r.implementation ?? ''),
    strikes,
    numContracts: toBigIntField(r.numContracts, 'request.params.numContracts'),
    requesterDeposit: toBigIntField(r.requesterDeposit, 'request.params.requesterDeposit'),
    collateralAmount: toBigIntField(r.collateralAmount, 'request.params.collateralAmount'),
    expiryTimestamp: toBigIntField(r.expiryTimestamp, 'request.params.expiryTimestamp'),
    offerEndTimestamp: toBigIntField(r.offerEndTimestamp, 'request.params.offerEndTimestamp'),
    isRequestingLongPosition: Boolean(r.isRequestingLongPosition),
    convertToLimitOrder: Boolean(r.convertToLimitOrder),
    extraOptionData: String(r.extraOptionData ?? '0x'),
  };
}

function parseRFQRequest(raw: unknown): RFQRequest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Build file missing top-level `request` object');
  }
  const r = raw as Record<string, unknown>;
  const trackingRaw = (r.tracking ?? {}) as Record<string, unknown>;
  return {
    params: parseQuotationParameters(r.params),
    tracking: {
      referralId: toBigIntField(trackingRaw.referralId ?? '0', 'request.tracking.referralId'),
      eventCode: toBigIntField(trackingRaw.eventCode ?? '0', 'request.tracking.eventCode'),
    },
    reservePrice: toBigIntField(r.reservePrice ?? '0', 'request.reservePrice'),
    requesterPublicKey: String(r.requesterPublicKey ?? ''),
  };
}

async function loadRequestFromBuildFile(filePath: string): Promise<RFQRequest> {
  const abs = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read --from-build-file at ${abs}: ${(err as Error).message ?? String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Build file at ${abs} is not valid JSON: ${(err as Error).message ?? String(err)}`);
  }
  const top = parsed as Record<string, unknown>;
  if (!top.request) {
    throw new Error(`Build file at ${abs} is missing a top-level "request" field — was it created by \`thetanuts rfq build --out\`?`);
  }
  return parseRFQRequest(top.request);
}

/**
 * Build an RFQ request from flags OR a saved build-file, then stamp the
 * requesterPublicKey from the keystore if it isn't already set. Used by every
 * write that submits an RFQRequest (request, static-request, swap-and-call's
 * inner self-call when generated from flags).
 */
async function loadOrBuildRequest(
  result: GetClientResult,
  local: Record<string, string | undefined>,
  globalOpts: ReturnType<typeof getGlobalOpts>
): Promise<{ request: RFQRequest; fromFile: boolean; structureType?: StructureType; ticker?: string }> {
  if (local.fromBuildFile) {
    const req = await loadRequestFromBuildFile(local.fromBuildFile);
    return { request: req, fromFile: true };
  }
  const built = await buildFromFlags(result, local, globalOpts);
  return { request: built.rfqRequest, fromFile: false, structureType: built.structureType, ticker: built.ticker };
}

/**
 * Parse the on-chain quotationId from a `requestForQuotation` receipt.
 *
 * Strategy (most reliable → fallback):
 *   1. Look for `CollateralDeposited(uint256 indexed quotationId, address, uint256)`
 *      via ABI parse. Always emitted for BUY (the requester's reservePrice
 *      escrow). The SDK's OPTION_FACTORY_ABI includes this event.
 *   2. Fall back to the first OptionFactory log with ≥2 topics — topic[1] of
 *      the QuotationRequested event is the quotationId. The on-chain event's
 *      topic[0] hash currently differs from the ABI definition (likely a
 *      stale ABI on the SDK side), so we can't ABI-parse it directly.
 *
 * Returns undefined if neither pattern matches. Caller treats as soft miss —
 * the tx itself succeeded; user just won't see the convenience ID printed.
 */
function extractQuotationIdFromReceipt(
  logs: ReadonlyArray<{ topics: readonly string[]; data: string; address: string }>,
  factoryAddress: string
): string | undefined {
  const iface = new Interface(OPTION_FACTORY_ABI);
  const factoryLower = factoryAddress.toLowerCase();

  // Pass 1: ABI parse for CollateralDeposited (reliable when emitted).
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'CollateralDeposited' && parsed.args?.quotationId !== undefined) {
        return (parsed.args.quotationId as bigint).toString();
      }
    } catch {
      // Not a recognized event — skip
    }
  }

  // Pass 2: first OptionFactory log with ≥2 topics — topic[1] of
  // QuotationRequested is the indexed quotationId.
  for (const log of logs) {
    if (log.address?.toLowerCase() !== factoryLower) continue;
    if (log.topics.length < 2) continue;
    try {
      return BigInt(log.topics[1]!).toString();
    } catch {
      // Malformed topic — skip
    }
  }
  return undefined;
}

async function ensureRequesterPublicKey(result: GetClientResult, req: RFQRequest): Promise<RFQRequest> {
  if (req.requesterPublicKey && req.requesterPublicKey.length > 0 && req.requesterPublicKey !== '0x') {
    return req;
  }
  // Auto-generate or load — design doc §1 says `rfq request` "auto-ensures a
  // keystore exists and stamps requesterPublicKey into the request before
  // submitting". This is the only place we silently persist a keypair.
  const kp = await result.client.rfqKeys.getOrCreateKeyPair();
  return { ...req, requesterPublicKey: kp.compressedPublicKey };
}

function previewRequest(req: RFQRequest, ticker?: string, structureType?: StructureType): Record<string, unknown> {
  return {
    action: 'requestForQuotation',
    ...(ticker ? { ticker } : {}),
    ...(structureType ? { structureType } : {}),
    requester: req.params.requester,
    collateral: req.params.collateral,
    implementation: req.params.implementation,
    strikes: req.params.strikes.map((s) => s.toString()),
    numContracts: req.params.numContracts.toString(),
    expiryTimestamp: req.params.expiryTimestamp.toString(),
    offerEndTimestamp: req.params.offerEndTimestamp.toString(),
    isRequestingLongPosition: req.params.isRequestingLongPosition,
    referralId: req.tracking.referralId.toString(),
    reservePrice: req.reservePrice.toString(),
    requesterPublicKey: req.requesterPublicKey,
  };
}

function checkOfferDeadlineFuture(req: RFQRequest): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (req.params.offerEndTimestamp <= now) {
    const err = new Error(
      `Offer deadline ${req.params.offerEndTimestamp.toString()} is in the past (now=${now.toString()}). ` +
        'Rebuild the request with a future --deadline-minutes; the SDK refuses to broadcast a stale deadline.'
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }
}

/**
 * Allowance check for both BUY and SHORT (sell) RFQs.
 *
 *   BUY  — OptionFactory escrows `reservePrice` at REQUEST time. If the
 *          requester's allowance is below that, the contract reverts with a
 *          cryptic ERC20 message. We hard-block here when --ensure-allowance
 *          isn't passed, with a clear actionable error.
 *   SHORT — OptionFactory pulls collateral at SETTLE (after maker fills).
 *          The user has time to approve between request and settle, so this
 *          path stays a soft stderr advisory and proceeds with the request.
 *
 * With `--ensure-allowance`, confirm prompt for the approval, then
 * `ensureAllowance(MaxUint256)` (or the user's `--approve-amount`).
 */
async function maybeEnsureCollateralAllowance(
  result: GetClientResult,
  req: RFQRequest,
  flags: { ensureAllowance?: boolean; approveAmount?: string; yes?: boolean; dryRun?: boolean }
): Promise<{ approveEncoded: { to: string; data: string } | null }> {
  const { client } = result;
  const signerAddr = await client.getSignerAddress();
  const spender = client.optionFactory.contractAddress;
  const current = await client.erc20.getAllowance(req.params.collateral, signerAddr, spender);

  const isBuy = req.params.isRequestingLongPosition;
  // BUY: contract escrows reservePrice at request. SHORT: nothing pulled now.
  const minRequired = isBuy ? req.reservePrice : 0n;
  const directionLabel = isBuy ? 'BUY' : 'SHORT';

  // Compute target allowance amount (what we approve TO, if --ensure-allowance is set)
  let target: bigint;
  let isMax = false;
  if (flags.approveAmount === undefined || flags.approveAmount === 'max') {
    target = MaxUint256;
    isMax = true;
  } else {
    const decimals = Number(await client.erc20.getDecimals(req.params.collateral));
    target = client.utils.toBigInt(flags.approveAmount, decimals);
  }
  if (target < minRequired) {
    throw new Error(
      `--approve-amount (${target.toString()}) is less than the contract's required ` +
        `escrow at request time (${minRequired.toString()}). Increase --approve-amount or omit it (defaults to MaxUint256).`
    );
  }

  if (flags.dryRun) {
    if (current >= target) return { approveEncoded: null };
    const encoded = client.erc20.encodeApprove(req.params.collateral, spender, target);
    return { approveEncoded: { to: encoded.to, data: encoded.data } };
  }

  if (current >= target) {
    if (!flags.ensureAllowance) {
      process.stderr.write(
        `Allowance for ${req.params.collateral} → ${spender} is already ${current.toString()} (sufficient).\n`
      );
    }
    return { approveEncoded: null };
  }

  // BUY: hard-block when the contract WILL revert (allowance < reservePrice).
  if (isBuy && current < minRequired && !flags.ensureAllowance) {
    const err = new Error(
      `BUY RFQ: current allowance on ${req.params.collateral} → OptionFactory (${spender}) ` +
        `is ${current.toString()}, but the contract will escrow ${minRequired.toString()} ` +
        `(your reserve-price total) at request time. Either:\n` +
        `  • Pass --ensure-allowance to approve in-flow (uses MaxUint256 by default), or\n` +
        `  • Pre-approve manually: thetanuts wallet approve --token <SYM> --for optionFactory --amount 5`
    );
    (err as Error & { exitCode?: number }).exitCode = 4;
    throw err;
  }

  // SHORT (or BUY with reservePrice=0) and not --ensure-allowance: soft advisory.
  if (!flags.ensureAllowance) {
    process.stderr.write(
      `⚠ ${directionLabel} RFQ: current allowance on ${req.params.collateral} → ${spender} is ${current.toString()}, ` +
        'which may be insufficient when the contract draws collateral at settle.\n' +
        '  Pass --ensure-allowance to approve before submitting, or run\n' +
        `  thetanuts wallet approve --token <SYM> --for optionFactory --amount <n>\n`
    );
    return { approveEncoded: null };
  }

  // Explicit ensure-allowance: confirm + approve
  if (isMax) {
    process.stderr.write('WARNING: approving MaxUint256. The spender will be able to move any amount.\n');
  }
  const approveOk = await confirm(
    `Approve ${isMax ? 'unlimited (MaxUint256)' : target.toString()} of ${req.params.collateral} to OptionFactory ${spender}?`,
    { yes: flags.yes, dryRun: flags.dryRun }
  );
  if (!approveOk) {
    process.stderr.write('Approval declined; aborting request.\n');
    process.exit(3);
  }
  await client.erc20.ensureAllowance(req.params.collateral, spender, target);
  return { approveEncoded: null };
}

// ----- rfq request ---------------------------------------------------------

function registerRequest(grp: Command): void {
  attachBuildFlags(
    grp
      .command('request')
      .description(
        'Submit an RFQ on-chain (broadcasts requestForQuotation). ' +
          'Use --from-build-file <path> to reuse a `rfq build --out` artifact, or pass build flags. ' +
          'Auto-stamps requesterPublicKey from the RFQ keystore (creates one if missing).'
      ),
    { allFlagsOptional: true }
  )
    .option('--from-build-file <path>', 'load the request from a JSON file saved by `rfq build --out` (skips most other flags)')
    .option(
      '--ensure-allowance',
      'for SHORT requests, prompt to approve the collateral token to the OptionFactory before submitting'
    )
    .option(
      '--approve-amount <max|n>',
      'amount to ensure-allowance to (default: max = MaxUint256; or a decimal token amount). Only used with --ensure-allowance.'
    )
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts() as Record<string, string | undefined> & {
        ensureAllowance?: boolean;
      };
      try {
        const result = getClient(opts);
        requireSigner(result);

        const loaded = await loadOrBuildRequest(result, local, opts);
        const requestWithPk = await ensureRequesterPublicKey(result, loaded.request);
        checkOfferDeadlineFuture(requestWithPk);

        render(
          previewRequest(requestWithPk, loaded.ticker, loaded.structureType),
          { output: opts.output, noColor: !opts.color }
        );

        // Sell-side allowance advisory / explicit approval
        await maybeEnsureCollateralAllowance(result, requestWithPk, {
          ensureAllowance: Boolean(local.ensureAllowance),
          approveAmount: local.approveAmount,
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });

        if (opts.dryRun) {
          const encoded = result.client.optionFactory.encodeRequestForQuotation(requestWithPk);
          // Truncate the hex calldata in table mode — see book fill --dry-run
          // for the rationale. JSON consumers still receive the full payload.
          render(
            { dryRun: true, request: { to: encoded.to, data: encoded.data, value: '0' } },
            { output: opts.output, noColor: !opts.color, truncate: true }
          );
          return;
        }

        const ok = await confirm('Submit RFQ on-chain?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const submittedAt = Math.floor(Date.now() / 1000);
        const receipt = await result.client.optionFactory.requestForQuotation(requestWithPk);
        const quotationId = extractQuotationIdFromReceipt(
          receipt.logs,
          result.client.optionFactory.contractAddress
        );
        const ethUsd = await fetchEthUsdSafe(result.client.api);
        render(
          buildTxReceiptPayload(
            receipt,
            ethUsd,
            quotationId !== undefined ? { quotationId } : undefined
          ),
          { output: opts.output, noColor: !opts.color }
        );
        if (quotationId !== undefined) {
          process.stderr.write(
            `\nRFQ ${quotationId} submitted. Watch offers: thetanuts rfq offers --id ${quotationId}\n` +
              `Cancel before deadline:           thetanuts rfq cancel --id ${quotationId}\n`
          );
        }
        // "Just wait" hint: skip under -o json (machine output should stay
        // clean) and the implicit --dry-run branch above already returned.
        // Printed to stderr so scripts piping stdout aren't polluted.
        if (opts.output !== 'json') {
          const tickerArg = loaded.ticker ?? '<ticker>';
          process.stderr.write(
            `\nTip: you don't need to manually call 'rfq accept' or 'rfq offers' — the protocol\n` +
              `auto-settles after the offer deadline (~45 seconds by default). Check fill status\n` +
              `later with:\n` +
              `  thetanuts rfq status --ticker ${tickerArg} --since ${submittedAt}\n` +
              `  thetanuts position list --source rfq\n` +
              `If you do want to lock in a specific maker early, see 'thetanuts rfq accept --help'.\n`
          );
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit === 0 ? 1 : exit);
      }
    });
}

// ----- rfq cancel ----------------------------------------------------------

function registerCancel(grp: Command): void {
  grp
    .command('cancel')
    .description('Cancel an RFQ the signer created (broadcasts cancelQuotation).')
    .requiredOption('--id <quotationId>', 'quotation ID to cancel')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ id: string }>();
      try {
        const result = getClient(opts);
        requireSigner(result);
        const id = parseBigIntStrict('--id', local.id);

        render(
          { action: 'cancelQuotation', quotationId: id.toString() },
          { output: opts.output, noColor: !opts.color }
        );

        if (opts.dryRun) {
          const encoded = result.client.optionFactory.encodeCancelQuotation(id);
          render(
            { dryRun: true, transaction: { to: encoded.to, data: encoded.data, value: '0' } },
            { output: opts.output, noColor: !opts.color, truncate: true }
          );
          return;
        }

        const ok = await confirm(`Cancel quotation ${id.toString()}?`, {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await result.client.optionFactory.cancelQuotation(id);
        const ethUsd = await fetchEthUsdSafe(result.client.api);
        render(
          buildTxReceiptPayload(receipt, ethUsd),
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}

// ----------------------------------------------------------------------------
// Shared helpers for `rfq offers` and `rfq accept` — read collateral metadata
// from a quotation, query raw OfferMade event args (signedOfferForRequester is
// non-indexed, so the SDK's typed helper doesn't expose it), and decrypt where
// the local keystore can.
// ----------------------------------------------------------------------------

interface RawOfferEvent {
  offeror: string;
  offerSignature: string;
  signingKey: string;
  signedOfferForRequester: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

interface DecodedOfferRow {
  offeror: string;
  signingKey: string;
  offerSignature: string;
  blockNumber: number;
  transactionHash: string;
  offerAmount?: string;
  offerAmountHuman?: string;
  nonce?: string;
  error?: string;
  /** New: status from indexer ('accepted' | 'rejected' | 'revealed' | 'pending' | 'encrypted'). Absent when sourced from logs only. */
  status?: string;
  /** New: source of the offerAmount value ('indexer' = revealedAmount field; 'decrypted' = local ECDH decrypt; 'logs' = legacy fallback). */
  amountSource?: 'indexer' | 'decrypted' | 'logs';
}

async function readQuotationCollateralDecimals(
  result: GetClientResult,
  id: bigint
): Promise<{ collateralAddress: string; decimals: number }> {
  const { client } = result;
  const quotation = await client.optionFactory.getQuotation(id);
  const collateralAddress = quotation.params.collateral;
  const decimals = Number(await client.erc20.getDecimals(collateralAddress));
  return { collateralAddress, decimals };
}

async function queryOfferMadeRaw(
  result: GetClientResult,
  id: bigint
): Promise<RawOfferEvent[]> {
  const { client } = result;
  const contract = new Contract(
    client.optionFactory.contractAddress,
    OPTION_FACTORY_ABI,
    client.provider
  );
  const filter = contract.filters['OfferMade']!(id);
  const logs = await contract.queryFilter(filter);
  const out: RawOfferEvent[] = [];
  for (const log of logs) {
    if (!('args' in log) || !log.args) continue;
    const args = log.args as unknown as {
      quotationId: bigint;
      offeror: string;
      offerSignature: string;
      signingKey: string;
      signedOfferForRequester: string;
    };
    out.push({
      offeror: args.offeror,
      offerSignature: args.offerSignature,
      signingKey: args.signingKey,
      signedOfferForRequester: args.signedOfferForRequester,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    });
  }
  return out;
}

/**
 * Fetch offers from the indexer's RFQ detail endpoint instead of scanning
 * eth_getLogs from genesis. The indexer already exposes:
 *   - offeror, signingKey, signature, signedOfferForRequester (the ECDH blob)
 *   - createdAt / createdTx / createdBlock
 *   - status: 'accepted' | 'rejected' | 'revealed' | 'pending'
 *   - revealedAmount: present for accepted/rejected/revealed offers (decrypted on-chain by the settle flow)
 *
 * For offers still in the unrevealed/pending state, we fall back to local
 * ECDH decrypt via client.rfqKeys.decryptOffer using signedOfferForRequester
 * — same path decodeOfferEvents() uses.
 *
 * Throws if the indexer call fails or the response is malformed; caller is
 * responsible for falling back to the on-chain log scan.
 */
async function fetchOffersFromIndexer(
  result: GetClientResult,
  id: bigint
): Promise<{ rows: DecodedOfferRow[]; collateral: string; decimals: number }> {
  const { client } = result;
  const rfq = await client.api.getRfq(id.toString());
  const collateralAddress = rfq.collateral;
  const decimals = Number(await client.erc20.getDecimals(collateralAddress));

  const offers = rfq.offers ?? {};
  const rows: DecodedOfferRow[] = [];
  for (const offer of Object.values(offers)) {
    const row: DecodedOfferRow = {
      offeror: offer.offeror,
      signingKey: offer.signingKey,
      offerSignature: offer.signature,
      blockNumber: offer.createdBlock,
      transactionHash: offer.createdTx,
      status: offer.status,
    };
    if (offer.revealedAmount !== undefined && offer.revealedAmount !== null && offer.revealedAmount !== '') {
      // Indexer already has the on-chain reveal — no local decrypt needed.
      try {
        const amount = BigInt(offer.revealedAmount);
        row.offerAmount = amount.toString();
        row.offerAmountHuman = client.utils.fromBigInt(amount, decimals);
        row.amountSource = 'indexer';
      } catch (err) {
        row.error = `bad revealedAmount: ${(err as Error).message ?? String(err)}`;
      }
    } else if (offer.signedOfferForRequester) {
      // Unrevealed — attempt local ECDH decrypt with the requester's keystore.
      try {
        const decrypted = await client.rfqKeys.decryptOffer(
          offer.signedOfferForRequester,
          offer.signingKey
        );
        row.offerAmount = decrypted.offerAmount.toString();
        row.offerAmountHuman = client.utils.fromBigInt(decrypted.offerAmount, decimals);
        row.nonce = decrypted.nonce.toString();
        row.amountSource = 'decrypted';
        // Mark unrevealed offers that we could open locally as 'encrypted' if
        // the indexer didn't already tag them (e.g. null/unknown status).
        if (!row.status) row.status = 'encrypted';
      } catch (err) {
        row.error = (err as Error).message?.split('\n')[0] ?? 'decryption failed';
      }
    } else {
      row.error = 'no revealedAmount and no encrypted blob';
    }
    rows.push(row);
  }
  // Sort by createdBlock asc (stable, matches the on-chain log order).
  rows.sort((a, b) => a.blockNumber - b.blockNumber);
  return { rows, collateral: collateralAddress, decimals };
}

async function decodeOfferEvents(
  result: GetClientResult,
  id: bigint,
  collateralDecimals: number
): Promise<DecodedOfferRow[]> {
  const { client } = result;
  const raws = await queryOfferMadeRaw(result, id);
  const out: DecodedOfferRow[] = [];
  for (const r of raws) {
    const row: DecodedOfferRow = {
      offeror: r.offeror,
      signingKey: r.signingKey,
      offerSignature: r.offerSignature,
      blockNumber: r.blockNumber,
      transactionHash: r.transactionHash,
    };
    try {
      const decrypted = await client.rfqKeys.decryptOffer(
        r.signedOfferForRequester,
        r.signingKey
      );
      row.offerAmount = decrypted.offerAmount.toString();
      row.offerAmountHuman = client.utils.fromBigInt(decrypted.offerAmount, collateralDecimals);
      row.nonce = decrypted.nonce.toString();
    } catch (err) {
      row.error = (err as Error).message?.split('\n')[0] ?? 'decryption failed';
    }
    out.push(row);
  }
  return out;
}

// ----- rfq offers ----------------------------------------------------------

function registerOffers(grp: Command): void {
  grp
    .command('offers')
    .description(
      'REQUESTER: list every offer submitted to an RFQ. Reads from the indexer ' +
        '(includes status + revealedAmount for accepted/rejected/revealed offers); ' +
        'falls back to local ECDH decrypt for still-encrypted offers, and to an ' +
        'on-chain OfferMade log scan if the indexer is unreachable. ' +
        'Marks undecryptable rows so you can spot key-mismatch / wrong-chain offers.'
    )
    .requiredOption('--id <quotationId>', 'quotation ID')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ id: string }>();
      try {
        const result = getClient(opts);
        const { client } = result;
        const id = parseBigIntStrict('--id', local.id);

        let rows: DecodedOfferRow[] | undefined;

        // ----- Primary path: indexer detail endpoint -----
        // The indexer has revealedAmount for accepted/rejected/revealed
        // offers, and the encrypted blob for unrevealed ones, so we can
        // serve the full set without scanning eth_getLogs from genesis.
        try {
          const fromIndexer = await fetchOffersFromIndexer(result, id);
          rows = fromIndexer.rows;

          // If any unrevealed offer is present, we'll need the local keystore
          // to decrypt it. fetchOffersFromIndexer attempts decryptOffer for
          // those — surface a hint if it failed because no keystore exists.
          const needsKey = rows.some((r) => !r.offerAmount && r.error && !r.amountSource);
          if (needsKey) {
            const hasKey = await client.rfqKeys.hasStoredKey();
            if (!hasKey) {
              process.stderr.write(
                `Note: some offers are still encrypted and need your local RFQ keystore to decrypt. ` +
                  `Run \`thetanuts keys ensure\` (or \`thetanuts keys import --in <file>\`) for chain ${result.chainId} to reveal them.\n`
              );
            }
          }
        } catch (indexerErr) {
          const msg = (indexerErr as Error).message ?? String(indexerErr);
          // Pass through clean not-found errors from the indexer directly.
          if (/not found|404/i.test(msg)) {
            const wrapped = new Error(
              `RFQ ${id.toString()} not found at the indexer. Check the quotation ID and the chain (current: ${result.chainId}).`
            );
            (wrapped as Error & { exitCode?: number }).exitCode = 4;
            throw wrapped;
          }
          // Otherwise log and fall back to the on-chain log scan below.
          process.stderr.write(
            `Indexer offers fetch failed (${msg.split('\n')[0]}); falling back to on-chain OfferMade log scan...\n`
          );
        }

        // ----- Fallback path: eth_getLogs OfferMade scan -----
        if (!rows) {
          const hasKey = await client.rfqKeys.hasStoredKey();
          if (!hasKey) {
            const err = new Error(
              `Indexer fetch failed and no RFQ keystore for chain ${result.chainId} to decrypt log-sourced offers. ` +
                `Run \`thetanuts keys ensure\` first, or restore from backup with \`thetanuts keys import --in <file>\`.`
            );
            (err as Error & { exitCode?: number }).exitCode = 6;
            throw err;
          }
          const { decimals } = await readQuotationCollateralDecimals(result, id);
          try {
            rows = await decodeOfferEvents(result, id, decimals);
            for (const r of rows) {
              if (r.offerAmount && !r.amountSource) r.amountSource = 'logs';
            }
          } catch (logsErr) {
            // Catch the common "eth_getLogs range too wide" failure from
            // public RPC tier-1 limits. Re-emit with an actionable message
            // rather than leaking ethers' coalesced error string.
            const msg = (logsErr as Error).message ?? String(logsErr);
            if (/eth_getLogs|getLogs|10,?000 range|block range|10000 block/i.test(msg)) {
              const wrapped = new Error(
                `Could not query OfferMade logs — indexer was unavailable and your RPC limits eth_getLogs block range.\n` +
                  `Workarounds:\n` +
                  `  • You can skip watching offers entirely. RFQs auto-settle when the deadline expires — anyone can call\n` +
                  `      thetanuts rfq settle --id <ID>\n` +
                  `    after offerEndTimestamp. If a maker quoted at or below your reserve-price, you'll get the option; otherwise your escrow is refunded.\n` +
                  `  • Retry — the indexer may be transiently down.\n` +
                  `  • Set THETANUTS_RPC_URL to a tier-1 provider (Alchemy / Infura / QuickNode / dRPC) and retry.\n` +
                  `  • Pass --rpc-url <url> on the same command.\n` +
                  `Original RPC error: ${msg.split('\n')[0]}`
              );
              (wrapped as Error & { exitCode?: number }).exitCode = 1;
              throw wrapped;
            }
            throw logsErr;
          }
        }

        if (rows.length === 0) {
          render(
            { quotationId: id.toString(), offers: [] },
            { output: opts.output, noColor: !opts.color }
          );
          process.stderr.write(`No offers found for quotation ${id.toString()} on chain ${result.chainId}.\n`);
          return;
        }
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit === 0 ? 1 : exit);
      }
    });
}

// ----- rfq accept ----------------------------------------------------------

function registerAccept(grp: Command): void {
  grp
    .command('accept')
    .description(
      'REQUESTER: accept an offer (broadcasts settleQuotationEarly). ' +
        'By default, fetches the offer from the indexer for --offeror and decrypts ' +
        'signedOfferForRequester locally to recover offerAmount + nonce ' +
        '(falls back to an on-chain OfferMade log scan if the indexer is unreachable). ' +
        'Use --offer-amount + --nonce to skip the decrypt step entirely.'
    )
    .requiredOption('--id <quotationId>', 'quotation ID')
    .requiredOption('--offeror <addr>', 'address of the offeror you want to accept')
    .option('--offer-amount <bigint>', 'raw offer amount in collateral units (skip decryption)')
    .option('--nonce <bigint>', 'nonce (skip decryption)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        id: string;
        offeror: string;
        offerAmount?: string;
        nonce?: string;
      }>();
      try {
        if (!ADDRESS_REGEX.test(local.offeror)) {
          throw new Error('--offeror must be a 0x-prefixed 40-char hex address');
        }
        const result = getClient(opts);
        requireSigner(result);
        const { client } = result;
        const id = parseBigIntStrict('--id', local.id);

        let offerAmount: bigint;
        let nonce: bigint;
        let source: 'decrypted' | 'flags' | 'decrypted-logs';

        if (local.offerAmount !== undefined && local.nonce !== undefined) {
          offerAmount = parseBigIntStrict('--offer-amount', local.offerAmount);
          nonce = parseBigIntStrict('--nonce', local.nonce);
          source = 'flags';
        } else {
          const hasKey = await client.rfqKeys.hasStoredKey();
          if (!hasKey) {
            const err = new Error(
              `No RFQ keystore for chain ${result.chainId}. Either pass --offer-amount + --nonce, ` +
                'or run `thetanuts keys ensure` (will only work if you originally requested this RFQ with the current keystore).'
            );
            (err as Error & { exitCode?: number }).exitCode = 6;
            throw err;
          }

          // ----- Primary path: indexer RFQ detail endpoint -----
          // Avoids eth_getLogs from genesis (public Base RPC caps the range at
          // 10k blocks). Same shape as `rfq offers`: rfq.offers[offeror] has
          // signedOfferForRequester + signingKey for local ECDH decrypt.
          interface SettleSource {
            signedOfferForRequester: string;
            signingKey: string;
          }
          let settleSource: SettleSource | undefined;
          let usedFallback = false;

          try {
            const rfq = await client.api.getRfq(id.toString());
            const offers = rfq.offers ?? {};
            // Indexer keys offers by offeror address; try exact + case-insensitive match.
            const target = local.offeror.toLowerCase();
            const match = Object.values(offers).find(
              (o) => o.offeror?.toLowerCase() === target
            );
            if (!match) {
              const err = new Error(
                `No offer from ${local.offeror} on RFQ ${id.toString()}. ` +
                  'Run `thetanuts rfq offers --id <id>` to inspect available offers.'
              );
              (err as Error & { exitCode?: number }).exitCode = 4;
              throw err;
            }
            if (!match.signedOfferForRequester || !match.signingKey) {
              const err = new Error(
                `Indexer record for offer from ${local.offeror} on RFQ ${id.toString()} is missing ` +
                  'signedOfferForRequester / signingKey. Cannot decrypt — pass --offer-amount + --nonce manually.'
              );
              (err as Error & { exitCode?: number }).exitCode = 4;
              throw err;
            }
            settleSource = {
              signedOfferForRequester: match.signedOfferForRequester,
              signingKey: match.signingKey,
            };
          } catch (indexerErr) {
            // Don't fall back for our own structured exits (not-found, malformed).
            const exitCode = (indexerErr as { exitCode?: number }).exitCode;
            if (exitCode === 4) throw indexerErr;
            const msg = (indexerErr as Error).message ?? String(indexerErr);
            // Clean 404 from the indexer == RFQ doesn't exist there. Surface as exit 4.
            if (/not found|404/i.test(msg)) {
              const err = new Error(
                `RFQ ${id.toString()} not found at the indexer. Check the quotation ID and the chain (current: ${result.chainId}).`
              );
              (err as Error & { exitCode?: number }).exitCode = 4;
              throw err;
            }
            // Otherwise log and fall back to the on-chain OfferMade log scan.
            process.stderr.write(
              `Indexer offer fetch failed (${msg.split('\n')[0]}); falling back to on-chain OfferMade log scan...\n`
            );
            const raws = await queryOfferMadeRaw(result, id);
            const match = raws.find((r) => r.offeror.toLowerCase() === local.offeror.toLowerCase());
            if (!match) {
              const err = new Error(
                `No OfferMade event found from offeror ${local.offeror} for quotation ${id.toString()}. ` +
                  'Run `thetanuts rfq offers --id <id>` to inspect available offers.'
              );
              (err as Error & { exitCode?: number }).exitCode = 4;
              throw err;
            }
            settleSource = {
              signedOfferForRequester: match.signedOfferForRequester,
              signingKey: match.signingKey,
            };
            usedFallback = true;
          }

          try {
            const decrypted = await client.rfqKeys.decryptOffer(
              settleSource.signedOfferForRequester,
              settleSource.signingKey
            );
            offerAmount = decrypted.offerAmount;
            nonce = decrypted.nonce;
            source = usedFallback ? 'decrypted-logs' : 'decrypted';
          } catch (err) {
            const e = new Error(
              `RFQ_KEY_MISMATCH: Decryption failed for offer from ${local.offeror}. ` +
                `Either the key for chain ${result.chainId} was changed/removed, or this offer is not addressed to you. ` +
                `Underlying error: ${(err as Error).message ?? String(err)}`
            );
            (e as Error & { exitCode?: number }).exitCode = 6;
            throw e;
          }
        }

        const { collateralAddress, decimals } = await readQuotationCollateralDecimals(result, id);
        const preview = {
          action: 'settleQuotationEarly',
          quotationId: id.toString(),
          offeror: local.offeror,
          offerAmount: offerAmount.toString(),
          offerAmountHuman: client.utils.fromBigInt(offerAmount, decimals),
          collateral: collateralAddress,
          nonce: nonce.toString(),
          source,
        };
        render(preview, { output: opts.output, noColor: !opts.color });

        if (opts.dryRun) {
          const encoded = client.optionFactory.encodeSettleQuotationEarly(id, offerAmount, nonce, local.offeror);
          render(
            { dryRun: true, transaction: { to: encoded.to, data: encoded.data, value: '0' } },
            { output: opts.output, noColor: !opts.color, truncate: true }
          );
          return;
        }

        const ok = await confirm('Accept this offer and broadcast settleQuotationEarly?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.optionFactory.settleQuotationEarly(id, offerAmount, nonce, local.offeror);
        const ethUsd = await fetchEthUsdSafe(client.api);
        render(
          buildTxReceiptPayload(receipt, ethUsd),
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        const exit = (err as { exitCode?: number }).exitCode ?? 1;
        process.exit(exit === 0 ? 1 : exit);
      }
    });
}

// ============================================================================
// Settle + status
// ============================================================================

// ----- rfq settle ---------------------------------------------------------

function registerSettle(grp: Command): void {
  grp
    .command('settle')
    .description(
      'Post-reveal settle of an RFQ (broadcasts settleQuotation). ' +
        'Anyone can call this once the reveal window has closed — the contract determines the winner from on-chain reveals.'
    )
    .requiredOption('--id <quotationId>', 'quotation ID to settle')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ id: string }>();
      try {
        const result = getClient(opts);
        requireSigner(result);
        const id = parseBigIntStrict('--id', local.id);

        render(
          { action: 'settleQuotation', quotationId: id.toString() },
          { output: opts.output, noColor: !opts.color }
        );

        if (opts.dryRun) {
          const encoded = result.client.optionFactory.encodeSettleQuotation(id);
          render(
            { dryRun: true, transaction: { to: encoded.to, data: encoded.data, value: '0' } },
            { output: opts.output, noColor: !opts.color, truncate: true }
          );
          return;
        }

        const ok = await confirm(`Settle quotation ${id.toString()}?`, {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await result.client.optionFactory.settleQuotation(id);
        const ethUsd = await fetchEthUsdSafe(result.client.api);
        render(
          buildTxReceiptPayload(receipt, ethUsd),
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}

// ----- rfq status ---------------------------------------------------------
//
// Queries the indexer for the signer's positions and looks for one matching --ticker created after
// --since. Useful after `rfq request` to detect whether a maker filled it

interface IndexerPositionShape {
  id?: string;
  optionAddress?: string;
  side?: string;
  status?: string;
  amount?: bigint | string | number | null;
  collateralSymbol?: string;
  option?: {
    underlying?: string;
    optionType?: number;
    strikes?: Array<bigint | string | number>;
    expiry?: number;
  };
}

interface NormalizedPosition {
  id?: string;
  optionAddress?: string;
  underlying?: string;
  type: 'PUT' | 'CALL' | 'UNKNOWN';
  strikes: number[];
  expiry: number;
  expiryDate: string | null;
  contracts: number | null;
  side: string;
  status?: string;
  collateral?: string;
  ticker: string;
}

function toNumberLoose(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Shape returned by /api/v1/factory/user/<addr>/positions — RFQ-source positions
// (auto-settled or manually-settled RFQs). Fields are flat (not nested under
// `option`) and use raw on-chain types. Mirrors the shape position.ts consumes
// from the same endpoint.
interface RfqOptionPositionShape {
  address?: string;
  buyer?: string;
  seller?: string;
  numContracts?: string | number | bigint;
  collateralDecimals?: number;
  collateralSymbol?: string;
  underlyingAsset?: string;
  strikes?: Array<string | number | bigint>;
  expiry?: number;
  expiryTimestamp?: number;
  optionType?: number | string;
  optionStatus?: string;
  [k: string]: unknown;
}

function normalizeRfqOptionPosition(raw: RfqOptionPositionShape): NormalizedPosition {
  const strikes = (raw.strikes ?? []).map((s) => {
    const n = toNumberLoose(s);
    return n !== null ? n / 1e8 : 0;
  });
  const optTypeNum = typeof raw.optionType === 'string' ? Number.parseInt(raw.optionType, 10) : raw.optionType;
  const type: 'PUT' | 'CALL' | 'UNKNOWN' = optTypeNum === 0 ? 'PUT' : optTypeNum === 1 ? 'CALL' : 'UNKNOWN';
  const expiry = raw.expiry ?? raw.expiryTimestamp ?? 0;
  const decimals = raw.collateralDecimals ?? 6;
  const contractsRaw = toNumberLoose(raw.numContracts);
  const contracts = contractsRaw !== null ? contractsRaw / 10 ** decimals : null;
  const underlying = raw.underlyingAsset;
  const ticker = underlying && expiry > 0 && type !== 'UNKNOWN'
    ? formatTicker(underlying, expiry, strikes, type)
    : 'UNKNOWN';
  // RFQ id from /factory carries -buyer/-seller suffix; match position.ts behavior.
  const side = raw.buyer ? 'BUYER' : raw.seller ? 'SELLER' : 'UNKNOWN';
  return {
    id: raw.address,
    optionAddress: raw.address,
    underlying,
    type,
    strikes,
    expiry,
    expiryDate: expiry > 0 ? new Date(expiry * 1000).toISOString() : null,
    contracts,
    side,
    status: raw.optionStatus,
    collateral: raw.collateralSymbol,
    ticker,
  };
}

function normalizeIndexerPosition(raw: IndexerPositionShape): NormalizedPosition {
  const opt = raw.option ?? {};
  const strikes = (opt.strikes ?? []).map((s) => {
    const n = toNumberLoose(s);
    return n !== null ? n / 1e8 : 0;
  });
  const type: 'PUT' | 'CALL' | 'UNKNOWN' = opt.optionType === 0 ? 'PUT' : opt.optionType === 1 ? 'CALL' : 'UNKNOWN';
  const expiry = opt.expiry ?? 0;
  const contractsRaw = toNumberLoose(raw.amount);
  const contracts = contractsRaw !== null ? contractsRaw / 1e18 : null;
  const ticker = opt.underlying && expiry > 0 && type !== 'UNKNOWN'
    ? formatTicker(opt.underlying, expiry, strikes, type)
    : 'UNKNOWN';
  return {
    id: raw.id,
    optionAddress: raw.optionAddress,
    underlying: opt.underlying,
    type,
    strikes,
    expiry,
    expiryDate: expiry > 0 ? new Date(expiry * 1000).toISOString() : null,
    contracts,
    side: raw.side?.toUpperCase() ?? 'UNKNOWN',
    status: raw.status,
    collateral: raw.collateralSymbol,
    ticker,
  };
}

function registerStatus(grp: Command): void {
  grp
    .command('status')
    .description(
      'Check whether an RFQ was filled. Queries the indexer for positions ' +
        'matching the given ticker. Port of OpenClaw scripts/check-rfq-fill.ts.'
    )
    .requiredOption('--ticker <ticker>', 'expected ticker, e.g. ETH-29MAR26-1900-P (or multi-strike: ETH-29MAR26-1900/1800-P)')
    .requiredOption('--since <ts>', 'unix timestamp of the original RFQ request (for messaging only — indexer may not expose exact creation times)')
    .option('--address <addr>', 'wallet address (defaults to signer)')
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ ticker: string; since: string; address?: string }>();
      try {
        const result = getClient(opts);
        const { client } = result;
        const since = parseUnsignedInt('--since', local.since);

        let address: string;
        if (local.address) {
          if (!ADDRESS_REGEX.test(local.address)) {
            throw new Error('--address must be a 0x-prefixed 40-char hex address');
          }
          address = local.address;
        } else if (result.hasSigner) {
          address = await client.getSignerAddress();
        } else {
          throw new Error('Pass --address or configure a signer (no default address available)');
        }

        const targetTicker = local.ticker.toUpperCase();
        // Query both indexer sources in parallel — book-side (getUserPositionsFromIndexer)
        // AND RFQ-side (getUserOptionsFromRfq). A position minted by an RFQ auto-settle
        // shows up only in the RFQ source; without this merge, rfq status reports
        // "not filled" even when position list clearly shows the new position.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [bookRaws, rfqRaws] = (await Promise.all([
          client.api.getUserPositionsFromIndexer(address).catch(() => [] as unknown[]),
          client.api.getUserOptionsFromRfq(address).catch(() => [] as unknown[]),
        ])) as [unknown[], unknown[]];
        const bookNormalized = (Array.isArray(bookRaws) ? bookRaws : []).map((r) =>
          normalizeIndexerPosition(r as IndexerPositionShape)
        );
        const rfqNormalized = (Array.isArray(rfqRaws) ? rfqRaws : []).map((r) =>
          normalizeRfqOptionPosition(r as RfqOptionPositionShape)
        );
        const merged = [...bookNormalized, ...rfqNormalized].filter((p) => p.ticker !== 'UNKNOWN');
        const match = merged.find((p) => p.ticker.toUpperCase() === targetTicker);

        const payload: Record<string, unknown> = {
          filled: Boolean(match),
          checkParams: {
            address,
            ticker: targetTicker,
            since,
            sinceDate: new Date(since * 1000).toISOString(),
          },
        };

        if (match) {
          payload.position = match;
          payload.message = `RFQ filled. Position ${match.ticker} with ${match.contracts?.toFixed(6) ?? '?'} contracts (${match.side}).`;
        } else {
          payload.message = 'No fill detected — no position matching the ticker yet.';
          payload.suggestions = [
            'Re-run after the offer deadline + reveal window has closed',
            'Verify the ticker exactly matches the RFQ (case-insensitive)',
            'Check `rfq offers --id <quotationId>` to see whether any maker bid',
            'Inspect orderbook fill alternatives via `book check`',
          ];
        }

        render(payload, { output: opts.output, noColor: !opts.color });
        if (!match) process.exit(1);
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
