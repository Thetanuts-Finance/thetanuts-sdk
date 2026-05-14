/**
 * Shared safety-warning helpers. These intentionally write to stderr so they
 * never pollute `-o json` / `-o csv` stdout output that callers may pipe into
 * other tools.
 *
 * PRD §12 requires a louder warning for any `MaxUint256` (unlimited) ERC20
 * approval. This helper exists so every call site that proposes such an
 * approval emits byte-identical text — `wallet approve --amount max` and
 * `book fill --approve-amount max` should look the same to the user.
 */

export interface WarnOpts {
  /**
   * Reserved. `--quiet` does NOT suppress this warning by design: it is a
   * safety message, not informational chatter. Accepted for forward-compat
   * with any future flag plumbing.
   */
  quiet?: boolean;
}

/**
 * Emit the unlimited-approval warning on stderr.
 *
 * The wording is intentionally identical to the legacy inline string in
 * `wallet.ts` so behavior is unchanged for that path. Both `wallet approve`
 * and `book fill` route through this helper.
 *
 * @param _token Token address or symbol (currently unused in the message text;
 *   reserved so we can include it in a future verbose mode without breaking
 *   callers).
 * @param _spender Spender address (same note as `_token`).
 * @param _opts Reserved for future flags. `quiet` is honored as a no-op today.
 */
export function warnMaxApproval(
  _token: string,
  _spender: string,
  _opts: WarnOpts = {}
): void {
  process.stderr.write(
    'WARNING: approving MaxUint256. The spender will be able to move any amount.\n'
  );
}
