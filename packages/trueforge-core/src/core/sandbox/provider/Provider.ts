import { posix } from 'node:path';
import type { CodeModeTransport } from '../codeMode/CodeModeTransport';
import type { GitRemotePrecondition } from '../gitRemoteObservation';

/** Command executed in sandbox — exitCode may be non-zero but the infra call succeeded. */
export interface ExecSuccessResult {
  success: true;
  response: { exitCode: number; result: string };
}

/** Sandbox infrastructure failure — command never ran (e.g. network error, auth failure). */
export interface ExecErrorResult {
  success: false;
  error: string;
}

export type ExecResult = ExecSuccessResult | ExecErrorResult;

/**
 * Wraps a value in single quotes for safe use in a shell command. Inner single quotes are
 * escaped via the standard shell idiom: ' -> '\''. Use for any user-controlled value that is
 * interpolated into an exec command string.
 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Throws if the exec result indicates failure (infra error or non-zero exit code). */
export function ensureExecSuccess(result: ExecResult): void {
  if (!result.success) {
    throw new Error(result.error);
  }
  if (result.response.exitCode !== 0) {
    throw new Error(`(exit code ${String(result.response.exitCode)}): ${result.response.result}`);
  }
}

export interface SandboxFileInfo {
  size: number;
  isDir: boolean;
}

/** Parameters for a single sandbox command. */
export interface SandboxExecParams {
  sandboxId: string;
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /** Cancels the owning host operation and any provider I/O that supports cancellation. */
  signal?: AbortSignal | undefined;
  /** Overrides the provider's default exec timeout (e.g. for long skill downloads). */
  timeoutSeconds?: number | undefined;
  /** Shared Git-metadata boundary for workspace commands on a persisted sandbox. */
  workspaceLock?: WorkspaceExecutionLock | undefined;
  /** The repositories the user approved for this network git command; host-carried git offers its token to no other. */
  approvedGitRemotes?: GitRemotePrecondition | undefined;
  /**
   * Package mirror grant for this call, issued for the workspace repo the person allowed downloads
   * for. Providers that serve mirrors (sandbox slots) pass it to the agent; others ignore it and the
   * call stays offline.
   */
  packageMirrorToken?: string | undefined;
}

export interface WorkspaceExecutionLock {
  workspaceRoot: string;
  /** Identifies a cancellable abnormal-handoff evidence capture. */
  operationId?: string | undefined;
}

export interface WorkspaceTerminationParams {
  sandboxId: string;
  workspaceRoot: string;
  operationId: string;
  timeoutSeconds: number;
}

export interface VerifiedWorkspaceCommitParams {
  sandboxId: string;
  workspaceRoot: string;
  cwd: string | undefined;
  env: Record<string, string>;
  timeoutSeconds: number | undefined;
  command: string;
  receipt: WorkspaceVerificationReceipt;
}

export interface WorkspaceVerificationReceipt {
  branch: string;
  head: string;
  refsSha256: string;
  indexSha256: string;
  trackedWorktreeSha256: string;
  untrackedSha256: string;
}

export type VerifiedWorkspaceCommitResult =
  | { status: 'completed'; result: ExecResult }
  | { status: 'blocked'; reason: string }
  | { status: 'indeterminate'; result: ExecResult };

/**
 * The sandbox PATH leads with workspace directories the model can write to, so the wrapper's own helpers
 * (flock, sh, mkdir, git, ...) run on this fixed system PATH. The caller's PATH is restored only for the command.
 */
const WRAPPER_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const WRAPPER_PATH_SETUP = ['tf_user_path="$PATH"', `PATH=${shellEscape(WRAPPER_PATH)}`, 'export tf_user_path PATH'];

/** Host-authored commands run on the fixed system PATH, never the workspace-led sandbox PATH. */
export function withTrustedPath(command: string): string {
  return `PATH=${shellEscape(WRAPPER_PATH)}; export PATH; ${command}`;
}

const RESTORE_USER_PATH = 'PATH="$tf_user_path"; export PATH; ';

function gitPathCommand(workspaceRoot: string, path: string): string {
  return `git -C ${shellEscape(workspaceRoot)} rev-parse --path-format=absolute --git-path ${shellEscape(path)}`;
}

