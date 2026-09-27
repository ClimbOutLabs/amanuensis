/**
 * Durable turn handle. {@link TurnHandle.stream} is execute-once (persist-before-yield).
 */
import { AgentHarnessError } from '../core/errors';
import type {
  MCPAuthRequiredEvent,
  ModelMessageDeltaEvent,
  ModelMessageEvent,
  ThreadDoneEvent,
  ToolResponseEvent,
} from '../core/events/schema';
import { EventType as HarnessEventType, newEventId } from '../core/events/schema';
import type { RegisteredCommandExecution } from '../core/llm/LLMTypes';
import type { AbnormalHandoff, AbnormalHandoffCause } from '../core/runtime/AbnormalHandoff';
import {
  InternalEventType,
  type AgentThreadExecutionEvent,
  type AgentThreadExecutionResult,
  type ContextMessage,
  type InternalMCPAuthRequiredEvent,
  type InternalThreadDoneEvent,
} from '../core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../core/runtime/contextUsage';
import type { AgentThreadMetrics } from '../core/runtime/metrics';
import type { ITurnResourceResolver } from './ITurnResourceResolver';
import type { TurnRecord } from './models/TurnRecord';
import { EventType, type PersistedTurnEvent, type TurnCreatedEvent, type TurnDoneEvent } from './schemas/events';
import type { TokenPagination } from './schemas/pagination';
import {
  CancellationReason,
  type TerminalTurnState,
  type TurnInputItem,
  type TurnMetrics,
  type TurnState,
} from './schemas/turn';
import type { ISessionStore } from './store/ISessionStore';
import { TurnNotRunningError } from './store/SessionStoreErrors';

/** Streaming yield union — deltas pass through; never persisted. No sequence_number. */
export type TurnStreamingEvent = PersistedTurnEvent | ModelMessageDeltaEvent;

/** Session persistence accepts historical v1 responses; first-party runtime writers emit v2 only. */
interface TurnExecutionSource {
  execute(input: {
    signal: AbortSignal;
  }): AsyncGenerator<AgentThreadExecutionEvent | ToolResponseEvent, AgentThreadExecutionResult>;
  getMetrics(): AgentThreadMetrics;
  activateThreadCreated?(threadId: string): void;
  buildAbnormalHandoff?(input: { cause: AbnormalHandoffCause }): Promise<AbnormalHandoff>;
}

function mechanicalAbnormalHandoff(cause: AbnormalHandoffCause): AbnormalHandoff {
  return {
    cause,
    summary: null,
    evidence: {
      repository: null,
      verification_receipt: {
        status: 'not_available',
        command: null,
        branch: null,
        head_sha: null,
        state_sha256: null,
      },
    },
  };
}

async function buildAbnormalHandoff(
  source: TurnExecutionSource,
  input: { cause: AbnormalHandoffCause },
): Promise<AbnormalHandoff> {
  if (source.buildAbnormalHandoff === undefined) {
    return mechanicalAbnormalHandoff(input.cause);
  }
  try {
    return await source.buildAbnormalHandoff(input);
  } catch {
    return mechanicalAbnormalHandoff(input.cause);
  }
}

function cancellationReasonFromAbortReason(abortReason: unknown): CancellationReason {
  if (abortReason === CancellationReason.ServerExecutionTimeout) {
    return CancellationReason.ServerExecutionTimeout;
  }
  if (abortReason === CancellationReason.CancelledForNextTurn) {
    return CancellationReason.CancelledForNextTurn;
  }
  if (abortReason === CancellationReason.Abandoned) {
    return CancellationReason.Abandoned;
  }
  return CancellationReason.ClientCancelled;
}

function toThreadDoneEvent(event: InternalThreadDoneEvent): ThreadDoneEvent {
  const state =
    event.status === 'error'
      ? { status: 'error' as const, error: event.error, ...(event.output && { output: event.output }) }
      : { status: 'done' as const, output: event.output };
  return {
    type: HarnessEventType.THREAD_DONE,
    id: newEventId(),
    created_at: new Date().toISOString(),
    parent: event.parent,
    thread_id: event.thread_id,
    title: event.title,
    state,
  };
}

