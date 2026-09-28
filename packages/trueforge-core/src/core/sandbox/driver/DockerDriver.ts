import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  OUTPUT_EXCEEDED_MARKER,
  runCodeProgramPath,
  type DriverReadiness,
  type DriverRunParams,
  type DriverRunResult,
  type IsolationDriver,
  type RunCodeLanguage,
} from './IsolationDriver.js';

const execFileAsync = promisify(execFileCallback);

/** Label selecting sandbox run containers for the reaper. */
const SANDBOX_RUN_LABEL = 'tf.sandbox.run';
/** Label for the transient wedged-daemon probe container. */
const PROBE_LABEL = 'tf.sandbox.probe';
/** Sandbox uid:gid baked into the image (plan §2.5). */
const SANDBOX_USER = '65532:65532';
/** Driver-internal per-stream capture bound; the wrapper owns the model-visible contract. */
const TRANSPORT_STREAM_CAP_BYTES = 4 * 1024 * 1024;
/** Reaper age: containers older than this are crashed-supervisor leaks. */
const STALE_CONTAINER_MS = 30 * 60 * 1000;
/** dispose() drains in-flight runs up to this long, then kills the remainder. */
const DISPOSE_DRAIN_MS = 30 * 1000;

/** Outcome of one docker/cosign CLI invocation. */
export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the invocation was killed by its own timeout. */
  timedOut: boolean;
}

/**
 * Test seam for every docker/cosign interaction: short-lived CLI calls
 * (`run`), image pulls with streaming progress (`pull`), and the
 * start+attach streaming session (`startAttach`).
 */
export interface DockerCommandRunner {
  run(
    binary: string,
    args: string[],
    options: { timeoutMs: number; signal: AbortSignal | undefined },
  ): Promise<DockerCommandResult>;
  pull(input: {
    image: string;
    signal: AbortSignal | undefined;
    onProgress: (line: string) => void;
  }): Promise<void>;
  /**
   * Starts the created container attached and streams stdout/stderr through
   * the callbacks. Resolves with the container's exit code, or undefined when
   * the CLI itself failed.
   */
  startAttach(input: {
    containerId: string;
    signal: AbortSignal | undefined;
    onStdout: (chunk: Buffer) => void;
    onStderr: (chunk: Buffer) => void;
  }): Promise<number | undefined>;
}

export interface DockerDriverOptions {
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
  /**
   * OCI runtime for `docker create` (e.g. 'runsc' for gVisor). When undefined,
   * Docker's default runtime is used.
   */
  runtime: string | undefined;
  /**
   * Pinned runsc version (exact match against `runsc --version`, e.g.
   * 'release-20260727.0'). Required when runtime is 'runsc': a blank or
   * missing pin refuses the run. Ignored for the plain Docker driver.
   */
  runscVersion: string | undefined;
}

/** execFile-shaped failure: non-zero exit or timeout kill. */
interface ExecFileFailure {
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
}

function isExecFileFailure(error: unknown): error is ExecFileFailure {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (!('code' in error) || !('killed' in error) || !('stdout' in error) || !('stderr' in error)) {
    return false;
  }
  const fields: { code: unknown; killed: unknown; stdout: unknown; stderr: unknown } = error;
  return (
    typeof fields.code === 'number' &&
    typeof fields.killed === 'boolean' &&
    typeof fields.stdout === 'string' &&
    typeof fields.stderr === 'string'
  );
}

