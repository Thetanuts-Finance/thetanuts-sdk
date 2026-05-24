#!/usr/bin/env npx tsx
/**
 * ABI parity verifier (TNU-8 W6 invariant 7 + 8).
 *
 * Compares each inline TS ABI in src/abis/ against the canonical JSON ABI at
 * /Users/eesheng_eth/Desktop/thetaverse/abis/<Contract>.json.
 *
 * Invariant: every function / event / error fragment present in the SDK ABI
 * must have a matching canonical fragment with identical name, inputs, outputs,
 * and stateMutability. Extra fragments in the canonical (admin-only callbacks,
 * internal notify* / handle* hooks) are allowed — the SDK is a curated subset.
 *
 * Additional checks:
 *   - SDK must NOT expose admin-only entrypoints (deny-list).
 *   - All `*_FLY` implementation keys/names must use the FLY form, not FLYS.
 *
 * Exits non-zero on drift so this can run in CI.
 */
import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const CANONICAL_DIR = '/Users/eesheng/Desktop/thetaverse/abis'.replace(
  '/eesheng/',
  '/eesheng_eth/'
);

interface AbiFragment {
  type: string;
  name?: string;
  inputs?: any[];
  outputs?: any[];
  stateMutability?: string;
  anonymous?: boolean;
}

const ADMIN_ONLY_DENYLIST = new Set([
  // OptionFactory admin
  'setBaseSplitFee',
  'setMaxRfqValue',
  'deprecateFactory',
  // BaseOption internal callbacks
  'notifyCreationComplete',
  'notifyTradeSettled',
  'executeCollateralReclaim',
  'handleSettlement',
  'handleSettlementComplete',
  // OptionBook admin
  'setMinimumThresholds',
  // LoanCoordinator admin (already excluded by convention but enforce)
  'setAssetConfig',
  'removeAssetConfig',
  'setFee',
  'rescueToken',
  'renounceOwnership',
  'acceptOwnership',
]);

interface ParityCheck {
  /** Filename of canonical JSON (e.g. OptionBook.json) */
  canonical: string;
  /** SDK source path relative to repo root */
  sdkPath: string;
  /** Exported symbol name inside the SDK ABI file */
  sdkSymbol: string;
  /** SDK ABI uses literal array (true) or ethers human-readable strings (false) */
  isLiteralArray: boolean;
}

const CHECKS: ParityCheck[] = [
  { canonical: 'OptionFactory.json', sdkPath: 'src/abis/optionFactory.ts', sdkSymbol: 'OPTION_FACTORY_ABI', isLiteralArray: true },
  { canonical: 'OptionBook.json', sdkPath: 'src/abis/optionBook.ts', sdkSymbol: 'OPTION_BOOK_ABI', isLiteralArray: true },
  { canonical: 'BaseOption.json', sdkPath: 'src/abis/option.ts', sdkSymbol: 'BASE_OPTION_ABI', isLiteralArray: true },
  { canonical: 'RangerOption.json', sdkPath: 'src/abis/ranger.ts', sdkSymbol: 'RANGER_OPTION_ABI', isLiteralArray: true },
  // Loan ABIs are human-readable string form — extract via ethers Interface.format(json)
  { canonical: 'PhysicallySettledCallOptionLoanCoordinator.json', sdkPath: 'src/abis/loan.ts', sdkSymbol: 'LOAN_COORDINATOR_ABI', isLiteralArray: false },
  { canonical: 'PhysicallySettledCallOptionLoanHandler.json', sdkPath: 'src/abis/loan.ts', sdkSymbol: 'LOAN_HANDLER_ABI', isLiteralArray: false },
  { canonical: 'PhysicallySettledCallOption.json', sdkPath: 'src/abis/loan.ts', sdkSymbol: 'LOAN_OPTION_ABI', isLiteralArray: false },
];

interface Violation {
  check: ParityCheck;
  severity: 'high' | 'medium' | 'low';
  kind: 'missing-in-canonical' | 'signature-mismatch' | 'admin-leak' | 'fly-naming';
  fragment: string;
  detail: string;
}

const violations: Violation[] = [];

/**
 * Normalize an ABI fragment to a comparable canonical signature string.
 * Uses ethers' Interface formatting to handle struct flattening / internalType
 * differences between source and Foundry artifacts.
 */
function fragmentSignature(frag: AbiFragment): string {
  try {
    const iface = new ethers.Interface([frag as any]);
    const fmt = iface.format('full');
    if (Array.isArray(fmt) && fmt.length > 0) return fmt[0].trim();
    return JSON.stringify(frag);
  } catch {
    return JSON.stringify(frag);
  }
}

function fragmentKey(frag: AbiFragment): string {
  // Identity = type + name + input arity (so we can locate the canonical entry
  // even when stateMutability or struct internalType differs).
  const inputArity = Array.isArray(frag.inputs) ? frag.inputs.length : 0;
  const name = frag.name ?? '<unnamed>';
  return `${frag.type}:${name}:${inputArity}`;
}

async function extractSdkAbi(check: ParityCheck): Promise<AbiFragment[]> {
  const sdkAbs = resolve(REPO_ROOT, check.sdkPath);
  // Lazy import the SDK ABI source via tsx
  const mod = await import(sdkAbs);
  const raw = mod[check.sdkSymbol];
  if (!raw) throw new Error(`SDK symbol ${check.sdkSymbol} not found in ${check.sdkPath}`);

  if (check.isLiteralArray) {
    return raw as AbiFragment[];
  }
  // Human-readable string array — reflate via ethers Interface, then extract fragments.
  const iface = new ethers.Interface(raw as string[]);
  // ethers v6: iface.fragments is a readonly array of Fragment objects; convert to plain objects.
  return iface.fragments.map((f) => JSON.parse(f.format('json'))) as AbiFragment[];
}

