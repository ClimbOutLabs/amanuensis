import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

/** What the person sees when a reply never got going. */
export const TURN_COULD_NOT_START_MESSAGE = 'This reply could not start. Send your message again.';

/** A turn whose setup ran past its start limit or its deadline; nothing was created. */
export class TurnCouldNotStartError extends Error {
  constructor() {
    super(TURN_COULD_NOT_START_MESSAGE);
    this.name = 'TurnCouldNotStartError';
  }
}

/**
 * Limits the time from a turn's acceptance to its first model work: a model chunk, or a tool
 * starting or answering. Setup events (connectors starting, memory recall, a sandbox) do not count.
 * Past the limit the turn is aborted and, once it exists, ended through `end`, which must not depend
 * on the stuck step honouring the abort.
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

  /** The turn reached the model; the bound no longer applies. */
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

export type TurnSetupOutcome<T> = { status: 'ready'; value: T } | { status: 'could_not_start' };

/**
 * Runs a turn's setup, up to and including its creation, against the turn's time running out on its
 * signal (its start limit or its deadline). Setup steps need not honour the signal: when it fires first the answer is
 * `could_not_start` at once, and the setup finishes in the background, where `discard` ends what it made.
 */
export async function raceTurnSetup<T>(input: {
  signal: AbortSignal;
  setup: () => Promise<T>;
  discard: (value: T) => Promise<void>;
  logger: Logger;
  sessionId: string;
}): Promise<TurnSetupOutcome<T>> {
  const { signal, logger, sessionId } = input;
  // Read live: the signal fires while the setup runs. Setup aborting its own turn is not a timeout.
  const ranOutOfTime = (): boolean => signal.reason === CancellationReason.ServerExecutionTimeout;
  if (ranOutOfTime()) {
    return { status: 'could_not_start' };
  }
  const aborted = Promise.withResolvers<TurnSetupOutcome<T>>();
  const onAbort = (): void => {
    if (ranOutOfTime()) {
      aborted.resolve({ status: 'could_not_start' });
    }
  };
  signal.addEventListener('abort', onAbort);
  const work = input.setup();
  let outcome: TurnSetupOutcome<T>;
  try {
    outcome = await Promise.race([
      work.then((value): TurnSetupOutcome<T> => ({ status: 'ready', value })),
      aborted.promise,
    ]);
  } catch (error) {
    if (!ranOutOfTime()) {
      throw error;
    }
    logger.warn('A turn failed while it was being set up after its time ran out', {
      sessionId,
      ...extractErrorLogFields(error),
    });
    return { status: 'could_not_start' };
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (outcome.status === 'could_not_start') {
    void work.then(input.discard).catch((error: unknown) => {
      logger.warn('Cleaning up a turn that could not start failed', { sessionId, ...extractErrorLogFields(error) });
    });
  }
  return outcome;
}