function truncateSingleLine(text: string, maxChars: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** Production runner: real docker/cosign binaries via execFile/spawn. */
export function createDefaultDockerCommandRunner(options: { dockerBinary: string }): DockerCommandRunner {
  const dockerBinary = options.dockerBinary;
  return {
    async run(binary, args, runOptions): Promise<DockerCommandResult> {
      try {
        const { stdout, stderr } = await execFileAsync(binary, args, {
          timeout: runOptions.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          signal: runOptions.signal ?? undefined,
        });
        return { stdout, stderr, exitCode: 0, timedOut: false };
      } catch (error: unknown) {
        if (isExecFileFailure(error)) {
          return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code, timedOut: error.killed };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { stdout: '', stderr: message, exitCode: -1, timedOut: false };
      }
    },

    pull(input): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const child = spawn(dockerBinary, ['pull', input.image], { stdio: ['ignore', 'ignore', 'pipe'] });
        let settled = false;
        const finish = (error: Error | undefined): void => {
          if (settled) {
            return;
          }
          settled = true;
          input.signal?.removeEventListener('abort', onAbort);
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        };
        const onAbort = (): void => {
          child.kill('SIGKILL');
          finish(new Error('docker pull aborted'));
        };
        if (input.signal?.aborted === true) {
          onAbort();
          return;
        }
        input.signal?.addEventListener('abort', onAbort, { once: true });
        // Progress bars redraw with \r; split on both and forward distinct lines.
        let pending = '';
        let lastLine = '';
        child.stderr.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8');
          const parts = pending.split(/[\r\n]+/);
          pending = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.trim();
            if (line.length === 0 || line === lastLine) {
              continue;
            }
            lastLine = line;
            input.onProgress(line);
          }
        });
        child.on('error', (error: Error) => {
          finish(new Error(`docker pull failed to start: ${error.message}`, { cause: error }));
        });
        child.on('close', (code: number | null) => {
          if (code === 0) {
            finish(undefined);
            return;
          }
          finish(new Error(`docker pull exited with code ${String(code)}`));
        });
      });
    },

    startAttach(input): Promise<number | undefined> {
      return new Promise<number | undefined>((resolve) => {
        const child = spawn(dockerBinary, ['start', '--attach', '--interactive', input.containerId], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let settled = false;
        const finish = (exitCode: number | undefined): void => {
          if (settled) {
            return;
          }
          settled = true;
          input.signal?.removeEventListener('abort', onAbort);
          resolve(exitCode);
        };
        const onAbort = (): void => {
          // The driver docker-kills the container on abort; releasing the CLI
          // child promptly lets the run resolve without waiting on the daemon.
          child.kill('SIGKILL');
        };
        if (input.signal?.aborted === true) {
          child.kill('SIGKILL');
        } else {
          input.signal?.addEventListener('abort', onAbort, { once: true });
        }
        child.stdout.on('data', (chunk: Buffer) => {
          input.onStdout(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          input.onStderr(chunk);
        });
        child.on('error', () => {
          finish(undefined);
        });
        child.on('close', (code: number | null) => {
          finish(code ?? undefined);
        });
      });
    },
  };
}

/** First line of `runsc --version` is `runsc version <version>` (e.g. `runsc version release-20260727.0`). */
const RUNSC_VERSION_PATTERN = /^runsc version (\S+)/;

/** Parse the runsc version from `runsc --version` stdout; undefined when unparseable. */
function parseRunscVersion(stdout: string): string | undefined {
  const firstLine = stdout.split('\n')[0] ?? '';
  return RUNSC_VERSION_PATTERN.exec(firstLine)?.[1];
}

/** docker image inspect → RepoDigest pin check. */
function checkRepoDigest(input: {
  inspectJson: string;
  expectedDigest: string;
}): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.inspectJson);
  } catch {
    return { ok: false, error: 'could not parse `docker image inspect` output' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: '`docker image inspect` returned no image data' };
  }
  const digests: string[] = [];
  const entries: unknown[] = parsed;
  for (const entry of entries) {
    if (typeof entry === 'object' && entry !== null && 'RepoDigests' in entry) {
      const repoDigests: unknown = entry.RepoDigests;
      if (Array.isArray(repoDigests)) {
        for (const digest of repoDigests) {
          if (typeof digest === 'string') {
            digests.push(digest);
          }
        }
      }
    }
  }
  if (digests.length === 0) {
    return {
      ok: false,
      error:
        'sandbox image has no RepoDigest (locally built or retagged?) — refusing to run an image that cannot be pinned to its digest',
    };
  }
  const pinned = digests.some((digest) => digest.slice(digest.lastIndexOf('@') + 1) === input.expectedDigest);
  if (!pinned) {
    return {
      ok: false,
      error: `sandbox image digest mismatch: expected ${input.expectedDigest}, image reports ${digests.join(', ')} — refusing to run`,
    };
  }
  return { ok: true };
}

export class DockerDriver implements IsolationDriver {
  readonly kind = 'docker';

