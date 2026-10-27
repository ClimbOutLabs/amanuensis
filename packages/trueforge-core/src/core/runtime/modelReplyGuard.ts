/**
 * Guards on one finished model reply, applied before any of its tool calls are classified or run.
 *
 * A reply from a struggling model can carry calls that must not be sent as they stand: arguments
 * that do not fit the tool's schema, a call the stream stopped early for running past its size
 * limit, the same call repeated many times, a read of something the same reply is only just
 * creating, or simply more calls than one reply may make. This module
 * repairs what the argument check can repair, drops exact duplicates, flags the calls that must
 * not run (with a plain message the model can act on), and reports a reply that is over the call
 * cap so the runtime can stop the turn. Nothing here ever loosens a check: a flagged call resolves
 * as never ran, with its reason, never as a run one.
 */
import type { ChatCompletionTool } from 'openai/resources/chat';
import { CREATE_EVENT_TOOL_NAME, GET_EVENT_TOOL_NAME } from '../calendar/toolContract';
import type { RawAssistantMessage, RawToolCall } from '../llm/LLMTypes';
import {
  checkToolArguments,
  parseToolCallArguments,
  toolArgumentProblemMessage,
  toParameterSchema,
  type ToolParameterSchema,
} from '../mcp/toolArgumentCheck';
import { stableStringify } from '../permissions/approvalTokens';
import type { ContextMessage } from './AgentThread.types';

/** Most tool calls one reply may make; beyond this the turn stops (see TOO_MANY_TOOL_CALLS_MESSAGE). */
export const MAX_TOOL_CALLS_PER_REPLY = 20;

/** Shown to the person when a reply asks for more tool calls than one reply may make. */
export const TOO_MANY_TOOL_CALLS_MESSAGE =
  'The model asked for too many tool calls at once, so Aman stopped. Try again.';

/** Shown to the person when a reply hits the output limit, which can leave a tool call half-written. */
export const LENGTH_CUT_OFF_MESSAGE = "Aman's reply was cut off because it ran long. Ask it to continue.";

/**
 * Shown to the model when one of its calls was stopped mid-stream for running past the host's
 * per-call argument size limit. The arguments are partial by construction, so this is checked
 * before the argument checks: "send the whole call again" would be wrong advice here, because
 * the fix is a smaller call, not a resent one.
 */
export const TOOL_CALL_SIZE_CUT_MESSAGE =
  'That call was stopped while it was still being written, because its arguments ran past the size limit for one call, so nothing was written. ' +
  'Send the content in smaller parts instead: the first part now, then the rest in follow-up calls.';

/**
 * Shown to the person for a call the guard stopped, if it is still undone at the end of the turn.
 * The model gets its own retry instruction instead, so the two never share words.
 */
export const REPLY_CALL_NOT_RUN_OWNER_MESSAGE =
  'I could not finish one of the steps in this reply. Ask me to try again.';

interface ModelReplyGuardOutcome {
  /** The reply with arguments repaired and exact duplicate calls removed. */
  message: RawAssistantMessage;
  /** Calls that must not run, by call id, each with the plain message the model gets instead. */
  invalidCalls: Map<string, string>;
  /** True when the reply still holds more calls than one reply may make after duplicates merged. */
  tooManyCalls: boolean;
}

const ID_FIELD_PATTERN = /"(?:id|event_id)"\s*:\s*"([^"]+)"/g;

/**
 * Event ids this chat has already seen: in tool results, in earlier calls, or pasted by the
 * person. A read in the same reply as a create may only name one of these; anything else names
 * something that does not exist yet.
 */
export function collectKnownEventIds(context: readonly ContextMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of context) {
    if (!('role' in message)) {
      continue;
    }
    if (message.role === 'tool' || message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : '';
      for (const match of content.matchAll(ID_FIELD_PATTERN)) {
        const id = match[1];
        if (id !== undefined) {
          ids.add(id);
        }
      }
    }
    if (message.role === 'assistant' && 'tool_calls' in message && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const args = parseToolCallArguments(call);
        const eventId = args?.['event_id'];
        if (typeof eventId === 'string') {
          ids.add(eventId);
        }
      }
    }
  }
  return ids;
}

export function guardModelReply(input: {
  message: RawAssistantMessage;
  tools: ChatCompletionTool[];
  knownEventIds: ReadonlySet<string>;
  /** Tools whose reads the host vouches for; for these an optional true-or-false argument that cannot be repaired is dropped. */
  readOnlyTools: ReadonlySet<string>;
  /** Calls the stream stopped early for running past their tool's argument size limit; their arguments are partial and never run. */
  sizeCutCalls: ReadonlySet<string>;
}): ModelReplyGuardOutcome {
  const { message, tools, knownEventIds, readOnlyTools, sizeCutCalls } = input;
  const schemas = new Map<string, ToolParameterSchema>();
  for (const tool of tools) {
    if (tool.type === 'function') {
      schemas.set(tool.function.name, toParameterSchema(tool.function.parameters));
    }
  }

  const calls = message.tool_calls ?? [];
  const replyHasCreate = calls.some(call => call.function.name === CREATE_EVENT_TOOL_NAME);
  const invalidCalls = new Map<string, string>();
  const cleaned: RawToolCall[] = [];

  for (const call of calls) {
    if (sizeCutCalls.has(call.id)) {
      invalidCalls.set(call.id, TOOL_CALL_SIZE_CUT_MESSAGE);
      cleaned.push(call);
      continue;
    }
    const args = parseToolCallArguments(call);
    if (args === undefined) {
      invalidCalls.set(
        call.id,
        `The ${call.function.name} call was not sent because its arguments were not complete, so nothing was done with it. ` +
          'Send the whole call again, with all of its arguments finished.',
      );
      cleaned.push(call);
      continue;
    }
    let finalArgs = args;
    const schema = schemas.get(call.function.name);
    if (schema !== undefined) {
      const outcome = checkToolArguments({ schema, args, readOnly: readOnlyTools.has(call.function.name) });
      finalArgs = outcome.args;
      if (outcome.problems.length > 0) {
        invalidCalls.set(
          call.id,
          toolArgumentProblemMessage({ toolName: call.function.name, problems: outcome.problems }),
        );
      }
    }
    if (
      !invalidCalls.has(call.id) &&
      replyHasCreate &&
      call.function.name === GET_EVENT_TOOL_NAME &&
      typeof args['event_id'] === 'string' &&
      !knownEventIds.has(args['event_id'])
    ) {
      invalidCalls.set(
        call.id,
        'That event has not been created yet, so there is nothing to read. Create it first, then read it back if you still need to.',
      );
    }
    cleaned.push(
      finalArgs === args ? call : { ...call, function: { ...call.function, arguments: JSON.stringify(finalArgs) } },
    );
  }

  // Exact duplicates within one reply merge into the first: one approval card, one run. This is
  // what stops a flood of identical reads, and two identical creates becoming two events.
  const seen = new Set<string>();
  const deduped: RawToolCall[] = [];
  for (const call of cleaned) {
    const args = parseToolCallArguments(call);
    const signature = `${call.function.name}:${args === undefined ? call.function.arguments : stableStringify(args)}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(call);
  }

  return {
    message: {
      ...message,
      ...(message.tool_calls === undefined ? {} : { tool_calls: deduped }),
    },
    invalidCalls,
    // Every call counts here: which calls an unattended run will hold for approval is only
    // known after classification, so the runtime recounts there and exempts the held ones.
    // Counted at this stage, the cap is the plain per-reply limit for any run.
    tooManyCalls: deduped.length > MAX_TOOL_CALLS_PER_REPLY,
  };
}
