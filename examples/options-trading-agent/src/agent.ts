/**
 * Premium-hunter agent — covered-call writer that reads the IV surface,
 * picks an attractive expiry, posts an RFQ, watches for offers, and
 * settles. End-to-end demonstration of @thetanuts-finance/agentkit
 * driven by the Vercel AI SDK against Anthropic Claude.
 *
 * Run with:
 *   cp .env.example .env       # fill in the keys
 *   npm install
 *   npm run dry-run            # first pass — no chain writes
 *   npm start                  # actually trade
 *
 * Read the README before running on mainnet with real funds.
 */

import 'dotenv/config';
import { generateText, type CoreMessage } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { AgentKit, CdpEvmWalletProvider, type ActionProvider, type WalletProvider } from '@coinbase/agentkit';
import { getVercelAITools } from '@coinbase/agentkit-vercel-ai-sdk';
import { thetanutsActionProvider } from '@thetanuts-finance/agentkit';

const DRY_RUN = process.env.DRY_RUN === 'true';
const MODEL = 'claude-opus-4-7';
// Safety budget. The agent is allowed to write at most this notional per
// individual action, and this is the operating ceiling for the example.
// Conservative on purpose — bump after you trust the loop.
const MAX_NOTIONAL_USDC_PER_ACTION = 25_000_000n; // $25

async function buildAgent() {
  const required = ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET', 'ANTHROPIC_API_KEY'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing env: ${missing.join(', ')}. See .env.example.`);
  }

  // CDP MPC wallet — the agent never holds the private key material.
  const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
    apiKeyId: process.env.CDP_API_KEY_ID!,
    apiKeySecret: process.env.CDP_API_KEY_SECRET!,
    walletSecret: process.env.CDP_WALLET_SECRET!,
    networkId: 'base-mainnet',
  });

  const address = await walletProvider.getAddress();
  console.log(`[agent] wallet=${address} dry_run=${DRY_RUN}`);

  // The action provider's generic narrows to EvmWalletProvider; AgentKit's
  // collection widens to the base WalletProvider. The cast is safe because
  // CdpEvmWalletProvider IS an EvmWalletProvider.
  const thetanuts = thetanutsActionProvider({
    rpcUrl: process.env.BASE_RPC_URL,
    safetyLimits: {
      maxNotionalUsdcPerAction: MAX_NOTIONAL_USDC_PER_ACTION,
      maxApprovalAmount: 'exact',
      allowedCollateral: ['USDC'],
      // Host gate. In dry-run mode we reject every write here — the
      // LLM still plans and reasons but no transaction lands. In
      // normal mode we log every attempt for the audit trail.
      onWriteAction: (ctx) => {
        console.log(`[safety] ${ctx.action} amount=${ctx.amount.toString()} token=${ctx.token}`);
        if (DRY_RUN) return 'reject';
        return 'allow';
      },
    },
  });

  const agentkit = await AgentKit.from({
    walletProvider,
    actionProviders: [thetanuts as unknown as ActionProvider<WalletProvider>],
  });

  return { agentkit, address };
}

async function main() {
  const { agentkit, address } = await buildAgent();
  const tools = getVercelAITools(agentkit);

  const systemPrompt = [
    'You are a Thetanuts options-trading agent on Base mainnet.',
    `Your wallet is ${address}. Trade conservatively.`,
    'Operating constraints (hard limits enforced in code):',
    `- Max notional per action: ${MAX_NOTIONAL_USDC_PER_ACTION} USDC base units (=$${Number(MAX_NOTIONAL_USDC_PER_ACTION) / 1_000_000}).`,
    '- Collateral token: USDC only.',
    '- One open RFQ at a time. Cancel before opening a new one.',
    '',
    'Standing strategy: hunt for short-dated covered calls on ETH where the implied',
    'volatility (from get_market_prices and the SDK pricing) suggests above-mark',
    'premium. Prefer expiries 3-7 days out. Strikes 5-15% out of the money.',
    '',
    'Loop:',
    '1. get_market_prices — read the current ETH oracle price.',
    '2. get_user_positions — confirm we have no open RFQ or competing position.',
    '3. If no open position: choose a strike + expiry and call request_rfq with',
    '   isRequestingLongPosition=false (we are SELLING the call) and a reservePrice',
    '   you believe is fair given the IV. Use a 30-minute offerEndTimestamp.',
    '4. Wait 60 seconds, then call get_rfq to check for offers.',
    '5. If an offer arrived and its revealedAmount (once status=revealed) clears',
    '   our reserve, call settle_rfq_early with the offerorAddress.',
    '6. If 30 minutes have passed with no acceptable offer, call cancel_rfq.',
    '',
    'When you finish a full cycle, output a one-line summary and stop. Do NOT',
    'loop indefinitely — one cycle per invocation.',
    DRY_RUN ? 'NOTE: Dry-run mode. Every write will be REJECTED by safety policy. Plan but expect refusals.' : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: CoreMessage[] = [
    {
      role: 'user',
      content:
        'Run one full premium-hunting cycle now. Report the quotation ID you opened, ' +
        'the offer (if any) you settled, or "no trade" with a reason.',
    },
  ];

  const result = await generateText({
    model: anthropic(MODEL),
    system: systemPrompt,
    messages,
    tools,
    maxSteps: 12,
  });

  console.log('\n=== agent text ===');
  console.log(result.text);
  console.log('\n=== tool calls ===');
  for (const call of result.toolCalls) {
    console.log(`- ${call.toolName}(${JSON.stringify(call.args)})`);
  }
  console.log('\n=== usage ===');
  console.log(result.usage);
}

main().catch((err) => {
  console.error('agent failed:', err);
  process.exit(1);
});
