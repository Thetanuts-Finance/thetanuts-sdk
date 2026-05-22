#!/usr/bin/env npx tsx
/**
 * CollarModule smoke tests
 *
 * Runs against:
 *   - synthetic Deribit-shaped fixture (deterministic, no network)
 *   - live pricing.thetanuts.finance/all (only when --live is passed)
 *
 * Usage:
 *   npx tsx scripts/test-collar-module.ts            # offline only
 *   npx tsx scripts/test-collar-module.ts --live     # + live Deribit fetch
 */

import { ethers } from 'ethers';
import { ThetanutsClient } from '../src/client/ThetanutsClient.js';
import { CollarModule } from '../src/modules/collar.js';
import { isCollarDeployed, COLLAR_CONFIG } from '../src/chains/collar.js';
import type { DeribitPricingMap } from '../src/types/loan.js';

const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const RUN_LIVE = process.argv.includes('--live');

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}
const results: TestResult[] = [];
function record(name: string, passed: boolean, detail?: string) {
  results.push({ name, passed, detail });
  console.log(`${passed ? '[32m✓[0m' : '[31m✗[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, e: unknown) {
  const detail = e instanceof Error ? e.message : String(e);
  record(name, false, detail);
}

// ─── Fixture: a minimal Deribit-shaped pricing map ───
// Spot BTC ≈ 90,000. Call at $100,000 (OTM), puts at $60k, $50k, $40k.
//
// Math expectation (mm_margin=4%):
//   target_put = 0.05 * 0.96 = 0.048
//   $60k put has ask 0.06 → > target, skipped
//   $50k put has ask 0.045 → ≤ target, candidate (highest)
//   $40k put has ask 0.02  → ≤ target, dominated by $50k
// So K_lo = 50,000.
//
//   L = 50,000 * 0.5 = 25,000
//   cap_payout = (100,000 - 50,000) * 0.5 = 25,000
const FIXTURE: DeribitPricingMap = {
  BTC: {
    'BTC-26DEC25-100000-C': {
      bid_price: 0.05,
      ask_price: 0.052,
      mark_price: 0.051,
      underlying_price: 90000,
    },
    'BTC-26DEC25-60000-P': {
      ask_price: 0.06,
      mark_price: 0.058,
      underlying_price: 90000,
    },
    'BTC-26DEC25-50000-P': {
      ask_price: 0.045,
      mark_price: 0.044,
      underlying_price: 90000,
    },
    'BTC-26DEC25-40000-P': {
      ask_price: 0.02,
      mark_price: 0.02,
      underlying_price: 90000,
    },
    // Distractor: ITM put, should be ignored.
    'BTC-26DEC25-95000-P': {
      ask_price: 0.1,
      mark_price: 0.1,
      underlying_price: 90000,
    },
  },
  ETH: {},
};

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const client = new ThetanutsClient({ chainId: 8453, provider });
  const collar: CollarModule = client.collar;

  // ─── Capability checks ───

  try {
    record('isDeployed() returns false with placeholder addresses', !collar.isDeployed());
  } catch (e) {
    fail('isDeployed()', e);
  }

  try {
    record(
      'isCollarDeployed() matches collar.isDeployed()',
      isCollarDeployed() === collar.isDeployed(),
    );
  } catch (e) {
    fail('isCollarDeployed()', e);
  }

  // ─── Write methods must throw NETWORK_UNSUPPORTED while undeployed ───

  for (const [name, fn] of [
    [
      'requestLoan',
      () =>
        collar.requestLoan({
          underlying: 'BTC',
          collateralAmount: '0.5',
          capUsd: 100000,
          minLoanUsd: 22500,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 86400 * 30,
        }),
    ],
    ['cancelLoan', () => collar.cancelLoan(1n)],
    ['acceptOffer', () => collar.acceptOffer(1n, 1n, 1n, ethers.ZeroAddress)],
    ['getLoanRequest', () => collar.getLoanRequest(1n)],
  ] as const) {
    try {
      await fn();
      record(`${name} throws on undeployed coordinator`, false, 'did not throw');
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      record(
        `${name} throws NETWORK_UNSUPPORTED on undeployed coordinator`,
        code === 'NETWORK_UNSUPPORTED',
        code ?? 'no code',
      );
    }
  }

  // ─── Pricing math against fixture ───

  try {
    const est = collar.estimateCollar({
      underlying: 'BTC',
      collateralAmount: 0.5,
      capUsd: 100000,
      expiryLabel: '26DEC25',
      pricingData: FIXTURE,
      underlyingPrice: 90000,
      mmMarginPct: 4,
    });
    if (!est) {
      record('estimateCollar produces a result for fixture', false, 'null');
    } else {
      record('estimateCollar.putStrike == 50000', est.putStrike === 50000, `got ${est.putStrike}`);
      record('estimateCollar.loanUsd == 25000', est.loanUsd === 25000, `got ${est.loanUsd}`);
      record(
        'estimateCollar.capPayoutUsd == 25000',
        est.capPayoutUsd === 25000,
        `got ${est.capPayoutUsd}`,
      );
      record('estimateCollar.triggerUsd == 50000', est.triggerUsd === 50000, `got ${est.triggerUsd}`);
      record('estimateCollar.callBtc uses bid_price (0.05)', est.callBtc === 0.05, `got ${est.callBtc}`);
    }
  } catch (e) {
    fail('estimateCollar fixture', e);
  }

  // ─── Edge: invalid inputs return null ───

  try {
    const noCall = collar.estimateCollar({
      underlying: 'BTC',
      collateralAmount: 0.5,
      capUsd: 999999, // no such call in fixture
      expiryLabel: '26DEC25',
      pricingData: FIXTURE,
      underlyingPrice: 90000,
    });
    record('estimateCollar returns null when call not found', noCall === null);
  } catch (e) {
    fail('estimateCollar null guard', e);
  }

  try {
    const noN = collar.estimateCollar({
      underlying: 'BTC',
      collateralAmount: 0,
      capUsd: 100000,
      expiryLabel: '26DEC25',
      pricingData: FIXTURE,
      underlyingPrice: 90000,
    });
    record('estimateCollar returns null when collateral=0', noN === null);
  } catch (e) {
    fail('estimateCollar zero collateral', e);
  }

  try {
    const noSpot = collar.estimateCollar({
      underlying: 'BTC',
      collateralAmount: 0.5,
      capUsd: 100000,
      expiryLabel: '26DEC25',
      pricingData: FIXTURE,
      underlyingPrice: 0,
    });
    record('estimateCollar returns null when spot=0', noSpot === null);
  } catch (e) {
    fail('estimateCollar zero spot', e);
  }

  // ─── filterCapStrikes dedup behavior ───
  //
  // Need 2 caps that imply the same K_lo. Construct a fixture where two calls
  // (e.g. $100k and $110k) both end up at K_lo=$50k under the mm_margin=4%
  // budget. Only $110k should remain (highest cap per implied trigger wins).

  const dedupFixture: DeribitPricingMap = {
    BTC: {
      'BTC-26DEC25-100000-C': {
        bid_price: 0.05,
        ask_price: 0.052,
        mark_price: 0.051,
        underlying_price: 90000,
      },
      'BTC-26DEC25-110000-C': {
        bid_price: 0.05,
        ask_price: 0.052,
        mark_price: 0.051,
        underlying_price: 90000,
      },
      'BTC-26DEC25-50000-P': {
        ask_price: 0.045,
        mark_price: 0.044,
        underlying_price: 90000,
      },
    },
    ETH: {},
  };

  try {
    // Far-out expiry so the time filter (default minDurationDays=30) accepts it.
    // 26DEC25 = Dec 26, 2025. If we're past that, this fixture wouldn't pass the
    // duration filter; instead use a dynamic expiry.
    const futureDate = new Date(Date.now() + 90 * 86400 * 1000);
    const dd = String(futureDate.getUTCDate()).padStart(2, '0');
    const mm = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][
      futureDate.getUTCMonth()
    ];
    const yy = String(futureDate.getUTCFullYear() % 100).padStart(2, '0');
    const expiryLabel = `${dd}${mm}${yy}`;

    const futureFixture: DeribitPricingMap = {
      BTC: {
        [`BTC-${expiryLabel}-100000-C`]: dedupFixture.BTC!['BTC-26DEC25-100000-C']!,
        [`BTC-${expiryLabel}-110000-C`]: dedupFixture.BTC!['BTC-26DEC25-110000-C']!,
        [`BTC-${expiryLabel}-50000-P`]: dedupFixture.BTC!['BTC-26DEC25-50000-P']!,
      },
      ETH: {},
    };

    const groups = collar.filterCapStrikes(futureFixture, 'BTC', 90000, {
      ...collar.defaultSettings,
      collateralAmount: 0.5,
      minCapGapPct: 0, // disable gap filter for this test
    });
    const allCaps = groups.flatMap((g) => g.caps);
    const dedup = allCaps.filter((c) => c.estimate.putStrike === 50000);
    record(
      'filterCapStrikes dedups to single highest cap per K_lo',
      dedup.length === 1 && dedup[0]?.cap === 110000,
      `got ${dedup.length} caps at K_lo=50000, first cap=${dedup[0]?.cap}`,
    );
  } catch (e) {
    fail('filterCapStrikes dedup', e);
  }

  // ─── isDeployed gating on getMaxCapStrike ───
  try {
    const max = await collar.getMaxCapStrike('BTC');
    record('getMaxCapStrike returns null on undeployed coordinator', max === null);
  } catch (e) {
    fail('getMaxCapStrike', e);
  }

  // ─── Coordinator address is the placeholder we expect ───
  try {
    record(
      'COLLAR_CONFIG.contracts.collarCoordinator is zero placeholder',
      COLLAR_CONFIG.contracts.collarCoordinator === '0x0000000000000000000000000000000000000000',
    );
  } catch (e) {
    fail('coordinator placeholder check', e);
  }

  // ─── Default settings sanity ───
  try {
    record(
      'defaultSettings.minCapStrikeUsd === 0 (asset-aware fix)',
      collar.defaultSettings.minCapStrikeUsd === 0,
      `got ${collar.defaultSettings.minCapStrikeUsd}`,
    );
    record(
      'defaultSettings.mmMarginPct === 4',
      collar.defaultSettings.mmMarginPct === 4,
      `got ${collar.defaultSettings.mmMarginPct}`,
    );
  } catch (e) {
    fail('defaultSettings', e);
  }

  // ─── Live Deribit fetch (only with --live) ───

  if (RUN_LIVE) {
    console.log('\n--- LIVE Deribit fetch ---');
    try {
      const pricing = await collar.fetchPricing();
      record('fetchPricing returns BTC slot', !!pricing.BTC);
      record('fetchPricing returns ETH slot', !!pricing.ETH);
      const spotBtc = collar.extractUnderlyingPrice(pricing, 'BTC');
      const spotEth = collar.extractUnderlyingPrice(pricing, 'ETH');
      record('extractUnderlyingPrice(BTC) > 0', spotBtc > 0, `$${spotBtc}`);
      record('extractUnderlyingPrice(ETH) > 0', spotEth > 0, `$${spotEth}`);

      const groups = await collar.getCapStrikeOptions(
        'BTC',
        { ...collar.defaultSettings, collateralAmount: 0.5 },
        { pricingData: pricing, underlyingPrice: spotBtc },
      );
      const totalCaps = groups.reduce((sum, g) => sum + g.caps.length, 0);
      record('getCapStrikeOptions(BTC, 0.5) returns ≥1 cap row', totalCaps > 0, `${totalCaps} rows across ${groups.length} expiries`);

      // ETH path — must not regress under asset-aware fix
      const ethGroups = await collar.getCapStrikeOptions(
        'ETH',
        { ...collar.defaultSettings, collateralAmount: 1.0 },
        { pricingData: pricing, underlyingPrice: spotEth },
      );
      const ethCaps = ethGroups.reduce((sum, g) => sum + g.caps.length, 0);
      record('getCapStrikeOptions(ETH, 1.0) returns ≥1 cap row (regression check)', ethCaps > 0, `${ethCaps} rows across ${ethGroups.length} expiries`);
    } catch (e) {
      fail('live Deribit', e);
    }
  } else {
    console.log('\n(skipping live Deribit — re-run with --live to include)');
  }

  // ─── Summary ───
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`\n${passed}/${total} passed`);
  if (passed !== total) {
    console.log('FAILED:');
    for (const r of results) {
      if (!r.passed) console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('runner crashed:', e);
  process.exit(2);
});
