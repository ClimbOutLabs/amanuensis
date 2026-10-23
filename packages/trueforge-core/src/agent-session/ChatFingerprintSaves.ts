import type { Logger } from 'winston';
import {
  chatFingerprintsAfterTurn,
  hasPrivateFingerprintsToSave,
  hasUnrepeatedPrivateFingerprints,
  type WebSearchTurnState,
} from '../core/permissions/webSearch';
import type { SetPrivateFingerprintsInput } from './store/ISessionStore';

/**
 * The turns of each chat whose private-text fingerprints the store may not hold yet: still running, or whose save
 * failed. A turn that starts while one is unsaved cannot trust the stored record, so it runs as if a fingerprint
 * were lost. One per process, like the process-local private-read mark it backs.
 */
class ChatFingerprintSaves {
  private readonly running = new Map<string, Set<WebSearchTurnState>>();
  /** Chats whose last failed save has not yet been followed by a stored incomplete record. */
  private readonly failed = new Set<string>();

  /**
   * Registers a starting turn. Returns true when an earlier turn of the chat has fingerprints the store may not
   * hold. Call it before reading the stored record, so a save that finishes in between is in what is read.
   */
  begin(input: { session_id: string; state: WebSearchTurnState }): boolean {
    const running = this.running.get(input.session_id) ?? new Set<WebSearchTurnState>();
    const unsaved = this.failed.has(input.session_id) || [...running].some(hasUnrepeatedPrivateFingerprints);
    running.add(input.state);
    this.running.set(input.session_id, running);
    return unsaved;
  }

  /** Saves the turn's fingerprints when it has any, then forgets the turn. */
  async finish(input: {
    session_id: string;
    state: WebSearchTurnState;
    store: { setPrivateFingerprints(input: SetPrivateFingerprintsInput): Promise<void> };
    logger: Logger | undefined;
  }): Promise<void> {
    try {
      if (!hasPrivateFingerprintsToSave(input.state)) {
        return;
      }
      const fingerprints = chatFingerprintsAfterTurn(input.state);
      try {
        await input.store.setPrivateFingerprints({ session_id: input.session_id, fingerprints });
      } catch (err: unknown) {
        // Later turns of this chat in this process run as if a fingerprint were lost, until one stores that. Text the
        // host puts before the model each turn is kept again by the next turn, so losing only that loses nothing.
        if (hasUnrepeatedPrivateFingerprints(input.state)) {
          this.failed.add(input.session_id);
        }
        input.logger?.warn('Saving the chat fingerprints failed', { err });
        return;
      }
      // A stored incomplete record stays incomplete, so it covers whatever a failed save missed.
      if (!fingerprints.complete) {
        this.failed.delete(input.session_id);
      }
    } finally {
      this.forget(input);
    }
  }

  /** Forgets a turn that was registered but never ran. */
  forget(input: { session_id: string; state: WebSearchTurnState }): void {
    const running = this.running.get(input.session_id);
    running?.delete(input.state);
    if (running?.size === 0) {
      this.running.delete(input.session_id);
    }
  }
}

/** Shared by every session handle of the process, so a turn sees the unsaved turns of its chat. */
export const chatFingerprintSaves = new ChatFingerprintSaves();