/**
 * Shell expression for a workspace coordination path (lock file,
 * evidence-control dir). Prefers `git rev-parse --git-path` so repository
 * checkouts keep coordination files out of the worktree; in non-git
 * workspaces the probe fails and the fallback is a `.trueforge` directory
 * under the workspace root. The fallback is resolved where the command runs:
 * absolute roots are embedded directly (`normalize` is lexical, no filesystem
 * access), while a relative root always equals the exec's cwd at every call
 * site, so it resolves against the shell's working directory — never the
 * host's.
 */
function workspaceCoordinationPathExpression(input: { workspaceRoot: string; name: string }): string {
  const fallback = posix.isAbsolute(input.workspaceRoot)
    ? shellEscape(`${posix.normalize(input.workspaceRoot)}/.trueforge/${input.name}`)
    : `"$(pwd)/.trueforge/${input.name}"`;
  return `$(${gitPathCommand(input.workspaceRoot, input.name)} 2>/dev/null || printf '%s' ${fallback})`;
}

function buildWorkspaceLockCommand(input: { workspaceRoot: string; command: string }): string {
  const lockPath = workspaceCoordinationPathExpression({
    workspaceRoot: input.workspaceRoot,
    name: 'trueforge-workspace.lock',
  });
  const controlPath = workspaceCoordinationPathExpression({
    workspaceRoot: input.workspaceRoot,
    name: 'trueforge-evidence-control',
  });
  const guardedCommand =
    'state_after="$(cat "$state_file" 2>/dev/null || true)"; ' +
    'case "$state_after" in \'\'|*:idle) ;; *) exit 125 ;; esac; ' +
    'if test "$state_before" != "$state_after" || test -e "$barrier"; then exit 125; fi; ' +
    RESTORE_USER_PATH +
    input.command;
  return [
    ...WRAPPER_PATH_SETUP,
    `lock_path="${lockPath}"`,
    `control_dir="${controlPath}"`,
    'barrier="$control_dir/trueforge-workspace-termination"',
    'state_file="$control_dir/trueforge-workspace-termination-state"',
    'mkdir -p "$control_dir" "$(dirname "$lock_path")"',
    'while :; do state_before="$(cat "$state_file" 2>/dev/null || true)"; case "$state_before" in *:terminating) sleep 0.05 ;; \'\'|*:idle) break ;; *) exit 125 ;; esac; done',
    'export barrier state_file state_before',
    `flock -x "$lock_path" sh -c ${shellEscape(guardedCommand)}`,
  ].join(' && ');
}

function buildTimedEvidenceCaptureCommand(input: {
  workspaceRoot: string;
  command: string;
  operationId: string;
}): string {
  const controlPath = workspaceCoordinationPathExpression({
    workspaceRoot: input.workspaceRoot,
    name: 'trueforge-evidence-control',
  });
  const lockPath = workspaceCoordinationPathExpression({
    workspaceRoot: input.workspaceRoot,
    name: 'trueforge-workspace.lock',
  });
  const markerName = `${input.operationId}.pid`;
  const cancellationName = `${input.operationId}.cancel`;
  const controlledCommand = [
    'state_after="$(cat "$state_file" 2>/dev/null || true)"',
    'case "$state_after" in \'\'|*:idle) ;; *) exit 125 ;; esac',
    'if test "$state_before" != "$state_after" || test -e "$barrier"; then exit 125; fi',
    `marker="$control_dir/${markerName}"`,
    `cancellation="$control_dir/${cancellationName}"`,
    'printf \'%s\' "$$" > "$marker"',
    // A termination may be delivered before this original request. This is a
    // durable, per-operation fence: every duplicate late delivery must see it.
    // It is retained until the sandbox workspace is retired, because deleting
    // it after one rejection would reopen the terminated operation id.
    'if test -e "$cancellation"; then rm -f "$marker"; exit 125; fi',
    // Keep the provider command in a child shell so it cannot replace the
    // marker-owning process-group leader's signal disposition with a trap.
    `sh -c ${shellEscape(RESTORE_USER_PATH + input.command)}`,
    'status=$?',
    'rm -f "$marker"',
    'exit "$status"',
  ].join('; ');
  return [
    ...WRAPPER_PATH_SETUP,
    `lock_path="${lockPath}"`,
    `control_dir="${controlPath}"`,
    'barrier="$control_dir/trueforge-workspace-termination"',
    'state_file="$control_dir/trueforge-workspace-termination-state"',
    'mkdir -p "$control_dir" "$(dirname "$lock_path")"',
    'while :; do state_before="$(cat "$state_file" 2>/dev/null || true)"; case "$state_before" in *:terminating) sleep 0.05 ;; \'\'|*:idle) break ;; *) exit 125 ;; esac; done',
    'export control_dir barrier state_file state_before',
    `flock -x "$lock_path" setsid sh -c ${shellEscape(controlledCommand)}`,
  ].join(' && ');
}

