import type { ChatCompletionTool } from 'openai/resources/chat';
import type { LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';

/**
 * Every tool a request lets the model call: those sent in full, and those the tool index in the
 * system prompt lists by name only (a listed tool can be called directly by that name).
 */
export function offeredTools(request: LLMCreateParamsStreaming): ChatCompletionTool[] {
  const system = request.messages.find(message => message.role === 'system');
  const text = typeof system?.content === 'string' ? system.content : '';
  const sent = request.tools ?? [];
  const sentNames = new Set(sent.flatMap(tool => (tool.type === 'function' ? [tool.function.name] : [])));
  const listed = [...text.matchAll(/^- ([A-Za-z0-9_-]+): /gm)]
    .map(match => match[1] ?? '')
    .filter(name => name !== '' && !sentNames.has(name));
  return [...sent, ...listed.map((name): ChatCompletionTool => ({ type: 'function', function: { name } }))];
}
