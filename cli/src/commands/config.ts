import type { Command } from 'commander';
import fs from 'node:fs';
import { ethers } from 'ethers';
import {
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type Config,
} from '../config.js';
import { DEFAULT_CHAIN_ID, DEFAULT_RPC_URL } from '../defaults.js';
import { getGlobalOpts } from '../options.js';
import { render, renderError } from '../output.js';

/**
 * Read all bytes from stdin and return as a UTF-8 string. Used by
 * `config set privateKey -` to accept the key over a pipe instead of as an
 * argv positional (which would leak into shell history, ps aux, and terminal
 * scrollback). Mirrors the OpenClaw `import-wallet.js --stdin` pattern.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      'Expected input on stdin but stdin is a TTY. Example:\n' +
        '  printf "%s" "$KEY" | thetanuts config set privateKey -\n' +
        'Or use `thetanuts wallet import` for an interactive prompt.'
    );
  }
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

type AllowedKey =
  | 'chainId'
  | 'rpcUrl'
  | 'privateKey'
  | 'rfqKeysDir'
  | 'referrer';

const ALLOWED_KEYS: ReadonlyArray<AllowedKey> = [
  'chainId',
  'rpcUrl',
  'privateKey',
  'rfqKeysDir',
  'referrer',
];

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

function isAllowedKey(key: string): key is AllowedKey {
  return (ALLOWED_KEYS as ReadonlyArray<string>).includes(key);
}

function maskPrivateKey(pk?: string): string {
  if (!pk) return '<not set>';
  if (pk.length < 6) return '0x…';
  return `0x…${pk.slice(-4)}`;
}

function emptyConfig(): Config {
  return {
    version: 1,
    chainId: DEFAULT_CHAIN_ID,
    rpcUrl: DEFAULT_RPC_URL,
  };
}

function parseValue(key: AllowedKey, value: string): Config[AllowedKey] {
  if (key === 'chainId') {
    const n = Number.parseInt(value, 10);
    if (Number.isNaN(n)) {
      throw new Error(`chainId must be an integer (got "${value}")`);
    }
    return n;
  }
  if (key === 'privateKey') {
    if (!PRIVATE_KEY_REGEX.test(value)) {
      throw new Error(`privateKey must be a 0x-prefixed 64-char hex string`);
    }
    return value;
  }
  if (key === 'referrer') {
    if (!ethers.isAddress(value)) {
      throw new Error(`referrer must be a valid 0x-prefixed Ethereum address`);
    }
    return value;
  }
  // rpcUrl, rfqKeysDir — plain strings
  return value;
}

export function register(program: Command): void {
  const grp = program
    .command('config')
    .description('Inspect, get, set, or unset persisted CLI configuration');

  grp
    .command('show')
    .description('Print the current configuration (private key masked)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        const cfg = loadConfig(path);
        if (!cfg) {
          render({ path, exists: false }, { output: opts.output, noColor: !opts.color });
          return;
        }
        const masked = {
          version: cfg.version,
          chainId: cfg.chainId,
          rpcUrl: cfg.rpcUrl,
          privateKey: maskPrivateKey(cfg.privateKey),
          rfqKeysDir: cfg.rfqKeysDir ?? '<not set>',
          referrer: cfg.referrer ?? '<not set>',
          path,
        };
        render(masked, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('path')
    .description('Print the config file path')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        render(path, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('set <key> <value>')
    .description(
      'Set one config field (chainId, rpcUrl, privateKey, rfqKeysDir, referrer). ' +
        'For privateKey, only `-` (read from stdin) is accepted — argv would leak the key via shell history.'
    )
    .action(async (key: string, value: string, _localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        if (!isAllowedKey(key)) {
          process.stderr.write(
            `Unknown config key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}\n`
          );
          process.exit(2);
        }
        // SECURITY: reject argv for privateKey. The shell records argv in
        // history (~/.zsh_history, ~/.bash_history), and the running process
        // is visible in `ps aux` for its lifetime. Either route is a key-leak
        // vector that the safer commands (`wallet import`, `setup`) avoid by
        // reading via masked prompt. Mirror that here by accepting only:
        //   - `-`        → read the key from stdin (pipe / heredoc / here-string)
        //   - anything else → hard refusal
        // The plain-argv path was the same footgun TODO §8 cited when it
        // chose to ship import-only over BIP-39 wallet generation in v0.1.0.
        let effectiveValue = value;
        if (key === 'privateKey') {
          if (value !== '-') {
            throw new Error(
              'Refusing to read a private key from argv — it would land in shell\n' +
                'history, ps aux, and terminal scrollback. Use one of:\n' +
                '  1. `thetanuts wallet import`                       (recommended; interactive, masked)\n' +
                '  2. `thetanuts config set privateKey - <<< "$KEY"`  (read from stdin, no argv exposure)\n' +
                '  3. `THETANUTS_PRIVATE_KEY=$KEY thetanuts ...`      (env var, per-invocation)'
            );
          }
          effectiveValue = (await readStdin()).trim();
        }
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        const cfg = loadConfig(path) ?? emptyConfig();
        const parsed = parseValue(key, effectiveValue);
        // Assign with a typed cast — Config field types vary per key.
        (cfg as unknown as Record<string, unknown>)[key] = parsed;
        saveConfig(cfg, path);
        render(
          { key, value: key === 'privateKey' ? maskPrivateKey(String(parsed)) : parsed, path },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('unset <key>')
    .description('Remove one config field')
    .action(async (key: string, _localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        if (!isAllowedKey(key)) {
          process.stderr.write(
            `Unknown config key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}\n`
          );
          process.exit(2);
        }
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        const cfg = loadConfig(path);
        if (!cfg) {
          process.stderr.write(`No config file at ${path}\n`);
          process.exit(4);
        }
        // chainId and rpcUrl are required fields; rather than `delete` them, reset to defaults.
        if (key === 'chainId') {
          cfg.chainId = DEFAULT_CHAIN_ID;
        } else if (key === 'rpcUrl') {
          cfg.rpcUrl = DEFAULT_RPC_URL;
        } else {
          delete (cfg as unknown as Record<string, unknown>)[key];
        }
        saveConfig(cfg, path);
        render({ key, unset: true, path }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('validate')
    .description('Ensure RPC is reachable and the private key (if any) is valid')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        if (!fs.existsSync(path)) {
          process.stderr.write(`No config file at ${path}\n`);
          process.exit(4);
        }
        const cfg = loadConfig(path);
        if (!cfg) {
          process.stderr.write(`Could not parse config at ${path}\n`);
          process.exit(4);
        }
        const rpcUrl = cfg.rpcUrl;
        let chainId: number;
        try {
          const provider = new ethers.JsonRpcProvider(rpcUrl);
          const network = await provider.getNetwork();
          chainId = Number(network.chainId);
          if (chainId !== cfg.chainId) {
            process.stderr.write(
              `Chain id mismatch: RPC reports ${chainId}, config says ${cfg.chainId}\n`
            );
            process.exit(4);
          }
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          process.stderr.write(`RPC unreachable: ${msg}\n`);
          process.exit(4);
        }

        let address: string | undefined;
        if (cfg.privateKey) {
          try {
            const w = new ethers.Wallet(cfg.privateKey);
            address = w.address;
          } catch (err) {
            const msg = (err as Error).message ?? String(err);
            process.stderr.write(`Private key invalid: ${msg}\n`);
            process.exit(4);
          }
        }

        render(
          {
            path,
            chainId,
            rpcUrl,
            address: address ?? '<no signer>',
            valid: true,
          },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
