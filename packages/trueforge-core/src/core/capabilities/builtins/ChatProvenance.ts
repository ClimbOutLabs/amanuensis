import type { LLMUserMessage, RawToolCall } from '../../llm/LLMTypes';
import { parseToolCallArguments } from '../../mcp/toolArgumentCheck';
import { collectOutboundStrings } from '../../permissions/outboundGuard';
import type { ReadSource } from '../../permissions/provenance';
import { recordPersonText, recordUntrustedText } from '../../permissions/provenance';
import {
  readSourceOf,
  recordToolResultProvenance,
  toolReturnsOutsideContent,
  type WebSearchTurnState,
} from '../../permissions/webSearch';
import type { ContextMessage } from '../../runtime/AgentThread.types';
import { isHostWrappedText, isLLMContextMessage, isUntrustedDocumentText } from '../../runtime/contextUtils';
import { CALL_TOOL_NAME, tryParseCallToolWrapper } from '../../runtime/DeferredTool';
import type { AgentCapability } from '../AgentCapability';
import type { AgentContextProcessorOutput, AgentThreadExecutionContext } from '../AgentContextProcessor';

/**
 * The tool a call reached and the arguments it sent. A call the model made through the call_tool wrapper counts as
 * the tool the wrapper names, so wrapped and direct calls to the same tool count the same way.
 */
function calledTool(call: RawToolCall): { tool_name: string; argument_values: string[] } {
  const args = parseToolCallArguments(call);
  const wrapped =
    args !== undefined && (call.function.name === CALL_TOOL_NAME || call.function.name.endsWith(`__${CALL_TOOL_NAME}`))
      ? tryParseCallToolWrapper(args)
      : undefined;
  const sent = collectOutboundStrings(wrapped?.input ?? args ?? {});
  return {
    tool_name: wrapped?.tool_name ?? call.function.name,
    argument_values: sent === undefined ? [] : [...sent.values, ...sent.plumbing],
  };
}

/**
 * Whether the result of a tool call may hold text from outside the chat, whether the call was made directly or
 * through the call_tool wrapper. A result with no known call counts as outside content.
 */
export function callReturnsOutsideContent(call: RawToolCall | undefined): boolean {
  return call === undefined || toolReturnsOutsideContent(calledTool(call).tool_name);
}

/** Where a tool result came from, as a person would say it: their mail, their calendar, the web, a file, or any other tool. */
export type ToolResultSource = 'email' | 'calendar' | 'web' | 'attachment' | 'other';

const TOOL_RESULT_SOURCE_OF_READ: Record<ReadSource, ToolResultSource> = {
  email_sender: 'email',
  email: 'email',
  event: 'calendar',
  page: 'web',
  browser_page: 'web',
  file: 'attachment',
  tool_result: 'other',
  other: 'other',
};

/** Where the result of a tool call came from; a call that is not known counts as `other`. */
export function callResultSource(call: RawToolCall | undefined): ToolResultSource {
  return call === undefined ? 'other' : TOOL_RESULT_SOURCE_OF_READ[readSourceOf(calledTool(call).tool_name)];
}

/**
 * Whether any tool result in these messages may hold text from outside the chat. A result whose call is not
 * among the messages counts as outside content.
 */
export function contextHasOutsideToolResult(messages: readonly ContextMessage[]): boolean {
  const outside = new Map<string, boolean>();
  return messages.some(message => {
    if (!isLLMContextMessage(message)) {
      return false;
    }
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        outside.set(call.id, callReturnsOutsideContent(call));
      }
    }
    return message.role === 'tool' && (outside.get(message.tool_call_id) ?? true);
  });
}

/** Each text of a user message, so the person's own words are told apart from file text and host notes. */
function userTexts(content: LLMUserMessage['content']): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  return content.flatMap(part => (part.type === 'text' ? [part.text] : []));
}

/**
 * Records where the links and addresses of the chat so far came from, before every model step, so a call the model
 * makes is judged against everything it has read in this chat, earlier turns included. The person's own words are
 * theirs; file text, host notes such as an earlier summary, and tool results are data, except a search's result
 * links. Each message is read once. Root thread only: a sub-agent's results are recorded as they arrive.
 */
export function chatProvenanceCapability(input: { turn: WebSearchTurnState }): AgentCapability {
  const read = new WeakSet<object>();
  const calls = new Map<string, RawToolCall>();
  const record = (context: AgentThreadExecutionContext['context']): void => {
    const { provenance } = input.turn;
    for (const message of context) {
      if (!isLLMContextMessage(message)) {
        continue;
      }
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          calls.set(call.id, call);
        }
      }
      if (read.has(message)) {
        continue;
      }
      read.add(message);
      if (message.role === 'user') {
        for (const text of userTexts(message.content)) {
          if (isHostWrappedText(text)) {
            recordUntrustedText({ provenance, text, source: isUntrustedDocumentText(text) ? 'file' : 'other' });
          } else {
            recordPersonText({ provenance, text });
          }
        }
      } else if (message.role === 'tool') {
        const call = calls.get(message.tool_call_id);
        const called = call === undefined ? { tool_name: '', argument_values: [] } : calledTool(call);
        recordToolResultProvenance({ state: input.turn, ...called, texts: [message.content] });
      }
    }
  };
  return {
    preLLMProcessors: [
      {
        processPreLLM: execution => {
          record(execution.context);
          return NOTHING_TO_ADD;
        },
      },
    ],
  };
}

/** The processor only records; it never adds to the context. */
const NOTHING_TO_ADD: AsyncIterable<AgentContextProcessorOutput> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};
