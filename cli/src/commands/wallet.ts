import fs from 'node:fs';
import type { Command } from 'commander';
import prompts from 'prompts';
import { ethers } from 'ethers';
import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { render, renderError, buildTxReceiptPayload, fetchEthUsdSafe } from '../output.js';
import { confirm } from '../confirm.js';
import {
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type Config,
} from '../config.js';
import { DEFAULT_CHAIN_ID, DEFAULT_RPC_URL } from '../defaults.js';

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

/**
 * Resolve a token symbol or raw address to a contract address
 *
 * Accepts either a known symbol from `client.chainConfig.tokens` (case-sensitive
 * match preferred, case-insensitive fallback) or a 0x-prefixed 40-char hex
 * address. Throws on unknown symbol
 */
function resolveToken(client: ThetanutsClient, symbolOrAddr: string): string {
  if (!symbolOrAddr) {
    throw new Error('Token is required (symbol like USDC or 0x-address)');
  }
  if (ADDRESS_REGEX.test(symbolOrAddr)) {
    return symbolOrAddr;
  }
  const tokens = client.chainConfig.tokens;
  if (tokens[symbolOrAddr]) {
    return tokens[symbolOrAddr]!.address;
  }
  const wanted = symbolOrAddr.toLowerCase();
  for (const [sym, t] of Object.entries(tokens)) {
    if (sym.toLowerCase() === wanted) return t.address;
  }
  throw new Error(
    `Unknown token "${symbolOrAddr}". Known symbols: ${Object.keys(tokens).join(', ')}`
  );
}

function maskPrivateKey(pk?: string): string {
  if (!pk) return '<not set>';
  if (pk.length < 6) return '0x…';
  return `0x…${pk.slice(-4)}`;
}

/** Resolve which source supplied the active private key. */
function privateKeySource(opts: Record<string, unknown>): 'flag' | 'env' | 'config' | 'none' {
  if (opts.privateKey) return 'flag';
  if (process.env.THETANUTS_PRIVATE_KEY) return 'env';
  const cfgPath = (opts.config as string | undefined) ?? defaultConfigPath();
  const cfg = loadConfig(cfgPath);
  if (cfg?.privateKey) return 'config';
  return 'none';
}

async function promptPrivateKey(prompt: string): Promise<string> {
  while (true) {
    const r = await prompts({ type: 'password', name: 'pk', message: prompt });
    const pk = r.pk as string | undefined;
    if (!pk) {
      throw new Error('Aborted (no private key provided)');
    }
    if (!PRIVATE_KEY_REGEX.test(pk)) {
      process.stderr.write('Invalid private key. Expect a 0x-prefixed 64-char hex string.\n');
      continue;
    }
    return pk;
  }
}

function parseAmount(
  amount: string,
  decimals: number,
  client: ThetanutsClient
): bigint {
  if (amount === 'max') {
    return ethers.MaxUint256;
  }
  return client.utils.toBigInt(amount, decimals);
}

function resolveSpender(
  client: ThetanutsClient,
  spender?: string,
  forFlag?: string
): string {
  if (spender) {
    if (!ADDRESS_REGEX.test(spender)) {
      throw new Error('--spender must be a 0x-prefixed 40-char hex address');
    }
    return spender;
  }
  if (forFlag) {
    if (forFlag === 'optionBook') {
      const addr = client.chainConfig.contracts.optionBook;
      if (!addr) throw new Error('optionBook is not deployed on this chain');
      return addr;
    }
    if (forFlag === 'optionFactory') {
      const addr = client.chainConfig.contracts.optionFactory;
      if (!addr) throw new Error('optionFactory is not deployed on this chain');
      return addr;
    }
    throw new Error(`--for must be one of: optionBook, optionFactory (got "${forFlag}")`);
  }
  throw new Error('Either --spender <addr> or --for <optionBook|optionFactory> is required');
}

async function resolveOwner(
  client: ThetanutsClient,
  result: GetClientResult,
  explicit?: string
): Promise<string> {
  if (explicit) {
    if (!ADDRESS_REGEX.test(explicit)) {
      throw new Error('--owner must be a 0x-prefixed 40-char hex address');
    }
    return explicit;
  }
  if (!result.hasSigner) {
    throw new Error('No --owner provided and no signer configured');
  }
  return client.getSignerAddress();
}

