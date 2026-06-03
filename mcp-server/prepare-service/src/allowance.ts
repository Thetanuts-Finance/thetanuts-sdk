import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { PreparedTx } from './types.js';
import { BASE_CHAIN_ID } from './sdk.js';

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Bundle a token approval as the first step of a batch if and only if the
 * caller's existing allowance falls short of `required`. Returns a possibly-
 * empty list to prepend to the main action's tx list.
 *
 * Uses `MAX_UINT256` when approving — same approach as the existing CLI/UI,
 * avoids constant re-approvals for repeat traders. Reset to 0 first is not
 * needed for standard ERC20 (no USDT-style requirement on Base collateral).
 */
export async function maybeApproveTx(
  client: ThetanutsClient,
  opts: { owner: string; token: string; spender: string; required: bigint },
): Promise<PreparedTx[]> {
  const allowance = await client.erc20.getAllowance(opts.token, opts.owner, opts.spender);
  if (allowance >= opts.required) return [];

  const encoded = client.erc20.encodeApprove(opts.token, opts.spender, MAX_UINT256);
  return [
    {
      step: 'approve',
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
      value: '0x0',
      chainId: BASE_CHAIN_ID,
    },
  ];
}
