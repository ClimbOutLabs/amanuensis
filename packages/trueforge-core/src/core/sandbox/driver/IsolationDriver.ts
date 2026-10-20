/**
 * Pluggable isolation contract for `run_code`. One interface, two drivers
 * (Docker default, Firecracker opt-in); the host wrapper owns the contract,
 * bounds, truncation, and harvesting — the driver owns ALL isolation.
 *
 * The old `SandboxProvider` interface is superseded by this contract.
 */

/** Languages the `run_code` contract offers. Shell is deliberately NOT offered. */
export type RunCodeLanguage = 'python' | 'node';

/**
 * Prefix a driver sets on DriverRunResult.internalError when the 4 MiB
 * per-stream transport bound fires. The wrapper maps it onto `output_exceeded`.
 */
export const OUTPUT_EXCEEDED_MARKER = 'output_exceeded:';

/**
 * Prefix a driver sets on DriverRunResult.internalError when a created
 * container fails post-create isolation verification. The wrapper maps it
 * onto `isolation_refused` and surfaces the spec's exact refusal message.
 * Mirrors the OUTPUT_EXCEEDED_MARKER pattern.
 */
export const ISOLATION_REFUSED_MARKER = 'isolation_refused:';

/**
 * Reserved ingress prefix for wrapper-staged files (the program itself).
 * Harvesting skips these; the driver executes the program from this path.
 */
export const RUN_CODE_RESERVED_PREFIX = '__runcode_';

/** File name of the staged program inside ingress. */
export function runCodeProgramName(language: RunCodeLanguage): string {
  return `${RUN_CODE_RESERVED_PREFIX}main.${language === 'python' ? 'py' : 'mjs'}`;
}

/** Container-side path of the staged program (ingress mounts read-only at /ingress). */
export function runCodeProgramPath(language: RunCodeLanguage): string {
  return `/ingress/${runCodeProgramName(language)}`;
}

/** The command that runs the staged program; the program is read from ingress, so argv size never limits it. */
export function runCodeArgv(language: RunCodeLanguage): string[] {
  const program = runCodeProgramPath(language);
  return language === 'python' ? ['python3', program] : ['node', program];
}

/** Uid:gid the container runs as, plus whether staged run dirs must be handed to it. */
export interface SandboxIdentity {
  uid: number;
  gid: number;
  /** True when the server cannot run as `uid`, so it must chown the run dirs to it. */
  chownRunDirs: boolean;
}

/** How a driver run ended, before the wrapper maps it onto the error taxonomy. */
export type DriverTermination = 'completed' | 'timeout' | 'oom' | 'killed' | 'disk' | 'internal';

/** Finer cause behind a failure whose `error_code` is shared with other causes. */
export type DriverReadinessReason = 'signature_unverified' | 'isolation_refused';

export type DriverReadiness =
  | { ready: true }
  | {
      ready: false;
      /**
       * `image_missing` is the only code the wrapper may heal: it triggers the
       * explicit bounded provisioning step. Every other code is terminal
       * for the call.
       */
      error_code:
        | 'daemon_unavailable'
        | 'docker_unavailable'
        | 'image_unavailable'
        | 'image_missing'
        | 'kvm_unavailable'
        | 'sandbox_disabled'
        | 'slots_unavailable'
        | 'unsupported_platform';
      /** Human-actionable remediation text, shown to the user. */
      error: string;
      /** True when `error` is already the complete message, so it reaches the model and the chat unchanged. */
      verbatim?: true | undefined;
      reason?: DriverReadinessReason | undefined;
    };

export interface DriverRunParams {
  language: RunCodeLanguage;
  /** Already validated and size-capped by the wrapper. */
  code: string;
  /** Model-authored inputs, staged to ingress (read-only) by the wrapper. */
  filesIn: readonly { name: string; bytes: Buffer }[];
  /** Host path of the read-only ingress mount / transfer source. */
  ingressDir: string;
  /** Host path of the read-write working dir (cwd inside the sandbox). */
  scratchDir: string;
  /** Host path where result files land. */
  egressDir: string;
  /** Wall clock bound in ms — the ONLY time bound. No cpuSeconds (dead logic). */
  timeoutMs: number;
  /** Hard memory cap in MiB. */
  memoryMb: number;
  /** Scratch+egress quota in MiB (host-dir + supervisor du-poll + kill). */
  diskMb: number;
  /** Label/tracking for reaping. */
  runId: string;
  /**
   * Curated environment only (PATH, LANG, HOME=/scratch, USER/LOGNAME,
   * PIP_NO_INDEX=1, npm_config_registry dead-end). The host process env is never
   * passed through.
   */
  env: Readonly<Record<string, string>>;
  /**
   * Package mirror grant for this run, issued for the chat's repo when the person allowed downloads
   * for it. Slot drivers pass it to the agent; the Docker driver ignores it and the run stays offline.
   */
  packageMirrorToken: string | undefined;
  /** Container user; the wrapper stages the run dirs so this uid can use them. */
  sandboxIdentity: SandboxIdentity;
  /** Cancels the run: the driver must kill the container/VM on abort. */
  signal: AbortSignal | undefined;
  /** FC pull-before-kill best-effort grace in ms (Docker ignores it). */
  harvestGraceMs: number;
}

export interface DriverRunResult {
  exitCode: number;
  /**
   * RAW captured stream. The WRAPPER applies the 256 KiB truncation contract;
   * driver-internal capture is bounded at 4 MiB/stream as a transport safety
   * limit only, never model-visible.
   */
  stdout: string;
  stderr: string;
  terminatedBy: DriverTermination;
  /** Host-path-scrubbed before it reaches the model. */
  internalError: string | undefined;
  /**
   * Driver-originated collection notes (e.g. Firecracker's pull-before-kill
   * grace expiring with zero bytes pulled). The wrapper appends these to the
   * result's `harvest_warnings` and owns the final shape; the driver never
   * builds the result contract itself.
   */
  harvestWarnings: readonly string[];
}

export interface IsolationDriver {
  readonly kind: 'docker' | 'firecracker' | 'slots';
  /**
   * Idempotent readiness: image present and verified, daemon/KVM reachable. Never pulls the
   * image, but it is neither quick nor read-only: the Docker driver also creates and removes
   * probe containers and stages, runs and deletes a canary run.
   */
  ensureReady(signal?: AbortSignal): Promise<DriverReadiness>;
  /**
   * Explicit provisioning step: pull/prepare the image inside
   * image_pull_timeout_seconds with honest progress events. Never called
   * implicitly from ensureReady; concurrent calls coalesce on the one pull.
   */
  provision(input: {
    signal: AbortSignal | undefined;
    onProgress: (message: string) => void;
    timeoutSeconds: number;
  }): Promise<void>;
  /** One execution. The driver owns ALL isolation; the wrapper owns contract + bounds. */
  run(params: DriverRunParams): Promise<DriverRunResult>;
  /**
   * True only when no container or VM for this run exists any more. False when
   * one is still there or the answer could not be confirmed; the wrapper
   * touches a run tree's permissions only after a true.
   */
  isRunGone(runId: string): Promise<boolean>;
  /**
   * Reaper support: kill labeled containers/VMs older than the abandon
   * deadline. Called on the 5-minute cadence and at startup (crash recovery).
   */
  reapStale(): Promise<void>;
  /**
   * Release process-scoped resources. Drains in-flight runs up to a 30s
   * deadline, then kills whatever remains (process-group kill; containers/VMs
   * left to the reaper). Never blocks shutdown indefinitely and never orphans
   * a labeled container/VM without the reaper knowing its runId.
   */
  dispose(): Promise<void>;
}
