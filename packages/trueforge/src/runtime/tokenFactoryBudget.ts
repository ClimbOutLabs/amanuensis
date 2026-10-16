import type {
  CompletionUsage,
  ExtendedChatCompletionChunk,
  ILLM,
  LLMCreateParams,
  LLMCreateParamsStreaming,
  RawAssistantMessageWithUsage,
  VercelAIProviderName,
} from '@truefoundry/trueforge-core/core';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'winston';

import type { ITokenFactoryUsageStore } from '../db/tokenFactoryUsageStore';

/** Machine-readable `error.code` on the 429 returned once the daily budget is used up. */
export const TOKEN_FACTORY_DAILY_CAP_CODE = 'token_factory_daily_cap_reached';

/** A call to Token Factory was refused because today's token budget is used up. */
export class TokenFactoryDailyCapError extends HTTPException {
  readonly code = TOKEN_FACTORY_DAILY_CAP_CODE;

  constructor() {
    super(429, { message: "Today's Token Factory token budget is used up. It resets at midnight UTC." });
    this.name = 'TokenFactoryDailyCapError';
  }
}

/** The UTC calendar day of an instant as `YYYY-MM-DD`; the key the budget resets on. */
export function utcUsageDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export interface TokenFactoryBudget {
  /** True once today's counted tokens reach the cap; never true without a cap. */
  isExhausted(): Promise<boolean>;
  /** Throws {@link TokenFactoryDailyCapError} once today's counted tokens reach the cap. */
  assertWithinCap(): Promise<void>;
  /** Adds provider-reported tokens to today's UTC counter. */
  record(tokens: number): Promise<void>;
}

/**
 * Counts Token Factory tokens per UTC day against `cap`. With no cap every call is a no-op, so an
 * instance without `TOKEN_FACTORY_DAILY_TOKEN_CAP` never touches the store.
 */
export function createTokenFactoryBudget({
  store,
  cap,
  now = () => new Date(),
}: {
  store: ITokenFactoryUsageStore;
  cap: number | undefined;
  now?: () => Date;
}): TokenFactoryBudget {
  async function isExhausted(): Promise<boolean> {
    if (cap === undefined) {
      return false;
    }
    const usage = await store.getUsage({ usage_date: utcUsageDate(now()) });
    return (usage?.used_tokens ?? 0) >= cap;
  }
  return {
    isExhausted,
    async assertWithinCap() {
      if (await isExhausted()) {
        throw new TokenFactoryDailyCapError();
      }
    },
    async record(tokens) {
      if (cap === undefined || tokens <= 0) {
        return;
      }
      await store.addUsage({ usage_date: utcUsageDate(now()), tokens });
    },
  };
}

/**
 * Which side of a model's routing is Token Factory: `primary` for a Token Factory model (or
 * `TOKEN_FACTORY_MODE=force`), `fallback` for `TOKEN_FACTORY_MODE=fallback`, where it only answers
 * once the configured provider failed.
 */
export type TokenFactoryRole = 'primary' | 'fallback';

/** The Token Factory side of a model's routing, if it has one. */
export function tokenFactoryRole({
  primaryType,
  fallbackType,
}: {
  primaryType: VercelAIProviderName;
  fallbackType: VercelAIProviderName | undefined;
}): TokenFactoryRole | undefined {
  if (primaryType === 'tokenfactory') {
    return 'primary';
  }
  return fallbackType === 'tokenfactory' ? 'fallback' : undefined;
}

async function closeStream(stream: AsyncIterator<unknown>): Promise<void> {
  await stream.return?.();
}

/**
 * The one place Token Factory calls are limited and counted. The budget is re-checked before every
 * call: a Token Factory primary is refused with the daily-cap error, a Token Factory fallback is left
 * out of the call. Usage is counted from each chunk that reports it, so a stream that is aborted or
 * fails afterwards still counts what the provider already reported. A call that failed over is
 * counted only when Token Factory was the side that answered.
 */
export class TokenFactoryMeteredLLM implements ILLM {
  readonly #role: TokenFactoryRole;
  readonly #budget: TokenFactoryBudget;
  readonly #logger: Logger;
  readonly #build: (options: { withFailover: boolean; onFailover: () => void }) => ILLM;

  constructor({
    role,
    budget,
    logger,
    build,
  }: {
    role: TokenFactoryRole;
    budget: TokenFactoryBudget;
    logger: Logger;
    /** Builds the client for one call; `withFailover: false` must leave out any fallback provider. */
    build: (options: { withFailover: boolean; onFailover: () => void }) => ILLM;
  }) {
    this.#role = role;
    this.#budget = budget;
    this.#logger = logger;
    this.#build = build;
  }

  async *create(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    let withFailover = true;
    if (this.#role === 'primary') {
      await this.#budget.assertWithinCap();
    } else {
      withFailover = !(await this.#budget.isExhausted());
    }
    let failedOver = false;
    const stream = this.#build({
      withFailover,
      onFailover: () => {
        failedOver = true;
      },
    }).create(body);
    let finished = false;
    try {
      for (;;) {
        const step = await stream.next();
        if (step.done) {
          finished = true;
          return step.value;
        }
        // Failover happens before the first chunk, so the flag is settled by the time usage arrives.
        if (this.#servedByTokenFactory(failedOver)) {
          await this.#count(step.value.usage);
        }
        yield step.value;
      }
    } finally {
      // A consumer that stops early (turn cancelled) must close the provider stream too.
      if (!finished) {
        await closeStream(stream);
      }
    }
  }

  async createNonStream(body: LLMCreateParams): Promise<RawAssistantMessageWithUsage> {
    const stream = this.create({ ...body, stream: true });
    let step = await stream.next();
    while (!step.done) {
      step = await stream.next();
    }
    return step.value;
  }

  #servedByTokenFactory(failedOver: boolean): boolean {
    return (this.#role === 'primary') !== failedOver;
  }

  /** Counting never fails the call: a store error costs one count, not the reply. */
  async #count(usage: CompletionUsage | null | undefined): Promise<void> {
    if (usage === undefined || usage === null) {
      return;
    }
    try {
      await this.#budget.record(usage.input_tokens + usage.output_tokens);
    } catch (error) {
      this.#logger.warn('Token Factory usage could not be counted', extractErrorLogFields(error));
    }
  }
}

/**
 * Meters a helper call (relevance judge, summarization, profile learning) that has no failover
 * routing: only a model configured on the `tokenfactory` provider is Token Factory traffic.
 */
export function meterHelperLlm({
  llm,
  providerType,
  budget,
  logger,
}: {
  llm: ILLM;
  providerType: VercelAIProviderName;
  budget: TokenFactoryBudget;
  logger: Logger;
}): ILLM {
  if (providerType !== 'tokenfactory') {
    return llm;
  }
  return new TokenFactoryMeteredLLM({ role: 'primary', budget, logger, build: () => llm });
}
