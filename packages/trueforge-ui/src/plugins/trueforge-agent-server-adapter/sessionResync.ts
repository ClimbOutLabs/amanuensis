/**
 * Session tip probe + pending-approval escape hatch for the harness chat server.
 *
 * After a background/foreground cycle the client can miss approvals that
 * arrived server-side; the server's 422 then blocks sends with no way out.
 * `peekSessionTip` reads only the newest turn so a foreground check can
 * decide whether a full re-sync is needed; `dismissPendingApprovals` denies
 * every still-pending approval in one continuation turn (fail-closed: nothing
 * here can approve a tool call the user did not explicitly approve).
 */
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

import type { HeldActionOutcome } from '../../sentinel/heldActionErrors.js';

/** One tool call still waiting for a human decision on the session tip turn. */
export interface PendingApprovalInfo {
  /** Tool call id awaiting the decision. */
  toolCallId: string;
  /** Thread that owns the pending tool call. */
  threadId: string;
  /** ISO 8601 timestamp of the `tool.approval_required` event. */
  createdAt: string;
}

/** The newest turn in a session, read without loading the session itself. */
export interface SessionTipInfo {
  turnId: string;
  status: string;
  pendingApprovals: PendingApprovalInfo[];
}

/** Summary of the most recent context compaction on a session. */
export interface LastCompactionStatus {
  /** ISO 8601 timestamp of the compaction event. */
  createdAt: string;
  /** Whether the compaction applied, was skipped, or fell back to truncation. */
  outcome: TrueForgeApi.ContextCompactionEventOutcome;
}

/** What the owner picks on a held action. */
export type HeldActionDecision = 'approve' | 'always_allow' | 'deny';

/** Host-facing methods beyond the vendor `AgentChatServer` contract. */
export interface HarnessChatServerExtensions {
  /**
   * Read the session's newest turn and any approvals still pending on it.
   * Returns `null` when the session has no turns yet.
   */
  peekSessionTip(request: { sessionId: string }): Promise<SessionTipInfo | null>;
  /**
   * Deny every approval still pending on the session tip turn in a single
   * continuation turn. `alreadyResolved` is true when a fresh probe found
   * nothing left to dismiss (e.g. the user decided manually in the meantime).
   */
  dismissPendingApprovals(request: {
    sessionId: string;
    reason: string;
  }): Promise<{ dismissed: number; alreadyResolved: boolean }>;
  /**
   * Answer an action a scheduled run held for the owner. Approving runs just that call, once;
   * the server refuses it when the hold ran out or no longer matches what the owner was shown.
   * Resolves with what became of the call, read from the answer's own turn.
   */
  answerHeldAction(request: {
    sessionId: string;
    threadId: string;
    toolCallId: string;
    answer: HeldActionDecision;
  }): Promise<HeldActionOutcome>;
  /**
   * Read the most recent context compaction event for a session.
   * Returns `null` when no compaction has run yet.
   */
  getLastCompactionStatus(request: { sessionId: string }): Promise<LastCompactionStatus | null>;
  /**
   * Read the input token count from the session's most recent turn.
   * This is the actual number the model saw for its last request.
   * Returns `null` when the session has no turns yet or tokens are unknown.
   */
  getLastTurnInputTokens(request: { sessionId: string }): Promise<number | null>;
}

/** Type guard for servers that provide the harness chat extensions. */
export function hasSessionResync(server: object): server is HarnessChatServerExtensions {
  const peek: unknown = Reflect.get(server, 'peekSessionTip');
  const dismiss: unknown = Reflect.get(server, 'dismissPendingApprovals');
  const answerHeld: unknown = Reflect.get(server, 'answerHeldAction');
  const compaction: unknown = Reflect.get(server, 'getLastCompactionStatus');
  const tokens: unknown = Reflect.get(server, 'getLastTurnInputTokens');
  return (
    typeof peek === 'function' &&
    typeof dismiss === 'function' &&
    typeof answerHeld === 'function' &&
    typeof compaction === 'function' &&
    typeof tokens === 'function'
  );
}

