import Table from 'cli-table3';
import pc from 'picocolors';

export type OutputFormat = 'table' | 'json' | 'csv' | 'yaml';

export interface RenderOptions {
  output?: OutputFormat;
  /** When true, ANSI color escapes are suppressed even if stdout is a TTY. */
  noColor?: boolean;
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

function renderArrayTable(rows: unknown[]): string {
  if (rows.length === 0) return '(empty)';
  // Use first row's keys as the column ordering. Implementer commands that
  // need stable columns should normalize their output before calling render.
  const first = rows[0];
  if (!isPlainObject(first)) {
    return rows.map((r) => toCellString(r)).join('\n');
  }
  const headers = Object.keys(first);
  const table = new Table({ head: headers });
  for (const row of rows) {
    if (isPlainObject(row)) {
      table.push(headers.map((h) => toCellString(row[h])));
    } else {
      table.push([toCellString(row)]);
    }
  }
  return table.toString();
}

function renderObjectTable(obj: Record<string, unknown>): string {
  const table = new Table({ head: ['key', 'value'] });
  for (const [k, v] of Object.entries(obj)) {
    table.push([k, toCellString(v)]);
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
  if (Array.isArray(data)) {
    process.stdout.write(renderArrayTable(data) + '\n');
    return;
  }
  if (isPlainObject(data)) {
    process.stdout.write(renderObjectTable(data) + '\n');
    return;
  }
  // primitive
  process.stdout.write(toCellString(data) + '\n');
}

/**
 * Print an error to stderr. When `jsonErrors` is set, emits a single-line
 * JSON object so scripts can parse failure modes.
 */
export function renderError(err: unknown, opts: RenderErrorOptions = {}): void {
  const e = err as { message?: string; code?: string; stack?: string } | null;
  if (opts.jsonErrors) {
    const payload = {
      error: e?.message ?? String(err),
      code: e?.code,
    };
    process.stderr.write(JSON.stringify(payload, jsonReplacer) + '\n');
    return;
  }
  const msg = e?.message ?? String(err);
  const useColor = !opts.noColor && process.stderr.isTTY;
  const prefix = useColor ? pc.red('Error:') : 'Error:';
  process.stderr.write(`${prefix} ${msg}\n`);
}
