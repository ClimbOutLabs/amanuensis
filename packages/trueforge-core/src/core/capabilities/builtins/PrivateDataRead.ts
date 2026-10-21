import { CALENDAR_READ_TOOL_NAMES } from '../../calendar/toolContract';
import { GMAIL_READ_TOOL_NAMES } from '../../email/gmail/toolContract';
import {
  hasReadPrivateData,
  markPrivateDataReadFromHistory,
  type WebSearchTurnState,
} from '../../permissions/webSearch';
import { InternalEventType } from '../../runtime/AgentThread.types';
import { isLLMContextMessage } from '../../runtime/contextUtils';
import type { AgentCapability } from '../AgentCapability';
import type { AgentThreadExecutionContext } from '../AgentContextProcessor';

const PRIVATE_READ_TOOL_NAMES = [...GMAIL_READ_TOOL_NAMES, ...CALENDAR_READ_TOOL_NAMES];

/** Whether a tool reads the user's private data (mail or calendar), so later web requests ask first. */
export function isPrivateReadToolName(tool_name: string): boolean {
  return PRIVATE_READ_TOOL_NAMES.some(name => tool_name.endsWith(name));
}

export const PRIVATE_DATA_READ_STATE_KEY = 'tfy.private_data_read';

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
      (message.tool_calls ?? []).some(call => isPrivateReadToolName(call.function.name)),
  );
}

/**
 * The root thread's private-read state: the flag for the chat, saved so the next turn starts with it, and a mark
 * restored from the context when a forked or cut-off thread still holds a mail or calendar call. Each read's text is
 * kept by the tool set at dispatch, on every thread, so this capability only ever runs on the root thread.
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
