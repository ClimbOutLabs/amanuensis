import type { InternalToolCallInfo } from '../llm/LLMTypes';

/**
 * One tool call as the model authored it, offered to the host policy for review.
 */
export interface HostToolCallPolicyCall {
  /**
   * Function name the model invoked. This may be a dispatcher (such as
   * `call_tool`) rather than the tool that will actually run.
   */
  functionName: string;
  /**
   * Underlying tool name resolved by the host when the call was dispatched
   * through another tool (e.g. `web_search` reached via `call_tool`).
   * Undefined when the host could not resolve one.
   */
  underlyingToolName: string | undefined;
  /**
   * Parsed tool arguments. Hallucinated JSON degrades to `{}` here, never throws.
   */
  args: Record<string, unknown>;
}

/**
 * The host's verdict on a tool call: block it, with `message` delivered to the
 * model as the tool's error result.
 */
export interface HostToolCallPolicyBlock {
  message: string;
}

/**
 * Synchronous per-turn host policy over tool calls. Consulted during
 * assistant-message enrichment, before any provider dispatch. Return a block to
 * resolve the call as `policy_blocked` with `message` as the tool error result;
 * return undefined to leave the call untouched.
 *
 * Must be cheap and infallible: it runs on every tool call of every turn, and a
 * throwing policy fails open (the call proceeds unblocked).
 */
export type HostToolCallPolicy = (call: HostToolCallPolicyCall) => HostToolCallPolicyBlock | undefined;

/**
 * Minimal logger surface for policy failure reporting; winston's Logger
 * satisfies it structurally.
 */
export interface HostToolCallPolicyLogger {
  warn(message: string, ...meta: unknown[]): void;
}

/**
 * Applies the host tool-call policy to one enriched call. Stamps
 * `pre_dispatch_failure: { kind: 'policy_blocked', message }` when the policy
 * blocks; otherwise returns the input unchanged. An existing pre-dispatch
 * failure always wins: the policy can only add a block, never clear one.
 *
 * A throwing policy, or a policy returning a malformed block, fails open —
 * loudly: the failure is logged so a broken policy is visible instead of
 * silently passing every call.
 */
export function applyHostToolCallPolicy(input: {
  call: HostToolCallPolicyCall;
  toolInfo: InternalToolCallInfo;
  policy: HostToolCallPolicy | undefined;
  logger: HostToolCallPolicyLogger | undefined;
}): InternalToolCallInfo {
  const { call, toolInfo, policy, logger } = input;
  if (policy === undefined || toolInfo.pre_dispatch_failure !== undefined) {
    return toolInfo;
  }
  let block: HostToolCallPolicyBlock | undefined;
  try {
    block = policy(call);
  } catch (error) {
    // A host policy must never fail the turn: fail open, but loudly — a
    // silently-throwing policy would be invisible in production.
    logger?.warn('Host tool-call policy threw; failing open and allowing the call', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return toolInfo;
  }
  if (block === undefined) {
    return toolInfo;
  }
  if (typeof block.message !== 'string' || block.message.length === 0) {
    // A malformed block must not be stamped as the tool error: fail open,
    // loudly, so the broken policy gets fixed instead of confusing the model.
    logger?.warn('Host tool-call policy returned a malformed block; failing open and allowing the call');
    return toolInfo;
  }
  // A blocked call never dispatches, so there is nothing left to approve: an
  // approval prompt stamped earlier (e.g. by permission classification) must
  // not pause the turn on it.
  return {
    ...toolInfo,
    is_approval_required: false,
    pre_dispatch_failure: { kind: 'policy_blocked', message: block.message },
  };
}
