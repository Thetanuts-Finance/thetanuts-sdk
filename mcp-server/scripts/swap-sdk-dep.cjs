#!/usr/bin/env node
/**
 * Swap the SDK dependency from `file:..` (workspace link, used during local
 * development) to `^<sdkVersion>` (npm range, used in the published tarball).
 *
 * Wired into `mcp-server/package.json` via the `prepublishOnly` script. Runs
 * just before `npm publish` packages the tarball; `restore-sdk-dep.cjs` runs
 * via `postpublish` to put `file:..` back so local dev keeps working.
 *
 * Idempotent: if the dep is already a version range, this is a no-op.
 *
 * Source of truth for the SDK version is the root `package.json`'s `version`
 * field — that's the SDK that ships from this same monorepo.
 */

const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const MCP_PKG_PATH = path.resolve(HERE, '..', 'package.json');
const ROOT_PKG_PATH = path.resolve(HERE, '..', '..', 'package.json');
const SDK_NAME = '@thetanuts-finance/thetanuts-client';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  // Match the existing 2-space indent + trailing newline.
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const mcp = readJson(MCP_PKG_PATH);
const root = readJson(ROOT_PKG_PATH);

const currentDep = mcp.dependencies?.[SDK_NAME];
if (!currentDep) {
  console.error(`[swap-sdk-dep] ERROR: ${SDK_NAME} not in mcp-server dependencies`);
  process.exit(1);
}

if (!currentDep.startsWith('file:')) {
  console.log(`[swap-sdk-dep] no-op: ${SDK_NAME} is already "${currentDep}"`);
  process.exit(0);
}

const sdkVersion = root.version;
if (!sdkVersion) {
  console.error('[swap-sdk-dep] ERROR: root package.json has no version field');
  process.exit(1);
}

const newDep = `^${sdkVersion}`;
mcp.dependencies[SDK_NAME] = newDep;
writeJson(MCP_PKG_PATH, mcp);

console.log(`[swap-sdk-dep] ${SDK_NAME}: "${currentDep}" -> "${newDep}"`);
