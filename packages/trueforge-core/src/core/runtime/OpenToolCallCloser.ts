/**
 * OpenToolCallCloser - Context processor that closes unresolved tool calls.
 *
 * When an assistant message contains tool_calls but corresponding tool response
 * messages are missing (e.g., due to a failed or interrupted tool execution),
 * LLMs will reject the request. This processor detects such cases in the
 * **last** assistant message and appends dummy tool responses so the
 * conversation can continue.
 *
 * Uses is_thread_creation from InternalToolCallInfo to identify sub-agent
 * tool calls (which should remain open); does NOT use SUB_AGENTS_SERVER_ID.
 * Older persisted contexts without is_thread_creation follow the ordinary
 * non-thread-creation path (no compatibility fallback).
 */
import type {
  AgentContextProcessorAppendContext,
  AgentThreadExecutionContext,
  PreSendContextProcessor,
} from '../capabilities/AgentContextProcessor';
import {
  createToolResponseV2,
  EventType,
  newEventId,
  type ToolAdmissionProvenance,
  type ToolResultDisposition,
  type ToolResultRemediation,
} from '../events/schema';
import type { InternalEnrichedAssistantMessage, InternalToolCallInfo, LLMToolMessage } from '../llm/LLMTypes';
import { awaitsApproval } from '../mcp/approvalGrant';
import { deniedToolCallRemediation, deniedToolCallText, REPEATED_DENIAL_REMEDIATION } from '../mcp/ToolSet';
import type { ContextMessage } from './AgentThread.types';
import { InternalEventType } from './AgentThread.types';
import { mergeCurrentContextUsage } from './contextUsage';
import { estimateTokensForContextMessages, isLLMContextMessage, scanApprovalDecisions } from './contextUtils';

const DUMMY_TOOL_MESSAGE_CONTENT = JSON.stringify({
  // No standing invitation to retry: an unfinished call from an earlier turn stays unfinished
  // unless the person asks again. A model told to "please retry" would revive old requests
  // unasked in later turns, which is how a dropped calendar add once resurfaced inside an
  // unrelated email check.
  error:
    'Tool call was not executed. Only make this call again if the person asks for it again, or it is still needed for what they just asked.',
});

/**
 * Current contexts distinguish prepared calls from calls that crossed the
 * execution boundary. Legacy contexts do not. When that proof is absent,
 * telling the model a side-effecting call "was not executed" could invite it
 * to repeat an operation that already happened, including an action the user
 * authorized exactly once.
 */
const UNKNOWN_OUTCOME_TOOL_MESSAGE_CONTENT = JSON.stringify({
  error:
    'Tool call outcome unknown: it may have run without its result being recorded. Do not repeat it blindly. Establish whether it already took effect, then continue.',
});

/**
 * Whether repeating this call cannot cause harm, so the model can be told
 * plainly that it did not run. Read-only work qualifies; everything else is
 * treated as side-effecting, including calls whose metadata is missing, since
 * absent metadata must not resolve to the reassuring answer.
 */
export function isSafeToRepeat(info: InternalToolCallInfo): boolean {
  return info.effect === 'inspect' || (info.effect === undefined && info.read_only_hint === true);
}

export interface ClosableToolOutcome {
  rawContent: string;
  disposition: ToolResultDisposition;
  remediation: ToolResultRemediation | undefined;
  admissionProvenance: ToolAdmissionProvenance;
}

/**
 * The conservative closeout for a call whose terminal result is missing and
 * which cannot be proven never to have run: the model must establish whether
 * the action took effect instead of repeating it blindly.
 */
export function unknownOutcomeCloseout(admissionProvenance: ToolAdmissionProvenance): ClosableToolOutcome {
  return {
    rawContent: UNKNOWN_OUTCOME_TOOL_MESSAGE_CONTENT,
    disposition: 'outcome_unknown',
    remediation: {
      reason_code: 'missing_terminal_result',
      message: 'Establish whether the action took effect before continuing.',
      suggested_action: 'inspect_state',
    },
    admissionProvenance,
  };
}

function unresolvedCallOutcome(
  info: InternalToolCallInfo,
  toolCallId: string,
  admissionProvenance: ToolAdmissionProvenance,
  tracking: {
    preparedToolCallIds: ReadonlySet<string>;
    startedToolCallIds: ReadonlySet<string>;
  },
): ClosableToolOutcome {
  const { preparedToolCallIds, startedToolCallIds } = tracking;
  if (isSafeToRepeat(info)) {
    return {
      rawContent: DUMMY_TOOL_MESSAGE_CONTENT,
      disposition: 'never_ran',
      remediation: {
        reason_code: 'tool_call_never_ran',
        message: 'The call did not run and may be retried if it is still needed.',
        suggested_action: 'retry',
      },
      admissionProvenance,
    };
  }

  // Legacy contexts predate the checkpoint and cannot prove that a side effect
  // did not start. A tracked call with no start marker is the only retry-safe
  // side-effecting recovery case.
  if (preparedToolCallIds.has(toolCallId) && !startedToolCallIds.has(toolCallId)) {
    return {
      rawContent: DUMMY_TOOL_MESSAGE_CONTENT,
      disposition: 'never_ran',
      remediation: {
        reason_code: 'tool_call_never_started',
        message: 'The durable checkpoint proves the call never started.',
        suggested_action: 'retry',
      },
      admissionProvenance,
    };
  }
  return unknownOutcomeCloseout(admissionProvenance);
}

