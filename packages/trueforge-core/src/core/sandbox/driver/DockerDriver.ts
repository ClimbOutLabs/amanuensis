import { execFile as execFileCallback, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'winston';
import {
  cosignKeyFingerprint,
  readImageVerificationRecord,
  recordVouchesForSubject,
  writeImageVerificationRecord,
} from './ImageVerificationRecord.js';
import {
  ISOLATION_REFUSED_MARKER,
  OUTPUT_EXCEEDED_MARKER,
  runCodeArgv,
  type DriverReadiness,
  type DriverRunParams,
  type DriverRunResult,
  type IsolationDriver,
  type SandboxIdentity,
} from './IsolationDriver.js';
import {
  measureRunDiskUsage,
  removeRunTree,
  resolveSandboxIdentity,
  SANDBOX_RUN_ENV,
  sandboxRunsDir,
  stageRunDirs,
} from './RunStaging.js';

const execFileAsync = promisify(execFileCallback);

/** Label selecting sandbox run containers for the reaper. */
const SANDBOX_RUN_LABEL = 'tf.sandbox.run';

/** The `key=value` label that ties a container to its run; the value is made label-safe. */
function runLabel(runId: string): string {
  return `${SANDBOX_RUN_LABEL}=${runId.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
}

/** Label for the transient wedged-daemon probe container. */
const PROBE_LABEL = 'tf.sandbox.probe';
/** Readiness canary: a python program touching every mount the way a real run does. */
const CANARY_INPUT_NAME = 'canary_in';
const CANARY_PROGRAM = [
  'import pathlib',
  `data = pathlib.Path('/ingress/${CANARY_INPUT_NAME}').read_bytes()`,
  "pathlib.Path('/scratch/sub').mkdir()",
  "pathlib.Path('/scratch/sub/f').write_bytes(data)",
  "pathlib.Path('/egress/out').write_bytes(data)",
].join('\n');
/** Driver-internal per-stream capture bound; the wrapper owns the model-visible contract. */
const TRANSPORT_STREAM_CAP_BYTES = 4 * 1024 * 1024;
/** Reaper age: containers older than this are crashed-supervisor leaks. */
const STALE_CONTAINER_MS = 30 * 60 * 1000;
/** dispose() drains in-flight runs up to this long, then kills the remainder. */
const DISPOSE_DRAIN_MS = 30 * 1000;

/** cosign stderr that means the registry could not be reached, as opposed to the signature being bad. */
const REGISTRY_UNREACHABLE_PATTERN =
  /dial tcp|no such host|server misbehaving|name resolution|network is unreachable|no route to host|connection (refused|reset)|timeout|timed out|deadline exceeded/i;

/** Default Docker socket path probed by detectDocker(). */
export const DOCKER_SOCKET_PATH = '/var/run/docker.sock';

/**
 * Exact user-facing message when Docker is not available (spec acceptance #5).
 * Returned as the readiness error; the wrapper surfaces it verbatim.
 */
export const DOCKER_UNAVAILABLE_MESSAGE =
  "I can't run code on this machine because Docker isn't available. To enable code execution, install Docker from https://docs.docker.com/engine/install/ and restart Aman.";

/**
 * Exact user-facing message when mandatory isolation guarantees cannot be
 * applied (spec acceptance #6). Quoted verbatim from the spec.
 */
export const ISOLATION_REFUSED_MESSAGE =
  "I can't run this safely, the sandbox couldn't apply all isolation guarantees.";

const dockerDetectionCache = new Map<string, Promise<boolean>>();

/**
 * Probe Docker socket accessibility. The result is memoized per socket path
 * for the process lifetime: detection happens once at startup, not per tool
 * call. A missing socket means Docker is not installed or not running for
 * this user; the driver reports docker_unavailable and the wrapper shows the
 * recovery message. (Restarting Aman re-probes, per the message.)
 */
export function detectDocker(socketPath: string = DOCKER_SOCKET_PATH): Promise<boolean> {
  const cached = dockerDetectionCache.get(socketPath);
  if (cached !== undefined) {
    return cached;
  }
  const probe = stat(socketPath).then(
    () => true,
    () => false,
  );
  dockerDetectionCache.set(socketPath, probe);
  return probe;
}

/** Test seam: clear the memoized detection so tests can re-probe. */
export function resetDockerDetectionForTests(): void {
  dockerDetectionCache.clear();
}

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
  pull(input: { image: string; signal: AbortSignal | undefined; onProgress: (line: string) => void }): Promise<void>;
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
  /** Directory owned by the app where the driver remembers its last successful signature verification. */
  stateDir: string;
  dockerBinary: string | undefined;
  cosignBinary: string | undefined;
  /** Override for the Docker socket path probed by detectDocker(). Defaults to /var/run/docker.sock. */
  dockerSocketPath: string | undefined;
  /** Same data dir the RunCodeService stages runs under; the readiness canary stages there too. */
  dataDir: string;
  /** Bound for docker info / image inspect / cosign verify. Default 5000. */
  commandTimeoutMs: number | undefined;
  /** Bound for the wedged-daemon docker create probe. Default 30000. */
  createTimeoutMs: number | undefined;
  logger: Logger;
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

/** The errno-style `code` of a failed fs call, without the message that would carry its path. */
function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Deletes the canary run root; the server must be able to remove what the container wrote. */
async function removeCanaryRoot({
  runRoot,
  runStopped,
}: {
  runRoot: string;
  runStopped: boolean;
}): Promise<string | undefined> {
  try {
    await removeRunTree({ runRoot, runStopped });
  } catch (error: unknown) {
    return `the host could not remove the run directory: ${errorText(error)}`;
  }
  try {
    await stat(runRoot);
  } catch (error: unknown) {
    const gone = typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
    return gone ? undefined : `the host could not confirm the run directory was removed: ${errorText(error)}`;
  }
  return 'the run directory still exists after removal';
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
      return new Promise<number | undefined>(resolve => {
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

/** docker image inspect → RepoDigest pin check; yields the local image ID a verification record binds to. */
function checkPinnedImage(input: {
  inspectJson: string;
  expectedDigest: string;
}): { ok: true; imageId: string } | { ok: false; error: string } {
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
  let imageId: string | undefined;
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
    if (imageId === undefined && typeof entry === 'object' && entry !== null && 'Id' in entry) {
      const id: unknown = entry.Id;
      if (typeof id === 'string' && id.length > 0) {
        imageId = id;
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
  const pinned = digests.some(digest => digest.slice(digest.lastIndexOf('@') + 1) === input.expectedDigest);
  if (!pinned) {
    return {
      ok: false,
      error: `sandbox image digest mismatch: expected ${input.expectedDigest}, image reports ${digests.join(', ')} — refusing to run`,
    };
  }
  if (imageId === undefined) {
    return {
      ok: false,
      error: '`docker image inspect` reported no image ID; refusing to run an unidentifiable image',
    };
  }
  return { ok: true, imageId };
}

/** The docker CLI reads any other seccomp value as a profile file path, so the daemon default must be named `builtin`. */
const SECCOMP_BUILTIN_OPT = 'seccomp=builtin';

/**
 * Verify a created container actually carries the mandatory isolation flags,
 * including the uid:gid it was created to run as.
 * Fail-closed (spec): any missing guarantee refuses the run. A partial
 * sandbox is never silently downgraded. Defensive unknown-typed navigation in
 * the checkRepoDigest style; exported for unit tests.
 */
export function checkContainerIsolation(input: {
  inspectJson: string;
  /** The uid:gid the container was created to run as. */
  identity: SandboxIdentity;
}): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.inspectJson);
  } catch {
    return { ok: false, reason: 'could not parse `docker inspect` output' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: '`docker inspect` returned no container data' };
  }
  const entry: unknown = parsed[0];
  if (typeof entry !== 'object' || entry === null) {
    return { ok: false, reason: '`docker inspect` returned a non-object container entry' };
  }
  const record = entry as Record<string, unknown>;
  const hostConfig: unknown = record['HostConfig'];
  const config: unknown = record['Config'];
  if (typeof hostConfig !== 'object' || hostConfig === null || typeof config !== 'object' || config === null) {
    return { ok: false, reason: '`docker inspect` entry is missing HostConfig or Config' };
  }
  const hc = hostConfig as Record<string, unknown>;
  const cc = config as Record<string, unknown>;

  if (hc['NetworkMode'] !== 'none') {
    const actual = typeof hc['NetworkMode'] === 'string' ? hc['NetworkMode'] : 'missing';
    return { ok: false, reason: `container NetworkMode is '${actual}', expected 'none'` };
  }
  if (hc['ReadonlyRootfs'] !== true) {
    return { ok: false, reason: 'container root filesystem is not read-only' };
  }
  const user: unknown = cc['User'];
  if (typeof user !== 'string' || user === '' || user === '0' || user === 'root' || user === '0:0') {
    const actual = typeof user === 'string' && user !== '' ? user : 'missing';
    return { ok: false, reason: `container user is '${actual}', expected a non-root user` };
  }
  const expectedUser = `${String(input.identity.uid)}:${String(input.identity.gid)}`;
  if (user !== expectedUser) {
    return { ok: false, reason: `container user is '${user}', expected '${expectedUser}'` };
  }
  const capDrop: unknown = hc['CapDrop'];
  if (!Array.isArray(capDrop) || !capDrop.includes('ALL')) {
    return { ok: false, reason: 'container capabilities were not fully dropped (CapDrop does not include ALL)' };
  }
  const securityOpt: unknown = hc['SecurityOpt'];
  const opts = Array.isArray(securityOpt) ? securityOpt.filter((o): o is string => typeof o === 'string') : [];
  if (!opts.includes('no-new-privileges:true')) {
    return { ok: false, reason: 'container is missing no-new-privileges' };
  }
  if (!opts.includes(SECCOMP_BUILTIN_OPT)) {
    return { ok: false, reason: 'container is missing the built-in seccomp profile' };
  }
  return { ok: true };
}

export class DockerDriver implements IsolationDriver {
  readonly kind = 'docker';
  // The container runs with no network, so the package gateway is unreachable.
  readonly packageGatewayCapable = false;

  private readonly image: string;
  private readonly cosignPublicKeyPath: string;
  private readonly stateDir: string;
  private readonly dockerBinary: string;
  private readonly cosignBinary: string;
  private readonly dockerSocketPath: string;
  private readonly dataDir: string;
  private readonly commandTimeoutMs: number;
  private readonly createTimeoutMs: number;
  private readonly logger: Logger;
  private readonly runner: DockerCommandRunner;
  /** containerId → in-flight run, for dispose()'s drain-then-kill. */
  private readonly inFlight = new Map<string, Promise<DriverRunResult>>();
  /** Coalesced provisioning pull (plan §2.8: concurrent calls share one pull). */
  private activeProvision: Promise<void> | undefined;

  constructor(options: DockerDriverOptions, commandRunner: DockerCommandRunner | undefined) {
    this.image = options.image;
    this.cosignPublicKeyPath = options.cosignPublicKeyPath;
    this.stateDir = options.stateDir;
    this.dockerBinary = options.dockerBinary ?? 'docker';
    this.cosignBinary = options.cosignBinary ?? 'cosign';
    this.dockerSocketPath = options.dockerSocketPath ?? DOCKER_SOCKET_PATH;
    this.dataDir = options.dataDir;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.createTimeoutMs = options.createTimeoutMs ?? 30000;
    this.logger = options.logger;
    this.runner = commandRunner ?? createDefaultDockerCommandRunner({ dockerBinary: this.dockerBinary });
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
    return this.probeReadiness({ signal, forceVerification: false });
  }

  /**
   * forceVerification re-runs the cosign check even when a matching record
   * exists; provisioning uses it because a pull is online and refreshes trust.
   */
  private async probeReadiness({
    signal,
    forceVerification,
  }: {
    signal: AbortSignal | undefined;
    forceVerification: boolean;
  }): Promise<DriverReadiness> {
    // v1: the Docker driver needs a Linux container host (plan §4 edge 11).
    if (process.platform === 'win32') {
      return {
        ready: false,
        error_code: 'unsupported_platform',
        error: 'run_code is not supported on Windows in v1: the Docker driver needs a Linux container host.',
      };
    }
    // Docker detection (spec): a missing socket is a distinct, user-actionable
    // state from a wedged daemon. The wrapper surfaces the exact recovery
    // message; detection is memoized per process (see detectDocker).
    if (!(await detectDocker(this.dockerSocketPath))) {
      return {
        ready: false,
        error_code: 'docker_unavailable',
        error: DOCKER_UNAVAILABLE_MESSAGE,
      };
    }
    const expectedDigest = this.expectedDigest();
    if (expectedDigest === undefined) {
      return {
        ready: false,
        error_code: 'image_unavailable',
        error: `sandbox image '${this.image}' is not pinned as tag@sha256:<digest> — refusing to run an unpinned image`,
      };
    }
    const info = await this.runner.run(this.dockerBinary, ['info'], { timeoutMs: this.commandTimeoutMs, signal });
    if (info.timedOut || info.exitCode !== 0) {
      return {
        ready: false,
        error_code: 'daemon_unavailable',
        error:
          'Docker daemon not reachable (`docker info` failed). Is dockerd running, and is the service user in the docker group?',
      };
    }
    const inspect = await this.runner.run(this.dockerBinary, ['image', 'inspect', this.image], {
      timeoutMs: this.commandTimeoutMs,
      signal,
    });
    if (inspect.timedOut || inspect.exitCode !== 0) {
      return {
        ready: false,
        // distinct from image_unavailable — a missing image is healable via
        // the explicit provisioning step; a bad pin or signature is not.
        error_code: 'image_missing',
        error: `sandbox image '${this.image}' is not present locally — the harness will pull it as an explicit provisioning step`,
      };
    }
    const digestCheck = checkPinnedImage({ inspectJson: inspect.stdout, expectedDigest });
    if (!digestCheck.ok) {
      return { ready: false, error_code: 'image_unavailable', error: digestCheck.error };
    }
    const verification = await this.verifyImageSignature({
      expectedDigest,
      imageId: digestCheck.imageId,
      forceVerification,
      signal,
    });
    if (!verification.ok) {
      return {
        ready: false,
        error_code: 'image_unavailable',
        error: verification.error,
        reason: 'signature_unverified',
      };
    }
    // Wedged-daemon escalation (plan §2.8): dockerd answers `docker info` but
    // `docker create` never returns → daemon_unavailable, manual remediation.
    // --entrypoint keeps the probe immune to the image's own entrypoint.
    const probe = await this.runner.run(
      this.dockerBinary,
      ['create', '--entrypoint', 'true', '--label', `${PROBE_LABEL}=1`, this.image],
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
    await this.runner.run(this.dockerBinary, ['rm', '-f', probeId], {
      timeoutMs: this.commandTimeoutMs,
      signal: undefined,
    });
    // Canary run through the real staging and create flags: a host/uid mismatch
    // is a clear capability error here, not a permission failure mid-run.
    const ownership = await this.probeBindMountOwnership(signal);
    if (!ownership.ok) {
      return { ready: false, error_code: 'daemon_unavailable', error: ownership.error, reason: ownership.reason };
    }
    return { ready: true };
  }

  /**
   * cosign verify fetches signatures from the registry, so it must not gate
   * every probe or run_code breaks offline. A prior success is trusted only
   * while the pinned reference and digest, the local image ID, and the key
   * fingerprint all equal what is observed now; anything else re-verifies.
   */
  private async verifyImageSignature(input: {
    expectedDigest: string;
    imageId: string;
    forceVerification: boolean;
    signal: AbortSignal | undefined;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const keyFingerprint = await cosignKeyFingerprint({ keyPath: this.cosignPublicKeyPath });
    const subject =
      keyFingerprint === undefined
        ? undefined
        : {
            image_ref: this.image,
            image_digest: input.expectedDigest,
            image_id: input.imageId,
            key_fingerprint: keyFingerprint,
          };
    if (subject !== undefined && !input.forceVerification) {
      const record = await readImageVerificationRecord({ stateDir: this.stateDir });
      if (recordVouchesForSubject({ record, subject })) {
        return { ok: true };
      }
    }
    const cosign = await this.runner.run(this.cosignBinary, ['verify', '--key', this.cosignPublicKeyPath, this.image], {
      timeoutMs: this.commandTimeoutMs,
      signal: input.signal,
    });
    if (cosign.timedOut || cosign.exitCode !== 0) {
      return { ok: false, error: this.describeCosignFailure(cosign) };
    }
    if (subject !== undefined) {
      try {
        await writeImageVerificationRecord({
          stateDir: this.stateDir,
          record: { ...subject, verified_at: new Date().toISOString() },
        });
      } catch (error: unknown) {
        // The image is verified now, so this does not fail readiness; the next probe verifies again.
        // Only the errno code is logged: fs messages carry the state dir path.
        this.logger.warn('sandbox image verification record could not be saved; the next probe verifies again', {
          errorCode: errorCode(error),
        });
      }
    }
    return { ok: true };
  }

  private describeCosignFailure(cosign: DockerCommandResult): string {
    // cosign echoes the --key path in its stderr (missing/unreadable key
    // file); the detail is model-visible, so the host key path is redacted
    // before it leaves the driver.
    const detail = truncateSingleLine(this.scrubCosignKeyPath(cosign.stderr), 300);
    if (cosign.timedOut || REGISTRY_UNREACHABLE_PATTERN.test(cosign.stderr)) {
      return (
        `cosign could not reach the image registry to verify the signature of '${this.image}'. ` +
        'The signature is verified once when the image is set up and remembered afterwards, so run_code works offline from then on; ' +
        `connect to the internet once so the check can complete.${detail === '' ? '' : ` Detail: ${detail}`}`
      );
    }
    return `cosign signature verification failed for '${this.image}': ${detail}`;
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
      const readiness = await this.probeReadiness({ signal: input.signal, forceVerification: true });
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
      // Fail-closed isolation verification (spec): the flags passed to
      // `docker create` must be reflected in the created container. A
      // container missing any mandatory guarantee is removed and the run is
      // refused, never executed with reduced isolation.
      await this.verifyContainerIsolation(containerId, params.sandboxIdentity);
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

  async isRunGone(runId: string): Promise<boolean> {
    try {
      const ps = await this.runner.run(
        this.dockerBinary,
        ['ps', '-a', '--filter', `label=${runLabel(runId)}`, '--format', '{{.ID}}'],
        { timeoutMs: this.commandTimeoutMs, signal: undefined },
      );
      return !ps.timedOut && ps.exitCode === 0 && ps.stdout.trim().length === 0;
    } catch {
      return false;
    }
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
      .map(line => line.trim())
      .filter(line => line.length > 0);
    if (ids.length === 0) {
      return;
    }
    const inspect = await this.runner.run(this.dockerBinary, ['inspect', '--format', '{{.Id}} {{.Created}}', ...ids], {
      timeoutMs: this.commandTimeoutMs,
      signal: undefined,
    });
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
    await this.runner.run(this.dockerBinary, ['rm', '-f', ...stale], {
      timeoutMs: this.commandTimeoutMs,
      signal: undefined,
    });
  }

  async dispose(): Promise<void> {
    if (this.inFlight.size === 0) {
      return;
    }
    await Promise.race([
      Promise.allSettled([...this.inFlight.values()]),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, DISPOSE_DRAIN_MS);
        timer.unref();
      }),
    ]);
    // Kill whatever remains; labeled containers are known to the reaper regardless.
    await Promise.allSettled([...this.inFlight.keys()].map(id => this.killContainer(id)));
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

  /**
   * The non-negotiable hardened create flags (plan §2.5), encoded here, not
   * in config. Curated env only — the host process env never passes through.
   */
  private async createContainer(params: DriverRunParams): Promise<string> {
    const envArgs = Object.entries(params.env).flatMap(([key, value]: [string, string]) => ['-e', `${key}=${value}`]);
    const args = [
      'create',
      // No --rm: the container must survive exit so .State.OOMKilled can be
      // inspected deterministically. Cleanup is explicit `rm -f` below plus
      // the label reaper for anything left behind by a crash.
      '--network',
      'none',
      '--init',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--user',
      `${String(params.sandboxIdentity.uid)}:${String(params.sandboxIdentity.gid)}`,
      '--cap-drop=ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--security-opt',
      SECCOMP_BUILTIN_OPT,
      '--pids-limit',
      '256',
      '--memory',
      `${String(params.memoryMb)}m`,
      '--memory-swap',
      `${String(params.memoryMb)}m`,
      // A boolean flag: a separate `false` would be read as the image name.
      '--oom-kill-disable=false',
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
      runLabel(params.runId),
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
      ...runCodeArgv(params.language),
    ];
    const result = await this.runner.run(this.dockerBinary, args, {
      timeoutMs: this.createTimeoutMs,
      signal: undefined,
    });
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

  /**
   * Fail-closed post-create verification: inspect the created container and
   * confirm every mandatory isolation flag took effect. On any failure the
   * container is removed (best-effort; the labeled reaper owns leftovers) and
   * the run is refused with the spec's exact message, marked with
   * ISOLATION_REFUSED_MARKER for the wrapper.
   */
  private async verifyContainerIsolation(containerId: string, identity: SandboxIdentity): Promise<void> {
    const inspect = await this.runner.run(this.dockerBinary, ['inspect', containerId], {
      timeoutMs: this.commandTimeoutMs,
      signal: undefined,
    });
    const check: { ok: true } | { ok: false; reason: string } =
      inspect.timedOut || inspect.exitCode !== 0
        ? { ok: false, reason: '`docker inspect` failed on the created container' }
        : checkContainerIsolation({ inspectJson: inspect.stdout, identity });
    if (!check.ok) {
      await this.removeContainer(containerId);
      throw new Error(`${ISOLATION_REFUSED_MARKER}${ISOLATION_REFUSED_MESSAGE}`);
    }
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
        return {
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
          terminatedBy: 'killed',
          internalError: undefined,
          harvestWarnings: [],
        };
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
   * Readiness canary: a throwaway run with the same staging, identity, env and
   * create flags as a real one. It then checks what the host relies on later:
   * the container read ingress and wrote scratch and egress, du can account for
   * them, and the run root can be deleted. Catches uid/permission mismatches,
   * including bind mounts that ignore ownership (Docker Desktop).
   */
  private async probeBindMountOwnership(
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; error: string; reason: 'isolation_refused' | undefined }> {
    let identity;
    try {
      identity = resolveSandboxIdentity();
    } catch (error: unknown) {
      return { ok: false, error: `sandbox canary run not started: ${errorText(error)}`, reason: undefined };
    }
    const token = randomUUID();
    const runId = `canary-${token}`;
    const runRoot = join(sandboxRunsDir(this.dataDir), runId);
    const canaryProblem = await this.runCanary({ runId, runRoot, token, identity, signal });
    // Always clean up: a failed canary must not leave container-written files behind.
    const cleanupProblem = await removeCanaryRoot({ runRoot, runStopped: await this.isRunGone(runId) });
    const problem = canaryProblem ?? cleanupProblem;
    if (problem === undefined) {
      return { ok: true };
    }
    const sandboxUser = `${String(identity.uid)}:${String(identity.gid)}`;
    return {
      ok: false,
      error: `sandbox canary run failed as ${sandboxUser}: ${problem.split(runRoot).join('<canary>')}`,
      reason: problem.includes(ISOLATION_REFUSED_MARKER) ? 'isolation_refused' : undefined,
    };
  }

  /** Returns the first failed check, or undefined when the canary behaved like a healthy run. */
  private async runCanary(input: {
    runId: string;
    runRoot: string;
    token: string;
    identity: SandboxIdentity;
    signal: AbortSignal | undefined;
  }): Promise<string | undefined> {
    const files = [{ name: CANARY_INPUT_NAME, bytes: Buffer.from(input.token) }];
    let dirs;
    try {
      dirs = await stageRunDirs({
        runRoot: input.runRoot,
        language: 'python',
        code: CANARY_PROGRAM,
        files,
        identity: input.identity,
      });
    } catch (error: unknown) {
      return `the host could not stage the run directories: ${errorText(error)}`;
    }
    const timeout = AbortSignal.timeout(this.createTimeoutMs);
    const result = await this.run({
      language: 'python',
      code: CANARY_PROGRAM,
      filesIn: files,
      ingressDir: dirs.ingressDir,
      scratchDir: dirs.scratchDir,
      egressDir: dirs.egressDir,
      timeoutMs: this.createTimeoutMs,
      memoryMb: 256,
      diskMb: 16,
      runId: input.runId,
      env: SANDBOX_RUN_ENV,
      packageMirrorToken: undefined,
      sandboxIdentity: input.identity,
      signal: input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]),
      harvestGraceMs: 0,
    });
    if (result.terminatedBy !== 'completed' || result.exitCode !== 0) {
      const detail = truncateSingleLine(result.internalError ?? result.stderr, 300);
      return `the canary container ended as ${result.terminatedBy} (exit ${String(result.exitCode)}): ${detail}`;
    }
    let output: string;
    try {
      output = await readFile(join(dirs.egressDir, 'out'), 'utf8');
    } catch (error: unknown) {
      return `the host could not read the file the container wrote to egress: ${errorText(error)}`;
    }
    if (output !== input.token) {
      return 'the file read back from egress does not match what the container read from ingress';
    }
    if ((await measureRunDiskUsage({ scratchDir: dirs.scratchDir, egressDir: dirs.egressDir })) === undefined) {
      return 'the host could not measure the canary directories with du';
    }
    return undefined;
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
      await this.runner.run(this.dockerBinary, ['kill', containerId], {
        timeoutMs: this.commandTimeoutMs,
        signal: undefined,
      });
    } catch {
      // best-effort
    }
  }

  /** Best-effort: never throws; the labeled reaper owns leftovers. */
  private async removeContainer(containerId: string): Promise<void> {
    try {
      await this.runner.run(this.dockerBinary, ['rm', '-f', containerId], {
        timeoutMs: this.commandTimeoutMs,
        signal: undefined,
      });
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
