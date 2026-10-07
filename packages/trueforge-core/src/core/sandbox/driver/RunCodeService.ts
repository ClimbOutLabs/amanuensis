import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { Logger } from 'winston';
import { onSignalAbort, signalAbortError } from '../../util/abort';
import { errorCodeForTermination, errorTextForCode, scrubHostPaths } from './errors';
import type { DriverReadiness, DriverRunParams, DriverRunResult, IsolationDriver } from './IsolationDriver';
import { OUTPUT_EXCEEDED_MARKER, RUN_CODE_RESERVED_PREFIX } from './IsolationDriver';
import {
  FILE_BASENAME_PATTERN,
  RunCodeInputSchema,
  RunCodeResultSchema,
  type RunCodeErrorCode,
  type RunCodeInput,
  type RunCodeResult,
} from './RunCodeSchemas';

/**
 * Host wrapper for `run_code` — owns the contract, bounds, mounts, harvest,
 * truncation, error taxonomy, and host-path scrubbing. The driver owns ALL
 * isolation. Both layers fail closed.
 */

export const RUN_CODE_CODE_MAX_BYTES = 512 * 1024;
export const RUN_CODE_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const RUN_CODE_FILES_IN_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const RUN_CODE_FILES_IN_MAX_COUNT = 32;
export const RUN_CODE_HARVEST_MAX_FILES = 64;
export const RUN_CODE_HARVEST_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const RUN_CODE_SANDBOX_UID = 65532;
export const RUN_CODE_SANDBOX_GID = 65532;
/** successful readiness probes are trusted for 60s (failures re-probe). */
export const RUN_CODE_READINESS_CACHE_TTL_MS = 60_000;

/**
 * Ownership handoff (plan E-B1): the sandbox uid must own the run dirs AND the
 * staged files inside them — staged files are root-owned 0400, so chowning
 * only the dirs would leave them unreadable to uid 65532.
 */
async function chownRecursive(root: string, uid: number, gid: number): Promise<void> {
  await chown(root, uid, gid);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await chownRecursive(full, uid, gid);
    } else {
      await chown(full, uid, gid);
    }
  }
}

export interface RunCodeServiceOptions {
  driver: IsolationDriver;
  /** Parent dir for per-run dirs (`<dataDir>/sandbox-runs/<runId>/…`). */
  dataDir: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  memoryMb: number;
  diskMb: number;
  /** Per-stream stdout/stderr cap in KiB (wrapper-owned truncation contract). */
  outputCapKb: number;
  maxConcurrentRuns: number;
  /** Bound for the explicit image-provisioning step. */
  imagePullTimeoutSeconds: number;
  /** FC pull-before-kill best-effort grace (Docker ignores it). */
  harvestGraceMs: number;
  logger: Logger;
  /** Injectable clock / sleep for tests. */
  now: (() => number) | undefined;
  sleepMs: ((ms: number) => Promise<void>) | undefined;
}

export interface TurnAttachment {
  name: string;
  bytes: Buffer;
}

/**
 * One harvested result file with its bytes. The bytes never enter the
 * model-visible result (files_out is metadata-only); the optional
 * {@link RunCodeCallOptions.onHarvestedFiles} sink lets the host persist them
 * (per-turn download artifacts, plan §2.1) before run-root cleanup.
 */
export interface HarvestedFile {
  name: string;
  bytes: Buffer;
  size_bytes: number;
  sha256: string;
}

export interface RunCodeCallOptions {
  signal: AbortSignal | undefined;
  /** Turn attachments staged into ingress (harness-owned, §2.1.1). */
  attachments: TurnAttachment[] | undefined;
  /** Progress events for the explicit provisioning step. */
  onProgress: ((message: string) => void) | undefined;
  /**
   * Called with harvested file bytes after a run, before run-root cleanup.
   * Sink failures never fail the run — they become a harvest warning.
   */
  onHarvestedFiles: ((files: HarvestedFile[]) => Promise<void>) | undefined;
}

/**
 * Minimal contract the agent runtime needs from the run_code backend.
 * RunCodeService is the canonical implementation; tests and future backends
 * program against this interface instead of the concrete class.
 */
export interface RunCodeBackend {
  runCode(rawInput: unknown, options: RunCodeCallOptions | undefined): Promise<RunCodeResult>;
  /**
   * Backend-owned scrub for dispatch-level throws. The backend owns its
   * host paths (runRoot/dataDir); the agent runtime must never see them raw,
   * so this — not a free scrubber the caller cannot feed — is the narrow
   * contract for model-visible error text from a throw.
   */
  scrubDispatchErrorText(text: string): string;
}

export class RunCodeService implements RunCodeBackend {
  private readonly driver: IsolationDriver;
  private readonly dataDir: string;
  private readonly defaultTimeoutSeconds: number;
  private readonly maxTimeoutSeconds: number;
  private readonly memoryMb: number;
  private readonly diskMb: number;
  private readonly outputCapBytes: number;
  private readonly maxConcurrentRuns: number;
  private readonly imagePullTimeoutSeconds: number;
  private readonly harvestGraceMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleepMs: (ms: number) => Promise<void>;