export function register(program: Command): void {
  const grp = program
    .command('wallet')
    .description('Wallet, balances, allowances, transfers');

  // ---- Reads ----

  grp
    .command('show')
    .description('Show wallet address, source, and config path')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const result = getClient(opts);
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        if (!result.hasSigner) {
          render(
            { address: '<no signer configured>', source: 'none', configPath: path },
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }
        const address = await result.client.getSignerAddress();
        const source = privateKeySource(opts);
        render(
          { address, source, configPath: path },
          // This is the primary copy/paste surface for a wallet address; keep
          // it complete even though generic table rows compact long values.
          { output: opts.output, noColor: !opts.color, truncate: false }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('balance')
    .description(
      'Show native ETH, a token, or all configured token balances. ' +
        'By default, tokens whose balanceOf call fails (known SDK config quirks: aBasUSDC, cbDOGE, cbXRP) ' +
        'are silently skipped — pass --all to inspect them.'
    )
    .option('--token <symbol>', 'token symbol or address')
    .option('--address <addr>', 'owner address (defaults to signer)')
    .option(
      '--all',
      'include tokens whose balanceOf call fails (truncated error in cell). Useful for SDK debugging.',
      false
    )
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token?: string; address?: string; all?: boolean }>();
      try {
        const result = getClient(opts);
        const { client } = result;
        const owner = await resolveOwner(client, result, local.address);
        const nativeSymbol = client.chainConfig.nativeCurrency;

        if (local.token) {
          if (local.token.toUpperCase() === nativeSymbol.toUpperCase()) {
            const balance = await client.provider.getBalance(owner);
            render(
              {
                address: 'native',
                symbol: nativeSymbol,
                decimals: 18,
                balance: client.utils.fromBigInt(balance, 18),
                raw: balance.toString(),
              },
              { output: opts.output, noColor: !opts.color }
            );
            return;
          }
          const tokenAddr = resolveToken(client, local.token);
          const balance = await client.erc20.getBalance(tokenAddr, owner);
          // SDK types getDecimals() as number but ethers v6 returns bigint at
          // runtime; coerce defensively to keep arithmetic in fromBigInt happy.
          const decimals = Number(await client.erc20.getDecimals(tokenAddr));
          let symbol = local.token;
          // Try to look up symbol from chainConfig if we got a raw address.
          for (const [sym, t] of Object.entries(client.chainConfig.tokens)) {
            if (t.address.toLowerCase() === tokenAddr.toLowerCase()) symbol = sym;
          }
          render(
            {
              address: tokenAddr,
              symbol,
              decimals,
              balance: client.utils.fromBigInt(balance, decimals),
              raw: balance.toString(),
            },
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }

        // Multi-token path. Default: hide tokens whose balanceOf fails — they
        // tend to be SDK-config stragglers (stale Aave addresses, EIP-55
        // checksum mismatches on cbDOGE/cbXRP)
        const rows: Array<Record<string, unknown>> = [];
        const skipped: string[] = [];
        const nativeBalance = await client.provider.getBalance(owner);
        rows.push({
          symbol: nativeSymbol,
          address: 'native',
          balance: client.utils.fromBigInt(nativeBalance, 18),
          raw: nativeBalance.toString(),
        });
        for (const [symbol, t] of Object.entries(client.chainConfig.tokens)) {
          try {
            const balance = await client.erc20.getBalance(t.address, owner);
            rows.push({
              symbol,
              address: t.address,
              balance: client.utils.fromBigInt(balance, Number(t.decimals)),
              raw: balance.toString(),
            });
          } catch (err) {
            if (local.all) {
              const msg = (err as Error).message ?? String(err);
              rows.push({
                symbol,
                address: t.address,
                balance: 'error',
                raw: msg.length > 80 ? `${msg.slice(0, 77)}...` : msg,
              });
            } else {
              skipped.push(symbol);
            }
          }
        }
        if (!local.all && skipped.length > 0) {
          // Stderr note so JSON pipelines stay clean
          process.stderr.write(
            `Skipped ${skipped.length} token(s) with known SDK config issues: ${skipped.join(', ')}. ` +
              'Use --all to inspect.\n'
          );
        }
        render(rows, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('allowance')
    .description('Show ERC20 allowance for a spender')
    .requiredOption('--token <symbol>', 'token symbol or address')
    .option('--spender <addr>', 'spender address')
    .option('--for <name>', 'preset spender: optionBook | optionFactory')
    .option('--owner <addr>', 'owner address (defaults to signer)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string; spender?: string; for?: string; owner?: string }>();
      try {
        const result = getClient(opts);
        const { client } = result;
        const tokenAddr = resolveToken(client, local.token);
        const spender = resolveSpender(client, local.spender, local.for);
        const owner = await resolveOwner(client, result, local.owner);
        const allowance = await client.erc20.getAllowance(tokenAddr, owner, spender);
        const decimals = Number(await client.erc20.getDecimals(tokenAddr));
        render(
          {
            token: tokenAddr,
            owner,
            spender,
            allowance: client.utils.fromBigInt(allowance, decimals),
            raw: allowance.toString(),
          },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ---- Writes / config mutations ----

  grp
    .command('create')
    .description(
      'Generate a fresh random wallet and store it in the config. ' +
        'The private key is NEVER printed unless --reveal-key is passed (with confirmation). ' +
        'For a one-time backup, use --reveal-key or copy the config file to a secure location.'
    )
    .option('--force', 'overwrite an existing private key without prompting', false)
    .option(
      '--reveal-key',
      'after saving, display the private key and BIP-39 mnemonic on stdout. Will appear in scrollback — pipe to a secure destination.',
      false
    )
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ force?: boolean; revealKey?: boolean }>();
      // Refuse --yes + --reveal-key: --yes blanket-consents the most dangerous
      // render in the CLI (key + mnemonic to stdout). The reveal prompt is
      // intentionally gated by a TTY confirm so the user has one last chance
      // to back out before secrets land in scrollback or pipe targets.
      if (local.revealKey && opts.yes) {
        process.stderr.write(
          '`--reveal-key` cannot be combined with `--yes`; the reveal prompt is intentionally gated by a TTY confirm to prevent accidental key disclosure in scrollback or pipe targets.\n'
        );
        process.exit(2);
      }
      try {
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        const existing = loadConfig(path);
        if (existing?.privateKey && !local.force) {
          const ok = await confirm(
            `Config at ${path} already has a private key (${maskPrivateKey(existing.privateKey)}). Overwrite with a NEW random wallet? ` +
              `The existing key cannot be recovered after overwrite.`,
            { yes: Boolean(opts.yes), dryRun: Boolean(opts.dryRun) }
          );
          if (!ok) process.exit(3);
        } else if (existing?.privateKey && local.force) {
          // --force skipped the confirm prompt entirely. Surface the address
          // being destroyed so a user rotating keys can at least verify which
          // one is going away — silent overwrite is too easy to mis-aim.
          try {
            const oldAddr = new ethers.Wallet(existing.privateKey).address;
            process.stderr.write(
              `--force: overwriting wallet ${oldAddr} (key permanently destroyed)\n`
            );
          } catch {
            process.stderr.write(
              '--force: overwriting an unparseable existing key (no recovery possible)\n'
            );
          }
        }

        // Generate a fresh wallet. ethers v6's createRandom() returns a
        // wallet whose mnemonic is accessible at this instance — once we
        // persist only the raw private key, the mnemonic is unrecoverable.
        // The mnemonic is strictly more sensitive than the key (HD master
        // vs single-account); we deliberately do NOT persist it, instead
        // nudging the user to capture a paper backup at create time.
        const wallet = ethers.Wallet.createRandom();
        const address = wallet.address;
        const privateKey = wallet.privateKey;
        const mnemonic = wallet.mnemonic?.phrase;

        // Announcement goes to stderr so `-o json | jq` stays clean. The
        // structured success record still lands on stdout via render() below.
        process.stderr.write(`\nGenerated wallet ${address}\n\n`);

        // ---- Interactive backup warning ----
        //
        // The mnemonic exists ONLY in this process's memory right now. Once
        // we save the raw key to disk and the action returns, the mnemonic
        // is irretrievable. This is THE moment to offer paper backup.
        //
        // Skipped when:
        //   - --reveal-key (user already opted in to seeing it below)
        //   - --yes (user pre-confirmed everything; respect the contract)
        //   - --dry-run (no broadcast pattern; skip prompts)
        //   - stdin is not a TTY (scripted invocation; warn on stderr instead)
        let mnemonicShown = Boolean(local.revealKey);
        const canPrompt =
          !local.revealKey &&
          !opts.yes &&
          !opts.dryRun &&
          process.stdin.isTTY;
        if (canPrompt) {
          const showBackup = await prompts({
            type: 'confirm',
            name: 'show',
            message:
              'Display the 12-word mnemonic now for paper backup? ' +
              '(One-shot — once you dismiss this, only the config file is your backup.)',
            initial: true,
          });
          if (showBackup.show && mnemonic) {
            process.stdout.write(
              `\nMnemonic (write this down somewhere safe — anyone with these 12 words controls the wallet):\n\n  ${mnemonic}\n\n`
            );
            const ack = await prompts({
              type: 'confirm',
              name: 'ok',
              message: 'I have written down the mnemonic',
              initial: false,
            });
            if (!ack.ok) {
              process.stderr.write(
                'Aborting. Wallet was NOT saved. Re-run `thetanuts wallet create` to try again.\n'
              );
              process.exit(3);
            }
            mnemonicShown = true;
          }
        }

        const cfg: Config = existing
          ? { ...existing, privateKey }
          : {
              version: 1,
              chainId: DEFAULT_CHAIN_ID,
              rpcUrl: DEFAULT_RPC_URL,
              privateKey,
            };
        saveConfig(cfg, path);

        const out: Record<string, unknown> = {
          created: true,
          address,
          path,
        };

        if (local.revealKey) {
          // Explicit --reveal-key path: gated by an additional confirm
          // because the key + mnemonic about to land in stdout / scrollback.
          const ack = await confirm(
            'About to print your private key and mnemonic to stdout. They will appear in scrollback / pipe / log targets. Continue?',
            { yes: Boolean(opts.yes), dryRun: Boolean(opts.dryRun) }
          );
          if (ack) {
            out.privateKey = privateKey;
            if (mnemonic) out.mnemonic = mnemonic;
            out.backupReminder =
              'Write the mnemonic down on paper, not screenshots. Anyone with this key or mnemonic controls the wallet.';
            mnemonicShown = true;
          }
        }

        render(out, { output: opts.output, noColor: !opts.color });

        // ---- Loud post-save warning when mnemonic was discarded ----
        //
        // If the user got here without backing up the mnemonic (declined the
        // prompt, ran with --yes, --dry-run, or non-TTY stdin), the mnemonic
        // is now unrecoverable. We can't bring it back — but we can be
        // very loud about what just happened, on stderr so JSON-output
        // pipelines still parse cleanly.
        if (!mnemonicShown) {
          process.stderr.write(
            '\n⚠ Mnemonic discarded — the config file is now your ONLY backup of this wallet.\n' +
              `  If ${path} is lost, deleted, or corrupted with no copy elsewhere, the wallet is unrecoverable.\n` +
              '  Back up now: cp "' +
              path +
              '" /path/to/secure/location\n\n'
          );
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('import')
    .description('Interactively import a private key into the config')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        const existing = loadConfig(path);
        if (existing?.privateKey) {
          const ok = await confirm(
            `Config at ${path} already has a private key (${maskPrivateKey(existing.privateKey)}). Overwrite?`,
            { yes: Boolean(opts.yes), dryRun: Boolean(opts.dryRun) }
          );
          if (!ok) process.exit(3);
        }
        const pk = await promptPrivateKey('Paste your private key (input hidden)');
        const cfg: Config = existing
          ? { ...existing, privateKey: pk }
          : {
              version: 1,
              chainId: DEFAULT_CHAIN_ID,
              rpcUrl: DEFAULT_RPC_URL,
              privateKey: pk,
            };
        saveConfig(cfg, path);
        const address = new ethers.Wallet(pk).address;
        render(
          { imported: true, address, path },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('reset')
    .description('Delete the config file')
    .option('--force', 'do not prompt for confirmation', false)
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ force?: boolean }>();
      try {
        const path = (opts.config as string | undefined) ?? defaultConfigPath();
        if (!fs.existsSync(path)) {
          render({ deleted: false, reason: 'no config', path }, { output: opts.output, noColor: !opts.color });
          return;
        }
        if (!local.force) {
          const ok = await confirm(`Delete config at ${path}?`, {
            yes: Boolean(opts.yes),
            dryRun: Boolean(opts.dryRun),
          });
          if (!ok) process.exit(3);
        }
        fs.unlinkSync(path);
        render({ deleted: true, path }, { output: opts.output, noColor: !opts.color });
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ---- On-chain writes ----

  grp
    .command('approve')
    .description('Approve a spender to move tokens')
    .requiredOption('--token <symbol>', 'token symbol or address')
    .option('--spender <addr>', 'spender address')
    .option('--for <name>', 'preset spender: optionBook | optionFactory')
    .option('--amount <amount>', 'amount or "max"', 'max')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{
        token: string;
        spender?: string;
        for?: string;
        amount: string;
      }>();
      try {
        const result = getClient(opts);
        requireSigner(result);
        const { client } = result;
        const tokenAddr = resolveToken(client, local.token);
        const spender = resolveSpender(client, local.spender, local.for);
        const decimals = Number(await client.erc20.getDecimals(tokenAddr));
        const amount = parseAmount(local.amount, decimals, client);

        const preview = {
          action: 'approve',
          token: tokenAddr,
          spender,
          amount: amount === ethers.MaxUint256 ? 'max (MaxUint256)' : client.utils.fromBigInt(amount, decimals),
          raw: amount.toString(),
        };
        render(preview, { output: opts.output, noColor: !opts.color });
        if (amount === ethers.MaxUint256) {
          process.stderr.write('WARNING: approving MaxUint256. The spender will be able to move any amount.\n');
        }

        if (opts.dryRun) {
          const encoded = client.erc20.encodeApprove(tokenAddr, spender, amount);
          render(
            { dryRun: true, ...encoded },
            { output: opts.output, noColor: !opts.color, truncate: true }
          );
          return;
        }

        const ok = await confirm('Proceed with approve?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.erc20.approve(tokenAddr, spender, amount);
        const ethUsd = await fetchEthUsdSafe(client.api);
        render(
          buildTxReceiptPayload(receipt, ethUsd),
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('transfer')
    .description('Transfer an ERC-20 token to another address')
    .requiredOption('--token <symbol>', 'token symbol or address')
    .requiredOption('--to <addr>', 'recipient address')
    .requiredOption('--amount <amount>', 'decimal amount (e.g. 5.50)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string; to: string; amount: string }>();
      try {
        const result = getClient(opts);
        requireSigner(result);
        const { client } = result;

        let tokenAddr: string;
        let tokenSymbol = local.token;
        const tokens = client.chainConfig.tokens;
        const symKey =
          tokens[local.token]
            ? local.token
            : Object.keys(tokens).find((s) => s.toLowerCase() === local.token.toLowerCase());
        if (symKey) {
          tokenAddr = tokens[symKey]!.address;
          tokenSymbol = symKey;
        } else if (ADDRESS_REGEX.test(local.token)) {
          tokenAddr = local.token;
          for (const [sym, t] of Object.entries(tokens)) {
            if (t.address.toLowerCase() === tokenAddr.toLowerCase()) tokenSymbol = sym;
          }
        } else {
          process.stderr.write(
            'Unknown token; run `thetanuts chain tokens` to see what\'s configured.\n'
          );
          process.exit(4);
        }

        if (!ADDRESS_REGEX.test(local.to)) {
          process.stderr.write('--to must be a 0x-prefixed 40-char hex address\n');
          process.exit(2);
        }

        // Resolve token decimals first. Some tokens have quirky setups
        // (proxy/upgrade weirdness, malformed ABIs) where getDecimals reverts —
        // wrap so the user sees something actionable instead of an ethers stack.
        let decimals: number;
        try {
          decimals = Number(await client.erc20.getDecimals(tokenAddr));
        } catch (err) {
          process.stderr.write(
            `Could not read decimals for ${tokenSymbol} (${tokenAddr}): ${(err as Error).message ?? String(err)}\n` +
              `Run \`thetanuts chain tokens\` to confirm the symbol is configured for this chain.\n`
          );
          process.exit(4);
        }
        let amountRaw: bigint;
        try {
          amountRaw = client.utils.toBigInt(local.amount, decimals);
        } catch (err) {
          process.stderr.write(`Invalid --amount: ${(err as Error).message}\n`);
          process.exit(2);
        }
        if (amountRaw <= 0n) {
          process.stderr.write('--amount must be positive (got 0 or less after decimal scaling)\n');
          process.exit(2);
        }

        const from = await client.getSignerAddress();
        const balance = await client.erc20.getBalance(tokenAddr, from);
        if (amountRaw > balance) {
          process.stderr.write(
            `Insufficient balance: have ${client.utils.fromBigInt(balance, decimals)} ${tokenSymbol}, ` +
              `need ${client.utils.fromBigInt(amountRaw, decimals)} ${tokenSymbol}.\n`
          );
          process.exit(4);
        }

        const preview = {
          action: 'transfer',
          token: tokenAddr,
          tokenSymbol,
          from,
          to: local.to,
          amount: client.utils.fromBigInt(amountRaw, decimals),
          amountRaw: amountRaw.toString(),
        };
        render(preview, { output: opts.output, noColor: !opts.color });

        if (opts.dryRun) {
          const encoded = client.erc20.encodeTransfer(tokenAddr, local.to, amountRaw);
          render(
            { dryRun: true, ...encoded },
            { output: opts.output, noColor: !opts.color, truncate: true }
          );
          return;
        }

        const ok = await confirm('Proceed with transfer?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.erc20.transfer(tokenAddr, local.to, amountRaw);
        const ethUsd = await fetchEthUsdSafe(client.api);
        render(
          buildTxReceiptPayload(receipt, ethUsd),
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

}
