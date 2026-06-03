/**
 * Wire types for prepare endpoint responses.
 *
 * All endpoints return the ordered-batch shape so a single response can bundle
 * approval + action, matching Base MCP's `send_calls` input shape.
 */

export interface PreparedTx {
  step: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  chainId: number;
}

export interface PrepareResponse {
  transactions: PreparedTx[];
  simulation?: {
    status: 'ok' | 'revert' | 'unknown';
    gas?: string;
    revertReason?: string;
  };
}

export interface PrepareError {
  ok: false;
  error: string;
  code: string;
}