  private readonly image: string;
  private readonly cosignPublicKeyPath: string;
  private readonly dockerBinary: string;
  private readonly cosignBinary: string;
  private readonly commandTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly runtime: string | undefined;
  private readonly runscVersion: string | undefined;
  private readonly runner: DockerCommandRunner;
  /** containerId → in-flight run, for dispose()'s drain-then-kill. */
  private readonly inFlight = new Map<string, Promise<DriverRunResult>>();
  /** Coalesced provisioning pull (plan §2.8: concurrent calls share one pull). */
  private activeProvision: Promise<void> | undefined;

  constructor(options: DockerDriverOptions, commandRunner: DockerCommandRunner | undefined) {
    this.image = options.image;
    this.cosignPublicKeyPath = options.cosignPublicKeyPath;
    this.dockerBinary = options.dockerBinary ?? 'docker';
    this.cosignBinary = options.cosignBinary ?? 'cosign';
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.createTimeoutMs = options.createTimeoutMs ?? 30000;
    this.runtime = options.runtime;
    this.runscVersion = options.runscVersion;
    this.runner = commandRunner ?? createDefaultDockerCommandRunner({ dockerBinary: this.dockerBinary });
  }

  /** Driver identity for per-run audit logging (image + OCI runtime). */
  get auditIdentity(): { image: string; runtime: string | undefined } {
    return { image: this.image, runtime: this.runtime };
  }

  /**
   * the configured cosign public-key path is host layout, never
   * model-visible. cosign echoes it in stderr (missing/unreadable key file),
   * so every occurrence is redacted from model-visible detail. split/join
   * replaces all occurrences without regex-escaping the path.
   */
  private scrubCosignKeyPath(text: string): string {
    const keyPath = this.cosignPublicKeyPath;
    if (keyPath.length === 0) {
      return text;
    }
    return text.split(keyPath).join('<cosign public key>');
  }