export function commandWithWorkspaceLock(params: SandboxExecParams): SandboxExecParams {
  const workspaceLock = params.workspaceLock;
  if (workspaceLock === undefined) {
    return params;
  }
  const command =
    workspaceLock.operationId === undefined
      ? buildWorkspaceLockCommand({ workspaceRoot: workspaceLock.workspaceRoot, command: params.command })
      : buildTimedEvidenceCaptureCommand({
          workspaceRoot: workspaceLock.workspaceRoot,
          command: params.command,
          operationId: workspaceLock.operationId,
        });
  return { ...params, command, workspaceLock: undefined };
}

export function workspaceTerminationCommand(input: { workspaceRoot: string; operationId: string }): string {
  const controlPath = workspaceCoordinationPathExpression({
    workspaceRoot: input.workspaceRoot,
    name: 'trueforge-evidence-control',
  });
  const lockPath = workspaceCoordinationPathExpression({
    workspaceRoot: input.workspaceRoot,
    name: 'trueforge-workspace.lock',
  });
  const markerName = `${input.operationId}.pid`;
  const cancellationName = `${input.operationId}.cancel`;
  const completionName = `${input.operationId}.terminated`;
  const terminatingState = `${input.operationId}:terminating`;
  const idleState = `${input.operationId}:idle`;
  const finalizeCommand = [
    'rm -f "$marker" "$barrier"',
    ': > "$completed"',
    'state_tmp="$control_dir/.trueforge-workspace-state.$$"',
    `printf '%s' ${shellEscape(idleState)} > "$state_tmp"`,
    'mv "$state_tmp" "$state_file"',
  ].join(' && ');
  const controlledCommand = [
    'state_now="$(cat "$state_file" 2>/dev/null || true)"',
    `if test -e "$completed"; then if test "$state_now" = ${shellEscape(terminatingState)}; then flock -x "$lock_path" sh -c ${shellEscape(finalizeCommand)} || exit $?; fi; exit 0; fi`,
    // Fence the target operation and queued workspace commands before sending
    // the signal. The persistent state lets later commands wait, while the
    // barrier fails closed if this process crashes between these steps.
    ': > "$cancellation"',
    ': > "$barrier"',
    'state_tmp="$control_dir/.trueforge-workspace-state.$$"',
    `printf '%s' ${shellEscape(terminatingState)} > "$state_tmp"`,
    'mv "$state_tmp" "$state_file"',
    'if test -r "$marker"; then pid=$(cat "$marker"); case "$pid" in *[!0-9]*|\'\') exit 1 ;; esac; kill -TERM "-$pid" 2>/dev/null || true; fi',
    `flock -x "$lock_path" sh -c ${shellEscape(finalizeCommand)}`,
  ].join(' && ');
  return [
    ...WRAPPER_PATH_SETUP,
    `control_dir="${controlPath}"`,
    `lock_path="${lockPath}"`,
    'mkdir -p "$control_dir" "$(dirname "$lock_path")"',
    `cancellation="$control_dir/${cancellationName}"`,
    `completed="$control_dir/${completionName}"`,
    `marker="$control_dir/${markerName}"`,
    'barrier="$control_dir/trueforge-workspace-termination"',
    'state_file="$control_dir/trueforge-workspace-termination-state"',
    'termination_lock="$control_dir/trueforge-workspace-termination.lock"',
    'export control_dir lock_path cancellation completed marker barrier state_file',
    // Serialize provider replicas. The persistent state distinguishes commands
    // admitted before this termination from commands arriving after it, while
    // making a completed delivery for the same operation idempotent.
    `flock -x "$termination_lock" sh -c ${shellEscape(controlledCommand)}`,
  ].join(' && ');
}

