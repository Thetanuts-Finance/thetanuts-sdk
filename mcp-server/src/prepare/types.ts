/**
 * Wire types for prepare endpoint responses.
 *
 * Shaped to be passed DIRECTLY into Base MCP's `send_calls` tool. Per
 * docs.base.org/ai-agents/skills/references/batch-calls:
 *
 *   send_calls({ chain: "base" | "base-sepolia" | ..., calls: [{to, value?, data?}] })
 *
 * - `chain` is a STRING name (not numeric chainId).
 * - Each call is `{ to, data, value? }`. Base MCP ignores extra fields;
 *   we keep `step` for human-readable display before user approval.
 *
 * Wrap your call to send_calls like:
 *   const prep = await web_request("http://localhost:8787/v1/prepare/fill-order", { ... });
 *   await send_calls({ chain: prep.chain, calls: prep.calls });
 */

export interface PreparedCall {
  /** Human-readable label for what this call does (e.g. "approve", "fillOrder"). Display to the user before approval. */
  step: string;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Hex wei value, defaults to "0x0" if omitted. */
  value?: `0x${string}`;
}

export interface PrepareResponse {
  /** Chain name string as Base MCP's send_calls expects. */
  chain: 'base' | 'base-sepolia';
  /** Ordered batch — user approves them in this order. */
  calls: PreparedCall[];
  /** Optional pre-flight simulation result for the LLM to display. */
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
