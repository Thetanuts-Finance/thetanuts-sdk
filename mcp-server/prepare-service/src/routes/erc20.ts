import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { PrepareResponse } from '../types.js';
import { BASE_CHAIN_ID } from '../sdk.js';

const ApproveBody = z.object({
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  spender: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().regex(/^\d+$/),
});

export function approveHandler(client: ThetanutsClient) {
  return (req: Request, res: Response) => {
    const parsed = ApproveBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const { token, spender, amount } = parsed.data;
    const encoded = client.erc20.encodeApprove(token, spender, BigInt(amount));
    const response: PrepareResponse = {
      transactions: [
        {
          step: 'approve',
          to: encoded.to as `0x${string}`,
          data: encoded.data as `0x${string}`,
          value: '0x0',
          chainId: BASE_CHAIN_ID,
        },
      ],
    };
    res.json(response);
  };
}
