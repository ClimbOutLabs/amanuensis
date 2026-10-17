import type {
  CompletionUsage,
  ExtendedChatCompletionChunk,
  ILLM,
  LLMCreateParams,
  LLMCreateParamsStreaming,
  RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core';
import { extractErrorLogFields, newEventId } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { ICompletedTurnEventStore } from '../db/completedTurnEvents';
import type { TurnStreamingEvent } from '../schemas/events';

import type { ModelUsagePersistedEvent, ModelUsageRole } from '../schemas/modelUsageEvents';
import { MODEL_USAGE_EVENT_TYPE } from '../schemas/modelUsageEvents';
import type { EventSubscription } from './event-subscription';
import { lookupModelPrice, modelDisplayName, priceTokens, type ModelPrices } from './modelPricing';

/** The model a call went to: the configured name, the id the provider was called with, and the provider type. */
export interface ModelIdentity {
  model_name: string;
  model_id: string;
  provider: string;
}

/** The identity of the model a provider config resolves to, under the name the user configured it by. */
export function modelIdentity({
  name,
  providerConfig,
}: {
  name: string;
  providerConfig: { model: { id: string }; provider: { type: string } };
}): ModelIdentity {
  return { model_name: name, model_id: providerConfig.model.id, provider: providerConfig.provider.type };
}

/** One finished model call. `usage` is null when the provider did not report any. */
export interface ModelCall {
  role: ModelUsageRole;
  identity: ModelIdentity;
  usage: CompletionUsage | null;
}

/** Receives the calls a turn makes, whichever role or model made them. */
export interface TurnModelUsage {
  record(call: ModelCall): void;
}

/**
 * The provider's own usage, or null. A completed call always has at least one input token, so an
 * all-zero usage means the provider reported nothing and the client filled in zeros; it is never
 * shown as a real count.
 */
export function reportedUsage(usage: CompletionUsage | null | undefined): CompletionUsage | null {
  if (usage === undefined || usage === null || usage.input_tokens + usage.output_tokens <= 0) {
    return null;
  }
  return usage;
}

/** Closes a provider stream a consumer stopped reading, so the request is not left running. */
export async function closeStream(stream: AsyncIterator<unknown>): Promise<void> {
  await stream.return?.();
}

/**
 * Reports one call to `onCall` after it ends. A call that failed before the provider reported any
 * usage is not reported: there is nothing to attribute to it.
 */
export class UsageRecordingLLM implements ILLM {
  readonly #llm: ILLM;
  readonly #onCall: (usage: CompletionUsage | null) => void;

  constructor({ llm, onCall }: { llm: ILLM; onCall: (usage: CompletionUsage | null) => void }) {
    this.#llm = llm;
    this.#onCall = onCall;
  }

  async *create(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    const stream = this.#llm.create(body);
    let lastChunkUsage: CompletionUsage | null = null;
    let finished: RawAssistantMessageWithUsage | undefined;
    try {
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          finished = step.value;
          return step.value;
        }
        lastChunkUsage = reportedUsage(step.value.usage) ?? lastChunkUsage;
        yield step.value;
      }
    } finally {
      const usage = finished === undefined ? lastChunkUsage : reportedUsage(finished.usage);
      if (finished === undefined) {
        // A consumer that stops early (turn cancelled) must close the provider stream too.
        await closeStream(stream);
      }
      if (finished !== undefined || usage !== null) {
        this.#onCall(usage);
      }
    }
  }

  async createNonStream(body: LLMCreateParams): Promise<RawAssistantMessageWithUsage> {
    const result = await this.#llm.createNonStream(body);
    this.#onCall(reportedUsage(result.usage));
    return result;
  }
}

interface Group {
  role: ModelUsageRole;
  identity: ModelIdentity;
  calls: ModelCall[];
}

/**
 * Collects a turn's model calls and turns them into `aman.model.usage` events: one per role and
 * model, summing the usage the provider reported. Cost is the provider's own figure when it sends
 * one, else tokens at the configured price; it is null when any reported call has neither.
 */
export class TurnModelUsageLedger implements TurnModelUsage {
  readonly #prices: ModelPrices;
  readonly #now: () => Date;
  #pending: ModelCall[] = [];

  constructor({ prices, now = () => new Date() }: { prices: ModelPrices; now?: () => Date }) {
    this.#prices = prices;
    this.#now = now;
  }

  record(call: ModelCall): void {
    this.#pending.push(call);
  }

  /** The events for calls recorded since the last take; empties the ledger. */
  takeEvents(): ModelUsagePersistedEvent[] {
    const calls = this.#pending;
    this.#pending = [];
    const groups = new Map<string, Group>();
    for (const call of calls) {
      const key = [call.role, call.identity.provider, call.identity.model_name, call.identity.model_id].join('\u0000');
      const group = groups.get(key) ?? { role: call.role, identity: call.identity, calls: [] };
      group.calls.push(call);
      groups.set(key, group);
    }
    const createdAt = this.#now().toISOString();
    return [...groups.values()].map(group => this.#toEvent({ group, createdAt }));
  }

  #toEvent({ group, createdAt }: { group: Group; createdAt: string }): ModelUsagePersistedEvent {
    const { identity } = group;
    const price = lookupModelPrice({
      providerType: identity.provider,
      modelId: identity.model_id,
      configured: this.#prices,
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let reportedCalls = 0;
    let costUsd: number | null = 0;
    for (const { usage } of group.calls) {
      if (usage === null) {
        continue;
      }
      reportedCalls += 1;
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      const callCost =
        usage.cost_in_usd ??
        (price === undefined
          ? undefined
          : priceTokens({ price, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }));
      costUsd = costUsd === null || callCost === undefined ? null : costUsd + callCost;
    }
    return {
      type: MODEL_USAGE_EVENT_TYPE,
      id: newEventId(),
      created_at: createdAt,
      role: group.role,
      model_name: identity.model_name,
      model_id: identity.model_id,
      display_name: modelDisplayName({
        providerType: identity.provider,
        modelId: identity.model_id,
        configured: this.#prices,
      }),
      provider: identity.provider,
      calls: group.calls.length,
      reported_calls: reportedCalls,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: reportedCalls === 0 ? null : costUsd,
    };
  }
}

/** What the turn event drain needs to persist the usage a turn recorded. */
export interface ModelUsageDrainMember {
  ledger: TurnModelUsageLedger;
  eventStore: ICompletedTurnEventStore;
}

/**
 * Persists the calls recorded since the last flush, then echoes them to the turn's live stream.
 * Never throws: usage display is best effort and must not affect the turn. Called once when the
 * turn completes and again after its follow-up helper work, which records later.
 */
export async function flushModelUsage({
  member,
  sessionId,
  turnId,
  turnEventStream,
  logger,
}: {
  member: ModelUsageDrainMember;
  sessionId: string;
  turnId: string;
  turnEventStream: EventSubscription<TurnStreamingEvent>;
  logger: Logger;
}): Promise<void> {
  const events = member.ledger.takeEvents();
  if (events.length === 0) {
    return;
  }
  try {
    await member.eventStore.appendEventsToDoneTurn({ session_id: sessionId, turn_id: turnId, events });
  } catch (error) {
    logger.warn('Model usage events could not be persisted', { sessionId, turnId, ...extractErrorLogFields(error) });
    return;
  }
  for (const event of events) {
    try {
      await turnEventStream.put(event);
    } catch (error) {
      logger.warn('Model usage event was persisted but not streamed', {
        sessionId,
        turnId,
        ...extractErrorLogFields(error),
      });
    }
  }
}
