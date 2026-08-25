import { strict as assert } from 'node:assert';
import { MaxUint256 } from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveApproveTarget } from '../src/commands/rfq.js';
import { saveConfig, loadConfig, type Config } from '../src/config.js';

const parse = (v: string): bigint => BigInt(Math.round(Number(v) * 1e6));

// ---- rfq --ensure-allowance target defaults ------------------------------

// BUY with no --approve-amount: exactly the reservePrice the factory escrows.
{
  const { target, isMax } = resolveApproveTarget(undefined, true, 12_500_000n, parse);
  assert.equal(target, 12_500_000n, 'BUY default must be the exact reservePrice');
  assert.equal(isMax, false);
}

// SHORT with no --approve-amount: MaxUint256.
//
// Regression guard. A previous fix defaulted this to `params.collateralAmount`,
// which every SDK builder hardcodes to 0 (and the send path rejects if nonzero).
// target=0 made `current >= target` always true, so --ensure-allowance became a
// SILENT no-op and settlement reverted after a maker had committed. A zero or
// small target here is the bug, not a stricter policy.
{
  const { target, isMax } = resolveApproveTarget(undefined, false, 0n, parse);
  assert.notEqual(target, 0n, 'SHORT default of 0 makes --ensure-allowance a silent no-op');
  assert.equal(target, MaxUint256, 'SHORT default must stay unlimited');
  assert.equal(isMax, true, 'SHORT default must flag isMax so the warning fires');
}

// Explicit --approve-amount max on either direction.
for (const isBuy of [true, false]) {
  const { target, isMax } = resolveApproveTarget('max', isBuy, 5n, parse);
  assert.equal(target, MaxUint256);
  assert.equal(isMax, true);
}

// Explicit numeric amount wins over both defaults and never reports isMax.
for (const isBuy of [true, false]) {
  const { target, isMax } = resolveApproveTarget('2.5', isBuy, 999n, parse);
  assert.equal(target, 2_500_000n);
  assert.equal(isMax, false);
}

// ---- saveConfig atomicity / permissions ----------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnu-cfg-'));
const cfgPath = path.join(dir, 'nested', 'config.json');
const key = '0x' + '11'.repeat(32);
const cfg: Config = { version: 1, chainId: 8453, rpcUrl: 'https://mainnet.base.org', privateKey: key };

saveConfig(cfg, cfgPath);
assert.equal(loadConfig(cfgPath)?.privateKey, key, 'roundtrip must preserve the key');
assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600, 'config must be 0600');
assert.equal(fs.statSync(path.dirname(cfgPath)).mode & 0o777, 0o700, 'config dir must be 0700');
assert.equal(
  fs.readdirSync(path.dirname(cfgPath)).filter((f) => f.includes('.tmp')).length,
  0,
  'no temp files may survive a successful save'
);

// A symlink at the config path must be replaced, not written through — this is
// the write-side counterpart to loadConfig's O_NOFOLLOW read.
const outside = path.join(dir, 'outside.txt');
fs.writeFileSync(outside, 'ORIGINAL');
fs.rmSync(cfgPath);
fs.symlinkSync(outside, cfgPath);
saveConfig({ ...cfg, rpcUrl: 'https://example.invalid' }, cfgPath);
assert.equal(fs.readFileSync(outside, 'utf8'), 'ORIGINAL', 'symlink target must not be written through');
assert.equal(fs.lstatSync(cfgPath).isSymbolicLink(), false, 'symlink must be replaced by a regular file');

fs.rmSync(dir, { recursive: true, force: true });

console.log('approval defaults + config atomicity tests passed');