/**
 * Pending tool approvals are automatically denied after this long without a
 * decision. The age is derived from the persisted `tool.approval_required`
 * event timestamp, so it holds while the browser is backgrounded or closed.
 * Fail-closed: an unanswered approval never becomes an approval.
 */
export const APPROVAL_AUTO_DENY_MINUTES = 30;

export function approvalAutoDenyReason(): string {
  return `Automatically denied: the approval was not answered within ${APPROVAL_AUTO_DENY_MINUTES} minutes.`;
}

const PENDING_APPROVALS_MESSAGE = 'user message cannot be sent while approvals or questions are pending';

/** True when the error is the server's pending-approvals 422. */
export function isPendingApprovalsError(error: unknown): boolean {
  if (error == null) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(PENDING_APPROVALS_MESSAGE);
}

/** True when the server reports there is no pending approval left to decide. */
function isNoPendingApprovalError(error: unknown): boolean {
  if (error == null) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /no pending approval/i.test(message);
}

function outcomeOfDisposition(disposition: TrueForgeApi.ToolResponseEventV2['disposition']): HeldActionOutcome {
  switch (disposition) {
    case 'executed_ok':
      return 'done';
    case 'executed_nonzero':
      return 'failed';
    case 'outcome_unknown':
      return 'unclear';
    case 'denied':
    case 'policy_blocked':
    case 'never_ran':
      return 'not_run';
  }
}

