import type { TurnStreamingEvent } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';
import { HTTPException } from 'hono/http-exception';

import type { ITokenFactoryUsageStore } from '../db/tokenFactoryUsageStore';

/** Machine-readable `error.code` on the 429 returned once the daily budget is used up. */
export const TOKEN_FACTORY_DAILY_CAP_CODE = 'token_factory_daily_cap_reached';

/** A new turn on Token Factory was refused because today's token budget is used up. */
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
  /** Throws {@link TokenFactoryDailyCapError} once today's counted tokens reach the cap. */
  assertWithinCap(): Promise<void>;
  /** Adds provider-reported tokens to today's UTC counter. */
  record(tokens: number): Promise<void>;
}

/**
 * Counts Token Factory tokens per UTC day against `cap`. With no cap both calls are no-ops, so an
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
  return {
    async assertWithinCap() {
      if (cap === undefined) {
        return;
      }
      const usage = await store.getUsage({ usage_date: utcUsageDate(now()) });
      if ((usage?.used_tokens ?? 0) >= cap) {
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
 * One turn's view of the budget. A turn is admitted when its primary model is on Token Factory;
 * only admitted turns have their usage counted. A turn already running when the cap is crossed
 * finishes, so the cap can be overshot by at most the turns in flight.
 */
export class TokenFactoryTurnMeter {
  readonly #budget: TokenFactoryBudget;
  #admitted = false;

  constructor(budget: TokenFactoryBudget) {
    this.#budget = budget;
  }

  /** Refuses the turn when the cap is reached, otherwise starts counting its usage. */
  async admit(): Promise<void> {
    await this.#budget.assertWithinCap();
    this.#admitted = true;
  }

  /** Counts the provider-reported usage on a completed model message. */
  async observe(event: TurnStreamingEvent): Promise<void> {
    if (!this.#admitted || event.type !== EventType.MODEL_MESSAGE || event.usage === undefined) {
      return;
    }
    await this.#budget.record(event.usage.input_tokens + event.usage.output_tokens);
  }
}