function toMCPAuthRequiredEvent(event: InternalMCPAuthRequiredEvent): MCPAuthRequiredEvent {
  return {
    type: HarnessEventType.MCP_AUTH_REQUIRED,
    id: event.id,
    created_at: event.created_at,
    thread_id: event.thread_id,
    mcp_servers: event.mcp_servers.map(({ thread_ids, ...server }) => {
      void thread_ids;
      return server;
    }),
  };
}

function turnMetricsFromAgentThreadMetrics(metrics: AgentThreadMetrics): TurnMetrics {
  return {
    total_input_tokens: metrics.total_input_tokens,
    total_output_tokens: metrics.total_output_tokens,
    total_tokens: metrics.total_tokens,
    total_cache_read_tokens: metrics.total_cache_read_tokens,
    total_cache_write_tokens: metrics.total_cache_write_tokens,
    total_reasoning_tokens: metrics.total_reasoning_tokens,
    total_cost_in_usd: metrics.total_cost_in_usd,
  };
}

/**
 * Applies the host's optional finalizeAssistantOutput post-pass to the root
 * thread's final assistant message. Runs exactly once, after execution and
 * before the terminal state is persisted and TURN_DONE is published. A
 * throwing hook — or one that returns undefined — keeps the original output:
 * host post-processing can never fail the turn.
 */
function finalizeAssistantOutput<TTurnCustom extends object>(
  resolver: ITurnResourceResolver<TTurnCustom> | undefined,
  output: ModelMessageEvent | null,
): ModelMessageEvent | null {
  const hook = resolver?.finalizeAssistantOutput;
  if (output === null || hook === undefined) {
    return output;
  }
  try {
    return hook(output) ?? output;
  } catch (error) {
    resolver?.logger.warn('finalizeAssistantOutput hook threw; keeping original assistant output', {
      error: error instanceof Error ? error.message : 'unknown error',
    });
    return output;
  }
}

/**
 * Applies the host's assistant-text sanitizer to assistant messages headed
 * for the durable thread context. Non-assistant messages, null content, and
 * refusal parts pass through untouched. Returns the input array unchanged
 * when nothing changed, so the common no-op case allocates nothing.
 */
function sanitizeAppendedAssistantMessages(
  messages: ContextMessage[],
  sanitize: (text: string) => string,
): ContextMessage[] {
  const result = messages.map(message => sanitizeOneAssistantMessage(message, sanitize));
  return result.every((message, index) => message === messages[index]) ? messages : result;
}

function sanitizeOneAssistantMessage(
  message: ContextMessage,
  sanitize: (text: string) => string,
): ContextMessage {
  if (!('role' in message) || message.role !== 'assistant') {
    return message;
  }
  const content = message.content;
  if (typeof content === 'string') {
    const cleaned = sanitize(content);
    return cleaned === content ? message : { ...message, content: cleaned };
  }
  if (Array.isArray(content)) {
    const parts = content.map(part => {
      if (part.type !== 'text') {
        return part;
      }
      const cleaned = sanitize(part.text);
      return cleaned === part.text ? part : { ...part, text: cleaned };
    });
    return parts.every((part, index) => part === content[index])
      ? message
      : { ...message, content: parts };
  }
  return message;
}

export class TurnHandle<TTurnCustom extends object = Record<string, never>> {
  private readonly store: ISessionStore<object, TTurnCustom>;
  private turn: TurnRecord<TTurnCustom>;
  private readonly orchestrator: TurnExecutionSource | undefined;
  private readonly resolver: ITurnResourceResolver<TTurnCustom> | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly abort: ((reason: CancellationReason) => void) | undefined;
  private readonly detachSignal: (() => void) | undefined;
  private readonly onCommandExecutionStarted: ((execution: RegisteredCommandExecution) => void) | undefined;
  private readonly commandExecutionOwnerId: string;
  private readonly runningCommandExecutions = new Map<
    string,
    { leaseId: string; renewalTimer: ReturnType<typeof setInterval> }
  >();
  private streamStarted = false;

