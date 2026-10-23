import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

/** What the person sees when a reply never got going. */
export const TURN_COULD_NOT_START_MESSAGE = 'This reply could not start. Send your message again.';

/**
 * Limits the time from a turn's acceptance to its first sign of work after `turn.created` (a model
 * chunk, a tool starting, a connector starting). Past the limit the turn is aborted and, once it
 * exists, ended through `end`, which must not depend on the stuck step honouring the abort.
 */
export class TurnStartBound {
  readonly #abortController: AbortController;
  readonly #timeoutMs: number;
  readonly #logger: Logger;
  readonly #sessionId: string;
  #timer: NodeJS.Timeout | undefined;
  #expired = false;
  #settled = false;
  #end: (() => Promise<void>) | undefined;

  constructor(input: { abortController: AbortController; timeoutMs: number; logger: Logger; sessionId: string }) {
    this.#abortController = input.abortController;
    this.#timeoutMs = input.timeoutMs;
    this.#logger = input.logger;
    this.#sessionId = input.sessionId;
  }

  get expired(): boolean {
    return this.#expired;
  }

  arm(): void {
    if (this.#timer !== undefined || this.#settled) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#expire();
    }, this.#timeoutMs);
    // Unref'd so a pending bound never keeps the process alive on its own.
    this.#timer.unref();
  }

  /** The turn showed work; the bound no longer applies. */
  markStarted(): void {
    this.#settled = true;
    this.dispose();
  }

  /** Called once the turn exists. Runs `end` right away when the limit already passed. */
  async whenExpired(end: () => Promise<void>): Promise<void> {
    this.#end = end;
    if (this.#expired) {
      await this.#runEnd();
    }
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #expire(): void {
    this.#timer = undefined;
    if (this.#settled) {
      return;
    }
    this.#expired = true;
    this.#logger.warn('A turn did not start within its time limit; ending it', {
      sessionId: this.#sessionId,
      timeoutMs: this.#timeoutMs,
    });
    if (this.#end === undefined) {
      // Not created yet: stop whatever setup step listens to the signal.
      this.#abortController.abort(CancellationReason.ServerExecutionTimeout);
      return;
    }
    void this.#runEnd();
  }

  async #runEnd(): Promise<void> {
    const end = this.#end;
    if (end === undefined || this.#settled) {
      return;
    }
    this.#settled = true;
    try {
      await end();
    } catch (error) {
      this.#logger.error('Ending a turn that did not start failed', {
        sessionId: this.#sessionId,
        ...extractErrorLogFields(error),
      });
    }
  }
}
