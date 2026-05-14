import type { Command } from 'commander';

/**
 * Centralized command registration. Each module under `commands/` exports a
 * `register(program)` function that attaches its subcommand tree to the root.
 * Keep this list in sync with the CLI PRD command surface.
 */
export function registerCommands(_program: Command): void {
  // Command groups are wired in follow-up commits.
}