  constructor(options: {
    store: ISessionStore<object, TTurnCustom>;
    turn: TurnRecord<TTurnCustom>;
    orchestrator?: TurnExecutionSource | undefined;
    resolver?: ITurnResourceResolver<TTurnCustom> | undefined;
    signal?: AbortSignal | undefined;
    abort?: ((reason: CancellationReason) => void) | undefined;
    detachSignal?: (() => void) | undefined;
    onCommandExecutionStarted?: ((execution: RegisteredCommandExecution) => void) | undefined;
    commandExecutionOwnerId?: string | undefined;
  }) {
    this.store = options.store;
    this.turn = options.turn;
    this.orchestrator = options.orchestrator;
    this.resolver = options.resolver;
    this.signal = options.signal;
    this.abort = options.abort;
    this.detachSignal = options.detachSignal;
    this.onCommandExecutionStarted = options.onCommandExecutionStarted;
    this.commandExecutionOwnerId = options.commandExecutionOwnerId ?? 'standalone';
  }

  /** Store-only handle (e.g. from {@link SessionHandle.getTurn}) — stream() is not available. */
  static fromRecord<TCustom extends object = Record<string, never>>(options: {
    store: ISessionStore<object, TCustom>;
    turn: TurnRecord<TCustom>;
  }): TurnHandle<TCustom> {
    return new TurnHandle(options);
  }

  static async get<TCustom extends object = Record<string, never>>(options: {
    store: ISessionStore<object, TCustom>;
    session_id: string;
    turn_id: string;
  }): Promise<TurnHandle<TCustom> | undefined> {
    const turn = await options.store.getTurn({
      session_id: options.session_id,
      turn_id: options.turn_id,
    });
    if (!turn) {
      return undefined;
    }
    return TurnHandle.fromRecord({
      store: options.store,
      turn,
    });
  }

  get id(): string {
    return this.turn.turn_id;
  }

  get session_id(): string {
    return this.turn.session_id;
  }

  get previous_turn_id(): string | null {
    return this.turn.previous_turn_id;
  }

  get input(): TurnInputItem[] {
    return this.turn.input;
  }

  get state(): TurnState {
    return this.turn.state;
  }

  get created_at(): Date {
    return this.turn.created_at;
  }

  get custom(): TTurnCustom | null {
    return this.turn.custom;
  }

  get record(): TurnRecord<TTurnCustom> {
    return this.turn;
  }

