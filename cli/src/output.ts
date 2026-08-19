import Table from 'cli-table3';
import pc from 'picocolors';

export type OutputFormat = 'table' | 'json' | 'csv' | 'yaml';

export interface RenderOptions {
  output?: OutputFormat;
  /** When true, ANSI color escapes are suppressed even if stdout is a TTY. */
  noColor?: boolean;
  /**
 * When true (table mode only), collapse long string cells. Table output
 * defaults to compact; pass `truncate: false` only for deliberately verbose
 * diagnostic views.
   */
  truncate?: boolean;
}

export interface RenderErrorOptions {
  jsonErrors?: boolean;
  noColor?: boolean;
}

/**
 * JSON.stringify replacer that serializes bigints as decimal strings. Lifted
 * verbatim from `mcp-server/src/index.ts` — many SDK reads return nested
 * bigint values (vault state, RangerInfo, etc.); without this,
 * `JSON.stringify` throws "Do not know how to serialize a BigInt".
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function toCellString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v, jsonReplacer);
  return String(v);
}

/**
 * Recursively shorten long 0x-hex strings inside an object/array for table
 * display. Keeps everything else intact. The original (untruncated) value is
 * preserved for -o json since this helper is only invoked from the table
 * renderer. Threshold matches roughly two terminal columns of useful preview.
 *
 * Encoded fill / approve / settle calldata routinely exceeds 4 KB on
 * multi-leg structures and renders as 50+ wrapped rows otherwise.
 */
// Addresses (42), tx hashes / bytes32 (66), and compressed RFQ public keys
// (68) are the copy/paste primitives of a chain CLI — `chain contracts`,
// `keys show`, `position list` -> `position info --address`, and every
// receipt -> block-explorer flow depends on them rendering whole. Only
// genuinely large blobs collapse (EIP-712 signatures are 132, encoded
// calldata far more), and they keep the length suffix so a dry-run's size
// stays checkable. Raise this if a longer primitive is ever displayed.
const TRUNCATE_HEX_THRESHOLD = 68;
// Long enough to preserve a full copy/paste next-step command. The longest
// the CLI emits is `book check`'s "Preview fill: thetanuts book preview …
// --collateral <amount>" at ~122 chars; keep headroom above that.
const TRUNCATE_STRING_THRESHOLD = 140;

function truncateForCell(s: string): string {
  if (/^0x[0-9a-fA-F]+$/.test(s) && s.length > TRUNCATE_HEX_THRESHOLD) {
    return `${s.slice(0, 10)}…${s.slice(-6)} (${s.length} chars)`;
  }
  if (s.length <= TRUNCATE_STRING_THRESHOLD) return s;
  return `${s.slice(0, TRUNCATE_STRING_THRESHOLD - 1)}…`;
}

function truncateValue(v: unknown): unknown {
  if (typeof v === 'string') return truncateForCell(v);
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (Array.isArray(v)) return v.map(truncateValue);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = truncateValue(val);
    }
    return out;
  }
  return v;
}

function toCellStringTruncated(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return truncateForCell(v);
  if (typeof v === 'object') {
    return JSON.stringify(truncateValue(v), jsonReplacer);
  }
  return String(v);
}

const EXPENDABLE_TABLE_COLUMNS = new Set([
  'signingKey',
  'offerSignature',
  'transactionHash',
  'signature',
  'calldata',
  'data',
  'rawApiData',
]);

function estimatedTableWidth(headers: string[], rows: Array<Record<string, unknown>>, cell: (v: unknown) => string): number {
  // cli-table3 needs one character of padding on each side plus a border per
  // column. This is an intentionally conservative estimate.
  return headers.reduce((total, header) => {
    const widest = Math.max(header.length, ...rows.map((row) => cell(row[header]).length));
    return total + widest + 3;
  }, 1);
}

