import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';

/**
 * Find the exact signed order in a refreshed book.
 *
 * Odette reuses a nonce across batches of orders, so `(maker, nonce)` is not a
 * unique identity. The EIP-712 signature commits to the complete order and is
 * stable when list indices move or available liquidity changes.
 */
export function findSignedOrder(
  orders: OrderWithSignature[],
  reference: OrderWithSignature
): OrderWithSignature | undefined {
  const maker = reference.order.maker.toLowerCase();
  const signature = reference.signature.toLowerCase();
  return orders.find(
    (candidate) =>
      candidate.order.maker.toLowerCase() === maker &&
      candidate.signature.toLowerCase() === signature
  );
}
