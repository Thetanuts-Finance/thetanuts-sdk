import fs from 'node:fs';
import type { Command } from 'commander';
import prompts from 'prompts';
import { ethers } from 'ethers';
import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { getGlobalOpts } from '../options.js';
import { getClient, requireSigner, type GetClientResult } from '../client.js';
import { render, renderError } from '../output.js';
import { confirm } from '../confirm.js';
import { warnMaxApproval } from '../warn.js';
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
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('balance')
    .description('Show balance for a token or all configured tokens')
    .option('--token <symbol>', 'token symbol or address')
    .option('--address <addr>', 'owner address (defaults to signer)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token?: string; address?: string }>();
      try {
        const result = getClient(opts);
        const { client } = result;
        const owner = await resolveOwner(client, result, local.address);

        if (local.token) {
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

        const rows: Array<Record<string, unknown>> = [];
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
            rows.push({
              symbol,
              address: t.address,
              balance: 'error',
              raw: (err as Error).message ?? String(err),
            });
          }
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
    .requiredOption('--spender <addr>', 'spender address')
    .option('--owner <addr>', 'owner address (defaults to signer)')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string; spender: string; owner?: string }>();
      try {
        const result = getClient(opts);
        const { client } = result;
        const tokenAddr = resolveToken(client, local.token);
        if (!ADDRESS_REGEX.test(local.spender)) {
          throw new Error('--spender must be a 0x-prefixed 40-char hex address');
        }
        const owner = await resolveOwner(client, result, local.owner);
        const allowance = await client.erc20.getAllowance(tokenAddr, owner, local.spender);
        const decimals = Number(await client.erc20.getDecimals(tokenAddr));
        render(
          {
            token: tokenAddr,
            owner,
            spender: local.spender,
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

  grp
    .command('info')
    .description('Show token decimals and symbol')
    .requiredOption('--token <symbol>', 'token symbol or address')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string }>();
      try {
        const { client } = getClient(opts);
        const tokenAddr = resolveToken(client, local.token);
        const [rawDecimals, symbol] = await Promise.all([
          client.erc20.getDecimals(tokenAddr),
          client.erc20.getSymbol(tokenAddr),
        ]);
        const decimals = Number(rawDecimals);
        render(
          { address: tokenAddr, symbol, decimals },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  // ---- Writes / config mutations ----

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
          warnMaxApproval(tokenAddr, spender, {});
        }

        if (opts.dryRun) {
          const encoded = client.erc20.encodeApprove(tokenAddr, spender, amount);
          render({ dryRun: true, ...encoded }, { output: opts.output, noColor: !opts.color });
          return;
        }

        const ok = await confirm('Proceed with approve?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.erc20.approve(tokenAddr, spender, amount);
        render(
          { txHash: receipt.hash, status: receipt.status === 1 ? 'success' : 'failed' },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('ensure-allowance')
    .description('Approve a spender only if current allowance is insufficient')
    .requiredOption('--token <symbol>', 'token symbol or address')
    .requiredOption('--spender <addr>', 'spender address')
    .requiredOption('--amount <amount>', 'minimum allowance (or "max")')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string; spender: string; amount: string }>();
      try {
        const result = getClient(opts);
        requireSigner(result);
        const { client } = result;
        if (!ADDRESS_REGEX.test(local.spender)) {
          throw new Error('--spender must be a 0x-prefixed 40-char hex address');
        }
        const tokenAddr = resolveToken(client, local.token);
        const decimals = Number(await client.erc20.getDecimals(tokenAddr));
        const amount = parseAmount(local.amount, decimals, client);

        const owner = await client.getSignerAddress();
        const current = await client.erc20.getAllowance(tokenAddr, owner, local.spender);

        const preview = {
          action: 'ensure-allowance',
          token: tokenAddr,
          owner,
          spender: local.spender,
          current: client.utils.fromBigInt(current, decimals),
          required: amount === ethers.MaxUint256 ? 'max' : client.utils.fromBigInt(amount, decimals),
          willApprove: current < amount,
        };
        render(preview, { output: opts.output, noColor: !opts.color });

        if (current >= amount) {
          process.stdout.write('Allowance already sufficient\n');
          return;
        }

        if (opts.dryRun) {
          const encoded = client.erc20.encodeApprove(tokenAddr, local.spender, amount);
          render({ dryRun: true, ...encoded }, { output: opts.output, noColor: !opts.color });
          return;
        }

        const ok = await confirm('Proceed with approval?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.erc20.ensureAllowance(tokenAddr, local.spender, amount);
        if (!receipt) {
          render(
            { status: 'no-op', reason: 'allowance already sufficient' },
            { output: opts.output, noColor: !opts.color }
          );
          return;
        }
        render(
          { txHash: receipt.hash, status: receipt.status === 1 ? 'success' : 'failed' },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });

  grp
    .command('transfer')
    .description('Transfer tokens to another address')
    .requiredOption('--token <symbol>', 'token symbol or address')
    .requiredOption('--to <addr>', 'recipient address')
    .requiredOption('--amount <amount>', 'amount in human units')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      const local = cmd.opts<{ token: string; to: string; amount: string }>();
      try {
        const result = getClient(opts);
        requireSigner(result);
        const { client } = result;
        if (!ADDRESS_REGEX.test(local.to)) {
          throw new Error('--to must be a 0x-prefixed 40-char hex address');
        }
        const tokenAddr = resolveToken(client, local.token);
        const decimals = Number(await client.erc20.getDecimals(tokenAddr));
        if (local.amount === 'max') {
          throw new Error('--amount max is not supported for transfer; pass a numeric amount');
        }
        const amount = client.utils.toBigInt(local.amount, decimals);
        const from = await client.getSignerAddress();

        const preview = {
          action: 'transfer',
          token: tokenAddr,
          from,
          to: local.to,
          amount: client.utils.fromBigInt(amount, decimals),
          raw: amount.toString(),
        };
        render(preview, { output: opts.output, noColor: !opts.color });

        if (opts.dryRun) {
          const encoded = client.erc20.encodeTransfer(tokenAddr, local.to, amount);
          render({ dryRun: true, ...encoded }, { output: opts.output, noColor: !opts.color });
          return;
        }

        const ok = await confirm('Proceed with transfer?', {
          yes: Boolean(opts.yes),
          dryRun: Boolean(opts.dryRun),
        });
        if (!ok) process.exit(3);

        const receipt = await client.erc20.transfer(tokenAddr, local.to, amount);
        render(
          { txHash: receipt.hash, status: receipt.status === 1 ? 'success' : 'failed' },
          { output: opts.output, noColor: !opts.color }
        );
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