const VERIFIED_WORKSPACE_COMMIT_SCRIPT = String.raw`
import hashlib, json, os, re, shutil, subprocess, sys

request = json.loads(sys.argv[1])
# Resolved once on the trusted PATH this script starts with; the command alone gets the caller's PATH back.
GIT = shutil.which("git")
COMMAND_ENV = {key: value for key, value in os.environ.items() if key != "tf_command_path"}
COMMAND_ENV["PATH"] = os.environ.get("tf_command_path", "")

def git(*args):
    if GIT is None:
        raise RuntimeError("git is not installed")
    return subprocess.run([GIT, *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

def digest(value):
    return hashlib.sha256(value).hexdigest()

def state():
    root = os.fsdecode(git("rev-parse", "--show-toplevel")).strip()
    if os.path.normpath(root) != os.path.normpath(request["workspace_root"]):
        return None
    branch = os.fsdecode(git("rev-parse", "--abbrev-ref", "HEAD")).strip()
    head = os.fsdecode(git("rev-parse", "HEAD")).strip()
    refs = git("for-each-ref", "--include-root-refs", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)%00")
    tagged = os.fsdecode(git("ls-files", "-v", "-z"))
    if any(re.match(r"^[a-zS] ", entry) for entry in tagged.split("\0")):
        return None
    index_diff = git("diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--")
    worktree_diff = git("diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "--")
    paths = sorted(path for path in os.fsdecode(git("ls-files", "--others", "--exclude-standard", "-z")).split("\0") if path)
    untracked = []
    for path in paths:
        object_sha = os.fsdecode(git("hash-object", "--no-filters", "--", path)).strip()
        untracked.append({"path": path, "objectSha": object_sha})
    return {
        "branch": branch,
        "head": head,
        "refsSha256": digest(refs),
        "indexSha256": digest(index_diff),
        "trackedWorktreeSha256": digest(worktree_diff),
        "untrackedSha256": digest(json.dumps(untracked, ensure_ascii=False, separators=(",", ":")).encode()),
    }

try:
    actual = state()
except Exception:
    actual = None

expected = request["receipt"]
if actual is None or any(actual[key] != expected[key] for key in expected):
    print(json.dumps({"status": "blocked", "reason": "The workspace changed after its last successful verification. Re-run verification before committing."}))
else:
    completed = subprocess.run(request["command"], shell=True, env=COMMAND_ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(json.dumps({"status": "completed", "exit_code": completed.returncode, "result": completed.stdout.decode(errors="replace")}))
`;

/**
 * A single provider command for the verification-to-commit critical section.
 * The caller applies the normal workspace lock, so every Git read and the
 * commit dispatch share the same remote `flock` lease. Python and git run on
 * the trusted PATH; only the commit command sees the caller's PATH.
 */
export function verifiedWorkspaceCommitCommand(input: {
  command: string;
  workspaceRoot: string;
  receipt: WorkspaceVerificationReceipt;
}): string {
  const check = `python3 -I -S -c ${shellEscape(VERIFIED_WORKSPACE_COMMIT_SCRIPT)} ${shellEscape(
    JSON.stringify({ command: input.command, workspace_root: input.workspaceRoot, receipt: input.receipt }),
  )}`;
  return `tf_command_path="$PATH"; export tf_command_path; ${withTrustedPath(check)}`;
}

function isVerifiedWorkspaceCommitPayload(
  value: unknown,
): value is { status: 'blocked'; reason: string } | { status: 'completed'; exit_code: number; result: string } {
  if (typeof value !== 'object' || value === null || !('status' in value)) {
    return false;
  }
  if (value.status === 'blocked') {
    return 'reason' in value && typeof value.reason === 'string';
  }
  return (
    value.status === 'completed' &&
    'exit_code' in value &&
    typeof value.exit_code === 'number' &&
    'result' in value &&
    typeof value.result === 'string'
  );
}

