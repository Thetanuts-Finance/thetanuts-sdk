import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { Contract, MaxUint256 } from 'ethers';
import { OPTION_FACTORY_ABI } from '@thetanuts-finance/thetanuts-client';
import type { QuotationParameters, RFQRequest } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { jsonReplacer, render, renderError } from '../output.js';
import { confirm } from '../confirm.js';

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
 *   single-strike CALL  → WETH (INVERSE_CALL / PHYSICAL_CALL)
 *   everything else     → USDC
 *
 * Iron condors fall under "everything else" (USDC); CLI multi-strike CALLs
 * also default to USDC even though the contract accepts WETH. The user can
 * override with --collateral-token explicitly
 */
function defaultCollateral(type: OptionType, strikeCount: number): 'USDC' | 'WETH' {
  return type === 'CALL' && strikeCount === 1 ? 'WETH' : 'USDC';
}

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

async function resolveRequester(opts: ReturnType<typeof getGlobalOpts>, result: GetClientResult, explicit?: string): Promise<string> {
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
  const contractsNum = Number.parseFloat(local.contracts ?? '');
  if (!Number.isFinite(contractsNum) || contractsNum <= 0) {
    throw new Error(`--contracts must be a positive number (got "${local.contracts}")`);
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
  const collateralToken =
    (local.collateralToken?.toUpperCase() as 'USDC' | 'WETH' | undefined) ??
    defaultCollateral(type as OptionType, strikes.length);
  if (!['USDC', 'WETH'].includes(collateralToken)) {
    throw new Error('--collateral-token must be USDC or WETH');
  }

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
    ...(reservePrice !== undefined ? { reservePrice } : {}),
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
  const requireContracts = allFlagsOptional ? cmd.option.bind(cmd) : cmd.requiredOption.bind(cmd);
  const requireDirection = allFlagsOptional ? cmd.option.bind(cmd) : cmd.requiredOption.bind(cmd);

  requireUnderlying('--underlying <asset>', 'ETH or BTC');
  requireType('--type <type>', 'PUT or CALL');
  cmd.option('--strike <n>', 'single strike (vanilla only)');
  cmd.option('--strikes <csv>', 'comma-separated strikes (2-4 values for spread/butterfly/condor)');
  requireExpiry('--expiry <ts>', 'unix expiry timestamp');
  requireContracts('--contracts <n>', 'contract count (human-readable)');
  requireDirection('--direction <buy|sell>', 'buy = long position, sell = short position');
  return cmd

    .option(
      '--collateral-token <USDC|WETH>',
      'override the collateral default (single-strike CALL → WETH, everything else → USDC)'
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
  registerViews(grp);
  registerRequest(grp);
  registerCancel(grp);
  registerOffers(grp);
  registerAccept(grp);
  registerSettle(grp);
  registerStatus(grp);
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
    .action(async (_local: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts() as Record<string, string | undefined>;
      try {
        const result = getClient(opts);
        const built = await buildFromFlags(result, local, opts);
        const encoded = result.client.optionFactory.encodeRequestForQuotation(built.rfqRequest);

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

        render(payload, { output: opts.output, noColor: !opts.color });
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
        render(quotation, { output: opts.output, noColor: !opts.color });
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
 * Soft allowance advisory for SHORT (sell) RFQs. At REQUEST time the
 * OptionFactory does not pull collateral, but the contract WILL draw it at
 * settle. We surface that on stderr now so a SHORT user knows to approve
 * before settle — without blocking the request itself
 *
 * If `--ensure-allowance` is passed, confirm
 * prompt for the approval, then `ensureAllowance(MaxUint256)` (or the user's
 * `--approve-amount`)
 */
async function maybeEnsureCollateralAllowance(
  result: GetClientResult,
  req: RFQRequest,
  flags: { ensureAllowance?: boolean; approveAmount?: string; yes?: boolean; dryRun?: boolean }
): Promise<{ approveEncoded: { to: string; data: string } | null }> {
  if (req.params.isRequestingLongPosition) {
    return { approveEncoded: null };
  }
  const { client } = result;
  const signerAddr = await client.getSignerAddress();
  const spender = client.optionFactory.contractAddress;
  const current = await client.erc20.getAllowance(req.params.collateral, signerAddr, spender);

  // Compute target allowance amount
  let target: bigint;
  let isMax = false;
  if (flags.approveAmount === undefined || flags.approveAmount === 'max') {
    target = MaxUint256;
    isMax = true;
  } else {
    const decimals = Number(await client.erc20.getDecimals(req.params.collateral));
    target = client.utils.toBigInt(flags.approveAmount, decimals);
  }

  if (flags.dryRun) {
    if (current >= target) return { approveEncoded: null };
    const encoded = client.erc20.encodeApprove(req.params.collateral, spender, target);
    return { approveEncoded: { to: encoded.to, data: encoded.data } };
  }

  if (current >= target) {
    if (!flags.ensureAllowance) {
      // No-op path, but a one-liner advisory so SHORT users know we checked
      process.stderr.write(
        `Allowance for ${req.params.collateral} → ${spender} is already ${current.toString()} (sufficient).\n`
      );
    }
    return { approveEncoded: null };
  }

  // Insufficient allowance.
  if (!flags.ensureAllowance) {
    process.stderr.write(
      `⚠ SHORT RFQ: current allowance on ${req.params.collateral} → ${spender} is ${current.toString()}, ` +
        'which may be insufficient when the contract draws collateral at settle.\n' +
        '  Pass --ensure-allowance to approve before submitting, or run\n' +
        `  thetanuts wallet ensure-allowance --token <SYM> --spender ${spender} --amount max\n`
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
          render(
            { dryRun: true, request: { to: encoded.to, data: encoded.data, value: '0' } },
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }

        const ok = await confirm('Submit RFQ on-chain?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await result.client.optionFactory.requestForQuotation(requestWithPk);
        render(
          {
            txHash: receipt.hash,
            status: receipt.status === 1 ? 'success' : 'failed',
            blockNumber: receipt.blockNumber,
          },
          { output: opts.output, noColor: !opts.color }
        );
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
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }

        const ok = await confirm(`Cancel quotation ${id.toString()}?`, {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await result.client.optionFactory.cancelQuotation(id);
        render(
          {
            txHash: receipt.hash,
            status: receipt.status === 1 ? 'success' : 'failed',
            blockNumber: receipt.blockNumber,
          },
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
      'REQUESTER: list every offer submitted to an RFQ from the OfferMade log, ' +
        'with decrypted amounts where the local keystore can open them. ' +
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

        const hasKey = await client.rfqKeys.hasStoredKey();
        if (!hasKey) {
          const err = new Error(
            `No RFQ keystore for chain ${result.chainId}. Run \`thetanuts keys generate\` first, ` +
              'or restore from backup with `thetanuts keys import --in <file>`.'
          );
          (err as Error & { exitCode?: number }).exitCode = 6;
          throw err;
        }

        const { decimals } = await readQuotationCollateralDecimals(result, id);
        const rows = await decodeOfferEvents(result, id, decimals);
        if (rows.length === 0) {
          render(
            { quotationId: id.toString(), offers: [] },
            { output: opts.output, noColor: !opts.color }
          );
          process.stderr.write(`No OfferMade events found for quotation ${id.toString()} on chain ${result.chainId}.\n`);
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
        'By default, decrypts the OfferMade event for --offeror to recover offerAmount + nonce. ' +
        'Use --offer-amount + --nonce to skip the decrypt step.'
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
        let source: 'decrypted' | 'flags';

        if (local.offerAmount !== undefined && local.nonce !== undefined) {
          offerAmount = parseBigIntStrict('--offer-amount', local.offerAmount);
          nonce = parseBigIntStrict('--nonce', local.nonce);
          source = 'flags';
        } else {
          const hasKey = await client.rfqKeys.hasStoredKey();
          if (!hasKey) {
            const err = new Error(
              `No RFQ keystore for chain ${result.chainId}. Either pass --offer-amount + --nonce, ` +
                'or run `thetanuts keys generate` (will only work if you originally requested this RFQ with the current keystore).'
            );
            (err as Error & { exitCode?: number }).exitCode = 6;
            throw err;
          }

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
          try {
            const decrypted = await client.rfqKeys.decryptOffer(match.signedOfferForRequester, match.signingKey);
            offerAmount = decrypted.offerAmount;
            nonce = decrypted.nonce;
            source = 'decrypted';
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
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }

        const ok = await confirm('Accept this offer and broadcast settleQuotationEarly?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.optionFactory.settleQuotationEarly(id, offerAmount, nonce, local.offeror);
        render(
          {
            txHash: receipt.hash,
            status: receipt.status === 1 ? 'success' : 'failed',
            blockNumber: receipt.blockNumber,
          },
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
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }

        const ok = await confirm(`Settle quotation ${id.toString()}?`, {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await result.client.optionFactory.settleQuotation(id);
        render(
          {
            txHash: receipt.hash,
            status: receipt.status === 1 ? 'success' : 'failed',
            blockNumber: receipt.blockNumber,
          },
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raws = (await client.api.getUserPositionsFromIndexer(address)) as any[];
        const normalized = (Array.isArray(raws) ? raws : []).map((r) => normalizeIndexerPosition(r as IndexerPositionShape));
        const match = normalized.find((p) => p.ticker.toUpperCase() === targetTicker);

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