/**
 * Open tool calls on the last assistant message that this processor can close, each mapped
 * to the tool message that closes it.
 *
 * Approval-required calls split on whether a decision is on record. An undecided call is
 * durable pending state — the approval card the user still has to answer — so nothing is
 * closed while one is open. A decided call that never ran is the opposite: no execution is
 * coming for it, and leaving it open blocks every later user message with nothing on screen
 * to explain why. Closing it states the outcome the user already chose. An undecided call that
 * repeats a "no" from earlier in the turn never got a card, so it is closed as that same "no".
 */
export function getClosableOpenToolCallOutcomes(
  context: ContextMessage[],
  deniedApprovalIdentities: ReadonlySet<string>,
): Map<string, ClosableToolOutcome> {
  const lastIdx = context.findLastIndex(
    (msg): msg is InternalEnrichedAssistantMessage =>
      isLLMContextMessage(msg) && msg.role === 'assistant' && !!msg.tool_calls?.length,
  );
  if (lastIdx === -1) {
    return new Map();
  }

  const lastAssistant = context[lastIdx];
  if (lastAssistant === undefined || !isLLMContextMessage(lastAssistant) || lastAssistant.role !== 'assistant') {
    throw new Error('Unreachable');
  }
  if (!lastAssistant.tool_calls) {
    return new Map();
  }

  // Only the client can resolve a client-side call, so the thread stays parked as a whole.
  if (lastAssistant.tool_calls.some(tc => tc.tool_info.is_client_side === true)) {
    return new Map();
  }

  const messagesAfterAssistant = context.slice(lastIdx + 1);
  const preparedToolCallIds = new Set(
    messagesAfterAssistant.flatMap(message =>
      'type' in message && message.type === 'internal.tool.execution_tracking' ? message.tool_call_ids : [],
    ),
  );
  const startedToolCallIds = new Set(
    messagesAfterAssistant.flatMap(message =>
      'type' in message && message.type === EventType.TOOL_EXECUTION_STARTED ? [message.tool_call_id] : [],
    ),
  );
  const decisions = scanApprovalDecisions(context);
  const closable = new Map<string, ClosableToolOutcome>();
  for (const toolCall of lastAssistant.tool_calls) {
    if (toolCall.tool_info.is_thread_creation === true) {
      continue;
    }
    if (toolCall.tool_info.is_approval_required !== true) {
      closable.set(
        toolCall.id,
        unresolvedCallOutcome(
          toolCall.tool_info,
          toolCall.id,
          { source: 'automatic' },
          {
            preparedToolCallIds,
            startedToolCallIds,
          },
        ),
      );
      continue;
    }
    const decision = decisions.get(toolCall.id);
    if (decision === undefined) {
      if (awaitsApproval({ call: toolCall, decisions, deniedApprovalIdentities })) {
        return new Map();
      }
      closable.set(toolCall.id, {
        rawContent: deniedToolCallText(undefined),
        disposition: 'denied',
        remediation: REPEATED_DENIAL_REMEDIATION,
        admissionProvenance: { source: 'automatic' },
      });
      continue;
    }
    closable.set(
      toolCall.id,
      decision.status === 'deny'
        ? {
            rawContent: deniedToolCallText(decision.reason),
            disposition: 'denied',
            remediation: deniedToolCallRemediation(decision.reason),
            admissionProvenance: {
              source: 'user_approval',
              decision: 'deny',
            },
          }
        : unresolvedCallOutcome(
            toolCall.tool_info,
            toolCall.id,
            {
              source: 'user_approval',
              decision: 'allow',
              ...(decision.scope === undefined ? {} : { scope: decision.scope }),
            },
            { preparedToolCallIds, startedToolCallIds },
          ),
    );
  }

  for (const msg of messagesAfterAssistant) {
    if (isLLMContextMessage(msg) && msg.role === 'tool') {
      closable.delete(msg.tool_call_id);
    }
  }

  return closable;
}

export function getClosableOpenToolCalls(
  context: ContextMessage[],
  deniedApprovalIdentities: ReadonlySet<string>,
): Map<string, string> {
  return new Map(
    [...getClosableOpenToolCallOutcomes(context, deniedApprovalIdentities)].map(([toolCallId, outcome]) => [
      toolCallId,
      outcome.rawContent,
    ]),
  );
}

export class OpenToolCallCloser implements PreSendContextProcessor {
  constructor(private readonly deniedApprovalIdentities: () => ReadonlySet<string>) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- async *: AsyncIterable contract; body is sync
  async *processPreSend(
    execution: Readonly<AgentThreadExecutionContext>,
  ): AsyncGenerator<AgentContextProcessorAppendContext, void, unknown> {
    const closable = getClosableOpenToolCallOutcomes(execution.context, this.deniedApprovalIdentities());
    if (closable.size === 0) {
      return;
    }

    const canonicalResults = [...closable].map(([toolCallId, outcome]) =>
      createToolResponseV2({
        id: newEventId(),
        thread_id: execution.threadId,
        tool_call_id: toolCallId,
        created_at: new Date().toISOString(),
        raw_content: outcome.rawContent,
        model_content: null,
        screen: null,
        disposition: outcome.disposition,
        remediation: outcome.remediation,
        admission_provenance: outcome.admissionProvenance,
        memoized: false,
        repeat_count: 1,
      }),
    );
    const dummyToolMessages: LLMToolMessage[] = canonicalResults.map(result => result.model_message);

    const currentContextUsage = mergeCurrentContextUsage(
      execution.currentContextUsage,
      estimateTokensForContextMessages(dummyToolMessages),
    );

    yield {
      type: InternalEventType.AGENT_CONTEXT_APPEND,
      context: dummyToolMessages,
      output: canonicalResults.map(result => result.event),
      current_context_usage: currentContextUsage,
      tool_call_memo: undefined,
      // Closes open tool calls only; never touches task state.
      task_state: undefined,
    };
  }
}
