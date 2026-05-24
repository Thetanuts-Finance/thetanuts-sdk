import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Persisted CLI configuration. Stored at `~/.config/thetanuts/config.json` by
 * default. The file is written 0o600; the parent directory is created 0o700.
 *
 * version: 1 is the current schema. Bump and add a migration when fields
 * change incompatibly.
 */
export interface Config {
  version: 1;
  chainId: number;
  rpcUrl: string;
  privateKey?: string;
  rfqKeysDir?: string;
}

export function defaultConfigPath(): string {
  // Honor XDG_CONFIG_HOME if set, else ~/.config.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'thetanuts', 'config.json');
}

export function loadConfig(configPath?: string): Config | null {
  const p = configPath ?? defaultConfigPath();
  if (!fs.existsSync(p)) return null;
  // Open with O_NOFOLLOW so a pre-planted symlink cannot redirect the read to
  // an attacker-controlled path (TNU-AUDIT-0078). O_NOFOLLOW is unsupported
  // on Windows — fall back to the previous read path there.
  let raw: string;
  if (process.platform !== 'win32') {
    const NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
    if (typeof NOFOLLOW === 'number') {
      const fd = fs.openSync(p, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        raw = fs.readFileSync(fd, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(p, 'utf8');
    }
  } else {
    raw = fs.readFileSync(p, 'utf8');
  }
  const parsed = JSON.parse(raw) as Config;
  // Auto-tighten loose perms rather than just warning to stderr — CI piping
  // stderr to /dev/null silently swallowed the warning (TNU-AUDIT-0079).
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statSync(p);
      if ((stat.mode & 0o077) !== 0) {
        const oct = (stat.mode & 0o777).toString(8);
        try {
          fs.chmodSync(p, 0o600);
          process.stderr.write(
            `notice: tightened ${p} from mode ${oct} → 600 (was world/group-readable).\n`,
          );
        } catch {
          // chmod may fail on non-owned file or unusual FS — keep the warning.
          process.stderr.write(
            `warning: ${p} has loose permissions (mode ${oct}); run 'chmod 600 <path>' to tighten\n`,
          );
        }
      }
    } catch {
      // best-effort; never block load on a stat failure
    }
  }
  return parsed;
}

export function saveConfig(cfg: Config, configPath?: string): void {
  const p = configPath ?? defaultConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  // `mode: 0o600` on writeFileSync is honored only on file creation. Force
  // tight perms unconditionally so we tighten any pre-existing loose mode.
  // Same applies to the parent directory
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // ignore (Windows / unsupported FS)
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // ignore (Windows / unsupported FS)
  }
}