function renderArrayCards(headers: string[], rows: Array<Record<string, unknown>>, cell: (v: unknown) => string): string {
  return rows
    .map((row, index) => {
      const table = new Table({ head: ['field', 'value'] });
      for (const header of headers) table.push([header, cell(row[header])]);
      return `${rows.length > 1 ? `#${index + 1}\n` : ''}${table.toString()}`;
    })
    .join('\n\n');
}

function renderArrayTable(rows: unknown[], truncate = true): string {
  if (rows.length === 0) return '(empty)';
  // Use first row's keys as the column ordering. Implementer commands that
  // need stable columns should normalize their output before calling render.
  const first = rows[0];
  const cell = truncate ? toCellStringTruncated : toCellString;
  if (!isPlainObject(first)) {
    return rows.map((r) => cell(r)).join('\n');
  }
  const objectRows = rows.filter(isPlainObject);
  let headers = Object.keys(first);
  const terminalWidth = process.stdout.columns ?? 120;
  const hidden: string[] = [];

  // Metadata such as a 65-byte signature is useful in JSON but destroys a
  // human table. Drop it only when needed to fit the current terminal.
  while (estimatedTableWidth(headers, objectRows, cell) > terminalWidth) {
    const index = headers.findIndex((header) => EXPENDABLE_TABLE_COLUMNS.has(header));
    if (index === -1) break;
    hidden.push(headers[index]!);
    headers = headers.filter((_, i) => i !== index);
  }

  if (estimatedTableWidth(headers, objectRows, cell) > terminalWidth && objectRows.length <= 5) {
    const cards = renderArrayCards(headers, objectRows, cell);
    return hidden.length > 0
      ? `${cards}\n(table view omitted: ${hidden.join(', ')}; use --output json for full values)`
      : cards;
  }

  const table = new Table({ head: headers });
  for (const row of rows) {
    if (isPlainObject(row)) {
      table.push(headers.map((h) => cell(row[h])));
    } else {
      table.push([cell(row)]);
    }
  }
  const note = hidden.length > 0
    ? `\n(table view omitted: ${hidden.join(', ')}; use --output json for full values)`
    : '';
  return table.toString() + note;
}

function renderObjectTable(obj: Record<string, unknown>, truncate = true): string {
  const cell = truncate ? toCellStringTruncated : toCellString;
  const entries = Object.entries(obj);

  // A key/value table has no column competition, so wrap the value column to
  // the terminal instead of letting a single long cell push the table far past
  // the viewport. Wrapping keeps the value intact and selectable; truncating
  // would break copy/paste of addresses and next-step commands.
  const terminalWidth = process.stdout.columns ?? 120;
  const keyWidth = Math.min(
    32,
    entries.reduce((widest, [k]) => Math.max(widest, k.length), 3) + 2
  );
  const valueWidth = Math.max(24, terminalWidth - keyWidth - 4);

  const table = new Table({
    head: ['key', 'value'],
    colWidths: [keyWidth, valueWidth],
    wordWrap: true,
    wrapOnWordBoundary: false,
  });
  for (const [k, v] of entries) {
    table.push([k, cell(v)]);
  }
  return table.toString();
}

function renderCsv(data: unknown): string {
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) return '';
  const first = rows[0];
  if (!isPlainObject(first)) {
    return rows.map((r) => toCellString(r)).join('\n');
  }
  const headers = Object.keys(first);
  const esc = (s: string) =>
    /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines = [headers.join(',')];
  for (const row of rows) {
    if (isPlainObject(row)) {
      lines.push(headers.map((h) => esc(toCellString(row[h]))).join(','));
    } else {
      lines.push(esc(toCellString(row)));
    }
  }
  return lines.join('\n');
}