/** Shared provider implementation for an atomic receipt check and commit dispatch. */
type InternalSandboxExecParams = Omit<SandboxExecParams, 'signal'> & {
  signal: AbortSignal | undefined;
};

export async function executeVerifiedWorkspaceCommit(input: {
  execute: (params: InternalSandboxExecParams) => Promise<ExecResult>;
  params: VerifiedWorkspaceCommitParams;
}): Promise<VerifiedWorkspaceCommitResult> {
  const result = await input.execute({
    sandboxId: input.params.sandboxId,
    command: verifiedWorkspaceCommitCommand({
      command: input.params.command,
      workspaceRoot: input.params.workspaceRoot,
      receipt: input.params.receipt,
    }),
    cwd: input.params.cwd,
    env: input.params.env,
    signal: undefined,
    ...(input.params.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.params.timeoutSeconds }),
    workspaceLock: { workspaceRoot: input.params.workspaceRoot },
  });
  if (!result.success || result.response.exitCode !== 0) {
    return { status: 'indeterminate', result };
  }
  try {
    const payload: unknown = JSON.parse(result.response.result);
    if (!isVerifiedWorkspaceCommitPayload(payload)) {
      return { status: 'indeterminate', result };
    }
    if (payload.status === 'blocked') {
      return { status: 'blocked', reason: payload.reason };
    }
    return {
      status: 'completed',
      result: { success: true, response: { exitCode: payload.exit_code, result: payload.result } },
    };
  } catch {
    return { status: 'indeterminate', result };
  }
}

export interface SandboxCreateParams {
  signal?: AbortSignal | undefined;
}

export interface SandboxDownloadFileParams {
  sandboxId: string;
  path: string;
  signal?: AbortSignal | undefined;
}

export interface SandboxUploadFileParams {
  sandboxId: string;
  remotePath: string;
  content: Buffer;
  signal?: AbortSignal | undefined;
}

/** File uploaded before a sandbox init command runs. */
export interface SandboxInitUpload {
  remotePath: string;
  content: Buffer;
}

/**
 * Init step from a producer (e.g. skill mounter).
 * Sandbox supplies `sandboxId` when it runs the command.
 */
export interface SandboxInit {
  command: string;
  env?: Record<string, string> | undefined;
  /** Exec timeout for this init command (seconds). Skill downloads use a long value. */
  timeoutSeconds: number;
  /** Files to upload before the init command runs (e.g. requested skills JSON). */
  uploads: readonly SandboxInitUpload[];
}

export type SandboxBuildStatus = 'pending' | 'ready' | 'failed';

/** Provider-specific opaque build metadata (string map). */
export type SandboxBuildMetadata = Record<string, string>;

export interface SandboxBuild {
  status: SandboxBuildStatus;
  /** Human-readable detail for the current status (shown to the user); null when ready. */
  reason: string | null;
  /** Provider-specific build details; null when the provider has none. */
  metadata: SandboxBuildMetadata | null;
}

/** What a network `git push` from the sandbox would send, as worked out by the host before approval. */
export interface HostGitPushPreview {
  /** `owner/repo`. */
  repository: string;
  remote_name: string;
  remote_url: string;
  source_branch: string;
  branch: string;
  tip: string;
  base: string | undefined;
  commit_count: number;
  commits: { sha: string; subject: string }[];
  dry_run: boolean;
  set_upstream: boolean;
}

export type HostGitPushPreviewResult =
  { status: 'ok'; preview: HostGitPushPreview } | { status: 'refused'; message: string };

/**
 * Network git carried out by the host for a sandbox that has no network: the sandbox never receives a token
 * and never contacts GitHub.
 */
export interface HostGitCapability {
  /** The host's GitHub token for this turn, or null when no connector provides one. */
  setToken(token: string | null): void;
  /** True when `command` is one plain `git push` this capability would carry out. */
  isPush(command: string): boolean;
  previewPush(input: {
    sandboxId: string;
    command: string;
    cwd: string | undefined;
    signal: AbortSignal | undefined;
  }): Promise<HostGitPushPreviewResult>;
}

