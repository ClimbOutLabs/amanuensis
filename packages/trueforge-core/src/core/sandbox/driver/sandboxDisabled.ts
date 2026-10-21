import type { DriverReadiness, DriverRunResult, IsolationDriver } from './IsolationDriver';
import { SANDBOX_DISABLED_MESSAGE } from './sandboxDisabledText';

/** Stands in for a real driver on an installer instance without the sandbox, so every run explains how to turn it on. */
export class DisabledDriver implements IsolationDriver {
  readonly kind = 'slots';
  readonly packageGatewayCapable = false;

  ensureReady(): Promise<DriverReadiness> {
    return Promise.resolve({
      ready: false,
      error_code: 'sandbox_disabled',
      error: SANDBOX_DISABLED_MESSAGE,
      verbatim: true,
    });
  }

  provision(): Promise<void> {
    return Promise.reject(new Error(SANDBOX_DISABLED_MESSAGE));
  }

  run(): Promise<DriverRunResult> {
    return Promise.reject(new Error(SANDBOX_DISABLED_MESSAGE));
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
