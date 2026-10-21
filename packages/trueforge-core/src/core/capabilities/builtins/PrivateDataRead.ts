import type { RawToolCall } from '../../llm/LLMTypes';
import { parseToolCallArguments } from '../../mcp/toolArgumentCheck';
import { isPrivateReadToolName } from '../../permissions/privateReadTools';
import {
  hasReadPrivateData,
  markPrivateDataReadFromHistory,
  type WebSearchTurnState,
} from '../../permissions/webSearch';
import { InternalEventType } from '../../runtime/AgentThread.types';
import { isLLMContextMessage } from '../../runtime/contextUtils';
import { CALL_TOOL_NAME, tryParseCallToolWrapper } from '../../runtime/DeferredTool';
import type { AgentCapability } from '../AgentCapability';
import type { AgentThreadExecutionContext } from '../AgentContextProcessor';

export const PRIVATE_DATA_READ_STATE_KEY = 'tfy.private_data_read';

/**
 * The name a call is recorded under. A call the model made through the call_tool wrapper is recorded under
 * the tool the wrapper names, so wrapped and direct calls to the same tool count the same way; a wrapper
 * whose arguments do not parse keeps the wrapper's name, which reads no private data.
 */
function recordedToolName(call: RawToolCall): string {
  if (call.function.name !== CALL_TOOL_NAME && !call.function.name.endsWith(`__${CALL_TOOL_NAME}`)) {
    return call.function.name;
  }
  const wrapperArgs = parseToolCallArguments(call);
  return wrapperArgs === undefined
    ? call.function.name
    : (tryParseCallToolWrapper(wrapperArgs)?.tool_name ?? call.function.name);
}

/**
 * Whether the conversation so far called a tool that reads private data. The saved flag can be missing for a
 * thread that was forked, rewound or cancelled before it was saved, while the mail it read is still in the
 * context; reading the context closes that gap by erring toward "read".
 */
function contextReadPrivateData(context: AgentThreadExecutionContext['context']): boolean {
  return context.some(
    message =>
      isLLMContextMessage(message) &&
      message.role === 'assistant' &&
      (message.tool_calls ?? []).some(call => isPrivateReadToolName(recordedToolName(call))),
  );
}

/**
 * The root thread's private-read state: the flag for the chat, saved so the next turn starts with it, and a mark
 * restored from the context when a forked or cut-off thread still holds a private read. Each result's text is recorded
 * by the dispatch loop before the model sees it, on every thread, so this capability only ever runs on the root thread.
 */
export function privateDataReadCapability(input: { turn: WebSearchTurnState }): AgentCapability {
  let saved = false;
  async function* saveWhenSet() {
    await Promise.resolve();
    if (saved || !hasReadPrivateData(input.turn)) {
      return;
    }
    saved = true;
    yield { type: InternalEventType.CAPABILITY_STATE, key: PRIVATE_DATA_READ_STATE_KEY, state: true };
  }
  return {
    state: {
      key: PRIVATE_DATA_READ_STATE_KEY,
      load: state => {
        if (state === true) {
          saved = true;
          markPrivateDataReadFromHistory(input.turn);
        }
      },
    },
    preLLMProcessors: [
      {
        processPreLLM: execution => {
          if (!hasReadPrivateData(input.turn) && contextReadPrivateData(execution.context)) {
            markPrivateDataReadFromHistory(input.turn);
          }
          return saveWhenSet();
        },
      },
    ],
    postToolCallProcessors: [
      {
        processPostToolCall: () => saveWhenSet(),
      },
    ],
  };
}
