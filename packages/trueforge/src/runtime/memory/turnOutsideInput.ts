import type { TurnInputItem, TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  callReturnsOutsideContent,
  EventType,
  isAgentInputUserMessage,
  isFileContentPart,
} from '@truefoundry/trueforge-core/core';

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

/**
 * The one rule for "this turn read something from outside": a turn that attached a file has, and so has a
 * turn with a tool result that may hold text from outside the chat. A result whose call is not known counts
 * as outside. Saving a note and reviewing an older one both ask it, so a note is judged the same way each time.
 * Events are fed in the order they were emitted, a call before its results.
 */
export function createOutsideInputTracker({ attachedFiles }: { attachedFiles: boolean }) {
  let ingested = attachedFiles;
  const callReturnsOutside = new Map<string, boolean>();
  return {
    get ingested(): boolean {
      return ingested;
    },
    /** Returns true when the event is a tool result that may hold text from outside the chat. */
    observe(event: TurnStreamingEvent): boolean {
      if (event.type === EventType.MODEL_MESSAGE) {
        for (const call of event.tool_calls ?? []) {
          callReturnsOutside.set(call.id, callReturnsOutsideContent(call));
        }
        return false;
      }
      const isResult =
        event.type === EventType.TOOL_RESPONSE ||
        (event.type === EventType.TOOL_RESPONSE_V2 && toolRanOrMayHave(event.disposition));
      if (isResult && (callReturnsOutside.get(event.tool_call_id) ?? true)) {
        ingested = true;
        return true;
      }
      return false;
    },
  };
}