  async ensureReady(signal?: AbortSignal): Promise<DriverReadiness> {
    // v1: the Docker driver needs a Linux container host (plan §4 edge 11).
    if (process.platform === 'win32') {
      return {
        ready: false,
        error_code: 'unsupported_platform',
        error: 'run_code is not supported on Windows in v1: the Docker driver needs a Linux container host.',
      };
    }
    // Fail-closed runsc gate (gVisor only): runsc must be present, healthy,
    // and exactly at the pinned version before any docker check runs. The
    // plain Docker driver (runtime undefined) never probes runsc, and a
    // failed probe is never retried under a different runtime.
    if (this.runtime === 'runsc') {
      const runscReady = await this.probeRunsc(signal);
      if (!runscReady.ready) {
        return runscReady;
      }
    }
    const expectedDigest = this.expectedDigest();
    if (expectedDigest === undefined) {
      return {
        ready: false,
        error_code: 'image_unavailable',
        error: `sandbox image '${this.image}' is not pinned as tag@sha256:<digest> — refusing to run an unpinned image`,
      };
    }
    const info = await this.runner.run(
      this.dockerBinary,
      ['info'],
      { timeoutMs: this.commandTimeoutMs, signal },
    );
    if (info.timedOut || info.exitCode !== 0) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          'Docker daemon not reachable (`docker info` failed). Is dockerd running, and is the service user in the docker group?',
      };
    }
    const inspect = await this.runner.run(
      this.dockerBinary,
      ['image', 'inspect', this.image],
      { timeoutMs: this.commandTimeoutMs, signal },
    );
    if (inspect.timedOut || inspect.exitCode !== 0) {
      return {
        ready: false,
        // distinct from image_unavailable — a missing image is healable via
        // the explicit provisioning step; a bad pin or signature is not.
        error_code: 'image_missing',
        error: `sandbox image '${this.image}' is not present locally — the harness will pull it as an explicit provisioning step`,
      };
    }
    const digestCheck = checkRepoDigest({ inspectJson: inspect.stdout, expectedDigest });
    if (!digestCheck.ok) {
      return { ready: false, error_code: 'image_unavailable', error: digestCheck.error };
    }
    const cosign = await this.runner.run(
      this.cosignBinary,
      ['verify', '--key', this.cosignPublicKeyPath, this.image],
      { timeoutMs: this.commandTimeoutMs, signal },
    );
    if (cosign.timedOut || cosign.exitCode !== 0) {
      return {
        ready: false,
        error_code: 'image_unavailable',
        // cosign echoes the --key path in its stderr (missing/unreadable
        // key file); the detail is model-visible, so the host key path is
        // redacted before it leaves the driver.
        error: `cosign signature verification failed for '${this.image}': ${truncateSingleLine(this.scrubCosignKeyPath(cosign.stderr), 300)}`,
      };
    }
    // Wedged-daemon escalation (plan §2.8): dockerd answers `docker info` but
    // `docker create` never returns → daemon_unavailable, manual remediation.
    // --entrypoint keeps the probe immune to the image's own entrypoint.
    const runtimeArgs = this.runtime === undefined ? [] : ['--runtime', this.runtime];
    const probe = await this.runner.run(
      this.dockerBinary,
      ['create', ...runtimeArgs, '--entrypoint', 'true', '--label', `${PROBE_LABEL}=1`, this.image],
      { timeoutMs: this.createTimeoutMs, signal },
    );
    if (probe.timedOut) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          'dockerd answered `docker info` but `docker create` did not return within 30s — the daemon is wedged. Restart the Docker daemon; no automatic repair is attempted.',
      };
    }
    const probeId = probe.stdout.trim();
    if (probe.exitCode !== 0 || probeId.length === 0) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error: `dockerd cannot create containers: ${truncateSingleLine(probe.stderr, 300)}`,
      };
    }
    await this.runner.run(
      this.dockerBinary,
      ['rm', '-f', probeId],
      { timeoutMs: this.commandTimeoutMs, signal: undefined },
    );
    // Bind-mount ownership probe (plan E-B1): Docker Desktop/macOS virtiofs may
    // squash or silently ignore the chown the wrapper best-effort applies. A
    // failed probe is a clear capability error here, not a silent permission
    // failure mid-run.
    const ownership = await this.probeBindMountOwnership(signal);
    if (!ownership.ok) {
      return { ready: false, error_code: 'daemon_unavailable', error: ownership.error };
    }
    return { ready: true };
  }

  /**
   * Fail-closed runsc verification for the gVisor driver: runsc must be
   * present, healthy, and exactly at the pinned version. Any failure refuses
   * the run with an error naming runsc, never a silent fallback to runc.
   */
  private async probeRunsc(signal: AbortSignal | undefined): Promise<DriverReadiness> {
    const probe = await this.runner.run('runsc', ['--version'], { timeoutMs: this.commandTimeoutMs, signal });
    if (probe.timedOut || probe.exitCode !== 0) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          'The gVisor sandbox driver needs runsc, but the `runsc --version` probe failed. ' +
          'runsc may be missing or unhealthy. Install runsc per the gVisor install docs ' +
          '(https://gvisor.dev/docs/user_guide/install/), register it as a Docker runtime, ' +
          'and set SANDBOX_RUNSC_VERSION to the pinned version. The driver never falls back to runc.',
      };
    }
    const installed = parseRunscVersion(probe.stdout);
    if (installed === undefined) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          'The `runsc --version` probe did not produce a parseable version line. ' +
          'Refusing to run the gVisor sandbox without a verified runsc version.',
      };
    }
    const pinned = this.runscVersion?.trim();
    if (pinned === undefined || pinned === '') {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          `runsc ${installed} is installed but no runsc version is pinned (SANDBOX_RUNSC_VERSION). ` +
          'Refusing to run the gVisor sandbox without a pinned runsc version.',
      };
    }
    if (installed !== pinned) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          `runsc version mismatch: installed ${installed}, pinned ${pinned}. ` +
          'Install the pinned runsc version, or update the pin and re-run the acceptance suite. ' +
          'The driver never falls back to runc.',
      };
    }
    return { ready: true };
  }

  async provision(input: {
    signal: AbortSignal | undefined;
    onProgress: (message: string) => void;
    timeoutSeconds: number;
  }): Promise<void> {
    const ongoing = this.activeProvision;
    if (ongoing !== undefined) {
      await ongoing;
      return;
    }
    const task = (async (): Promise<void> => {
      await this.pullBounded(input);
      // A pulled image is verified exactly like a present one: digest pin +
      // cosign signature, or the provisioning fails.
      const readiness = await this.ensureReady(input.signal ?? undefined);
      if (!readiness.ready) {
        throw new Error(`provisioned image failed verification: ${readiness.error}`);
      }
    })();
    this.activeProvision = task;
    try {
      await task;
    } finally {
      if (this.activeProvision === task) {
        this.activeProvision = undefined;
      }
    }
  }

  async run(params: DriverRunParams): Promise<DriverRunResult> {
    let containerId: string | undefined;
    let result: DriverRunResult;
    try {
      containerId = await this.createContainer(params);
      const task = this.attachAndRun(containerId, params);
      this.inFlight.set(containerId, task);
      try {
        result = await task;
      } finally {
        this.inFlight.delete(containerId);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        exitCode: -1,
        stdout: '',
        stderr: '',
        terminatedBy: 'internal',
        internalError: this.scrubPaths(message, params),
        harvestWarnings: [],
      };
    }
    if (containerId !== undefined) {
      // Post-mortem OOM check: exit 137 with .State.OOMKilled set is the kernel
      // OOM killer, not a program verdict. The container is deliberately not
      // --rm so this inspect is deterministic.
      if (result.terminatedBy === 'completed' && result.exitCode === 137) {
        if (await this.inspectOomKilled(containerId)) {
          result = { ...result, terminatedBy: 'oom' };
        }
      }
      // Kill (no-op when already exited) then remove; the labeled reaper owns
      // anything left behind by a host crash.
      await this.killContainer(containerId);
      await this.removeContainer(containerId);
    }
    return result;
  }

  /** Reaper support: remove labeled containers older than 30 minutes. */
  async reapStale(): Promise<void> {
    const ps = await this.runner.run(
      this.dockerBinary,
      ['ps', '-a', '--filter', `label=${SANDBOX_RUN_LABEL}`, '--format', '{{.ID}}'],
      { timeoutMs: this.commandTimeoutMs, signal: undefined },
    );
    if (ps.exitCode !== 0) {
      return; // daemon down — nothing to reap; the next cadence retries
    }
    const ids = ps.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (ids.length === 0) {
      return;
    }
    const inspect = await this.runner.run(
      this.dockerBinary,
      ['inspect', '--format', '{{.Id}} {{.Created}}', ...ids],
      { timeoutMs: this.commandTimeoutMs, signal: undefined },
    );
    if (inspect.exitCode !== 0) {
      return;
    }
    const now = Date.now();
    const stale: string[] = [];
    for (const line of inspect.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const space = trimmed.indexOf(' ');
      if (space === -1) {
        continue;
      }
      const created = new Date(trimmed.slice(space + 1)).getTime();
      if (!Number.isFinite(created)) {
        continue;
      }
      if (now - created > STALE_CONTAINER_MS) {
        stale.push(trimmed.slice(0, space));
      }
    }
    if (stale.length === 0) {
      return;
    }
    await this.runner.run(
      this.dockerBinary,
      ['rm', '-f', ...stale],
      { timeoutMs: this.commandTimeoutMs, signal: undefined },
    );
  }

  async dispose(): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...this.inFlight.values()]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DISPOSE_DRAIN_MS);
        timer.unref();
      }),
    ]);
    // Kill whatever remains; labeled containers are known to the reaper regardless.
    await Promise.allSettled([...this.inFlight.keys()].map((id) => this.killContainer(id)));
  }

  /** tag@sha256:<64 hex> pin, or undefined when the configured image is unpinned. */
  private expectedDigest(): string | undefined {
    const at = this.image.lastIndexOf('@');
    if (at === -1) {
      return undefined;
    }
    const digest = this.image.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined;
  }

  /** docker pull inside the caller's timeoutSeconds; the runner kills the child on abort. */
  private async pullBounded(input: {
    signal: AbortSignal | undefined;
    onProgress: (message: string) => void;
    timeoutSeconds: number;
  }): Promise<void> {
    const pullController = new AbortController();
    const timer = setTimeout(() => {
      pullController.abort();
    }, input.timeoutSeconds * 1000);
    const onCallerAbort = (): void => {
      pullController.abort();
    };
    if (input.signal?.aborted === true) {
      pullController.abort();
    } else {
      input.signal?.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      await this.runner.pull({ image: this.image, signal: pullController.signal, onProgress: input.onProgress });
    } catch (error: unknown) {
      if (input.signal?.aborted === true) {
        throw error;
      }
      if (pullController.signal.aborted) {
        throw new Error(`docker pull of '${this.image}' did not complete within ${String(input.timeoutSeconds)}s`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private interpreterArgv(language: RunCodeLanguage): string[] {
    // The wrapper stages the program into ingress (read-only) under a
    // reserved name; the driver executes it from there — no argv size limits.
    const program = runCodeProgramPath(language);
    if (language === 'python') {
      return ['python3', program];
    }
    if (language === 'node') {
      return ['node', program];
    }
    return ['bash', program];
  }

  /**
   * The non-negotiable hardened create flags (plan §2.5), encoded here, not
   * in config. Curated env only — the host process env never passes through.
   */
  private async createContainer(params: DriverRunParams): Promise<string> {
    const safeRunId = params.runId.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const envArgs = Object.entries(params.env).flatMap(([key, value]: [string, string]) => ['-e', `${key}=${value}`]);
    const runtimeArgs = this.runtime === undefined ? [] : ['--runtime', this.runtime];
    const args = [
      'create',
      // No --rm: the container must survive exit so .State.OOMKilled can be
      // inspected deterministically. Cleanup is explicit `rm -f` below plus
      // the label reaper for anything left behind by a crash.
      ...runtimeArgs,
      '--network',
      'none',
      '--init',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      SANDBOX_USER,
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '256',
      // A crashing run must not dump core to host disk.
      '--ulimit',
      'core=0',
      '--memory',
      `${String(params.memoryMb)}m`,
      '--memory-swap',
      `${String(params.memoryMb)}m`,
      '--oom-kill-disable',
      'false',
      '--cpus',
      '2',
      '--shm-size',
      '64m',
      '--log-driver',
      'local',
      '--log-opt',
      'max-size=1m',
      '--log-opt',
      'max-file=2',
      '--label',
      `${SANDBOX_RUN_LABEL}=${safeRunId}`,
      '-v',
      `${params.ingressDir}:/ingress:ro`,
      '-v',
      `${params.scratchDir}:/scratch:rw`,
      '-v',
      `${params.egressDir}:/egress:rw`,
      '--workdir',
      '/scratch',
      ...envArgs,
      this.image,
      ...this.interpreterArgv(params.language),
    ];
    const result = await this.runner.run(
      this.dockerBinary,
      args,
      { timeoutMs: this.createTimeoutMs, signal: undefined },
    );
    if (result.timedOut) {
      throw new Error(
        `docker create did not return within ${String(this.createTimeoutMs)}ms — the daemon may be wedged`,
      );
    }
    const containerId = result.stdout.trim();
    if (result.exitCode !== 0 || containerId.length === 0) {
      throw new Error(`docker create failed: ${truncateSingleLine(result.stderr, 500)}`);
    }
    return containerId;
  }

  private async attachAndRun(containerId: string, params: DriverRunParams): Promise<DriverRunResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded: 'stdout' | 'stderr' | undefined;
    const append = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (exceeded !== undefined) {
        return;
      }
      const bytes = which === 'stdout' ? stdoutBytes : stderrBytes;
      if (bytes + chunk.length > TRANSPORT_STREAM_CAP_BYTES) {
        // Transport bound fired: keep the first 4 MiB, kill the runaway
        // container, and let the wrapper map the marker to output_exceeded.
        exceeded = which;
        void this.runner
          .run(this.dockerBinary, ['kill', containerId], { timeoutMs: this.commandTimeoutMs, signal: undefined })
          .catch(() => undefined);
        return;
      }
      if (which === 'stdout') {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    };
    // Abort (timeout, disk, caller) kills the container; the wrapper maps the
    // abort reason onto the error taxonomy.
    const onAbort = (): void => {
      void this.runner
        .run(this.dockerBinary, ['kill', containerId], { timeoutMs: this.commandTimeoutMs, signal: undefined })
        .catch(() => undefined);
    };
    if (params.signal?.aborted === true) {
      onAbort();
    } else {
      params.signal?.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const exitCode = await this.runner.startAttach({
        containerId,
        signal: params.signal,
        onStdout: (chunk: Buffer) => {
          append('stdout', chunk);
        },
        onStderr: (chunk: Buffer) => {
          append('stderr', chunk);
        },
      });
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (exceeded !== undefined) {
        return {
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          terminatedBy: 'killed',
          internalError: `${OUTPUT_EXCEEDED_MARKER} ${exceeded} exceeded the 4 MiB transport bound`,
          harvestWarnings: [],
        };
      }
      if (params.signal?.aborted === true) {
        return { exitCode: exitCode ?? -1, stdout, stderr, terminatedBy: 'killed', internalError: undefined, harvestWarnings: [] };
      }
      if (exitCode === undefined) {
        return {
          exitCode: -1,
          stdout,
          stderr,
          terminatedBy: 'internal',
          internalError: 'container attach ended without an exit code',
          harvestWarnings: [],
        };
      }
      // A completed run keeps its verbatim exit code, even non-zero — the
      // exit code is the program's own verdict, never an infra failure.
      return { exitCode, stdout, stderr, terminatedBy: 'completed', internalError: undefined, harvestWarnings: [] };
    } finally {
      params.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Runs a throwaway container as the sandbox uid against a host temp dir and
   * requires a file write to land both inside the container and back on the
   * host. Catches the Docker Desktop/macOS virtiofs uid-mapping quirk where
   * chown through a bind mount is silently ignored.
   */
  private async probeBindMountOwnership(
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const probeDir = await mkdtemp(join(tmpdir(), 'tf-sandbox-probe-'));
    try {
      const runtimeArgs = this.runtime === undefined ? [] : ['--runtime', this.runtime];
      const result = await this.runner.run(
        this.dockerBinary,
        [
          'run',
          ...runtimeArgs,
          '--rm',
          '--network',
          'none',
          '--user',
          SANDBOX_USER,
          '-v',
          `${probeDir}:/probe:rw`,
          '--entrypoint',
          'sh',
          this.image,
          '-c',
          'touch /probe/write-test && echo PROBE_OK',
        ],
        { timeoutMs: this.commandTimeoutMs, signal },
      );
      const wroteInside = !result.timedOut && result.exitCode === 0 && result.stdout.includes('PROBE_OK');
      let visibleOnHost = false;
      if (wroteInside) {
        try {
          await stat(join(probeDir, 'write-test'));
          visibleOnHost = true;
        } catch {
          visibleOnHost = false;
        }
      }
      if (!wroteInside || !visibleOnHost) {
        return {
          ok: false,
          error:
            'sandbox bind-mount ownership probe failed: a container running as the sandbox uid (65532) could not write through a host bind mount. ' +
            'On Docker Desktop/macOS this is the virtiofs uid-mapping quirk — the wrapper\'s chown is silently ignored and runs would fail on permissions. ' +
            `Probe output: ${truncateSingleLine(result.stderr, 300)}`,
        };
      }
      return { ok: true };
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
  }

  /** Best-effort OOM check: false when the inspect fails or the flag is absent. */
  private async inspectOomKilled(containerId: string): Promise<boolean> {
    try {
      const inspect = await this.runner.run(
        this.dockerBinary,
        ['inspect', '--format', '{{.State.OOMKilled}}', containerId],
        { timeoutMs: this.commandTimeoutMs, signal: undefined },
      );
      return inspect.exitCode === 0 && inspect.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Best-effort: never throws; the labeled reaper owns leftovers. */
  private async killContainer(containerId: string): Promise<void> {
    try {
      await this.runner.run(
        this.dockerBinary,
        ['kill', containerId],
        { timeoutMs: this.commandTimeoutMs, signal: undefined },
      );
    } catch {
      // best-effort
    }
  }

  /** Best-effort: never throws; the labeled reaper owns leftovers. */
  private async removeContainer(containerId: string): Promise<void> {
    try {
      await this.runner.run(
        this.dockerBinary,
        ['rm', '-f', containerId],
        { timeoutMs: this.commandTimeoutMs, signal: undefined },
      );
    } catch {
      // best-effort
    }
  }

  /** Host paths never reach the model: known run dirs become placeholders. */
  private scrubPaths(text: string, params: DriverRunParams): string {
    const replacements: [string, string][] = [
      [params.ingressDir, '<ingress>'],
      [params.scratchDir, '<scratch>'],
      [params.egressDir, '<egress>'],
    ];
    let scrubbed = text;
    for (const [path, placeholder] of replacements) {
      if (path.length > 0) {
        scrubbed = scrubbed.split(path).join(placeholder);
      }
    }
    return scrubbed;
  }
}