export function createSessionResyncExtensions(client: Pick<TrueForge, 'sessions'>): HarnessChatServerExtensions {
  // `listTurns` is oldest-first, so its first row is the session's first turn, not its tip. The
  // session event feed is newest-first on the active branch, which names the real tip turn.
  async function readTipTurn({ sessionId }: { sessionId: string }): Promise<TrueForgeApi.Turn | null> {
    const page = await client.sessions.listEvents(sessionId, { limit: 1 });
    const newest = page.data[0];
    if (newest == null) return null;
    const response = await client.sessions.getTurn(sessionId, newest.turnId);
    return response.data;
  }

  async function peekSessionTip({ sessionId }: { sessionId: string }): Promise<SessionTipInfo | null> {
    const tip = await readTipTurn({ sessionId });
    if (tip == null) return null;
    const pendingApprovals: PendingApprovalInfo[] = [];
    const state = tip.state;
    if (state.status === 'done') {
      for (const action of state.requiredActions) {
        if (action.type !== 'tool.approval_required') continue;
        for (const toolCall of action.toolCalls) {
          pendingApprovals.push({
            toolCallId: toolCall.id,
            threadId: action.threadId,
            createdAt: action.createdAt,
          });
        }
      }
    }
    return { turnId: tip.id, status: state.status, pendingApprovals };
  }

  async function dismissPendingApprovals({
    sessionId,
    reason,
  }: {
    sessionId: string;
    reason: string;
  }): Promise<{ dismissed: number; alreadyResolved: boolean }> {
    const tip = await peekSessionTip({ sessionId });
    if (tip == null || tip.pendingApprovals.length === 0) {
      return { dismissed: 0, alreadyResolved: true };
    }
    const input: TrueForgeApi.TurnInputItem[] = tip.pendingApprovals.map(approval => ({
      type: 'user.tool_approval',
      threadId: approval.threadId,
      toolCallId: approval.toolCallId,
      approval: { status: 'deny', reason },
    }));
    let stream;
    try {
      stream = await client.sessions.createTurnStream(sessionId, {
        input,
        previousTurnId: tip.turnId,
      });
    } catch (error) {
      // Lost a race with a manual decision: nothing left to dismiss.
      if (isNoPendingApprovalError(error)) return { dismissed: 0, alreadyResolved: true };
      throw error;
    }
    // Drain the stream so a transport or validation failure surfaces to the
    // caller instead of leaving the dismissal half-done and silent.
    for await (const _event of stream) {
      // Consumed for completion only.
    }
    return { dismissed: input.length, alreadyResolved: false };
  }

  async function answerHeldAction({
    sessionId,
    threadId,
    toolCallId,
    answer,
  }: {
    sessionId: string;
    threadId: string;
    toolCallId: string;
    answer: HeldActionDecision;
  }): Promise<HeldActionOutcome> {
    const approval: TrueForgeApi.ApprovalDecision =
      answer === 'deny'
        ? { status: 'deny' }
        : { status: 'allow', scope: answer === 'always_allow' ? 'always' : 'once' };
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [{ type: 'user.tool_approval', threadId, toolCallId, approval }],
      previousTurnId: 'auto',
    });
    // Drain the stream so a failure while the call runs reaches the caller instead of passing silently.
    let outcome: HeldActionOutcome = 'unclear';
    // The replay runs under a fresh call id, announced by the answer turn's own model message.
    const replayedCallIds = new Set<string>();
    for await (const event of stream) {
      if (event.type === 'model.message') {
        for (const call of event.toolCalls ?? []) replayedCallIds.add(call.id);
      } else if (event.type === 'tool.response.v2' && replayedCallIds.has(event.toolCallId)) {
        outcome = outcomeOfDisposition(event.disposition);
      }
    }
    return outcome;
  }

  async function getLastCompactionStatus({ sessionId }: { sessionId: string }): Promise<LastCompactionStatus | null> {
    const page = await client.sessions.listEvents(sessionId, { limit: 100 });
    for (const item of page.data) {
      const event = item.event;
      if (event.type !== 'agent.context.compaction') continue;
      return {
        createdAt: event.createdAt,
        outcome: event.outcome,
      };
    }
    return null;
  }

  /** Extract a numeric metric from turn state, accepting camelCase or snake_case keys. */
  function readTurnMetricNumber(metrics: unknown, camel: string, snake: string): number | undefined {
    if (typeof metrics !== 'object' || metrics === null) return undefined;
    const camelValue: unknown = Reflect.get(metrics, camel);
    if (typeof camelValue === 'number' && Number.isFinite(camelValue)) return camelValue;
    const snakeValue: unknown = Reflect.get(metrics, snake);
    if (typeof snakeValue === 'number' && Number.isFinite(snakeValue)) return snakeValue;
    return undefined;
  }

  async function getLastTurnInputTokens({ sessionId }: { sessionId: string }): Promise<number | null> {
    const tip = await readTipTurn({ sessionId });
    if (tip == null) return null;
    const state: unknown = tip.state;
    if (typeof state !== 'object' || state === null) return null;
    const status: unknown = Reflect.get(state, 'status');
    if (status !== 'done' && status !== 'cancelled' && status !== 'error') return null;
    const metrics: unknown = Reflect.get(state, 'metrics');
    const inputTokens = readTurnMetricNumber(metrics, 'totalInputTokens', 'total_input_tokens');
    return inputTokens ?? null;
  }

  return {
    peekSessionTip,
    dismissPendingApprovals,
    answerHeldAction,
    getLastCompactionStatus,
    getLastTurnInputTokens,
  };
}

type BlockedSendListener = () => void;

const blockedSendListeners = new Set<BlockedSendListener>();

/**
 * Subscribe to "send blocked by pending approvals" signals. The chat
 * provider publishes when a send fails with the server's pending-approvals
 * 422; the pending-approvals banner subscribes so it can offer the dismiss
 * action immediately, before the re-sync round-trip completes.
 */
export function subscribeToBlockedSend(listener: BlockedSendListener): () => void {
  blockedSendListeners.add(listener);
  return () => {
    blockedSendListeners.delete(listener);
  };
}

/** Publish a "send blocked by pending approvals" signal to all subscribers. */
export function publishBlockedSend(): void {
  for (const listener of blockedSendListeners) {
    listener();
  }
}