function renderYaml(data: unknown, indent = 0): string {
  // Minimal YAML emitter — sufficient for SDK return shapes (objects, arrays,
  // primitives). Implementer agents needing richer YAML should add `yaml` as
  // a dependency rather than expanding this helper.
  const pad = '  '.repeat(indent);
  if (data === null || data === undefined) return `${pad}null`;
  if (typeof data === 'bigint') return `${pad}${data.toString()}`;
  if (
    typeof data === 'string' ||
    typeof data === 'number' ||
    typeof data === 'boolean'
  ) {
    return `${pad}${String(data)}`;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return `${pad}[]`;
    return data
      .map((item) => {
        if (isPlainObject(item) || Array.isArray(item)) {
          const sub = renderYaml(item, indent + 1).replace(/^ {2}/, '');
          return `${pad}- ${sub.trimStart()}`;
        }
        return `${pad}- ${toCellString(item)}`;
      })
      .join('\n');
  }
  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        if (isPlainObject(v) || Array.isArray(v)) {
          return `${pad}${k}:\n${renderYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${toCellString(v)}`;
      })
      .join('\n');
  }
  return `${pad}${toCellString(data)}`;
}

/**
 * Print a value to stdout in the user's selected format. `table` is the
 * default; implementer commands should pass the raw SDK return as `data` and
 * let the user pick `--output json` / `csv` / `yaml`.
 */
export function render(data: unknown, opts: RenderOptions = {}): void {
  const fmt: OutputFormat = opts.output ?? 'table';

  if (fmt === 'json') {
    process.stdout.write(JSON.stringify(data, jsonReplacer, 2) + '\n');
    return;
  }
  if (fmt === 'csv') {
    process.stdout.write(renderCsv(data) + '\n');
    return;
  }
  if (fmt === 'yaml') {
    process.stdout.write(renderYaml(data) + '\n');
    return;
  }

  // table (default)
  if (data === null || data === undefined) {
    process.stdout.write('\n');
    return;
  }
  const truncate = opts.truncate ?? true;
  if (Array.isArray(data)) {
    process.stdout.write(renderArrayTable(data, truncate) + '\n');
    return;
  }
  if (isPlainObject(data)) {
    process.stdout.write(renderObjectTable(data, truncate) + '\n');
    return;
  }
  // primitive
  process.stdout.write(toCellString(data) + '\n');
}

// ---------------------------------------------------------------------------
// Tx receipt rendering helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort ETH/USD spot fetch from the Odette market data API. Returns
 * `null` (never throws) on any failure — gas-cost USD is a nice-to-have, not
 * worth tanking a write command for. Caller should treat `null` as "skip the
 * feeUsd field gracefully".
 *
 * Structurally typed against the SDK's `client.api.getMarketData()` so we
 * don't have to drag in the full ThetanutsClient type here.
 */
export async function fetchEthUsdSafe(
  api: { getMarketData(): Promise<{ prices?: { ETH?: number } }> }
): Promise<number | null> {
  try {
    const md = await api.getMarketData();
    const eth = md?.prices?.ETH;
    if (typeof eth === 'number' && Number.isFinite(eth) && eth > 0) return eth;
    return null;
  } catch {
    return null;
  }
}

/**
 * Minimal subset of ethers v6 TransactionReceipt that this helper consumes.
 * Different SDK call sites typecheck against varying receipt types (raw
 * ethers vs the SDK's narrower aliases), so we accept a structural shape
 * with optional gas fields — never throw if anything is missing.
 */
export interface TxReceiptLike {
  hash: string;
  status?: number | null;
  blockNumber?: number;
  gasUsed?: bigint | null;
  // ethers v6 collapses effectiveGasPrice into `gasPrice` on the receipt
  gasPrice?: bigint | null;
  effectiveGasPrice?: bigint | null;
}

/**
 * Build the post-broadcast receipt payload with gas cost enrichments.
 *
 * `gasUsed` units are useless on their own — surface the effective gas price
 * (gwei), the total tx fee in ETH, and the USD equivalent when an ETH/USD
 * spot price is available. Any missing field is omitted rather than zeroed
 * so the table doesn't show misleading "0.000000 ETH" rows on chains where
 * the receipt doesn't expose gas pricing (some L2 RPCs).
 */
