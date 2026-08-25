import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Subprocess tests: exit codes are a process-level contract, and the mapping
// lives in the parse path — an in-process call cannot observe it.
//
// README "Exit codes" documents:
//   1 = generic error (network, RPC, contract revert)
//   2 = usage error (bad flags, missing required arg)
// Commander defaults every parse failure to 1, which made a typo'd flag
// indistinguishable from a reverted transaction for anything scripting the CLI.

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.join(here, '..');
const entry = path.join(cliRoot, 'src', 'index.ts');

/**
 * Every case below fails during argument parsing, before any action handler
 * runs, so none of them read config or touch the network — no key or RPC
 * isolation is needed here. If a case that reaches an action handler is ever
 * added, isolate it with `--config <nonexistent path>`: the CLI has no config
 * env var, and setting THETANUTS_PRIVATE_KEY='' does NOT suppress key lookup
 * (client.ts uses a truthy check, so '' falls through to the config file).
 */
function run(args: string[]): { code: number; stderr: string; stdout: string } {
  const r = spawnSync('npx', ['tsx', entry, ...args], {
    encoding: 'utf8',
    // Pin cwd so `npx` resolves the local tsx from cli/node_modules. Without
    // it, running the suite from another directory sends npx to the registry.
    cwd: cliRoot,
    env: process.env,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// --- usage errors must exit 2 --------------------------------------------

// The regression this file exists for: `wallet approve --amount` became a
// required option in 0.5.0, and Commander reported that as exit 1.
{
  const r = run(['wallet', 'approve', '--token', 'USDC', '--for', 'optionBook']);
  assert.equal(r.code, 2, `missing --amount must exit 2 (usage), got ${r.code}`);
  assert.match(r.stderr, /required option .*--amount/, 'must name the missing option');
}

for (const args of [
  ['wallet', 'approve'], // missing several required options
  ['book', 'fill', '--definitely-not-a-flag'], // unknown option
  ['not-a-command'], // unknown command
  ['wallet', 'not-a-subcommand'], // unknown subcommand
  // A group command with no subcommand is an incomplete invocation, not a
  // runtime failure. Commander reports these as `commander.help` with
  // exitCode 1 — the one usage-class code that is easy to miss, because it
  // shares a name with the successful `--help` path (`commander.helpDisplayed`,
  // exitCode 0), which must keep exiting 0. Both directions are asserted here.
  ['wallet'],
  ['book'],
  ['rfq'],
  [], // bare `thetanuts`
]) {
  const r = run(args);
  assert.equal(r.code, 2, `\`${args.join(' ')}\` must exit 2 (usage), got ${r.code}`);
}

// --- help and version are successful terminations, not failures ----------

for (const args of [
  ['--help'],
  ['--version'],
  ['wallet', '--help'],
  ['wallet', 'approve', '--help'],
  ['rfq', 'request', '--help'],
]) {
  const r = run(args);
  assert.equal(r.code, 0, `\`${args.join(' ')}\` must exit 0, got ${r.code}`);
}

// --version must still print the version, i.e. the exit mapping did not
// swallow Commander's output on the way past.
{
  const r = run(['--version']);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/, 'expected a semver on stdout');
}

console.log('exit code contract tests passed');
