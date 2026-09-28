import {
  DockerDriver,
  type DockerCommandRunner,
  type DockerDriverOptions,
} from './DockerDriver.js';
import type {
  DriverReadiness,
  DriverRunParams,
  DriverRunResult,
  IsolationDriver,
} from './IsolationDriver.js';

/**
 * Options for the gVisor driver. Mirrors DockerDriverOptions minus the
 * runtime (always 'runsc') — gVisor isolation is the point of this driver.
 */
export type GVisorDriverOptions = Omit<DockerDriverOptions, 'runtime'>;

/**
 * gVisor-isolated sandbox driver (the "sandboxd" backend).
 *
 * Spawns one micro-sandbox per execution using Docker with the runsc
 * (gVisor) runtime. The gVisor Sentry intercepts syscalls in userspace, so a
 * container escape must beat gVisor, not just Linux namespaces. No VM boot,
 * no KVM requirement — runsc works everywhere Docker works.
 *
 * All hardening (read-only rootfs, tmpfs scratch, no network, resource
 * limits, hard timeouts) comes from the DockerDriver this wraps; the only
 * difference is the OCI runtime.
 */
export class GVisorDriver implements IsolationDriver {
  readonly kind: 'gvisor' = 'gvisor';

  private readonly inner: DockerDriver;

  constructor(options: GVisorDriverOptions, commandRunner: DockerCommandRunner | undefined) {
    this.inner = new DockerDriver({ ...options, runtime: 'runsc' }, commandRunner);
  }

  ensureReady(signal?: AbortSignal): Promise<DriverReadiness> {
    return this.inner.ensureReady(signal);
  }

  provision(input: {
    signal: AbortSignal | undefined;
    onProgress: (message: string) => void;
    timeoutSeconds: number;
  }): Promise<void> {
    return this.inner.provision(input);
  }

  run(params: DriverRunParams): Promise<DriverRunResult> {
    return this.inner.run(params);
  }

  reapStale(): Promise<void> {
    return this.inner.reapStale();
  }

  dispose(): Promise<void> {
    return this.inner.dispose();
  }
}