export interface SandboxProvider {
  /** Stable provider kind used in fancy sandbox ids and carry-forward (plain string). */
  readonly type: string;
  /**
   * False when the provider offers no Code Mode bridge: the agent then keeps its connector tools as
   * ordinary tools and `createCodeModeTransport` is never called. Absent means supported.
   */
  readonly supportsCodeMode?: boolean | undefined;
  /**
   * Whose filesystem the sandbox's paths live on. `remote` means the server cannot see them, so Sentinel
   * checks workspace containment on normalized path text and never reads or resolves them on the server.
   * Absent means the server's own filesystem.
   */
  readonly filesystem?: 'host' | 'remote' | undefined;
  /**
   * `none` means nothing run in the sandbox can reach a network, by design. The agent is then told so
   * and network commands are refused before any approval. Absent means the sandbox may have network.
   */
  readonly network?: 'none' | undefined;
  /** Present when network git is done by the host; the Sandbox then never puts a token in the sandbox. */
  readonly hostGit?: HostGitCapability | undefined;
  /**
   * Ensures the release image is being built into the provider's backing store and
   * returns its current status. Idempotent: an already-built image reports `ready`;
   * a fresh build starts in the background and reports `pending`.
   */
  buildImage(): Promise<SandboxBuild>;
  /** Current build status of the release image. Read-only: never kicks off a build. */
  getImageBuildStatus(): Promise<SandboxBuild>;
  createSandbox(params?: SandboxCreateParams): Promise<{ sandboxId: string }>;
  exec(params: SandboxExecParams): Promise<ExecResult>;
  /** Atomically checks a durable verification receipt and dispatches the commit under one provider lease. */
  executeVerifiedWorkspaceCommit(params: VerifiedWorkspaceCommitParams): Promise<VerifiedWorkspaceCommitResult>;
  /** Returns only after a timed evidence capture is fenced, terminated, and its shared lock is released. */
  acknowledgeWorkspaceTermination(params: WorkspaceTerminationParams): Promise<void>;
  /** Provider-specific instructions appended to the agent system prompt. */
  getAdditionalInstructions(): string | undefined;
  /** Provider-owned writable root for unbound repository work, or undefined when no global root exists. */
  getWorkspaceDir(): string | undefined;
  /** Directory inside the sandbox where large tool responses are dumped. */
  getToolResultDumpDir(sandboxId: string): string;
  /**
   * Legacy credential-store location (absolute, or cwd-relative when exec cwd is the jail).
   * Nothing writes it any more; the sandbox deletes it on init so sandboxes persisted by
   * earlier releases do not keep a token.
   */
  getGitCredentialsPath(sandboxId: string): string;
  /** Directory for user-uploaded files (absolute, or cwd-relative when the provider has no global FS). */
  getFileUploadsDir(sandboxId: string): string;
  /** Directory for the private copies made while a document is read, when it must differ from the uploads directory (a provider whose ordinary reads are size-limited). */
  getDocumentSnapshotDir?(sandboxId: string): string;
  /** Directory where skill mounts are materialized. */
  getSkillsDir(sandboxId: string): string;
  /** Path the skill downloader script is written to before it runs. */
  getSkillDownloaderPath(sandboxId: string): string;
  /** Downloads a file from the sandbox as a Buffer. Throws SandboxFileNotFoundError / SandboxNotAvailableError / SandboxPathIsDirectoryError / SandboxFileTooLargeError. */
  downloadFile(params: SandboxDownloadFileParams): Promise<Buffer>;
  /** Uploads a file to the sandbox. */
  uploadFile(params: SandboxUploadFileParams): Promise<void>;
  /** Removes a sandbox's stored workspace when its chat is deleted. Absent when the provider keeps nothing per chat. */
  destroySandbox?(params: { sandboxId: string }): Promise<void>;

  /**
   * Construct a Code Mode transport for this provider (no connect/listen yet).
   * Throws if the provider does not support Code Mode.
   */
  createCodeModeTransport(): CodeModeTransport;
}
