import type { OrderWithSignature } from '@thetanuts-finance/thetanuts-client';

/**
 * The CLI currently supports cash-settled, USDC-collateralized OptionBook
 * purchases only. Keep the accepted implementation names explicit: physical
 * PUTs may also use USDC, so collateral filtering alone is not sufficient.
 */
const CASH_SETTLED_IMPLEMENTATION_KEYS = [
  'PUT',
  'LINEAR_CALL',
  'CALL_SPREAD',
  'PUT_SPREAD',
  'CALL_FLY',
  'PUT_FLY',
  'CALL_CONDOR',
  'PUT_CONDOR',
  'IRON_CONDOR',
  'RANGER',
] as const;

export const ORDER_PRICE_DECIMALS = 8;

export interface BookEligibilityPolicy {
  usdcAddress: string;
  cashSettledImplementations: ReadonlySet<string>;
  now: number;
  direction: 'buy' | 'sell';
}

export type BookOrderIneligibility =
  | 'missing-order-data'
  | 'wrong-collateral'
  | 'unsupported-implementation'
  | 'wrong-side'
  | 'expired-option'
  | 'expired-order'
  | 'invalid-price'
  | 'no-liquidity';

/** Build the current-chain allowlist while dropping undeployed zero addresses. */
export function cashSettledImplementationSet(
  implementations: object
): ReadonlySet<string> {
  const values = implementations as Record<string, string | undefined>;
  const accepted = new Set<string>();
  for (const key of CASH_SETTLED_IMPLEMENTATION_KEYS) {
    const address = values[key];
    if (
      address &&
      address.toLowerCase() !== '0x0000000000000000000000000000000000000000'
    ) {
      accepted.add(address.toLowerCase());
    }
  }
  return accepted;
}

/**
 * Return the first reason an order is unsafe for the requested taker side.
 *
 * Odette's OptionBook semantics are:
 *   isLong=false -> maker is the seller -> taker can BUY (an ask)
 *   isLong=true  -> maker is the buyer  -> taker can SELL (a bid)
 *
 * This is deliberately based on rawApiData.isLong rather than the SDK's legacy
 * `order.isBuyer` compatibility field, whose Odette mapping was historically
 * reversed in `normalizeOdetteOrder`.
 */
export function bookOrderIneligibility(
  order: OrderWithSignature,
  policy: BookEligibilityPolicy
): BookOrderIneligibility | null {
  const raw = order.rawApiData;
  if (!raw) return 'missing-order-data';

  if (raw.collateral.toLowerCase() !== policy.usdcAddress.toLowerCase()) {
    return 'wrong-collateral';
  }
  if (!policy.cashSettledImplementations.has(raw.implementation.toLowerCase())) {
    return 'unsupported-implementation';
  }

  const makerIsLong = raw.isLong;
  const requiredMakerIsLong = policy.direction === 'sell';
  if (makerIsLong !== requiredMakerIsLong) return 'wrong-side';

  if (Number(order.order.expiry) <= policy.now) return 'expired-option';
  if (raw.orderExpiryTimestamp <= policy.now) return 'expired-order';
  if (order.order.price <= 0n) return 'invalid-price';
  if (order.availableAmount <= 0n) return 'no-liquidity';

  return null;
}

export function isEligibleBookOrder(
  order: OrderWithSignature,
  policy: BookEligibilityPolicy
): boolean {
  return bookOrderIneligibility(order, policy) === null;
}

