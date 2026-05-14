#!/usr/bin/env node
/**
 * Restore the SDK dependency to `file:..` after publish so local dev keeps
 * resolving the workspace SDK instead of the npm registry.
 *
 * Wired into `cli/package.json` via the `postpublish` script.
 * Idempotent: if the dep is already `file:..`, this is a no-op.
 */

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const CLI_PKG_PATH = path.resolve(HERE, '..', 'package.json');
const SDK_NAME = '@thetanuts-finance/thetanuts-client';
const FILE_DEP = 'file:..';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const cli = readJson(CLI_PKG_PATH);
const currentDep = cli.dependencies?.[SDK_NAME];

if (!currentDep) {
  console.error(`[restore-sdk-dep] ERROR: ${SDK_NAME} not in cli dependencies`);
  process.exit(1);
}

if (currentDep === FILE_DEP) {
  console.log(`[restore-sdk-dep] no-op: ${SDK_NAME} is already "${FILE_DEP}"`);
  process.exit(0);
}

cli.dependencies[SDK_NAME] = FILE_DEP;
writeJson(CLI_PKG_PATH, cli);

console.log(`[restore-sdk-dep] ${SDK_NAME}: "${currentDep}" -> "${FILE_DEP}"`);
