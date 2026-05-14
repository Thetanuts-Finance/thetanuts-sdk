#!/usr/bin/env node
import { Command } from 'commander';
import { registerCommands } from './commands/registry.js';
import { addGlobalOptions } from './options.js';
import { renderError } from './output.js';

// Exit cleanly when downstream (e.g. `| head`) closes the pipe early.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const program = new Command();
program
  .name('thetanuts-cli')
  .description('Thetanuts Finance V4 command-line interface')
  .version('0.1.0'); // TODO read from package.json

addGlobalOptions(program);
registerCommands(program);

program.parseAsync(process.argv).catch((err) => {
  // Try to use the structured error renderer if we can detect --json-errors,
  // otherwise dump the stack to stderr.
  const jsonErrors = process.argv.includes('--json-errors');
  try {
    renderError(err, { jsonErrors });
  } catch {
    process.stderr.write(String((err as Error)?.stack || err) + '\n');
  }
  process.exit(1);
});
