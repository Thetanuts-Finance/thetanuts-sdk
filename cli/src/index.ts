#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { registerCommands } from './commands/registry.js';
import { addGlobalOptions } from './options.js';
import { renderError } from './output.js';

// Resolve the CLI version from package.json at runtime so bumping
// `cli/package.json` is the only edit needed for a release. `createRequire`
// keeps package.json outside the TypeScript `rootDir` (./src) while still
// resolving relative to either `cli/src/index.ts` (dev via tsx) or
// `cli/dist/index.js` (production bin) — both reach `cli/package.json`.
const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere('../package.json') as { version: string };

// Exit cleanly when downstream (e.g. `| head`) closes the pipe early.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const program = new Command();
program
  .name('thetanuts')
  .description('Thetanuts Finance V4 command-line interface')
  .version(pkg.version);

// Global flags live on the root command, so `thetanuts book fill --help`
// would not list `--referrer` / `--dry-run` / `--output` at all — making a
// present flag look missing from the help path people actually use.
program.configureHelp({ showGlobalOptions: true });

addGlobalOptions(program);
registerCommands(program);

program.parseAsync(process.argv).catch((err) => {
  // Try to use the structured error renderer if we can detect --json-errors,
  // otherwise print just the message — never the stack
  const jsonErrors = process.argv.includes('--json-errors');
  try {
    renderError(err, { jsonErrors });
  } catch {
    process.stderr.write(((err as Error)?.message ?? String(err)) + '\n');
  }
  process.exit(1);
});
