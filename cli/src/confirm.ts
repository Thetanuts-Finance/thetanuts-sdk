import prompts from 'prompts';

export interface ConfirmOptions {
  /** `--yes` flag — auto-confirm without prompting. */
  yes?: boolean;
  /** `--dry-run` flag — never actually execute; the caller should bail out. */
  dryRun?: boolean;
}

/**
 * Ask the user to confirm a write operation.
 *
 * Returns:
 *   - `true`  → proceed
 *   - `false` → abort (caller should `process.exit(3)` to signal user cancel)
 *
 * Semantics (precedence order — money is on the line, safer behavior wins):
 *   - `--dry-run` ALWAYS wins. If set, prints "Dry-run: aborted" and returns
 *     `false` without prompting, even when `--yes` is also passed. This is
 *     defense-in-depth: if any caller forgets to short-circuit on `dryRun`
 *     upstream and falls through to `confirm()`, we must not broadcast.
 *   - `--yes` short-circuits to `true` only when `--dry-run` is absent.
 *   - Otherwise prompts via `prompts` with the supplied message.
 *   - If stdin is not a TTY and no `--yes`, returns `false` (we never block
 *     non-interactive sessions on a prompt that nobody can answer).
 */
export async function confirm(
  message: string,
  opts: ConfirmOptions = {}
): Promise<boolean> {
  if (opts.dryRun) {
    process.stderr.write('Dry-run: aborted\n');
    return false;
  }
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'Refusing to prompt for confirmation on a non-TTY stdin. Re-run with --yes to bypass.\n'
    );
    return false;
  }
  const response = await prompts({
    type: 'confirm',
    name: 'ok',
    message,
    initial: false,
  });
  return Boolean(response.ok);
}
