import type { ChatCompletionCreateParams, ChatCompletionCreateParamsStreaming } from 'openai/resources/chat';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from './LLMTypes';

export type AgentMetadata = Record<string, string>;

/**
 * OpenAI chat-completion request shapes with `model` removed.
 * The bound ILLM client owns model identity (e.g. VercelAILLM providerConfig);
 * callers must not invent a model string just to satisfy OpenAI's required field.
 */
export type LLMCreateParams = Omit<ChatCompletionCreateParams, 'model'>;
export type LLMCreateParamsStreaming = Omit<ChatCompletionCreateParamsStreaming, 'model'>;

export interface ILLM {
  create(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown>;
  createNonStream(body: LLMCreateParams): Promise<RawAssistantMessageWithUsage>;
  /**
   * Counts tokens in text using the provider's actual tokenizer.
   * Used by the pre-flight context-limit guard and compaction budgets
   * so the estimate matches what the provider will charge. Never a heuristic.
   */
  countTokens(text: string): Promise<number>;
}