  /**
   * Executes the turn. Single consumer, callable ONCE — a second call throws:
   * this generator IS the execution (persist-before-yield). Execute-only: the
   * input was already sent and validated in run(); nothing is sent here.
   * Sole terminal writer — done/cancelled/error is written to the store from
   * inside this generator; honors the AbortSignal passed to run(). On every
   * exit path the resolver is closed best-effort in a finally, after the
   * terminal write.
   *
   * Two consumption patterns (both caller-side; this method is identical for both):
   *
   *   // STREAMING — pipe events out as they happen (e.g. SSE):
   *   for await (const e of turn.stream()) yield sse(e);
   *
   *   // NON-STREAMING — drain in background, respond immediately with the
   *   // running turn. The caller owns the active-turn registry, the .catch
   *   // (store-write failures reject the drain; agent errors do NOT — they
   *   // become terminal 'error' events inside), and graceful shutdown.
   *   const drain = (async () => { for await (const _ of turn.stream()); })()
   *     .catch(err => logger.error('turn drain failed', err));
   *   activeTurns.set(turn.id, { controller, drain });
   *   drain.finally(() => activeTurns.delete(turn.id));
   *   return turnCreatedResponse(turn);
   *
   * Yields the delta-inclusive streaming union: deltas pass through to the
   * consumer but are NEVER persisted. Events carry no sequence_number; yield
   * order ≡ persist order (single sequential generator), so callers that need
   * numbering (e.g. SSE resume) stamp it at their own transport boundary.
   */
  async *stream(): AsyncGenerator<TurnStreamingEvent> {
    if (this.streamStarted) {
      throw new Error('TurnHandle.stream() is single-use and was already called');
    }
    this.streamStarted = true;

    const orchestrator = this.orchestrator;
    const resolver = this.resolver;
    const signal = this.signal;
    if (!orchestrator || !resolver || !signal) {
      throw new Error('TurnHandle.stream() is only available on turns returned from SessionHandle.createTurn()');
    }

    let caughtError: Error | undefined;
    const lifecycle = { frozenByStore: false };
    let executeResult: AgentThreadExecutionResult | undefined;
    let generator:
      AsyncGenerator<AgentThreadExecutionEvent | ToolResponseEvent, AgentThreadExecutionResult, unknown> | undefined;

    try {
      const turnCreated: TurnCreatedEvent = {
        type: EventType.TURN_CREATED,
        id: newEventId(),
        turn_id: this.turn.turn_id,
        previous_turn_id: this.turn.previous_turn_id,
        ...(this.turn.input.length > 0 ? { input: this.turn.input } : {}),
        state: { status: 'running' },
        created_at: this.turn.created_at.toISOString(),
        thread_id: null,
      };
      await this.store.appendToEvents({
        session_id: this.turn.session_id,
        turn_id: this.turn.turn_id,
        events: [turnCreated],
      });
      yield turnCreated;

      generator = orchestrator.execute({ signal });
      let iterResult = await generator.next();
      while (!iterResult.done) {
        const event = iterResult.value;
        try {
          const yielded = await this.persistExecutionEvent(event);
          if (yielded) {
            yield yielded;
          }
        } catch (error) {
          if (error instanceof TurnNotRunningError) {
            lifecycle.frozenByStore = true;
            // The durable store fence means another replica owns terminal
            // state. Abort this linked signal before closing the graph so live
            // children close their parent calls instead of surviving locally.
            this.abort?.(CancellationReason.ClientCancelled);
            await this.persistGeneratorCleanup(generator, { ignoreStoreFence: true });
            // Cleared so the finally block does not close the generator a second time.
            generator = undefined;
            const updatedAt = new Date();
            const createdAtIso = updatedAt.toISOString();
            const state: TerminalTurnState = {
              ...error.state,
              metrics: turnMetricsFromAgentThreadMetrics(orchestrator.getMetrics()),
            };
            this.turn = { ...this.turn, state, updated_at: updatedAt };
            yield {
              type: EventType.TURN_DONE,
              id: newEventId(),
              created_at: createdAtIso,
              state,
              thread_id: null,
            };
            return;
          }
          throw error;
        }
        iterResult = await generator.next();
      }
      executeResult = iterResult.value;
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error));
    } finally {
      const consumerReturned = executeResult === undefined && caughtError === undefined;
      if (consumerReturned && !signal.aborted) {
        this.abort?.(CancellationReason.ClientCancelled);
      }
      this.detachSignal?.();
      if (generator) {
        await this.persistGeneratorCleanup(generator, { ignoreStoreFence: lifecycle.frozenByStore });
      }
      this.stopCommandExecutionLeaseRenewals();
      if (lifecycle.frozenByStore) {
        await resolver.close().catch((err: unknown) => {
          resolver.logger.warn('TurnResourceResolver.close() failed', { err });
        });
      } else {
        const updatedAt = new Date();
        const createdAtIso = updatedAt.toISOString();
        const metrics = turnMetricsFromAgentThreadMetrics(orchestrator.getMetrics());
        // Abnormal handoffs are mechanical. In particular, cancellation must not
        // revive work through another model inference.
        const abnormalHandoffInput: { cause: AbnormalHandoffCause } | undefined = signal.aborted
          ? {
              cause:
                cancellationReasonFromAbortReason(signal.reason) === CancellationReason.ClientCancelled
                  ? 'client_cancelled'
                  : 'server_cancelled',
            }
          : caughtError
            ? { cause: 'fatal_error' }
            : executeResult?.root_agent_error
              ? { cause: executeResult.root_agent_error.handoff_cause ?? 'fatal_error' }
              : executeResult === undefined
                ? { cause: 'client_cancelled' }
                : undefined;
        const handoff =
          abnormalHandoffInput === undefined
            ? undefined
            : await buildAbnormalHandoff(orchestrator, abnormalHandoffInput);
        let terminalState: TerminalTurnState;
        // When the post-pass changes the terminal message, the repaired event
        // is re-published on the stream (same id) before TURN_DONE below.
        let repairedTerminalMessage: ModelMessageEvent | null = null;
        if (signal.aborted) {
          terminalState = {
            status: 'cancelled',
            reason: cancellationReasonFromAbortReason(signal.reason),
            completed_at: createdAtIso,
            metrics,
            handoff,
          };
        } else if (caughtError) {
          terminalState = {
            status: 'error',
            message: caughtError.message,
            completed_at: createdAtIso,
            metrics,
            handoff,
          };
        } else if (executeResult?.root_agent_error) {
          terminalState = {
            status: 'error',
            message: executeResult.root_agent_error.error,
            completed_at: createdAtIso,
            metrics,
            handoff,
          };
        } else if (executeResult === undefined) {
          // Consumer abandoned the generator (break/return) without aborting —
          // no executeResult, no error, signal not aborted.
          terminalState = {
            status: 'cancelled',
            reason: CancellationReason.ClientCancelled,
            completed_at: createdAtIso,
            metrics,
            handoff,
          };
        } else {
          const rawOutput = executeResult.output;
          const repairedOutput = finalizeAssistantOutput(resolver, rawOutput);
          if (repairedOutput !== null && repairedOutput !== rawOutput) {
            repairedTerminalMessage = repairedOutput;
          }
          terminalState = {
            status: 'done',
            output: repairedOutput,
            required_actions: executeResult.required_actions,
            completed_at: createdAtIso,
            metrics,
          };
        }

        const turnDone: TurnDoneEvent = {
          type: EventType.TURN_DONE,
          id: newEventId(),
          created_at: createdAtIso,
          state: terminalState,
          thread_id: null,
        };

        let terminalWrite: { state: TerminalTurnState; written: boolean };
        try {
          terminalWrite = await this.persistTerminalStateOrReadWinner({
            state: terminalState,
            turn_done_event: turnDone,
          });
          this.turn = { ...this.turn, state: terminalWrite.state, updated_at: updatedAt };

          // A consumer that already returned will not resume past another yield,
          // so skip publication and let the finally block release its resources.
          if (!consumerReturned) {
            if (terminalWrite.written && repairedTerminalMessage !== null) {
              // Re-publish the repaired terminal message with its original id:
              // delta-folding live clients replace the folded content for a
              // repeated full model.message id, while turn.done itself is
              // turn-scoped and never reaches message rendering. Stream-only:
              // the durable repaired content travels in the turn record.
              yield repairedTerminalMessage;
            }
            yield terminalWrite.written
              ? turnDone
              : {
                  type: EventType.TURN_DONE,
                  id: newEventId(),
                  created_at: createdAtIso,
                  state: terminalWrite.state,
                  thread_id: null,
                };
          }
        } finally {
          await resolver.close().catch((err: unknown) => {
            resolver.logger.warn('TurnResourceResolver.close() failed', { err });
          });
        }
      }
    }
  }

  /** Persist this stream's terminal event, or adopt the state won by a concurrent freeze. */
  private async persistTerminalStateOrReadWinner(input: {
    state: TerminalTurnState;
    turn_done_event: TurnDoneEvent;
  }): Promise<{ state: TerminalTurnState; written: boolean }> {
    try {
      await this.store.updateTurnState({
        session_id: this.turn.session_id,
        turn_id: this.turn.turn_id,
        state: input.state,
        turn_done_event: input.turn_done_event,
      });
      return { state: input.state, written: true };
    } catch (error) {
      if (error instanceof TurnNotRunningError) {
        this.abort?.(CancellationReason.ClientCancelled);
        return { state: { ...error.state, metrics: input.state.metrics }, written: false };
      }
      throw error;
    }
  }

  /** Persist every event yielded while closing an aborted orchestrator. */
  private async persistGeneratorCleanup(
    generator: AsyncGenerator<AgentThreadExecutionEvent | ToolResponseEvent, AgentThreadExecutionResult, unknown>,
    options: { ignoreStoreFence: boolean },
  ): Promise<void> {
    const emptyResult: AgentThreadExecutionResult = {
      output: null,
      required_actions: [],
    };
    let result = await generator.return(emptyResult);
    while (!result.done) {
      try {
        await this.persistExecutionEvent(result.value);
      } catch (error) {
        if (!options.ignoreStoreFence || !(error instanceof TurnNotRunningError)) {
          throw error;
        }
      }
      result = await generator.next();
    }
  }

  /** Paginated read of this turn's persisted events. */
  async listEvents(input: {
    limit: number;
    page_token?: string | undefined;
    order?: 'asc' | 'desc' | undefined;
  }): Promise<{
    data: PersistedTurnEvent[];
    pagination: TokenPagination;
  }> {
    return this.store.listTurnEvents({
      session_id: this.turn.session_id,
      turn_id: this.turn.turn_id,
      limit: input.limit,
      page_token: input.page_token,
      order: input.order,
    });
  }

  /**
   * Host-sanitized copy of context messages for the durable thread context.
   * A throwing sanitizer keeps the original messages: sanitization can never
   * fail the turn.
   */
  private sanitizeAppendedContext(messages: ContextMessage[]): ContextMessage[] {
    const sanitize = this.resolver?.sanitizeAssistantTextForContext;
    if (sanitize === undefined) {
      return messages;
    }
    try {
      return sanitizeAppendedAssistantMessages(messages, sanitize);
    } catch (error) {
      this.resolver?.logger.warn('sanitizeAssistantTextForContext hook threw; keeping original context', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
      return messages;
    }
  }

  /**
   * Persist side effects for one execution event; return a streaming yield when
   * the event should be emitted to the consumer (null = side-effect only / skip).
   */
  private async persistExecutionEvent(
    event: AgentThreadExecutionEvent | ToolResponseEvent,
  ): Promise<TurnStreamingEvent | null> {
    const scope = {
      session_id: this.turn.session_id,
      turn_id: this.turn.turn_id,
    };

    switch (event.type) {
      case HarnessEventType.MODEL_MESSAGE:
      case HarnessEventType.MODEL_MESSAGE_DELTA:
        // Stream only — durable model content lands via AGENT_CONTEXT_APPEND.output.
        return event;

      case HarnessEventType.TOOL_EXECUTION_STARTED:
        if (event.command_execution !== undefined) {
          const leaseId = newEventId();
          await this.store.appendCommandExecutionStarted({
            ...scope,
            event: { ...event, command_execution: event.command_execution },
            ownership: {
              owner_id: this.commandExecutionOwnerId,
              lease_id: leaseId,
              lease_expires_at: this.nextCommandExecutionLeaseExpiry(),
            },
          });
          this.startCommandExecutionLeaseRenewal({
            threadId: event.thread_id,
            toolCallId: event.tool_call_id,
            leaseId,
          });
          this.onCommandExecutionStarted?.(event.command_execution);
          return event;
        }
        await this.store.appendToEvents({
          ...scope,
          events: [event],
        });
        return event;

      case HarnessEventType.TOOL_RESPONSE:
        await this.store.appendToEvents({
          ...scope,
          events: [event],
        });
        return event;

      case HarnessEventType.TOOL_RESPONSE_V2: {
        const key = this.commandExecutionKey({ threadId: event.thread_id, toolCallId: event.tool_call_id });
        const running = this.runningCommandExecutions.get(key);
        if (running === undefined) {
          await this.store.appendToEvents({
            ...scope,
            events: [event],
          });
          return event;
        }
        clearInterval(running.renewalTimer);
        // The store closes the matching running lease and appends this result
        // in one transaction. Recovery and provider finalization therefore
        // contend on the same durable row; exactly one terminal path wins.
        await this.store.appendCommandExecutionResult({
          ...scope,
          event,
          lease_id: running.leaseId,
        });
        this.runningCommandExecutions.delete(key);
        return event;
      }

      case InternalEventType.AGENT_CREATE_SUBAGENT:
        return null;

      case InternalEventType.CAPABILITY_STATE: {
        // Persist boundary: types exclude undefined; reject it at runtime so stores never see it.
        const state: unknown = event.state;
        if (state === undefined) {
          throw new AgentHarnessError(
            'capability_state_error',
            `CAPABILITY_STATE for key '${event.key}' must not be undefined — use null to clear durable state`,
          );
        }
        await this.store.patchThreadCapabilityState({
          ...scope,
          thread_id: event.thread_id,
          key: event.key,
          state: event.state,
        });
        return null;
      }

      case HarnessEventType.AGENT_CONTEXT_OVERWRITE: {
        await this.store.overwriteThreadContext({ ...scope, event });
        return null;
      }

      case InternalEventType.AGENT_CONTEXT_APPEND: {
        await this.store.appendToThreadContext({
          ...scope,
          thread_id: event.thread_id,
          context: this.sanitizeAppendedContext(event.context),
          current_context_usage: event.current_context_usage ?? null,
          completion: event.completion ?? null,
          tool_call_memo: event.tool_call_memo,
          task_state: event.task_state,
        });
        if (event.output.length > 0) {
          await this.store.appendToEvents({
            ...scope,
            events: event.output,
          });
        }
        return null;
      }

      case InternalEventType.AGENT_DONE: {
        if (!event.parent) {
          return null;
        }
        const threadDone = toThreadDoneEvent(event);
        await this.store.appendToEvents({
          ...scope,
          events: [threadDone],
        });
        await this.store.removeThreads({
          ...scope,
          thread_ids: [event.thread_id],
        });
        return threadDone;
      }

      case HarnessEventType.THREAD_CREATED: {
        await this.store.addThreadsAndAppendEvents({
          ...scope,
          threads: [
            {
              thread_id: event.thread_id,
              parent: event.parent,
              agent_info: event.agent_info,
              context: [],
              current_context_usage: getEmptyCurrentContextUsage(),
              completion: null,
              capability_state: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ],
          events: [event],
        });
        this.orchestrator?.activateThreadCreated?.(event.thread_id);
        return event;
      }

      case InternalEventType.MCP_AUTH_REQUIRED: {
        const authEvent = toMCPAuthRequiredEvent(event);
        await this.store.appendToEvents({
          ...scope,
          events: [authEvent],
        });
        return authEvent;
      }

      case HarnessEventType.MCP_INITIALIZE: {
        await this.store.patchMCPServers({
          ...scope,
          mcp_servers: event.mcp_servers.map(initInfo => ({
            id: initInfo.id,
            name: initInfo.name,
            session_id: initInfo.session_id,
            transport_type: initInfo.transport_type,
          })),
        });
        await this.store.appendToEvents({
          ...scope,
          events: [event],
        });
        return event;
      }

      case HarnessEventType.SANDBOX_CREATED: {
        await this.store.patchSandboxInfo({
          ...scope,
          sandbox_info: { sandbox_id: event.sandbox_id },
        });
        await this.store.appendToEvents({
          ...scope,
          events: [event],
        });
        return event;
      }

      case HarnessEventType.TOOL_APPROVAL_REQUIRED:
      case HarnessEventType.TOOL_RESPONSE_REQUIRED: {
        await this.store.appendToEvents({
          ...scope,
          events: [event],
        });
        return event;
      }

      default: {
        // Registered passthrough (orchestrator unwraps PASSTHROUGH before yield).
        await this.store.appendToEvents({
          ...scope,
          events: [event],
        });
        return event;
      }
    }
  }

  private commandExecutionKey(input: { threadId: string; toolCallId: string }): string {
    return `${input.threadId}\u0000${input.toolCallId}`;
  }

  private nextCommandExecutionLeaseExpiry(): Date {
    return new Date(Date.now() + 30_000);
  }

  private startCommandExecutionLeaseRenewal(input: { threadId: string; toolCallId: string; leaseId: string }): void {
    const key = this.commandExecutionKey({ threadId: input.threadId, toolCallId: input.toolCallId });
    const renewalTimer = setInterval(() => {
      void this.store
        .renewCommandExecutionLease({
          session_id: this.turn.session_id,
          turn_id: this.turn.turn_id,
          thread_id: input.threadId,
          tool_call_id: input.toolCallId,
          lease_id: input.leaseId,
          lease_expires_at: this.nextCommandExecutionLeaseExpiry(),
        })
        .catch((error: unknown) => {
          this.resolver?.logger.warn('Registered-command lease renewal failed', {
            err: error,
            threadId: input.threadId,
            toolCallId: input.toolCallId,
          });
        });
    }, 10_000);
    renewalTimer.unref();
    this.runningCommandExecutions.set(key, { leaseId: input.leaseId, renewalTimer });
  }

  private stopCommandExecutionLeaseRenewals(): void {
    for (const running of this.runningCommandExecutions.values()) {
      clearInterval(running.renewalTimer);
    }
    this.runningCommandExecutions.clear();
  }
}
