import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { resolveReferrer } from '../src/client.js';
import type { Config } from '../src/config.js';

const FLAG_ADDR = '0x1111111111111111111111111111111111111111';
const ENV_ADDR = '0x2222222222222222222222222222222222222222';
const CFG_ADDR = '0x3333333333333333333333333333333333333333';
// Mixed-case EIP-55 checksum of a real Base USDC address.
const CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function config(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    ...overrides,
  } as Config;
}

let savedEnv: string | undefined;

before(() => {
  savedEnv = process.env.THETANUTS_REFERRER;
  delete process.env.THETANUTS_REFERRER;
});

after(() => {
  if (savedEnv === undefined) {
    delete process.env.THETANUTS_REFERRER;
  } else {
    process.env.THETANUTS_REFERRER = savedEnv;
  }
});

test('flag beats env beats config', () => {
  process.env.THETANUTS_REFERRER = ENV_ADDR;
  assert.equal(
    resolveReferrer({ referrer: FLAG_ADDR }, config({ referrer: CFG_ADDR })),
    FLAG_ADDR
  );
  delete process.env.THETANUTS_REFERRER;
});

test('env beats config when no flag', () => {
  process.env.THETANUTS_REFERRER = ENV_ADDR;
  assert.equal(resolveReferrer({}, config({ referrer: CFG_ADDR })), ENV_ADDR);
  delete process.env.THETANUTS_REFERRER;
});

test('config is used when no flag and no env', () => {
  assert.equal(resolveReferrer({}, config({ referrer: CFG_ADDR })), CFG_ADDR);
});

test('undefined when nothing is set', () => {
  assert.equal(resolveReferrer({}, config()), undefined);
  assert.equal(resolveReferrer({}, null), undefined);
});

test('invalid address from the flag throws and names the source', () => {
  assert.throws(
    () => resolveReferrer({ referrer: 'notanaddress' }, config()),
    /Invalid referrer address from --referrer flag/
  );
});

test('invalid address from the env var throws and names the source', () => {
  process.env.THETANUTS_REFERRER = '0xdeadbeef';
  assert.throws(
    () => resolveReferrer({}, config()),
    /Invalid referrer address from THETANUTS_REFERRER env var/
  );
  delete process.env.THETANUTS_REFERRER;
});

test('invalid address from the config file throws and names the source', () => {
  assert.throws(
    () => resolveReferrer({}, config({ referrer: '0x123' })),
    /Invalid referrer address from config file/
  );
});

test('checksummed and lowercase addresses are both accepted', () => {
  assert.equal(resolveReferrer({ referrer: CHECKSUMMED }, null), CHECKSUMMED);
  const lower = CHECKSUMMED.toLowerCase();
  assert.equal(resolveReferrer({ referrer: lower }, null), lower);
});