  private activeRuns = 0;
  private provisioningPromise: Promise<void> | undefined;
  /** AbortController for the shared pull; aborted only when every coalesced caller has left. */
  private provisioningController: AbortController | undefined;
  /** Every caller currently waiting on the shared pull, for progress fan-out and refcounted abort. */
  private readonly provisioningListeners = new Set<{
    onProgress: (message: string) => void;
    signal: AbortSignal | undefined;
  }>();
  /** timestamp (via the injectable clock) of the last successful readiness probe. */
  private readinessAt: number | undefined;
  /** in-flight readiness probe shared by concurrent runCode calls. */
  private readinessInflight: Promise<DriverReadiness> | undefined;
  private reaperTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(options: RunCodeServiceOptions) {
    this.driver = options.driver;
    this.dataDir = options.dataDir;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    this.maxTimeoutSeconds = options.maxTimeoutSeconds;
    this.memoryMb = options.memoryMb;
    this.diskMb = options.diskMb;
    this.outputCapBytes = options.outputCapKb * 1024;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.imagePullTimeoutSeconds = options.imagePullTimeoutSeconds;
    this.harvestGraceMs = options.harvestGraceMs;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sleepMs = options.sleepMs ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  get driverKind(): 'docker' | 'firecracker' {
    return this.driver.kind;
  }

  /**
   * scrub a dispatch-level throw's message before it becomes
   * model-visible. A throw that escapes runCode happened before a runRoot
   * existed (mid-run throws are converted to failed results inside runCode),
   * so only the dataDir prefix is knowable here.
   */
  scrubDispatchErrorText(text: string): string {
    return scrubHostPaths({ text, runRoot: '', dataDir: this.dataDir });
  }

  /** Start the 5-minute reaper cadence (called once at server start). */
  startReaper(): void {
    if (this.reaperTimer !== undefined) {
      return;
    }
    const sweep = (): void => {
      this.reap().catch((error: unknown) => {
        this.logger.warn('run_code reaper sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    // Startup sweep for crash-recovery, then the 5-minute cadence.
    void this.reap().catch(() => undefined);
    const reaperTimer = setInterval(sweep, 5 * 60 * 1000);
    reaperTimer.unref();
    this.reaperTimer = reaperTimer;
  }

  /** One reaper pass: driver stale-container/VM sweep + per-run dir sweep. */
  async reap(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.driver.reapStale();
    } catch (error) {
      this.logger.warn('run_code driver reap failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.sweepRunDirs();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reaperTimer !== undefined) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
    await this.driver.dispose();
  }

  /**
   * Fast readiness probes only — never provisions. A missing image surfaces
   * as a readiness failure; provisioning is the explicit step below.
   */
  async ensureReady(signal?: AbortSignal): Promise<DriverReadiness> {
    return this.driver.ensureReady(signal);
  }

  /**
   * Explicit provisioning step: bounded image pull with honest progress
   * events. Concurrent calls coalesce on the one pull: every waiter receives
   * progress, and one caller's abort never kills the pull for the others —
   * the pull aborts only when every coalesced caller has left. Never called
   * implicitly from ensureReady.
   */
  async provision(options: {
    signal: AbortSignal | undefined;
    onProgress: ((message: string) => void) | undefined;
  }): Promise<void> {
    if (options.signal?.aborted === true) {
      throw signalAbortError(options.signal);
    }
    const listener = {
      onProgress: options.onProgress ?? ((): void => undefined),
      signal: options.signal,
    };
    this.provisioningListeners.add(listener);
    const onCallerAbort = (): void => {
      this.provisioningListeners.delete(listener);
      if (this.provisioningListeners.size === 0) {
        this.provisioningController?.abort();
      }
    };
    onSignalAbort(listener.signal, onCallerAbort);
    try {
      if (this.provisioningPromise === undefined) {
        const controller = new AbortController();
        this.provisioningController = controller;
        const fanout = (message: string): void => {
          for (const waiter of this.provisioningListeners) {
            waiter.onProgress(message);
          }
        };
        this.provisioningPromise = this.driver
          .provision({ signal: controller.signal, onProgress: fanout, timeoutSeconds: this.imagePullTimeoutSeconds })
          .finally(() => {
            this.provisioningPromise = undefined;
            this.provisioningController = undefined;
          });
      }
      await this.provisioningPromise;
    } finally {
      listener.signal?.removeEventListener('abort', onCallerAbort);
      this.provisioningListeners.delete(listener);
    }
    // provisioning may have replaced the image — the readiness cache is
    // only valid for the image it probed.
    this.readinessAt = undefined;
  }

  /**
   * readiness probe with a short success cache and in-flight coalescing.
   * ensureReady shells out to docker/cosign; without the cache every run_code
   * call pays the full probe. Only successes are cached (failures re-probe
   * next call); provisioning invalidates.
   */
  private async checkReadiness(signal: AbortSignal | undefined): Promise<DriverReadiness> {
    const now = this.now();
    if (this.readinessAt !== undefined && now - this.readinessAt < RUN_CODE_READINESS_CACHE_TTL_MS) {
      return { ready: true };
    }
    this.readinessInflight ??= this.driver.ensureReady(signal).finally(() => {
      this.readinessInflight = undefined;
    });
    const readiness = await this.readinessInflight;
    if (readiness.ready) {
      this.readinessAt = this.now();
    }
    return readiness;
  }

  /** Execute one `run_code` call: validate → stage → run supervised → harvest. */
  async runCode(rawInput: unknown, options?: RunCodeCallOptions): Promise<RunCodeResult> {
    const parsed = RunCodeInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return this.failedResult({
        error_code: 'invalid_input',
        error: 'Invalid run_code input: failed schema validation.',
        runRoot: '',
        stdout: '',
        stderr: '',
        filesOut: [],
        harvestWarnings: [],
      });
    }
    const input = parsed.data;

    if (this.activeRuns >= this.maxConcurrentRuns) {
      return this.failedResult({
        error_code: 'concurrency_exceeded',
        error: errorTextForCode({ error_code: 'concurrency_exceeded', detail: undefined }),
        runRoot: '',
        stdout: '',
        stderr: '',
        filesOut: [],
        harvestWarnings: [],
      });
    }

    // Readiness short-circuits BEFORE anything is staged.
    let readiness = await this.checkReadiness(options?.signal);
    if (!readiness.ready && readiness.error_code === 'image_missing') {
      // The explicit provisioning step — bounded pull with honest progress.
      // The first run_code that triggers it waits; concurrent calls coalesce
      // on the one pull via provisioningPromise. A failed pull is
      // image_unavailable (user-actionable), never a hang or retry loop.
      try {
        await this.provision({ signal: options?.signal, onProgress: options?.onProgress });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // An aborted caller isn't a provisioning failure — the harness owns
        // the abort disposition, so don't log it as one.
        if (options?.signal?.aborted !== true) {
          this.logger.warn('run_code image provisioning failed', { detail });
        }
        return this.failedResult({
          error_code: 'image_unavailable',
          error: errorTextForCode({ error_code: 'image_unavailable', detail }),
          runRoot: '',
          stdout: '',
          stderr: '',
          filesOut: [],
          harvestWarnings: [],
        });
      }
      readiness = await this.checkReadiness(options?.signal);
    }
    if (!readiness.ready) {
      // The model-visible taxonomy has no kvm/platform codes: a backend that
      // cannot isolate is daemon_unavailable with actionable detail text.
      const code: RunCodeErrorCode =
        readiness.error_code === 'image_unavailable' || readiness.error_code === 'image_missing'
          ? 'image_unavailable'
          : 'daemon_unavailable';
      return this.failedResult({
        error_code: code,
        error: errorTextForCode({ error_code: code, detail: readiness.error }),
        runRoot: '',
        stdout: '',
        stderr: '',
        filesOut: [],
        harvestWarnings: [],
      });
    }

    // Decode + validate files_in before staging (fail closed: nothing staged).
    const attachments = options?.attachments ?? [];
    const staged = this.validateAndDecodeFilesIn({ input, attachments });
    if (staged.error !== undefined) {
      return staged.error;
    }

    const runId = randomUUID().replace(/-/g, '');
    const runRoot = join(this.dataDir, 'sandbox-runs', runId);
    const ingressDir = join(runRoot, 'ingress');
    const scratchDir = join(runRoot, 'scratch');
    const egressDir = join(runRoot, 'egress');
    this.activeRuns += 1;
    try {
      return await this.executeRun({
        input,
        runId,
        runRoot,
        ingressDir,
        scratchDir,
        egressDir,
        filesIn: staged.files,
        attachments,
        signal: options?.signal,
        onHarvestedFiles: options?.onHarvestedFiles,
      });
    } catch (error) {
      // dispatch itself broke (driver throw, host I/O). The service
      // contract reports failures as data, so convert here — failedResult
      // scrubs runRoot/dataDir out of the detail, and the runRoot is removed
      // by the finally below. A throw reaching the caller means runCode
      // broke before the runRoot existed.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error('run_code dispatch failed', { runId, error: detail });
      return this.failedResult({
        error_code: 'internal',
        error: errorTextForCode({ error_code: 'internal', detail }),
        runRoot,
        stdout: '',
        stderr: '',
        filesOut: [],
        harvestWarnings: [],
      });
    } finally {
      this.activeRuns -= 1;
      await this.removeRunRoot(runRoot);
    }
  }

  private validateAndDecodeFilesIn(input: {
    input: RunCodeInput;
    attachments: TurnAttachment[];
  }): { files: { name: string; bytes: Buffer }[]; error: undefined } | { files: []; error: RunCodeResult } {
    const fail = (error: string): { files: []; error: RunCodeResult } => ({
      files: [],
      error: this.failedResult({
        error_code: 'invalid_input',
        error,
        runRoot: '',
        stdout: '',
        stderr: '',
        filesOut: [],
        harvestWarnings: [],
      }),
    });
    const attachmentNames = new Set(input.attachments.map(a => a.name));
    const files: { name: string; bytes: Buffer }[] = [];
    let totalBytes = 0;
    for (const file of input.input.files_in) {
      if (file.name.startsWith(RUN_CODE_RESERVED_PREFIX)) {
        return fail(`Invalid run_code input: files_in name "${file.name}" is reserved.`);
      }
      if (attachmentNames.has(file.name)) {
        return fail(
          `Invalid run_code input: "${file.name}" is already available in /ingress — do not re-upload it via files_in.`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(file.content_base64, 'base64');
      } catch {
        return fail(`Invalid run_code input: files_in["${file.name}"].content_base64 is not valid base64.`);
      }
      // Buffer.from is permissive (ignores stray characters); require canonical
      // base64 so a malformed payload cannot smuggle unexpected bytes.
      const compacted = file.content_base64.replace(/\s+/g, '');
      if (bytes.toString('base64') !== compacted) {
        return fail(`Invalid run_code input: files_in["${file.name}"].content_base64 is not canonical base64.`);
      }
      if (bytes.byteLength > RUN_CODE_FILE_MAX_BYTES) {
        return fail(`Invalid run_code input: files_in["${file.name}"] exceeds the 25 MiB per-file cap.`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > RUN_CODE_FILES_IN_MAX_TOTAL_BYTES) {
        return fail('Invalid run_code input: files_in exceeds the 100 MiB total cap.');
      }
      files.push({ name: file.name, bytes });
    }
    return { files, error: undefined };
  }

  private async executeRun(input: {
    input: RunCodeInput;
    runId: string;
    runRoot: string;
    ingressDir: string;
    scratchDir: string;
    egressDir: string;
    filesIn: { name: string; bytes: Buffer }[];
    attachments: TurnAttachment[];
    signal: AbortSignal | undefined;
    onHarvestedFiles: ((files: HarvestedFile[]) => Promise<void>) | undefined;
  }): Promise<RunCodeResult> {
    const timeoutSeconds = Math.min(input.input.timeout_seconds ?? this.defaultTimeoutSeconds, this.maxTimeoutSeconds);
    const timeoutMs = timeoutSeconds * 1000;

    // Per-run dirs, 0700. realpath guards against symlink games on the parent.
    await mkdir(input.ingressDir, { recursive: true, mode: 0o700 });
    await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
    await mkdir(input.egressDir, { recursive: true, mode: 0o700 });
    const runRoot = await realpath(input.runRoot).catch(() => input.runRoot);
    const ingressDir = join(runRoot, 'ingress');
    const scratchDir = join(runRoot, 'scratch');
    const egressDir = join(runRoot, 'egress');

    // Stage files_in + turn attachments into ingress (read-only inside).
    for (const file of input.filesIn) {
      await writeFile(join(ingressDir, file.name), file.bytes, { mode: 0o400 });
    }
    for (const attachment of input.attachments) {
      await writeFile(join(ingressDir, attachment.name), attachment.bytes, { mode: 0o400 });
    }
    // The program itself rides in ingress under a reserved name (never harvested).
    const programName = `${RUN_CODE_RESERVED_PREFIX}main.${input.input.language === 'python' ? 'py' : 'mjs'}`;
    await writeFile(join(ingressDir, programName), input.input.code, { mode: 0o400 });

    // Ownership handoff (E-B1): the sandbox uid owns the three dirs and every
    // staged file. Best-effort — the Docker driver probes the mapping at
    // ensureReady and fails loudly there.
    try {
      await chownRecursive(ingressDir, RUN_CODE_SANDBOX_UID, RUN_CODE_SANDBOX_GID);
      await chownRecursive(scratchDir, RUN_CODE_SANDBOX_UID, RUN_CODE_SANDBOX_GID);
      await chownRecursive(egressDir, RUN_CODE_SANDBOX_UID, RUN_CODE_SANDBOX_GID);
    } catch (error) {
      this.logger.warn('run_code chown of run dirs failed (continuing)', {
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const controller = new AbortController();
    const onAbort = (): void => {
      controller.abort();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const params: DriverRunParams = {
      language: input.input.language,
      code: input.input.code,
      filesIn: input.filesIn,
      ingressDir,
      scratchDir,
      egressDir,
      timeoutMs,
      memoryMb: this.memoryMb,
      diskMb: this.diskMb,
      runId: input.runId,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        HOME: '/scratch',
        // Belt-and-braces: offline environment, so stray installs fail fast.
        PIP_NO_INDEX: '1',
        npm_config_registry: 'http://127.0.0.1:1/',
      },
      signal: controller.signal,
      // FC pull-before-kill best-effort grace (Docker ignores it).
      harvestGraceMs: this.harvestGraceMs,
    };

    // Supervisors: wall-clock timeout, disk du-poll, absolute abandon deadline.
    // The abort REASON (not a boolean flag) records which supervisor fired —
    // abort() is idempotent, so the first reason wins and survives the run.
    const TIMEOUT_REASON = 'run_code_timeout';
    const DISK_REASON = 'run_code_disk_exceeded';
    const timeoutTimer = setTimeout(() => {
      controller.abort(TIMEOUT_REASON);
    }, timeoutMs);
    timeoutTimer.unref();
    // Disk poll as a sleep-driven loop (injectable clock for tests). It exits
    // when the controller aborts; the finally below aborts after a normal run
    // so no poller outlives its run.
    let duFailStreak = 0;
    const diskLoop = (async (): Promise<void> => {
      while (!controller.signal.aborted) {
        await this.sleepMs(500);
        const status = await this.pollDiskUsage(scratchDir, egressDir);
        if (status === 'unknown') {
          // Fail closed: three consecutive unreadable polls means the quota
          // can no longer be verified, so the run is killed, not trusted.
          duFailStreak += 1;
          if (duFailStreak >= 3) {
            controller.abort(DISK_REASON);
          }
          continue;
        }
        duFailStreak = 0;
        if (status === 'exceeded') {
          controller.abort(DISK_REASON);
        }
      }
    })();
    diskLoop.catch((error: unknown) => {
      this.logger.warn('run_code disk poll loop failed', {
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    let result: DriverRunResult;
    try {
      // Abandon deadline: timeoutMs + 5s kill grace + 10s harvest grace.
      // Past it the slot is released and the container/VM is left to the reaper.
      const abandonMs = timeoutMs + 5000 + 10000;
      result = await this.withDeadline(this.driver.run(params), abandonMs, input.runId);
    } catch (error) {
      result = {
        exitCode: -1,
        stdout: '',
        stderr: '',
        terminatedBy: controller.signal.reason === TIMEOUT_REASON ? 'timeout' : 'internal',
        internalError: error instanceof Error ? error.message : String(error),
        harvestWarnings: [],
      };
    } finally {
      clearTimeout(timeoutTimer);
      // Stop the disk poller; the run is over either way.
      controller.abort();
      input.signal?.removeEventListener('abort', onAbort);
    }

    // A completed run keeps its verbatim exit code — the disk supervisor only
    // reclassifies runs that did not complete.
    if (
      result.terminatedBy !== 'completed' &&
      result.terminatedBy !== 'timeout' &&
      controller.signal.reason === DISK_REASON
    ) {
      result = { ...result, terminatedBy: 'killed', internalError: 'disk quota exceeded during run' };
    }

    const harvestWarnings: string[] = [...result.harvestWarnings];
    const { filesOut, harvestedFiles } = await this.harvest({
      runRoot,
      ingressDir,
      scratchDir,
      egressDir,
      harvestWarnings,
    });

    // persist harvested bytes for per-turn download BEFORE run-root
    // cleanup. The sink never fails the run — a sink failure becomes a
    // harvest warning and the metadata-only files_out still stands.
    if (input.onHarvestedFiles !== undefined && harvestedFiles.length > 0) {
      try {
        await input.onHarvestedFiles(harvestedFiles);
      } catch (error) {
        harvestWarnings.push('Result files could not be saved for download; files_out metadata is still valid.');
        this.logger.warn('run_code harvested-file sink failed', {
          runId: input.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Error taxonomy: the wrapper maps the driver's termination report. A
    // completed run is status ok even with a non-zero exit — the exit code is
    // the program's own verdict, reported verbatim, never an infra failure.
    if (result.terminatedBy === 'completed') {
      return this.okResult({ result, runRoot, filesOut, harvestWarnings });
    }
    if (result.internalError?.startsWith(OUTPUT_EXCEEDED_MARKER) === true) {
      return this.failedResult({
        error_code: 'output_exceeded',
        error: errorTextForCode({
          error_code: 'output_exceeded',
          detail: 'the program wrote more than the 4 MiB transport bound per stream',
        }),
        runRoot,
        stdout: result.stdout,
        stderr: result.stderr,
        filesOut,
        harvestWarnings,
      });
    }
    // A 137 without a timeout abort smells like the kernel OOM-killer, even
    // when the driver only reported 'killed'.
    const oomKilled = result.exitCode === 137 && controller.signal.reason !== TIMEOUT_REASON;
    // The wrapper's own abort reason is authoritative: a timeout-supervisor
    // abort is 'timeout' even when the driver reported 'killed'/'oom', and a
    // disk-supervisor abort is 'disk_exceeded'.
    const abortReason: unknown = controller.signal.reason;
    let error_code: RunCodeErrorCode;
    if (abortReason === TIMEOUT_REASON) {
      error_code = 'timeout';
    } else if (abortReason === DISK_REASON) {
      error_code = 'disk_exceeded';
    } else {
      error_code = errorCodeForTermination({
        terminatedBy: result.terminatedBy,
        exitCode: result.exitCode,
        oomKilled,
      });
    }
    const detail = result.internalError ?? `exit code ${String(result.exitCode)}`;
    return this.failedResult({
      error_code,
      error: errorTextForCode({ error_code, detail }),
      runRoot,
      stdout: result.stdout,
      stderr: result.stderr,
      filesOut,
      harvestWarnings,
    });
  }

  private async withDeadline(promise: Promise<DriverRunResult>, ms: number, runId: string): Promise<DriverRunResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<DriverRunResult>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.logger.error('run_code abandon deadline hit; leaving run to the reaper', { runId });
            reject(new Error('abandon deadline hit'));
          }, ms);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Disk quota covers scratch + egress (the two user-writable dirs, plan D6) —
   * not ingress (harness-staged inputs and the program file), which the model
   * cannot grow. Sums both dirs; any unreadable or unparseable reading is
   * 'unknown' and the caller fails closed after three consecutive unknowns.
   */
  private pollDiskUsage(scratchDir: string, egressDir: string): Promise<'ok' | 'exceeded' | 'unknown'> {
    const parseTotalBytes = (stdout: string, perLineUnitBytes: number): number | undefined => {
      let total = 0;
      let lines = 0;
      for (const line of stdout.split('\n')) {
        const first = line.split(/\s+/)[0];
        if (first === undefined || first === '') {
          continue;
        }
        const n = Number.parseInt(first, 10);
        if (!Number.isFinite(n)) {
          return undefined;
        }
        total += n * perLineUnitBytes;
        lines += 1;
      }
      return lines === 2 ? total : undefined;
    };
    const verdict = (bytes: number | undefined): 'ok' | 'exceeded' | 'unknown' =>
      bytes === undefined ? 'unknown' : bytes > this.diskMb * 1024 * 1024 ? 'exceeded' : 'ok';
    return new Promise(resolve => {
      // --apparent-size counts sparse writes honestly; fall back to -sk on BSD du.
      execFile('du', ['-sb', '--apparent-size', scratchDir, egressDir], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          execFile('du', ['-sk', scratchDir, egressDir], { timeout: 5000 }, (fallbackError, fallbackStdout) => {
            if (fallbackError) {
              resolve('unknown');
              return;
            }
            resolve(verdict(parseTotalBytes(fallbackStdout, 1024)));
          });
          return;
        }
        resolve(verdict(parseTotalBytes(stdout, 1)));
      });
    });
  }

  /** Harvest egress AND scratch (egress wins on name collision) — wrapper-only (E-H1). */
  private async harvest(input: {
    runRoot: string;
    ingressDir: string;
    scratchDir: string;
    egressDir: string;
    harvestWarnings: string[];
  }): Promise<{ filesOut: RunCodeResult['files_out']; harvestedFiles: HarvestedFile[] }> {
    const seen = new Set<string>();
    const filesOut: RunCodeResult['files_out'] = [];
    const harvestedFiles: HarvestedFile[] = [];
    let totalBytes = 0;
    const consider = async (dir: string): Promise<void> => {
      const entries = await this.listFilesRecursive(dir, 0);
      for (const entry of entries) {
        if (filesOut.length >= RUN_CODE_HARVEST_MAX_FILES) {
          input.harvestWarnings.push(
            `Stopped collecting result files at the ${String(RUN_CODE_HARVEST_MAX_FILES)}-file cap; remaining files were skipped.`,
          );
          return;
        }
        if (entry.depth > 0) {
          // Basename-only outputs: nested files are skipped with a warning,
          // never flattened into the top level.
          input.harvestWarnings.push(
            `Skipped result file "${relative(dir, entry.path)}": only top-level files are collected.`,
          );
          continue;
        }
        const path = entry.path;
        const name = basename(path);
        if (!FILE_BASENAME_PATTERN.test(name) || name.startsWith(RUN_CODE_RESERVED_PREFIX)) {
          input.harvestWarnings.push(`Skipped result file with an invalid name: ${name}.`);
          continue;
        }
        if (seen.has(name)) {
          // Egress was considered first, so its file wins; the shadowed one
          // is reported rather than silently dropped.
          input.harvestWarnings.push(
            `Skipped result file "${name}": an earlier file with the same name takes precedence.`,
          );
          continue;
        }
        let fileStat;
        try {
          fileStat = await lstat(path);
        } catch {
          continue;
        }
        // Symlinks and non-regular files are skipped, never fatal.
        if (fileStat.isSymbolicLink()) {
          input.harvestWarnings.push(`Skipped result file "${name}": symlinks are not collected.`);
          continue;
        }
        if (!fileStat.isFile()) {
          input.harvestWarnings.push(`Skipped non-regular result file: ${name}.`);
          continue;
        }
        if (fileStat.size > RUN_CODE_FILE_MAX_BYTES) {
          input.harvestWarnings.push(
            `Skipped result file "${name}": exceeds the 25 MiB per-file cap (${(fileStat.size / 1048576).toFixed(1)} MiB).`,
          );
          continue;
        }
        if (totalBytes + fileStat.size > RUN_CODE_HARVEST_MAX_TOTAL_BYTES) {
          input.harvestWarnings.push(
            'Stopped collecting result files at the 100 MiB total cap; remaining files were skipped.',
          );
          return;
        }
        // a file that vanishes or becomes unreadable between lstat and
        // read must not fail the whole harvest — warn and continue.
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch {
          input.harvestWarnings.push(`Skipped result file "${name}": it could not be read.`);
          continue;
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        seen.add(name);
        totalBytes += bytes.byteLength;
        const fileOut = { name, size_bytes: bytes.byteLength, sha256 };
        filesOut.push(fileOut);
        harvestedFiles.push({ ...fileOut, bytes });
      }
    };
    // Egress first so it wins on name collision (H4).
    await consider(input.egressDir);
    await consider(input.scratchDir);
    return { filesOut, harvestedFiles };
  }

  private async listFilesRecursive(dir: string, depth: number): Promise<{ path: string; depth: number }[]> {
    if (depth > 8) {
      return [];
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: { path: string; depth: number }[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listFilesRecursive(path, depth + 1)));
      } else {
        files.push({ path, depth });
      }
      if (files.length > 4096) {
        break;
      }
    }
    return files;
  }

  private truncateStream(text: string): { text: string; truncated: boolean } {
    const full = Buffer.from(text, 'utf8');
    if (full.byteLength <= this.outputCapBytes) {
      return { text, truncated: false };
    }
    // Truncate on a byte boundary without splitting a multi-byte char: walk
    // back over a trailing incomplete sequence (at most a few bytes).
    const decoder = new TextDecoder('utf8', { fatal: true });
    let end = this.outputCapBytes;
    while (end > 0) {
      try {
        return { text: decoder.decode(full.subarray(0, end)), truncated: true };
      } catch {
        end -= 1;
      }
    }
    return { text: '', truncated: true };
  }

  private okResult(input: {
    result: DriverRunResult;
    runRoot: string;
    filesOut: { name: string; size_bytes: number; sha256: string }[];
    harvestWarnings: string[];
  }): RunCodeResult {
    const stdout = this.truncateStream(input.result.stdout);
    const stderr = this.truncateStream(input.result.stderr);
    const candidate = {
      status: 'ok' as const,
      exit_code: input.result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      files_out: input.filesOut,
      harvest_warnings: input.harvestWarnings,
    };
    return this.parseResult(candidate, input.runRoot);
  }

  private failedResult(input: {
    error_code: RunCodeErrorCode;
    error: string;
    runRoot: string;
    stdout: string;
    stderr: string;
    filesOut: { name: string; size_bytes: number; sha256: string }[];
    harvestWarnings: string[];
  }): RunCodeResult {
    const stdout = this.truncateStream(input.stdout);
    const stderr = this.truncateStream(input.stderr);
    const candidate = {
      status: 'failed' as const,
      error_code: input.error_code,
      error: scrubHostPaths({ text: input.error, runRoot: input.runRoot, dataDir: this.dataDir }),
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      files_out: input.filesOut,
      harvest_warnings: input.harvestWarnings,
    };
    return this.parseResult(candidate, input.runRoot);
  }

  /** The result shape is exhaustive under tsc — parse, never cast. */
  private parseResult(candidate: unknown, runRoot: string): RunCodeResult {
    const parsed = RunCodeResultSchema.safeParse(candidate);
    if (!parsed.success) {
      // Unreachable in practice: the candidate is built from validated parts.
      // Fail closed with a generic internal error rather than throwing.
      return RunCodeResultSchema.parse({
        status: 'failed',
        error_code: 'internal',
        error: scrubHostPaths({ text: 'Internal error building the run_code result.', runRoot, dataDir: this.dataDir }),
        stdout: '',
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        files_out: [],
        harvest_warnings: [],
      });
    }
    return parsed.data;
  }

  private async sweepRunDirs(): Promise<void> {
    const parent = join(this.dataDir, 'sandbox-runs');
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = this.now() - 30 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(parent, entry.name);
      try {
        const fileStat = await stat(path);
        if (fileStat.mtimeMs < cutoff) {
          await rm(path, { recursive: true, force: true });
        }
      } catch {
        // Best-effort sweep; a racing run dir is left for the next pass.
      }
    }
  }

  private async removeRunRoot(runRoot: string): Promise<void> {
    try {
      await rm(runRoot, { recursive: true, force: true });
    } catch (error) {
      this.logger.warn('run_code run-root cleanup failed; left for the reaper', {
        runRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Validate the startup invariants : fail closed, never warn-and-continue. */
export function validateRunCodeStartupConfig(input: {
  networkEgress: boolean;
  isolationDriver: 'docker' | 'firecracker';
  platform: NodeJS.Platform;
  image: string;
  /**
   * the image pin is the feature opt-in. False (blank SANDBOX_IMAGE, the
   * default for existing standalone installs) leaves run_code dormant: the
   * Docker-identity checks (digest pin) and the pull-related timeout
   * cross-check are skipped so boot succeeds, while the numeric sanity checks
   * below still run. True preserves the full fail-closed validation. Docker is
   * required only when run_code executes (plan §2.8), not at install/startup —
   * a dormant install fails closed at call time (image_unavailable).
   */
  imageConfigured: boolean;
  imagePullTimeoutSeconds: number;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  memoryMb: number;
  diskMb: number;
  outputCapKb: number;
  runCodeToolCallTimeoutMs: number | undefined;
  serverExecutionTimeoutSeconds: number | undefined;
}): void {
  if (input.networkEgress) {
    throw new Error(
      'sandbox.network_egress is reserved for a future version and must be false in v1 — refusing to start.',
    );
  }
  if (input.isolationDriver === 'firecracker' && input.platform === 'darwin') {
    throw new Error('isolation_driver=firecracker is Linux+KVM only — refusing to start on darwin.');
  }
  if (input.isolationDriver === 'firecracker') {
    throw new Error(
      'isolation_driver=firecracker is configured but the Firecracker driver is not implemented in this build (parked until /dev/kvm is confirmed on the target host) — refusing to start.',
    );
  }
  // Dormant (blank image): the digest pin is not checked — Docker is required
  // only when run_code executes. The numeric bounds below still apply so a
  // misconfigured install surfaces its mistakes at boot.
  if (input.imageConfigured && !/^.+@sha256:[0-9a-f]{64}$/.test(input.image)) {
    throw new Error(
      `sandbox.image must be a pinned digest reference (<tag>@sha256:<64 hex chars>), got ${JSON.stringify(input.image)} — refusing to start.`,
    );
  }
  const bounds: [name: string, value: number][] = [
    ['image_pull_timeout_seconds', input.imagePullTimeoutSeconds],
    ['default_timeout_seconds', input.defaultTimeoutSeconds],
    ['max_timeout_seconds', input.maxTimeoutSeconds],
    ['memory_mb', input.memoryMb],
    ['disk_mb', input.diskMb],
    ['stdout_stderr_cap_kb', input.outputCapKb],
  ];
  for (const [name, value] of bounds) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`sandbox.${name} must be a positive integer, got ${String(value)} — refusing to start.`);
    }
  }
  if (input.defaultTimeoutSeconds > input.maxTimeoutSeconds) {
    throw new Error(
      `sandbox.default_timeout_seconds (${String(input.defaultTimeoutSeconds)}) exceeds sandbox.max_timeout_seconds (${String(input.maxTimeoutSeconds)}) — refusing to start.`,
    );
  }
  // No pull ever happens while dormant, so the pull-sized tool-call timeout
  // is only enforced for configured installs.
  if (input.runCodeToolCallTimeoutMs !== undefined && input.imageConfigured) {
    const requiredMs = (input.imagePullTimeoutSeconds + input.maxTimeoutSeconds) * 1000;
    if (input.runCodeToolCallTimeoutMs < requiredMs) {
      throw new Error(
        `run_code tool-call timeout (${String(input.runCodeToolCallTimeoutMs)} ms) is below image_pull_timeout_seconds + max_timeout_seconds (${String(requiredMs)} ms) — a first-run image pull could not complete inside the tool-call timeout. Refusing to start.`,
      );
    }
  }
  // A turn that dies before run_code's own deadline would kill a worst-case
  // run_code call (first-run pull + longest run) from above; the turn ceiling
  // must cover the run_code bound it no longer shares with every tool.
  if (
    input.serverExecutionTimeoutSeconds !== undefined &&
    input.runCodeToolCallTimeoutMs !== undefined &&
    input.serverExecutionTimeoutSeconds * 1000 < input.runCodeToolCallTimeoutMs
  ) {
    throw new Error(
      `SERVER_EXECUTION_TIMEOUT_SECONDS (${String(input.serverExecutionTimeoutSeconds)} s) is below the run_code tool-call timeout (${String(input.runCodeToolCallTimeoutMs)} ms) — a worst-case run_code call would be killed by the turn deadline. Refusing to start.`,
    );
  }
}
