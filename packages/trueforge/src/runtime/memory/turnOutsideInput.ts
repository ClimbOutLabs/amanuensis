import type { TurnInputItem, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  callReturnsOutsideContent,
  EventType,
  isAgentInputUserMessage,
  isFileContentPart,
  type ModelMessageEvent,
} from '@truefoundry/trueforge-core/core';
import type { RawToolCall } from '@truefoundry/trueforge-core/core/llm/LLMTypes';

/** True when any user message in a turn's input carries an attached file. */
export function inputAttachesFiles(input: readonly TurnInputItem[]): boolean {
  return input
    .filter(isAgentInputUserMessage)
    .some(message => typeof message.content !== 'string' && message.content.some(isFileContentPart));
}

/** A call that was refused or never ran returned no content, so it cannot have brought anything in. */
function toolRanOrMayHave(disposition: string): boolean {
  return disposition !== 'denied' && disposition !== 'policy_blocked' && disposition !== 'never_ran';
}

/** A tool call as a live turn shows it: the call itself and what the host recorded about the tool it reached. */
type StreamedToolCall = NonNullable<ModelMessageEvent['tool_calls']>[number] | (RawToolCall & { tool_info?: unknown });

function callKey({ threadId, callId }: { threadId: string; callId: string }): string {
  return `${threadId}\u0000${callId}`;
}

/**
 * The tool calls of a turn, by the thread and id a result names. A stored turn holds each call whole. A live
 * turn sends a call in pieces and never as one finished message, so the pieces are put together here: the name
 * and arguments as they arrive, and the host's own record of the tool, which comes last and replaces any earlier one.
 */
function createTurnToolCalls() {
  const whole = new Map<string, StreamedToolCall>();
  const pieces = new Map<string, { id?: string; name: string; arguments: string; tool_info?: unknown }>();
  return {
    observe(event: TurnStreamingEvent): void {
      if (event.type === EventType.MODEL_MESSAGE) {
        for (const call of event.tool_calls ?? []) {
          whole.set(callKey({ threadId: event.thread_id, callId: call.id }), call);
        }
        return;
      }
      if (event.type !== EventType.MODEL_MESSAGE_DELTA) {
        return;
      }
      for (const piece of event.tool_calls ?? []) {
        const slot = `${event.thread_id}\u0000${event.id}\u0000${String(piece.index)}`;
        const call = pieces.get(slot) ?? { name: '', arguments: '' };
        pieces.set(slot, call);
        if (call.id === undefined && piece.id !== undefined) {
          call.id = piece.id;
        }
        call.name += piece.function?.name ?? '';
        call.arguments += piece.function?.arguments ?? '';
        call.tool_info = piece.tool_info ?? call.tool_info;
        if (call.id !== undefined) {
          whole.set(callKey({ threadId: event.thread_id, callId: call.id }), {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
            ...(call.tool_info === undefined ? {} : { tool_info: call.tool_info }),
          });
        }
      }
    },
    get(key: { threadId: string; callId: string }): StreamedToolCall | undefined {
      return whole.get(callKey(key));
    },
  };
}

/**
 * The one rule for "this turn read something from outside": a turn that attached a file has, and so has a
 * turn with a tool result that may hold text from outside the chat. A result whose call is not known counts
 * as outside. Saving a note and reviewing an older one both ask it, so a note is judged the same way each time.
 * Events are fed in the order they were emitted, a call before its results.
 */
export function createOutsideInputTracker({ attachedFiles }: { attachedFiles: boolean }) {
  let ingested = attachedFiles;
  const calls = createTurnToolCalls();
  return {
    get ingested(): boolean {
      return ingested;
    },
    /** The call a tool result answers, when the turn has shown it. */
    callOf(result: { thread_id: string; tool_call_id: string }): RawToolCall | undefined {
      return calls.get({ threadId: result.thread_id, callId: result.tool_call_id });
    },
    /** Returns true when the event is a tool result that may hold text from outside the chat. */
    observe(event: TurnStreamingEvent): boolean {
      calls.observe(event);
      const ran =
        event.type === EventType.TOOL_RESPONSE ||
        (event.type === EventType.TOOL_RESPONSE_V2 && toolRanOrMayHave(event.disposition));
      if (ran && callReturnsOutsideContent(calls.get({ threadId: event.thread_id, callId: event.tool_call_id }))) {
        ingested = true;
        return true;
      }
      return false;
    },
  };
}
