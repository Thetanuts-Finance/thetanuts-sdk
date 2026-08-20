/**
 * End-to-end verifier for the two reported CLI defects.
 *
 *   1. `book check` recommending RFQ for strikes that are live and fillable
 *      (routes traders off the book and forfeits orderbook credit).
 *   2. No `--referrer` anywhere, so every fill was attributed to address(0).
 *
 * Everything is derived from the live book at run time — no hardcoded strikes
 * or expiries — so this stays valid as the book turns over.
 *
 *   cd cli && npx tsx scripts/verify-book-fixes.ts
 *
 * Exits 0 only if every check passes.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import { cashSettledImplementationSet, isEligibleBookOrder } from '../src/bookEligibility.js';
import { computeCheckResult } from '../src/bookCheck.js';
import { orderStrikesRaw, orderStrikesUsd } from '../src/bookMatch.js';

const RPC = process.env.THETANUTS_RPC_URL ?? 'https://mainnet.base.org';
const REF_A = '0x1111111111111111111111111111111111111111';
const REF_B = '0x2222222222222222222222222222222222222222';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function cli(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('npx', ['tsx', 'src/index.ts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function cliJson(args: string[], env: NodeJS.ProcessEnv = {}): any {
  return JSON.parse(cli([...args, '--output', 'json'], env));
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC);
  const client: any = new ThetanutsClient({ chainId: 8453, provider });
  const all = await client.api.fetchOrders();
  const policy = {
    usdcAddress: client.chainConfig.tokens.USDC.address,
    cashSettledImplementations: cashSettledImplementationSet(client.chainConfig.implementations),
    now: Math.floor(Date.now() / 1000),
    direction: 'buy' as const,
  };
  const orders = (all as any[]).filter((o) => isEligibleBookOrder(o, policy));

  const symbolOf: Record<string, string> = {};
  for (const [k, v] of Object.entries(client.chainConfig.priceFeeds as Record<string, string>)) {
    if (!k.includes('/') && !symbolOf[v.toLowerCase()]) symbolOf[v.toLowerCase()] = k;
  }

  console.log(`\nLive book: ${all.length} orders, ${orders.length} eligible for cash-settled USDC buys\n`);

  // ---------------------------------------------------------------- DEFECT 1
  console.log('DEFECT 1 — "book check recommends RFQ for strikes that are live and fillable"\n');

  const ctxFor = (feed: string) => ({
    priceFeed: feed,
    implementations: client.chainConfig.optionImplementations,
    maxContracts: (o: any) => client.optionBook.calculateMaxContracts(o),
    contractScale: 10 ** (client.chainConfig.tokens.USDC?.decimals ?? 6),
    cliExecutable: true,
  });

  let probes = 0;
  let routedToRfq = 0;
  let viaVanilla = 0;
  let viaStructure = 0;
  const violations: string[] = [];

  for (const o of orders) {
    const feed = o.rawApiData.priceFeed.toLowerCase();
    const underlying = symbolOf[feed];
    if (!underlying) continue;
    const type: 'PUT' | 'CALL' = o.rawApiData.isCall ? 'CALL' : 'PUT';
    const expiry = Number(o.order.expiry);
    for (const raw of orderStrikesRaw(o)) {
      const strike = Number(raw) / 1e8;
      const r = computeCheckResult(orders, { underlying, type, strike, expiry, direction: 'buy' }, ctxFor(feed));
      probes += 1;
      if (r.recommendation === 'rfq') {
        routedToRfq += 1;
        if (violations.length < 5) violations.push(`${underlying} ${type} $${strike} @ ${expiry}`);
      } else if (r.orderbookOrders.length > 0) viaVanilla += 1;
      else viaStructure += 1;
    }
  }

  check(
    'no live, fillable strike is routed to RFQ',
    routedToRfq === 0,
    `${probes} strike positions probed; ${routedToRfq} routed to RFQ${violations.length ? ` (${violations.join('; ')})` : ''}`
  );
  console.log(`        matched as exact vanilla: ${viaVanilla}`);
  console.log(`        matched as structure leg: ${viaStructure}  <- what the old check could not see`);

  // Converse: strikes the book genuinely lacks must never be claimed as fillable.
  let phantomClaimed = 0;
  for (const o of orders.slice(0, 80)) {
    const feed = o.rawApiData.priceFeed.toLowerCase();
    const underlying = symbolOf[feed];
    if (!underlying) continue;
    const type: 'PUT' | 'CALL' = o.rawApiData.isCall ? 'CALL' : 'PUT';
    const strike = orderStrikesUsd(o)[0]! * 1.37 + 7; // nowhere near a listed strike
    const r = computeCheckResult(
      orders,
      { underlying, type, strike, expiry: Number(o.order.expiry), direction: 'buy' },
      ctxFor(feed)
    );
    if (r.recommendation !== 'rfq') phantomClaimed += 1;
  }
  check('strikes the book lacks are NOT claimed as fillable', phantomClaimed === 0, `${phantomClaimed} false positives`);

  // Sell side: the book carries bids, the CLI executes buys only. An
  // "orderbook" recommendation must never hand back an RFQ command — that is
  // the off-book route this branch exists to avoid — and no per-structure step
  // may be a `book preview` command, since preview filters to asks.
  const sellOrders = (all as any[]).filter((o) =>
    isEligibleBookOrder(o, { ...policy, direction: 'sell' as const })
  );
  let sellProbes = 0;
  let sellRfqSteps = 0;
  let sellBuyOnlySteps = 0;
  for (const o of sellOrders) {
    const feed = o.rawApiData.priceFeed.toLowerCase();
    const underlying = symbolOf[feed];
    if (!underlying) continue;
    const type: 'PUT' | 'CALL' = o.rawApiData.isCall ? 'CALL' : 'PUT';
    const expiry = Number(o.order.expiry);
    for (const raw of orderStrikesRaw(o)) {
      const r = computeCheckResult(
        sellOrders,
        { underlying, type, strike: Number(raw) / 1e8, expiry, direction: 'sell' },
        { ...ctxFor(feed), cliExecutable: false }
      );
      if (r.recommendation !== 'orderbook') continue;
      sellProbes += 1;
      if (r.nextStep.includes('rfq build')) sellRfqSteps += 1;
      if (r.structureMatches.some((m) => m.nextStep.includes('book preview'))) {
        sellBuyOnlySteps += 1;
      }
    }
  }
  check(
    'sell-side book liquidity never produces an RFQ next step',
    sellRfqSteps === 0,
    `${sellProbes} sell-side orderbook results; ${sellRfqSteps} routed to RFQ`
  );
  check(
    'sell-side results emit no buy-only preview commands',
    sellBuyOnlySteps === 0,
    `${sellBuyOnlySteps} buy-only steps on sell results`
  );

  // Round-trip: whatever `check` tells you to run next must actually run.
  const structureOrder = orders.find(
    (o) => orderStrikesUsd(o).length > 1 && symbolOf[o.rawApiData.priceFeed.toLowerCase()]
  );
  if (!structureOrder) {
    console.log('  SKIP  no multi-leg order on the book right now');
  } else {
    const underlying = symbolOf[structureOrder.rawApiData.priceFeed.toLowerCase()]!;
    const type = structureOrder.rawApiData.isCall ? 'CALL' : 'PUT';
    const expiry = Number(structureOrder.order.expiry);
    const legStrike = orderStrikesUsd(structureOrder).at(-1)!; // a NON-first leg
    const res = cliJson([
      'book', 'check',
      '--underlying', underlying, '--type', type,
      '--strike', String(legStrike), '--expiry', String(expiry),
      '--direction', 'buy',
    ]);
    check(
      `structure-leg strike (${underlying} ${type} $${legStrike}) reports orderbook, not rfq`,
      res.recommendation === 'orderbook',
      `got "${res.recommendation}"`
    );
    check(
      'ticker is structure-honest (no fake vanilla suffix)',
      res.structureMatches.length === 0 || !/-[CP]$/.test(res.structureMatches[0].ticker),
      res.structureMatches[0]?.ticker ?? 'n/a'
    );
    // Structure-only results deliberately emit no top-level command: several
    // structures can share a strike and their payoffs are not rankable by
    // premium, so the caller picks. The runnable command then lives on the
    // chosen match. Whichever path applies, the command must execute.
    const step: string | undefined = res.nextStepIsCommand
      ? res.nextStep
      : res.structureMatches.find((m: { nextStepIsCommand: boolean }) => m.nextStepIsCommand)
          ?.nextStep;
    check(
      'a structure-only result emits no auto-selected top-level command',
      res.orderbookOrders.length > 0 || res.nextStepIsCommand === false,
      `nextStepIsCommand=${res.nextStepIsCommand}`
    );
    let ran = false;
    if (step !== undefined) {
      const args = step.replace(/^thetanuts\s+/, '').replace('<amount>', '1').split(/\s+/);
      try {
        const out = cliJson(args);
        ran = typeof out.pricePerContract === 'string';
      } catch {
        ran = false;
      }
    }
    check(
      "check's own next step actually executes",
      ran,
      ran ? step! : `FAILED: ${step ?? 'no runnable command emitted'}`
    );
  }

  // Strike order must not matter (19 live orders store strikes descending).
  const descending = orders.find((o) => {
    const s = orderStrikesRaw(o);
    return s.length > 1 && s.some((v, i) => i > 0 && v < s[i - 1]!) && symbolOf[o.rawApiData.priceFeed.toLowerCase()];
  });
  if (!descending) {
    console.log('  SKIP  no descending-strike order on the book right now');
  } else {
    const underlying = symbolOf[descending.rawApiData.priceFeed.toLowerCase()]!;
    const type = descending.rawApiData.isCall ? 'CALL' : 'PUT';
    const expiry = Number(descending.order.expiry);
    const asc = [...orderStrikesUsd(descending)].sort((a, b) => a - b).join(',');
    let ok = false;
    try {
      const out = cliJson([
        'book', 'preview', '--underlying', underlying, '--type', type,
        '--strikes', asc, '--expiry', String(expiry), '--collateral', '1',
      ]);
      ok = typeof out.pricePerContract === 'string';
    } catch {
      ok = false;
    }
    check(`ascending --strikes ${asc} matches a descending-stored order`, ok);
  }

  // ---------------------------------------------------------------- DEFECT 2
  console.log('\nDEFECT 2 — "no --referrer anywhere"\n');

  const vanilla = orders.find(
    (o) => orderStrikesUsd(o).length === 1 && symbolOf[o.rawApiData.priceFeed.toLowerCase()]
  );
  if (!vanilla) {
    console.log('  SKIP  no vanilla order on the book right now');
  } else {
    const underlying = symbolOf[vanilla.rawApiData.priceFeed.toLowerCase()]!;
    const type = vanilla.rawApiData.isCall ? 'CALL' : 'PUT';
    const strike = String(orderStrikesUsd(vanilla)[0]);
    const expiry = String(Number(vanilla.order.expiry));
    const base = [
      'book', 'preview', '--underlying', underlying, '--type', type,
      '--strike', strike, '--expiry', expiry, '--collateral', '1',
    ];

    check('--referrer flag exists and is honored',
      cliJson(['--referrer', REF_A, ...base]).referrer.toLowerCase() === REF_A, REF_A);
    check('unset referrer still reports address(0)',
      cliJson(base).referrer === ethers.ZeroAddress);
    check('flag beats THETANUTS_REFERRER env',
      cliJson(['--referrer', REF_A, ...base], { THETANUTS_REFERRER: REF_B }).referrer.toLowerCase() === REF_A);
    check('env var is honored on its own',
      cliJson(base, { THETANUTS_REFERRER: REF_B }).referrer.toLowerCase() === REF_B);

    let rejected = false;
    try { cli(['--referrer', '0xNOTANADDRESS', ...base]); } catch { rejected = true; }
    check('invalid referrer address is rejected', rejected);

    // The one that actually matters: does it reach the transaction?
    const throwaway = '0x' + '1'.repeat(63) + '2';
    let inCalldata = false;
    try {
      const out = cli([
        '--private-key', throwaway, '--referrer', REF_A, '--dry-run', '--yes',
        'book', 'fill', '--underlying', underlying, '--type', type,
        '--strike', strike, '--expiry', expiry, '--collateral', '1', '--output', 'json',
      ]);
      inCalldata = out.toLowerCase().includes(REF_A.slice(2).toLowerCase());
    } catch (e: any) {
      inCalldata = String(e.stdout ?? '').toLowerCase().includes(REF_A.slice(2).toLowerCase());
    }
    check('referrer is embedded in the fill calldata', inCalldata, 'dry-run, never broadcast');

    const noRef = spawnSync(
      'npx',
      ['tsx', 'src/index.ts',
        '--private-key', throwaway, '--dry-run', '--yes',
        'book', 'fill', '--underlying', underlying, '--type', type,
        '--strike', strike, '--expiry', expiry, '--collateral', '1'],
      { encoding: 'utf8' }
    );
    check(
      'fill warns on stderr when no referrer is set',
      String(noRef.stderr).includes('no referrer configured')
    );

    const withRef = spawnSync(
      'npx',
      ['tsx', 'src/index.ts',
        '--private-key', throwaway, '--referrer', REF_A, '--dry-run', '--yes',
        'book', 'fill', '--underlying', underlying, '--type', type,
        '--strike', strike, '--expiry', expiry, '--collateral', '1'],
      { encoding: 'utf8' }
    );
    check(
      'no warning once a referrer IS set',
      !String(withRef.stderr).includes('no referrer configured')
    );
  }

  console.log(
    failures === 0
      ? '\n\x1b[32mAll checks passed.\x1b[0m No trade was broadcast — every fill ran with --dry-run.\n'
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
