import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ThetanutsClient } from '@thetanuts-finance/thetanuts-client';
import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';
import type { PrepareResponse, PreparedTx } from '../types.js';
import { BASE_CHAIN_ID } from '../sdk.js';
import { maybeApproveTx } from '../allowance.js';
import { toClientError } from '../errors.js';

const FillOrderBody = z.object({
  from: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  orderId: z.number().int().nonnegative(),
  usdcAmount: z
    .string()
    .regex(/^\d+$/)
    .optional(),
  referrer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

export function fillOrderHandler(client: ThetanutsClient) {
  return async (req: Request, res: Response) => {
    const parsed = FillOrderBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT', error: parsed.error.message });
    }
    const { from, orderId, usdcAmount, referrer } = parsed.data;

    let order: OrderWithSignature | undefined;
    try {
      const orders = await client.api.fetchOrders();
      order = orders[orderId];
    } catch (err) {
      const { client, log } = toClientError(err);
      console.error('ORDER_FETCH_FAILED', log);
      return res.status(502).json(client);
    }
    if (!order) {
      return res
        .status(404)
        .json({ ok: false, code: 'ORDER_NOT_FOUND', error: `No order at index ${orderId}` });
    }

    const collateralToken = order.order.collateralToken;
    if (!collateralToken) {
      return res.status(500).json({
        ok: false,
        code: 'ORDER_MISSING_COLLATERAL',
        error: 'Order is missing collateralToken — cannot determine approval target',
      });
    }

    const encoded = client.optionBook.encodeFillOrder(
      order,
      usdcAmount ? BigInt(usdcAmount) : undefined,
      referrer,
    );

    // Approval threshold: the taker's spend in collateralToken decimals. If
    // usdcAmount is unspecified, we approve for the order's max fill so the
    // user doesn't need to re-approve on a partial-then-full fill.
    const required = usdcAmount
      ? BigInt(usdcAmount)
      : order.order.numContracts * order.order.price;

    const approval = await maybeApproveTx(client, {
      owner: from,
      token: collateralToken,
      spender: encoded.to,
      required,
    });

    const action: PreparedTx = {
      step: 'fillOrder',
      to: encoded.to as `0x${string}`,
      data: encoded.data as `0x${string}`,
      value: '0x0',
      chainId: BASE_CHAIN_ID,
    };

    const response: PrepareResponse = { transactions: [...approval, action] };
    res.json(response);
  };
}
