/**
 * A per-model limit on requests in flight, shared by every thread in the process. A model that
 * can only serve one request at a time (a self-hosted server with room for a single sequence)
 * falls further and further behind when two long turns race it, and both can look silent to the
 * caller even though tokens are flowing. Under a limit, the later request waits its turn instead
 * of racing, and its silence deadlines only start once the request is actually sent, because the
 * caller acquires the slot before it creates the request.
 */

interface GateWaiter {
  withdrawn: boolean;
  grant: () => void;
}

interface GateState {
  inFlight: number;
  limit: number;
  waiters: GateWaiter[];
}

type SlotState = 'waiting' | 'holding' | 'done';

/** One request's place in a model's queue. */
export interface ModelRequestSlot {
  /** True when the request had to wait for another request to finish before it could be sent. */
  readonly queued: boolean;
  /** Resolves when the request may be sent. Never resolves after cancel(). */
  readonly granted: Promise<void>;
  /** Hands the place back so the next waiting request can go; safe to call more than once. */
  release(): void;
  /**
   * Gives the place up from any state: a still-waiting request leaves the queue, a granted one
   * hands its place back. For a caller abandoning the wait (its turn was cancelled), so the
   * queue can never wedge on a place nobody will release.
   */
  cancel(): void;
}

export class ModelRequestGate {
  private readonly states = new Map<string, GateState>();

  /**
   * Takes a place for one request to `key`'s model, at most `limit` in flight. Grants at once
   * when a place is free; otherwise the returned slot is queued, first come first served, and
   * its `granted` resolves when a finishing request hands its place over. The latest call's
   * limit wins for a key, so a settings change applies to the next request.
   */
  begin({ key, limit }: { key: string; limit: number }): ModelRequestSlot {
    let state = this.states.get(key);
    if (state === undefined) {
      state = { inFlight: 0, limit, waiters: [] };
      this.states.set(key, state);
    }
    state.limit = limit;

    if (state.inFlight < state.limit) {
      state.inFlight += 1;
      let slotState: SlotState = 'holding';
      return {
        queued: false,
        granted: Promise.resolve(),
        release: () => {
          if (slotState !== 'holding') {
            return;
          }
          slotState = 'done';
          this.handBack(key, state);
        },
        cancel: () => {
          if (slotState !== 'holding') {
            return;
          }
          slotState = 'done';
          this.handBack(key, state);
        },
      };
    }

    let slotState: SlotState = 'waiting';
    let resolveGranted: (() => void) | undefined;
    const granted = new Promise<void>(resolve => {
      resolveGranted = () => {
        resolve();
      };
    });
    const waiter: GateWaiter = {
      withdrawn: false,
      grant: () => {
        // The state flips synchronously with the handover, so a release or cancel racing the
        // caller's `granted` continuation still sees the true state.
        if (slotState !== 'waiting') {
          return;
        }
        slotState = 'holding';
        resolveGranted?.();
      },
    };
    state.waiters.push(waiter);
    const giveUp = (): void => {
      if (slotState === 'waiting') {
        slotState = 'done';
        waiter.withdrawn = true;
        this.forgetIfIdle(key, state);
      } else if (slotState === 'holding') {
        slotState = 'done';
        this.handBack(key, state);
      }
    };
    return {
      queued: true,
      granted,
      release: () => {
        if (slotState !== 'holding') {
          return;
        }
        slotState = 'done';
        this.handBack(key, state);
      },
      cancel: giveUp,
    };
  }

  private handBack(key: string, state: GateState): void {
    state.inFlight -= 1;
    while (state.inFlight < state.limit) {
      const waiter = state.waiters.shift();
      if (waiter === undefined) {
        break;
      }
      if (waiter.withdrawn) {
        continue;
      }
      state.inFlight += 1;
      waiter.grant();
    }
    this.forgetIfIdle(key, state);
  }

  private forgetIfIdle(key: string, state: GateState): void {
    if (state.inFlight === 0 && state.waiters.every(waiter => waiter.withdrawn)) {
      state.waiters.length = 0;
      if (this.states.get(key) === state) {
        this.states.delete(key);
      }
    }
  }
}
