import { CALENDAR_READ_TOOL_NAMES } from '../../calendar/toolContract';
import { GMAIL_READ_TOOL_NAMES } from '../../email/gmail/toolContract';
import {
  hasReadPrivateData,
  markPrivateDataReadFromHistory,
  recordPrivateReadText,
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
 * Keeps the text of each mail or calendar result for the checks, on every thread of the turn. The root thread
 * (`persisted`) also keeps "this chat read private data" for the life of the session: the turn's search state
 * starts clean every turn, so the flag is saved once it is set and put back at the start of the next turn.
 */
export function privateDataReadCapability(input: { turn: WebSearchTurnState; persisted: boolean }): AgentCapability {
  let saved = false;
  // Result messages already kept for the checks, so each one is read once per turn.
  const kept = new Set<string>();
  function keepNewReadResults(context: AgentThreadExecutionContext['context']): void {
    const readCallIds = new Set<string>();
    for (const message of context) {
      if (isLLMContextMessage(message) && message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          if (isPrivateReadToolName(call.function.name)) {
            readCallIds.add(call.id);
          }
        }
      }
    }
    for (const message of context) {
      if (
        isLLMContextMessage(message) &&
        message.role === 'tool' &&
        readCallIds.has(message.tool_call_id) &&
        !kept.has(message.tool_call_id)
      ) {
        kept.add(message.tool_call_id);
        recordPrivateReadText({ state: input.turn, text: message.content });
      }
    }
  }
  async function* saveWhenSet() {
    await Promise.resolve();
    if (!input.persisted || saved || !hasReadPrivateData(input.turn)) {
      return;
    }
    saved = true;
    yield { type: InternalEventType.CAPABILITY_STATE, key: PRIVATE_DATA_READ_STATE_KEY, state: true };
  }
  return {
    ...(input.persisted
      ? {
          state: {
            key: PRIVATE_DATA_READ_STATE_KEY,
            load: state => {
              if (state === true) {
                saved = true;
                markPrivateDataReadFromHistory(input.turn);
              }
            },
          },
        }
      : {}),
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
        processPostToolCall: execution => {
          keepNewReadResults(execution.context);
          return saveWhenSet();
        },
      },
    ],
  };
}
