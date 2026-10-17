import { GMAIL_READ_TOOL_NAMES } from '../../email/gmail/toolContract';
import { hasReadPrivateData, markPrivateDataRead, type WebSearchTurnState } from '../../permissions/webSearch';
import { InternalEventType } from '../../runtime/AgentThread.types';
import { isLLMContextMessage } from '../../runtime/contextUtils';
import type { AgentCapability } from '../AgentCapability';
import type { AgentThreadExecutionContext } from '../AgentContextProcessor';

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
      (message.tool_calls ?? []).some(call => GMAIL_READ_TOOL_NAMES.some(name => call.function.name.endsWith(name))),
  );
}

/**
 * Keeps "this chat read private data" for the life of the session. The turn's search state starts clean every
 * turn, so the flag is saved once it is set and put back at the start of the next turn.
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
          markPrivateDataRead(input.turn);
        }
      },
    },
    preLLMProcessors: [
      {
        processPreLLM: execution => {
          if (!hasReadPrivateData(input.turn) && contextReadPrivateData(execution.context)) {
            markPrivateDataRead(input.turn);
          }
          return saveWhenSet();
        },
      },
    ],
    postToolCallProcessors: [{ processPostToolCall: () => saveWhenSet() }],
  };
}
