import fs from 'node:fs';
import type { Command } from 'commander';
import prompts from 'prompts';
import { ethers } from 'ethers';
import { defaultConfigPath, loadConfig, saveConfig, type Config } from '../config.js';
import {
  DEFAULT_CHAIN_ID,
  DEFAULT_ETHEREUM_RPC_URL,
  DEFAULT_RPC_URL,
} from '../defaults.js';
import { getGlobalOpts } from '../options.js';
import { getClient } from '../client.js';
import { render, renderError } from '../output.js';

const PRIVATE_KEY_REGEX = /^0x[0-9a-fA-F]{64}$/;

interface ChainChoice {
  chainId: 1 | 8453;
  defaultRpc: string;
  label: string;
}

const CHAIN_CHOICES: ChainChoice[] = [
  { chainId: 8453, defaultRpc: DEFAULT_RPC_URL, label: 'Base (8453)' },
  { chainId: 1, defaultRpc: DEFAULT_ETHEREUM_RPC_URL, label: 'Ethereum (1)' },
];

function checkNodeVersion(): void {
  const v = process.versions.node;
  const major = Number.parseInt(v.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < 18) {
    throw new Error(`Node.js >= 18 is required, but found ${v}`);
  }
}

async function promptPrivateKey(): Promise<string> {
  // Re-prompt until valid or aborted.
  while (true) {
    const response = await prompts({
      type: 'password',
      name: 'pk',
      message: 'Paste your private key (input hidden)',
    });
    const pk = response.pk as string | undefined;
    if (!pk) {
      throw new Error('Setup aborted (no private key provided)');
    }
    if (!PRIVATE_KEY_REGEX.test(pk)) {
      process.stderr.write('Invalid private key. Expect a 0x-prefixed 64-char hex string.\n');
      continue;
    }
    return pk;
  }
}

async function promptAndValidateRpc(
  defaultUrl: string,
  expectedChainId: number
): Promise<string> {
  while (true) {
    const response = await prompts({
      type: 'text',
      name: 'url',
      message: 'RPC URL',
      initial: defaultUrl,
    });
    const url = (response.url as string | undefined)?.trim();
    if (!url) {
      throw new Error('Setup aborted (no RPC URL provided)');
    }
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const network = await provider.getNetwork();
      const actual = Number(network.chainId);
      if (actual !== expectedChainId) {
        process.stderr.write(
          `RPC chain id mismatch: got ${actual}, expected ${expectedChainId}. Try a different URL.\n`
        );
        continue;
      }
      return url;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      process.stderr.write(`RPC connection failed: ${msg}\nTry a different URL.\n`);
      continue;
    }
  }
}

export function register(program: Command): void {
  program
    .command('setup')
    .description('Interactive first-run setup: chain, RPC URL, private key, referrer')
    .action(async (_localOpts: unknown, cmd: Command) => {
      const opts = getGlobalOpts(cmd);
      try {
        process.stdout.write('Thetanuts CLI setup\n');
        process.stdout.write('-------------------\n');

        checkNodeVersion();

        const cfgPath = (opts.config as string | undefined) ?? defaultConfigPath();
        if (fs.existsSync(cfgPath)) {
          const ow = await prompts({
            type: 'confirm',
            name: 'ok',
            message: `Config exists at ${cfgPath}. Overwrite?`,
            initial: false,
          });
          if (!ow.ok) {
            process.stderr.write('Aborted.\n');
            process.exit(3);
          }
        }

        // Existing config (if any) gives sensible defaults.
        const existing = loadConfig(cfgPath) ?? null;

        const mode = await prompts({
          type: 'select',
          name: 'value',
          message: 'Import an existing private key, or skip (read-only mode)?',
          choices: [
            { title: 'Import private key', value: 'import' },
            { title: 'Skip — read-only mode', value: 'skip' },
          ],
          initial: 0,
        });
        if (mode.value === undefined) {
          throw new Error('Setup aborted');
        }

        let privateKey: string | undefined;
        if (mode.value === 'import') {
          privateKey = await promptPrivateKey();
        }

        const initialChainIdx = CHAIN_CHOICES.findIndex(
          (c) => c.chainId === (existing?.chainId ?? DEFAULT_CHAIN_ID)
        );
        const chainResp = await prompts({
          type: 'select',
          name: 'value',
          message: 'Select chain',
          choices: CHAIN_CHOICES.map((c) => ({ title: c.label, value: c.chainId })),
          initial: initialChainIdx >= 0 ? initialChainIdx : 0,
        });
        const chainId = chainResp.value as 1 | 8453 | undefined;
        if (!chainId) {
          throw new Error('Setup aborted');
        }
        const chainChoice = CHAIN_CHOICES.find((c) => c.chainId === chainId);
        if (!chainChoice) {
          throw new Error(`Unsupported chain id ${chainId}`);
        }

        const defaultRpc =
          (chainId === 1 ? existing?.ethereumRpcUrl : existing?.rpcUrl) ??
          chainChoice.defaultRpc;
        const rpcUrl = await promptAndValidateRpc(defaultRpc, chainId);

        // Persist. Preserve unrelated fields from any prior config.
        const newCfg: Config = {
          version: 1,
          chainId,
          rpcUrl: chainId === 8453 ? rpcUrl : (existing?.rpcUrl ?? DEFAULT_RPC_URL),
          ethereumRpcUrl: chainId === 1 ? rpcUrl : existing?.ethereumRpcUrl,
          privateKey: privateKey ?? existing?.privateKey,
          referrer: existing?.referrer,
          rfqKeysDir: existing?.rfqKeysDir,
        };
        saveConfig(newCfg, cfgPath);
        process.stdout.write(`Saved to ${cfgPath}\n`);

        // If a key was imported, show wallet summary.
        if (privateKey) {
          try {
            const { client } = getClient({ ...opts, config: cfgPath });
            const address = await client.getSignerAddress();
            const tokens = client.chainConfig.tokens;
            const optionBookAddr = client.chainConfig.contracts.optionBook;
            const usdc = tokens.USDC;

            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const ethBal = await provider.getBalance(address);

            let usdcBalanceStr = '<n/a>';
            let approvalStr = '<n/a>';
            if (usdc) {
              const balance = await client.erc20.getBalance(usdc.address, address);
              usdcBalanceStr = client.utils.fromBigInt(balance, Number(usdc.decimals));
              if (optionBookAddr) {
                const allowance = await client.erc20.getAllowance(
                  usdc.address,
                  address,
                  optionBookAddr
                );
                approvalStr =
                  allowance === 0n
                    ? 'not approved'
                    : `approved (${client.utils.fromBigInt(allowance, Number(usdc.decimals))})`;
              } else {
                approvalStr = 'optionBook not deployed on this chain';
              }
            }

            const summary = {
              address,
              eth: client.utils.fromBigInt(ethBal, 18),
              usdc: usdcBalanceStr,
              optionBookApproval: approvalStr,
            };
            render(summary, { output: opts.output, noColor: !opts.color });
          } catch (err) {
            // Don't fail setup if the post-save wallet check fails — config is already written.
            const msg = (err as Error).message ?? String(err);
            process.stderr.write(`Warning: could not fetch wallet summary: ${msg}\n`);
          }
        } else {
          process.stdout.write('Read-only mode. Run `thetanuts wallet import` later to add a key.\n');
        }
      } catch (err) {
        renderError(err, { jsonErrors: Boolean(opts.jsonErrors), noColor: !opts.color });
        process.exit(1);
      }
    });
}