export function buildTxReceiptPayload(
  receipt: TxReceiptLike,
  ethUsdPrice?: number | null,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    txHash: receipt.hash,
    status: receipt.status === 1 ? 'success' : receipt.status === 0 ? 'failed' : receipt.status ?? 'unknown',
  };
  if (receipt.blockNumber !== undefined && receipt.blockNumber !== null) {
    payload.blockNumber = receipt.blockNumber;
  }
  if (receipt.gasUsed !== undefined && receipt.gasUsed !== null) {
    payload.gasUsed = receipt.gasUsed.toString();
  }
  // ethers v6 names the post-mining effective price `gasPrice`; tolerate
  // either field name to stay forward/back-compat with SDK helper changes.
  const gp = receipt.effectiveGasPrice ?? receipt.gasPrice ?? null;
  if (gp && receipt.gasUsed) {
    try {
      const gwei = Number(gp) / 1e9;
      const feeWei = receipt.gasUsed * gp;
      const feeEth = Number(feeWei) / 1e18;
      payload.gasPriceGwei = gwei.toFixed(3);
      payload.feeEth = feeEth.toFixed(6);
      if (typeof ethUsdPrice === 'number' && Number.isFinite(ethUsdPrice) && ethUsdPrice > 0) {
        payload.feeUsd = `$${(feeEth * ethUsdPrice).toFixed(4)}`;
      }
    } catch {
      // Defensive — never let the receipt render throw. If the math fails
      // (e.g. somebody passes a string instead of a bigint), just omit the
      // enriched fields.
    }
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      payload[k] = v;
    }
  }
  return payload;
}

/**
 * Strip secrets that ethers and other transitively-thrown errors routinely
 * embed in their `.message`. We redact:
 *   - `Bearer <token>` Authorization values (any caller hand-formatting an
 *     HTTP header into a thrown error).
 *   - Alchemy/Infura-style `/v<N>/<API_KEY>` path segments where the key is
 *     20+ chars of safe URL chars — the standard shape for hosted RPCs.
 *   - `apiKey=<KEY>` query params (16+ chars) — generic key-in-querystring
 *     pattern used by several JSON-RPC providers.
 * Intentionally narrow: we don't try to redact every possible secret, just
 * the ones we know reliably leak into ethers' error surface.
 */
function redactSecrets(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9_\-\.=]+/g, 'Bearer <redacted>')
    .replace(/\/v[0-9]+\/[A-Za-z0-9_\-]{20,}/g, (m) => {
      const v = m.split('/')[1];
      return `/${v}/<redacted>`;
    })
    .replace(/apiKey=[A-Za-z0-9_\-]{16,}/g, 'apiKey=<redacted>')
    // Basic-auth credentials in URLs: https://user:pass@host (TNU-AUDIT-0083).
    .replace(
      /(https?:\/\/)([^:/?#@\s]+):([^@\s]+)@/g,
      '$1<redacted>:<redacted>@',
    )
    // QuickNode-style host: `<random>.<chain>.quiknode.pro/<token>/`.
    .replace(
      /([A-Za-z0-9_\-]+)\.([A-Za-z0-9_\-]+)\.quiknode\.pro\/[A-Za-z0-9_\-]+/g,
      '$1.$2.quiknode.pro/<redacted>',
    )
    // Etherscan-style 32-char uppercase API key on `apikey` query param.
    .replace(/apikey=[A-Za-z0-9]{32,}/gi, 'apikey=<redacted>');
}

/**
 * Print an error to stderr. When `jsonErrors` is set, emits a single-line
 * JSON object so scripts can parse failure modes.
 */
export function renderError(err: unknown, opts: RenderErrorOptions = {}): void {
  const e = err as { message?: string; code?: string; stack?: string } | null;
  const rawMsg = e?.message ?? String(err);
  const msg = redactSecrets(rawMsg);
  if (opts.jsonErrors) {
    const payload = {
      error: msg,
      code: e?.code,
    };
    process.stderr.write(JSON.stringify(payload, jsonReplacer) + '\n');
    return;
  }
  const useColor = !opts.noColor && process.stderr.isTTY;
  const prefix = useColor ? pc.red('Error:') : 'Error:';
  process.stderr.write(`${prefix} ${msg}\n`);
}
