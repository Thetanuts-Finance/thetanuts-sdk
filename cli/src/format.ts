/**
 * Shared formatting helpers for humanized CLI output.
 *
 * These render values for table-mode display only; JSON/CSV/YAML output paths
 * must continue to emit the raw bigint strings the SDK returns so that
 * scripting consumers stay byte-stable across patch releases.
 *
 * Centralized here (not inlined per-command) so `book` and `rfq` agree on the
 * exact ticker string and money formatting — users compare them across
 * commands and any drift is confusing.
 */

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

/**
 * Format an option ticker in the dApp-canonical style:
 *   ETH-19MAY26-2100-P
 *   ETH-19MAY26-2050/2100-P  (multi-leg)
 * `strikesUsd` are USD floats (already divided by 1e8 if you started from raw).
 */
export function formatTicker(
  underlying: string,
  expirySec: number,
  strikesUsd: number[],
  type: 'PUT' | 'CALL'
): string {
  const d = new Date(expirySec * 1000);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear().toString().slice(-2);
  const strikeStr =
    strikesUsd.length === 1 ? `${strikesUsd[0]}` : strikesUsd.join('/');
  return `${underlying}-${day}${month}${year}-${strikeStr}-${type === 'PUT' ? 'P' : 'C'}`;
}

/**
 * Render a strike (or comma-separated multi-leg strikes) in `$2100` form.
 * Inputs are USD floats.
 */
export function formatStrikeUsd(strikesUsd: number[]): string {
  if (strikesUsd.length === 0) return '';
  if (strikesUsd.length === 1) return `$${formatNumber(strikesUsd[0]!)}`;
  return strikesUsd.map((s) => `$${formatNumber(s)}`).join(',');
}

/**
 * Render a USD dollar amount with up to 2 decimals and thousands separators.
 * Used for premium / available / collateral surfacing in table mode.
 */
export function formatUsd(amount: number, maxFractionDigits = 2): string {
  return `$${formatNumber(amount, maxFractionDigits)}`;
}

function formatNumber(n: number, maxFractionDigits = 2): string {
  // Drop trailing zeros: $2100 not $2,100.00 for clean strikes, but $1.77
  // still renders.
  const opts: Intl.NumberFormatOptions = {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  };
  return new Intl.NumberFormat('en-US', opts).format(n);
}

/**
 * Format an expiry timestamp as `<unix> (<iso-date>)`. ISO is UTC-trimmed to
 * minutes — the seconds are always zero for option expiries and the user
 * rarely cares about exact-second granularity at the orderbook level.
 */
export function formatExpiry(expirySec: number): string {
  const d = new Date(expirySec * 1000);
  const iso = d.toISOString().slice(0, 16) + 'Z'; // YYYY-MM-DDTHH:mmZ
  return `${expirySec} (${iso})`;
}

/**
 * Reverse-lookup helper: given a token address and a chain config tokens map,
 * return the symbol (USDC, WETH, ...). Returns undefined when unmatched.
 *
 * Typed loosely on purpose — different SDK consumer shapes have slightly
 * different tokens map types; we only need `{ address, ... }`.
 */
export function tokenSymbolByAddress(
  address: string | undefined,
  tokens: Record<string, { address: string }>
): string | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  for (const [sym, cfg] of Object.entries(tokens)) {
    if (cfg.address.toLowerCase() === lower) return sym;
  }
  return undefined;
}

/**
 * Reverse-lookup helper: given a price-feed address and a price-feeds map
 * (symbol -> feed address), return the underlying symbol ('ETH', 'BTC', ...).
 */
export function underlyingSymbolByPriceFeed(
  priceFeed: string | undefined,
  priceFeeds: Record<string, string>
): string | undefined {
  if (!priceFeed) return undefined;
  const lower = priceFeed.toLowerCase();
  for (const [sym, addr] of Object.entries(priceFeeds)) {
    if (addr.toLowerCase() === lower) return sym;
  }
  return undefined;
}
