/**
 * In-memory registry of turns executing in this process. Keys are
 * `${sessionId}:${turnId}`. Cancel aborts via AbortController;
 * TurnHandle.stream() writes the terminal state when the signal fires.
 * `track()` owns registration and cleanup around the stream lifecycle.
 */
import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';

interface ActiveTurnRun {
  abortController: AbortController;
  waitUntilCompleted: Promise<void>;
  markCompleted: () => void;
}

function activeTurnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`;
}

/**
 * A chat turn this process is still setting up. It is not in the store yet, so a Cancel that comes
 * now cannot find it by id; it is marked here instead, and the turn starts already cancelled.
 */
export class TurnAdmission {
  #cancelReason: CancellationReason | undefined;

  constructor(private readonly onRelease: () => void) {}

  get cancelReason(): CancellationReason | undefined {
    return this.#cancelReason;
  }

  cancel(reason: CancellationReason): void {
    this.#cancelReason ??= reason;
  }

  /** Ends the admission. Safe to call more than once. */
  release(): void {
    this.onRelease();
  }
}

export class ActiveTurnRegistry {
  private readonly runs = new Map<string, ActiveTurnRun>();
  private readonly admissions = new Map<string, Set<TurnAdmission>>();
  private alreadyShutDownAbortReason: CancellationReason | undefined;
  private readonly startedAt = new Date();

  /** True for a turn created before this process started: no run here can own it. */
  predates(createdAt: Date): boolean {
    return createdAt < this.startedAt;
  }

  /** Registers a chat turn that is being set up, before it has an id in the store. */
  admit(input: { sessionId: string }): TurnAdmission {
    const admission: TurnAdmission = new TurnAdmission(() => {
      const pending = this.admissions.get(input.sessionId);
      pending?.delete(admission);
      if (pending?.size === 0) {
        this.admissions.delete(input.sessionId);
      }
    });
    const pending = this.admissions.get(input.sessionId) ?? new Set<TurnAdmission>();
    pending.add(admission);
    this.admissions.set(input.sessionId, pending);
    return admission;
  }

  /** Marks every turn of the chat still being set up here, so each one starts already cancelled. */
  cancelAdmissions(input: { sessionId: string; abortReason: CancellationReason }): void {
    for (const admission of this.admissions.get(input.sessionId) ?? []) {
      admission.cancel(input.abortReason);
    }
  }

  /**
   * Registers the run immediately, then returns a generator that forwards
   * `stream` and removes the run when the stream completes (or the consumer
   * exits early). If shutdown has already begun, aborts the controller with
   * the shutdown reason so the turn ends as abandoned. A turn whose admission
   * was cancelled is aborted the same way, so it ends before reaching the model.
   */
  track<T>(input: {
    sessionId: string;
    turnId: string;
    abortController: AbortController;
    stream: AsyncIterable<T>;
    admission?: TurnAdmission | undefined;
  }): AsyncGenerator<T> {
    const key = activeTurnKey(input.sessionId, input.turnId);
    const { promise: waitUntilCompleted, resolve } = Promise.withResolvers<undefined>();
    const markCompleted = (): void => {
      resolve(undefined);
    };
    const run: ActiveTurnRun = {
      abortController: input.abortController,
      waitUntilCompleted,
      markCompleted,
    };
    this.runs.set(key, run);

    // Accepted HTTP may still call track() after shutdownAndWait snapshotted;
    // abort immediately so the turn ends as abandoned instead of running past exit.
    if (this.alreadyShutDownAbortReason !== undefined) {
      if (!input.abortController.signal.aborted) {
        input.abortController.abort(this.alreadyShutDownAbortReason);
      }
    }
    // From here on a Cancel finds the run by its id.
    input.admission?.release();
    const admissionCancelReason = input.admission?.cancelReason;
    if (admissionCancelReason !== undefined && !input.abortController.signal.aborted) {
      input.abortController.abort(admissionCancelReason);
    }

    const complete = () => {
      run.markCompleted();
      if (this.runs.get(key) === run) {
        this.runs.delete(key);
      }
    };
    async function* tracked(): AsyncGenerator<T> {
      try {
        yield* input.stream;
      } finally {
        complete();
      }
    }
    return tracked();
  }

  /**
   * Aborts the given turn if it is running in this process. Returns true when
   * the run was found (already-aborted runs are not re-aborted). Cancelling a
   * turn that is not running is a no-op, mirroring the store's
   * first-terminal-write-wins rule.
   */
  cancelIfRunning(input: { sessionId: string; turnId: string; abortReason: CancellationReason }): boolean {
    const run = this.runs.get(activeTurnKey(input.sessionId, input.turnId));
    if (!run) {
      return false;
    }
    if (!run.abortController.signal.aborted) {
      run.abortController.abort(input.abortReason);
    }
    return true;
  }

  /**
   * Enter shutdown mode, abort every run with `abortReason`, and wait until the
   * registry is empty. Late `track()` calls (in-flight HTTP that registered after
   * the first snapshot) are aborted immediately as `abortReason` and included in
   * subsequent wait iterations.
   */
  async shutdownAndWait(abortReason: CancellationReason): Promise<void> {
    this.alreadyShutDownAbortReason = abortReason;
    while (this.runs.size > 0) {
      const pending = Array.from(this.runs.values());
      for (const run of pending) {
        if (!run.abortController.signal.aborted) {
          run.abortController.abort(abortReason);
        }
      }
      await Promise.allSettled(pending.map(run => run.waitUntilCompleted));
    }
  }
}
