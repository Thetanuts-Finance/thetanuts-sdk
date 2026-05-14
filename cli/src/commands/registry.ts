import type { Command } from 'commander';
import * as setup from './setup.js';
import * as config from './config.js';
import * as chain from './chain.js';
import * as wallet from './wallet.js';
import * as market from './market.js';
import * as pricing from './pricing.js';
import * as util from './util.js';

/**
 * Centralized command registration. Each module under `commands/` exports a
 * `register(program)` function that attaches its subcommand tree to the root.
 * Keep this list in sync with the CLI PRD command surface.
 */
export function registerCommands(program: Command): void {
  setup.register(program);
  config.register(program);
  chain.register(program);
  wallet.register(program);
  market.register(program);
  pricing.register(program);
  util.register(program);
}
