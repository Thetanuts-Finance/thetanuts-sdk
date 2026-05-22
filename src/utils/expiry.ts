/**
 * Deribit-style expiry parsing helpers.
 *
 * Deribit labels expiries as `DDMONYY` (e.g. `26DEC25` = Dec 26 2025, 08:00 UTC).
 * Both the LoanModule (put-leg, ITM strike picker) and the CollarModule
 * (call-leg, OTM cap picker) consume the same pricing API, so the parsing
 * lives here to avoid two diverging copies.
 */

export const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Parse a Deribit expiry label (e.g. `26DEC25`) into a Unix timestamp
 * (seconds) at 08:00 UTC on that date.
 *
 * Returns `null` when the input is malformed. The strict variant throws.
 */
export function parseDeribitExpiry(label: string): number | null {
  try {
    const day = parseInt(label.slice(0, -5), 10);
    const month = label.slice(-5, -2);
    const year = parseInt('20' + label.slice(-2), 10);
    const m = MONTH_MAP[month];
    if (m === undefined || !Number.isFinite(day) || !Number.isFinite(year)) return null;
    return Math.floor(Date.UTC(year, m, day, 8, 0, 0) / 1000);
  } catch {
    return null;
  }
}

/** Same as {@link parseDeribitExpiry} but throws on malformed input. */
export function parseDeribitExpiryOrThrow(label: string): number {
  const ts = parseDeribitExpiry(label);
  if (ts === null) throw new Error(`Invalid Deribit expiry label: ${label}`);
  return ts;
}

/**
 * Format a Deribit expiry label as a human-readable date in the user's locale,
 * e.g. `26DEC25` → "Fri, December 26, 2025".
 */
export function formatDeribitExpiry(label: string): string {
  const day = parseInt(label.slice(0, -5), 10);
  const month = label.slice(-5, -2);
  const year = parseInt('20' + label.slice(-2), 10);
  const m = MONTH_MAP[month];
  if (m === undefined) return label;
  const date = new Date(Date.UTC(year, m, day, 8, 0, 0));
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
