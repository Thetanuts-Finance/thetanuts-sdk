import { randomBytes } from 'node:crypto';
import { ThetanutsError } from '@thetanuts-finance/thetanuts-client';

/**
 * Error envelope returned to the client.
 *
 * We map ThetanutsError instances (which carry vetted, structured codes
 * and messages from the SDK) through verbatim, and turn everything else
 * into an opaque `INTERNAL` with a request id so support can correlate
 * against server logs. This prevents accidentally leaking upstream RPC
 * URLs, axios stack traces, or sqlite internals to LLM callers.
 */
export interface SafeError {
  ok: false;
  code: string;
  error: string;
  requestId?: string;
}

/** Allowlist of route-defined codes that are safe to surface as-is. */
const SAFE_ROUTE_CODES = new Set<string>([
  'INVALID_INPUT',
  'AUTH_REQUIRED',
  'AUTH_MALFORMED',
  'AUTH_WALLET_MISMATCH',
  'AUTH_INVALID',
  'AUTH_BAD_SIGNATURE',
  'AUTH_REPLAY',
  'RFQ_NOT_FOUND',
  'OFFER_NOT_FOUND',
  'ORDER_NOT_FOUND',
  'ORDER_FETCH_FAILED',
  'ORDER_MISSING_COLLATERAL',
  'TYPEHASH_MISMATCH',
  'DECRYPT_FAILED',
  'NOT_IMPLEMENTED_V1',
]);

function newRequestId(): string {
  return 'req_' + randomBytes(8).toString('hex');
}

/**
 * Convert any thrown value into a safe client envelope + the original
 * for server logs. Pass the result of the original throw site verbatim.
 *
 * Usage:
 *   const { client, log } = toClientError(err);
 *   console.error(log);
 *   return res.status(client.requestId ? 500 : 400).json(client);
 *
 * Callers that want to attach their own code/status should use
 * `safeError(code, message)` instead.
 */
export function toClientError(err: unknown): { client: SafeError; log: { requestId: string; raw: unknown } } {
  const requestId = newRequestId();
  if (err instanceof ThetanutsError) {
    return {
      client: { ok: false, code: err.code, error: err.message },
      log: { requestId, raw: err },
    };
  }
  return {
    client: { ok: false, code: 'INTERNAL', error: 'Internal error', requestId },
    log: { requestId, raw: err },
  };
}

/** Build a route-defined error envelope with one of the allowlisted codes. */
export function safeError(code: string, error: string): SafeError {
  if (!SAFE_ROUTE_CODES.has(code)) {
    // Forcing this to INTERNAL means a typo in a route can't accidentally
    // ship a never-allowlisted code that leaks data through its name.
    return { ok: false, code: 'INTERNAL', error: 'Internal error', requestId: newRequestId() };
  }
  return { ok: false, code, error };
}
