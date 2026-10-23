import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import type {
  ContextCompactionEvent,
  ContextCompactionStartedEvent,
  ThreadOverwriteContextEvent,
} from '../events/schema';
import type {
  AgentThreadAppendContext,
  ContextMessage,
  InternalCapabilityStateEvent,
  InternalModelUsageEvent,
  InternalPassthroughEvent,
} from '../runtime/AgentThread.types';
import type { CurrentContextUsage } from '../runtime/contextUsage';
import type { Sandbox } from '../sandbox/Sandbox';

/** Ambient thread snapshot passed Readonly to every capability processor hook. */
export interface AgentThreadExecutionContext {
  threadId: string;
  sandbox?: Sandbox | undefined;
  /** Turn cancellation signal. Processors must check it before starting external work. */
  signal?: AbortSignal | undefined;
  currentContextUsage: CurrentContextUsage;
  context: ContextMessage[];
  /**
   * Set only when the host is forcing this preLLM pass to run compaction regardless of the
   * configured token threshold (currently after a ModelStreamFault), so the retry attempt runs
   * against a shorter context. A processor with no notion of a threshold ignores this.
   */
  forceCompaction?: boolean;
}

export type AgentContextProcessorOverwriteContext = Omit<ThreadOverwriteContextEvent, 'thread_id'>;

/** Processors omit thread_id, since AgentThread stamps it (same as append/overwrite). */
export type AgentContextProcessorCompactionEvent = Omit<ContextCompactionEvent, 'thread_id'>;

export type AgentContextProcessorCompactionStartedEvent = Omit<ContextCompactionStartedEvent, 'thread_id'>;

export type AgentContextProcessorAppendContext = Omit<AgentThreadAppendContext, 'thread_id'>;

/** Processors omit thread_id — AgentThread stamps it (same as append/overwrite). */
export type AgentContextProcessorCapabilityState = Omit<InternalCapabilityStateEvent, 'thread_id'>;

/** Processors omit thread_id — AgentThread stamps it (same as append/overwrite). */
export type AgentContextProcessorModelUsage = Omit<InternalModelUsageEvent, 'thread_id'>;

export type AgentContextProcessorOutput =
  | AgentContextProcessorOverwriteContext
  | AgentContextProcessorAppendContext
  | InternalPassthroughEvent
  | AgentContextProcessorCapabilityState
  | AgentContextProcessorModelUsage
  | AgentContextProcessorCompactionEvent
  | AgentContextProcessorCompactionStartedEvent;

export interface PreSendContextProcessor {
  processPreSend(execution: Readonly<AgentThreadExecutionContext>): AsyncIterable<AgentContextProcessorAppendContext>;
}

// NOTE: Saved in Redis, Saved in AgentThread in memory. Persisted accross Agent Loop.
export interface PreLLMAgentContextProcessor {
  processPreLLM(execution: Readonly<AgentThreadExecutionContext>): AsyncIterable<AgentContextProcessorOutput>;
}

export interface PostToolCallAgentContextProcessor {
  processPostToolCall(execution: Readonly<AgentThreadExecutionContext>): AsyncIterable<AgentContextProcessorOutput>;
}

// NOTE: Not saved in Redis, Not saved in AgentThread in memory. Not persisted accross Agent Loop.
export interface PreLLMEphemeralAgentContextProcessor {
  processPreLLMEphemeral(input: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] | undefined;
}
