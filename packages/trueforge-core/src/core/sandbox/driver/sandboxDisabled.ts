import type { DriverReadiness, DriverRunResult, IsolationDriver } from './IsolationDriver';
import { sandboxDisabledMessage } from './sandboxDisabledText';

/** Stands in for a real driver on an installer instance without the sandbox, so every run explains how to turn it on. */
export class DisabledDriver implements IsolationDriver {
  readonly kind = 'slots';

  constructor(private readonly instance: string | undefined) {}

  ensureReady(): Promise<DriverReadiness> {
    return Promise.resolve({
      ready: false,
      error_code: 'sandbox_disabled',
      error: sandboxDisabledMessage({ instance: this.instance }),
      verbatim: true,
    });
  }

  provision(): Promise<void> {
    return Promise.reject(new Error(sandboxDisabledMessage({ instance: this.instance })));
  }

  run(): Promise<DriverRunResult> {
    return Promise.reject(new Error(sandboxDisabledMessage({ instance: this.instance })));
  }

  isRunGone(): Promise<boolean> {
    return Promise.resolve(true);
  }

  reapStale(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
