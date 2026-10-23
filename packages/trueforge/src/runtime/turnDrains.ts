function turnDrainKey(input: { sessionId: string; turnId: string }): string {
  return `${input.sessionId}:${input.turnId}`;
}

/**
 * Tracks in-flight turn event drains (per-event dual-writes plus the TURN_DONE
 * submissions) so shutdown can wait for them before the database is torn down.
 */
export class TurnDrainRegistry {
  private readonly drains = new Map<string, Promise<void>>();
  /** Each chat's latest turn whose sandbox files are still being saved, keyed by session. */
  private readonly artifactCaptures = new Map<string, { turnId: string; capture: Promise<void> }>();

  /**
   * Tracks a drain promise and unregisters it when it settles. A rejected drain
   * still unregisters; the drain itself owns its error logging.
   */
  track(input: { sessionId: string; turnId: string; drain: Promise<void> }): void {
    const key = turnDrainKey(input);
    this.drains.set(key, input.drain);
    const remove = (): void => {
      if (this.drains.get(key) === input.drain) {
        this.drains.delete(key);
      }
    };
    void input.drain.then(remove, remove);
  }

  /**
   * Tracks the step that saves a turn's sandbox files. The chat's next turn reuses that
   * sandbox, so it waits on this step before its tools can change those files.
   */
  trackArtifactCapture(input: { sessionId: string; turnId: string; capture: Promise<void> }): void {
    const entry = { turnId: input.turnId, capture: input.capture };
    this.artifactCaptures.set(input.sessionId, entry);
    const remove = (): void => {
      if (this.artifactCaptures.get(input.sessionId) === entry) {
        this.artifactCaptures.delete(input.sessionId);
      }
    };
    void input.capture.then(remove, remove);
  }

  /**
   * Waits for the chat's tracked capture step, giving up after `timeoutMs`. Returns the turn
   * whose capture was still running when the wait gave up, if any. Never throws.
   */
  async waitForArtifactCapture(input: {
    sessionId: string;
    timeoutMs: number;
  }): Promise<{ turnId: string } | undefined> {
    const entry = this.artifactCaptures.get(input.sessionId);
    if (entry === undefined) {
      return undefined;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      const timedOut = await Promise.race([
        entry.capture.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>(resolve => {
          timeout = setTimeout(() => {
            resolve(true);
          }, input.timeoutMs);
          // Unref'd so a pending capture never keeps the process alive on its own.
          timeout.unref();
        }),
      ]);
      return timedOut ? { turnId: entry.turnId } : undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Number of drains currently tracked. */
  get size(): number {
    return this.drains.size;
  }

  /**
   * Waits for every tracked drain to settle, giving up after `timeoutMs` so a
   * stuck provider call cannot hang shutdown. Drains still running after the
   * timeout keep running; they just no longer block shutdown. Never throws.
   */
  async shutdownAndWait(input: { timeoutMs: number }): Promise<void> {
    const pending = Array.from(this.drains.values());
    if (pending.length === 0) {
      return;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, input.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