function loadCanonicalAbi(filename: string): AbiFragment[] {
  const path = resolve(CANONICAL_DIR, filename);
  if (!existsSync(path)) {
    throw new Error(`Canonical ABI missing: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as AbiFragment[];
}

async function verifyCheck(check: ParityCheck): Promise<void> {
  const sdkAbi = await extractSdkAbi(check);
  const canonicalAbi = loadCanonicalAbi(check.canonical);

  // Index canonical by (type, name, input arity)
  const canonicalIndex = new Map<string, AbiFragment[]>();
  for (const frag of canonicalAbi) {
    const key = fragmentKey(frag);
    const bucket = canonicalIndex.get(key) ?? [];
    bucket.push(frag);
    canonicalIndex.set(key, bucket);
  }

  // Track which SDK function names we've seen — needed for dedupe reporting
  const sdkFunctionNames = new Set<string>();

  for (const sdkFrag of sdkAbi) {
    // Invariant: admin-only entrypoints must not leak into SDK
    if (sdkFrag.name && ADMIN_ONLY_DENYLIST.has(sdkFrag.name)) {
      violations.push({
        check,
        severity: 'high',
        kind: 'admin-leak',
        fragment: fragmentSignature(sdkFrag),
        detail: `Admin-only entrypoint '${sdkFrag.name}' exposed in SDK ABI (CLAUDE.md forbids this — non-owner callers revert).`,
      });
    }

    if (sdkFrag.type === 'function' && sdkFrag.name) {
      sdkFunctionNames.add(sdkFrag.name);
    }

    // Locate matching canonical fragment
    const key = fragmentKey(sdkFrag);
    const candidates = canonicalIndex.get(key);
    if (!candidates || candidates.length === 0) {
      // Constructor or anonymous event may have no name — skip if type is constructor (allowed to differ in args)
      if (sdkFrag.type === 'constructor') continue;
      violations.push({
        check,
        severity: 'high',
        kind: 'missing-in-canonical',
        fragment: fragmentSignature(sdkFrag),
        detail: `SDK ABI declares ${sdkFrag.type} '${sdkFrag.name ?? '<unnamed>'}' (arity ${sdkFrag.inputs?.length ?? 0}) but no matching entry exists in canonical ${check.canonical}.`,
      });
      continue;
    }

    // Try to find a canonical candidate with matching full signature
    const sdkSig = fragmentSignature(sdkFrag);
    const exactMatch = candidates.find((c) => fragmentSignature(c) === sdkSig);
    if (!exactMatch) {
      // Signature drift — same name/arity but different types
      const canonicalSigs = candidates.map((c) => fragmentSignature(c));
      violations.push({
        check,
        severity: 'high',
        kind: 'signature-mismatch',
        fragment: sdkSig,
        detail: `SDK signature does not match canonical. SDK: ${sdkSig}. Canonical candidates: ${canonicalSigs.join(' | ')}.`,
      });
    }
  }
}

function checkFlyNaming(): void {
  const chainsPath = resolve(REPO_ROOT, 'src/chains/index.ts');
  const source = readFileSync(chainsPath, 'utf8');
  // Look for "FLYS" anywhere except inside the comment patterns where it could appear
  const flysMatches = [...source.matchAll(/FLYS/g)];
  if (flysMatches.length > 0) {
    for (const m of flysMatches) {
      const lineStart = source.lastIndexOf('\n', m.index ?? 0) + 1;
      const lineEnd = source.indexOf('\n', m.index ?? 0);
      const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      violations.push({
        check: { canonical: '(naming)', sdkPath: 'src/chains/index.ts', sdkSymbol: 'FLYS_USAGE', isLiteralArray: true },
        severity: 'medium',
        kind: 'fly-naming',
        fragment: line.trim(),
        detail: `'FLYS' identifier should be 'FLY' (CLAUDE.md invariant 8).`,
      });
    }
  }
}

async function main(): Promise<void> {
  console.log('# ABI parity verification\n');
  console.log(`Canonical source: ${CANONICAL_DIR}`);
  console.log(`SDK root:         ${REPO_ROOT}\n`);

  for (const check of CHECKS) {
    process.stdout.write(`[checking] ${check.sdkPath} :: ${check.sdkSymbol} vs ${check.canonical} ... `);
    try {
      await verifyCheck(check);
      console.log('done');
    } catch (err) {
      console.log('error');
      violations.push({
        check,
        severity: 'high',
        kind: 'missing-in-canonical',
        fragment: '(loader error)',
        detail: (err as Error).message,
      });
    }
  }

  checkFlyNaming();

  console.log('');
  if (violations.length === 0) {
    console.log('PASS: SDK ABIs are a valid subset of canonical ABIs; no admin leak; no FLYS naming drift.');
    process.exit(0);
  }

  console.log(`FAIL: ${violations.length} parity violation(s) detected.\n`);
  const grouped = new Map<string, Violation[]>();
  for (const v of violations) {
    const k = `${v.check.sdkPath} :: ${v.check.sdkSymbol}`;
    const arr = grouped.get(k) ?? [];
    arr.push(v);
    grouped.set(k, arr);
  }
  for (const [key, vs] of grouped) {
    console.log(`## ${key}`);
    for (const v of vs) {
      console.log(`  - [${v.severity}] ${v.kind}: ${v.detail}`);
      console.log(`        fragment: ${v.fragment}`);
    }
    console.log('');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('verify-abi-parity crashed:', err);
  process.exit(2);
});
