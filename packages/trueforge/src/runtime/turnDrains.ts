function turnDrainKey(input: { sessionId: string; turnId: string }): string {
  return `${input.sessionId}:${input.turnId}`;
}

/**
 * Tracks in-flight turn event drains (per-event dual-writes plus the TURN_DONE
 * submissions) so shutdown can wait for them before the database is torn down.
 */
export class TurnDrainRegistry {
  private readonly drains = new Map<string, Promise<void>>();

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
