import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';

/** Mutable absolute turn deadline. Registered verification may extend, but never shorten, it. */
export class TurnExecutionDeadline {
  readonly #abortController: AbortController;
  readonly #defaultTimeoutMs: number;
  readonly #finalizationBufferMs: number;
  #deadlineAtMs: number | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(input: { abortController: AbortController; default_timeout_ms: number; finalization_buffer_ms: number }) {
    this.#abortController = input.abortController;
    this.#defaultTimeoutMs = input.default_timeout_ms;
    this.#finalizationBufferMs = input.finalization_buffer_ms;
  }

  arm(): void {
    if (this.#deadlineAtMs !== undefined) {
      throw new Error('Turn execution deadline is already armed');
    }
    this.#setDeadline(Date.now() + this.#defaultTimeoutMs);
  }

  extendForRegisteredCommand(timeoutMs: number): void {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Registered-command timeout must be a positive integer');
    }
    const current = this.#deadlineAtMs;
    if (current === undefined) {
      throw new Error('Turn execution deadline must be armed before it can be extended');
    }
    const candidate = Date.now() + timeoutMs + this.#finalizationBufferMs;
    if (candidate > current) {
      this.#setDeadline(candidate);
    }
  }

  dispose(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #setDeadline(deadlineAtMs: number): void {
    this.dispose();
    this.#deadlineAtMs = deadlineAtMs;
    const delayMs = Math.max(0, deadlineAtMs - Date.now());
    this.#timer = setTimeout(() => {
      if (!this.#abortController.signal.aborted) {
        this.#abortController.abort(CancellationReason.ServerExecutionTimeout);
      }
    }, delayMs);
    this.#timer.unref();
  }
}
