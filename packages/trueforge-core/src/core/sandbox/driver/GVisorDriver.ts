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
export interface GVisorDriverOptions {
  /** tag@sha256:<digest>. The digest pin is enforced at ensureReady; a bare tag is refused. */
  image: string;
  /** Path to the cosign public-key PEM. Signature verification is fail-closed. */
  cosignPublicKeyPath: string;
  dockerBinary: string | undefined;
  cosignBinary: string | undefined;
  /** Bound for docker info / image inspect / cosign verify. Default 5000. */
  commandTimeoutMs: number | undefined;
  /** Bound for the wedged-daemon docker create probe. Default 30000. */
  createTimeoutMs: number | undefined;
}

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
    const dockerOptions: DockerDriverOptions = {
      image: options.image,
      cosignPublicKeyPath: options.cosignPublicKeyPath,
      dockerBinary: options.dockerBinary,
      cosignBinary: options.cosignBinary,
      commandTimeoutMs: options.commandTimeoutMs,
      createTimeoutMs: options.createTimeoutMs,
      runtime: 'runsc',
    };
    this.inner = new DockerDriver(dockerOptions, commandRunner);
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
