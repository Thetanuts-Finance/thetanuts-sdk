import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { PreparedCall } from './types.js';

/**
 * Bundle a token approval as the first step of a batch if and only if the
 * caller's existing allowance falls short of `required`. Returns a possibly-
 * empty list to prepend to the main action's call list.
 *
 * Approves the exact required amount. Unlimited approvals are too broad for
 * an LLM-prepared transaction bundle because the signer UI may only display
 * the high-level RFQ action.
 */
export async function maybeApproveCall(
  client: ThetanutsClient,
  opts: { owner: string; token: string; spender: string; required: bigint },
): Promise<PreparedCall[]> {
  const allowance = await client.erc20.getAllowance(opts.token, opts.owner, opts.spender);
  if (allowance >= opts.required) return [];

  const encoded = client.erc20.encodeApprove(opts.token, opts.spender, opts.required);
  return [
    {
      step: 'approve',
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
      value: '0x0',
    },
  ];
}
