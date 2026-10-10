import { context, propagation } from '@opentelemetry/api';
import dedent from 'dedent';
import type { Logger } from 'winston';
import { z } from 'zod';
import {
  MAX_BYTES_PER_DOCUMENT,
  MAX_CHARS_PER_DOCUMENT,
  MAX_PAGES_PER_DOCUMENT,
} from '../../documents/documentExtraction';
import {
  ImplementationPlanAdmissionBlockedError,
  StructuredEditPreconditionBlockedError,
  ToolPreDispatchError,
} from '../errors';
import type { ApprovalDecision } from '../events/schema';
import { InstructionBuilder } from '../InstructionBuilder';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import { estimateTokensForString } from '../llm/usage';
import type { MappedMCPTool } from '../mcp/convertMCPServers';
import {
  toolResultResponse,
  type CallToolResponse,
  type IToolSet,
  type ToolInvocationContext,
} from '../mcp/IMCPServer';
import {
  implementationPlanAllowsScope,
  implementationPlanCheckoutId,
  ImplementationPlanGrantScopeSchema,
  ImplementationPlanSchema,
  mintImplementationPlanGrant,
  validateImplementationPlanGrant,
  type ImplementationPlan,
  type ImplementationPlanGrant,
  type ImplementationPlanGrantOwner,
  type ImplementationPlanGrantScope,
} from '../mcp/implementationPlanGrant';
import { defineTool, LocalToolMCP } from '../mcp/LocalToolMCP';
import { stampSentinelDecision } from '../mcp/ToolSet';
import {
  canonicalFileIdentity,
  canonicalWriteTarget,
  classifyContextFor,
  classifyHostToolCall,
  observeShellCreatedFiles,
  type SentinelHostContext,
} from '../permissions';
import { toJsonSafeParams } from '../permissions/approvalTokens';
import type { AbnormalHandoffEvidence } from '../runtime/AbnormalHandoff';
import {
  DEFERRED_TOOLS_SERVER_ID,
  GET_TOOL_INFO_NAME,
  GET_TOOL_OUTPUT_SCHEMA_NAME,
  LIST_TOOLS_NAME,
} from '../runtime/DeferredTool';
import type { AgentTracing } from '../tracing/AgentTracing';
import { awaitWithAbort, throwIfSignalAborted } from '../util/abort';
import { extractErrorLogFields } from '../util/errorLogFields';
import { PromiseTimeoutError, withTimeout } from '../util/promiseUtils';
import { CodeModeDispatcher } from './codeMode/CodeModeDispatcher';
import { type CodeModeClientInstall, type CodeModeTransport } from './codeMode/CodeModeTransport';
import {
  SANDBOX_INVOCATION_PURPOSES,
  sandboxCommandHasGitSubcommand,
  sandboxCommandHasNetworkIntent,
  sandboxCommandRequiresApproval,
  sandboxCommandUsesEvaluatorWrapper,
  sandboxCommandUsesUnstructuredOperation,
  sandboxCommandWebEgressRejection,
  sandboxInvocationPolicy,
  sandboxVerifyCommandUsesInlineEval,
  sandboxVerifyCommandUsesUnsafeSyntax,
  type SandboxCommandEffect,
  type SandboxInvocationPurpose,
} from './commandClassification';
import { classifyExecCommand, interpreterInvocationRefusal, type ExecGuardHost } from './driver/ExecGuard';
import { buildProvisioningEvent } from './driver/provisionEvents';
import { RunCodeInputSchema, type RunCodeInput, type RunCodeResult } from './driver/RunCodeSchemas';
import { type HarvestedFile, type RunCodeBackend, type TurnAttachment } from './driver/RunCodeService';
import { buildExecResultShape } from './execResultSemantics';
import { getGithubConnectorHint, type GithubConnectorState } from './githubConnectorHint';
import { ensureExecSuccess, shellEscape, type ExecResult, type SandboxProvider } from './provider/Provider';
import { SandboxNotAvailableError, validateNoPathTraversal } from './SandboxErrors';
import { formatSandboxId, rawSandboxId } from './sandboxRef';
// Import submodules, not the ./skills barrel, to avoid a cycle (the mounters import from Sandbox).
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { dirname, join, delimiter as pathDelimiter, posix, relative } from 'node:path';
import { convertOpenAIPatchToGitDiff, detectApplyPatchFormat } from './openaiPatchFormat';
import { matchReplaceText } from './replaceTextDiagnostics';
import type { ISkillMounter } from './skills/ISkillMounter';
import { detectSkillUsedEvents } from './skills/skillEvents';
import {
  extractStructuredEditPaths,
  repositoryRelativeStructuredEditPath,
  repositoryRootsMatch,
  structuredEditCwdRelativePath,
} from './structuredEditPaths';
import {
  buildStructuredEditObservationCommand,
  parseStructuredEditObservation,
  structuredEditObservationMatches,
  type StructuredEditPrecondition,
} from './structuredEditPrecondition';
import { structuredEditReceivedSnippet, structuredEditRejection } from './structuredEditRejection';
import {
  normalizeStructuredEditArguments,
  resolveLineArrayField,
  type StructuredEditToolName,
} from './toolArgumentNormalization';

export { sandboxCommandEffect, sandboxCommandRequiresApproval } from './commandClassification';
export type { SandboxCommandEffect, SandboxInvocationPurpose } from './commandClassification';

/** Layout derived from install remotePath (always `…/mcp_client.py`). */
function mcpClientLayout(remotePath: string): { pythonPath: string; binDir: string; binLink: string } {
  const pythonPath = dirname(remotePath);
  const binDir = join(pythonPath, 'bin');
  return { pythonPath, binDir, binLink: join(binDir, 'mcp-client') };
}

export interface SandboxInfo {
  sandbox_id: string;
}

// Downloader/setup scripts can run longer than a normal exec.
export const SKILL_DOWNLOAD_TIMEOUT_SECONDS = 180;

function validateDocumentPageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGES_PER_DOCUMENT) {
    throw new Error(`Document page limit must be an integer between 1 and ${String(MAX_PAGES_PER_DOCUMENT)}`);
  }
  return value;
}

// Keeps the sandbox-side NATS wait longer than the host's own MCP deadline, so the host
// surfaces the real MCP error instead of the bridge client giving up first.
const NATS_REQUEST_TIMEOUT_BUFFER_SECONDS = 30;

// Write a script (base64-encoded, never interpolated raw) to a path and run it. Skill mounters reuse it.
export function buildWriteAndRunScriptCommand(params: { scriptPath: string; scriptContent: string }): string {
  const b64 = Buffer.from(params.scriptContent, 'utf-8').toString('base64');
  const scriptPath = shellEscape(params.scriptPath);
  return [
    `mkdir -p "$(dirname ${scriptPath})"`,
    `rm -f ${scriptPath}`,
    `echo ${shellEscape(b64)} | base64 -d > ${scriptPath}`,
    `chmod a-w ${scriptPath}`,
    `python3 ${scriptPath}`,
  ].join(' && ');
}

/** Write or clear the git credential-store file at an absolute path (no global git config mutation). */
function buildSyncGitCredentialsCommand(credentialsContent: string | null, credentialsPath: string): string {
  const path = shellEscape(credentialsPath);
  if (credentialsContent === null) {
    return `rm -f ${path}`;
  }
  // Base64 avoids interpolating credentials directly into the shell command.
  const b64 = Buffer.from(credentialsContent, 'utf-8').toString('base64');
  return `mkdir -p "$(dirname ${path})" && ` + `echo '${b64}' | base64 -d > ${path} && ` + `chmod 600 ${path}`;
}

/**
 * Process-scoped credential.helper via GIT_CONFIG_* (avoids shared ~/.gitconfig).
 * Path is whatever the provider returns; providers with a shared FS (TFY) make
 * `store --file` absolute in their own `exec`.
 */
function buildGitCredentialHelperEnv(credentialsPath: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: `store --file ${credentialsPath}`,
  };
}

export interface SandboxStoredFile {
  filePath: string;
  sandboxCreated?: SandboxInfo | undefined;
}

/** Upload failure that still carries a sandbox created by the failed operation. */
export class SandboxFileUploadError extends Error {
  constructor(
    message: string,
    readonly sandboxCreated: SandboxInfo,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SandboxFileUploadError';
  }
}

export interface SandboxDocumentSnapshot {
  filePath: string;
  content: Buffer;
  verify: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export interface RepositoryCommandSourceObservation {
  sources: readonly RepositoryCommandSource[];
  signal: AbortSignal | undefined;
}

export type RepositoryCommandSourceObserver = (input: RepositoryCommandSourceObservation) => Promise<void>;

export interface SandboxOptions {
  provider: SandboxProvider;
  existingSandboxId?: string | undefined;
  /** Host-resolved repository binding for this session. Never model-authored. */
  boundRepository?: BoundRepository | undefined;
  /** Re-reads the owner-scoped repository record for final plan admission. */
  loadBoundRepository?: (() => Promise<BoundRepository | undefined>) | undefined;
  /** Receives bounded repository command-source files after the checkout is verified. */
  onRepositorySources?: RepositoryCommandSourceObserver | undefined;
  /** Durable cross-replica coordinator for semantic verification and workspace mutations. */
  workspaceVerificationCoordinator?: WorkspaceVerificationCoordinator | undefined;
  /** Replica/process identity recorded on durable workspace leases. */
  workspaceLeaseOwnerId?: string | undefined;
  skillMounter?: ISkillMounter | undefined;
  fileDownloadEnabled?: boolean | undefined;
  /** Pre-resolved credential-store file content (null = clear / no git auth). */
  resolvedGitCredentialsContent?: string | null | undefined;
  /** Whether the session's agent spec has a GitHub MCP connector configured, regardless of whether its credentials resolved. */
  githubConnectorAttached?: boolean | undefined;
  /** Whether the session's agent spec has a web-search/fetch MCP connector configured. */
  webConnectorAttached?: boolean | undefined;
  /** One-sentence name of the web connector's fetch/extract tool, used in the exec egress rejection. */
  webConnectorToolHint?: string | undefined;
  /**
   * Blocks destructive tools in code mode so they go through the approval flow
   * instead. Must be `true` — approvals are always enabled (the kill switch is gone).
   */
  blockDestructiveToolsInCodeMode: true;
  /** Used to derive the Code Mode NATS wait as request + connect. */
  mcpRequestTimeoutMs: number;
  mcpConnectTimeoutMs: number;
  /** Space-separated Tesseract language codes for OCR. Empty string means Tesseract default (English). */
  ocrLanguages?: string | undefined;
  /**
   * The code-execution backend behind the `run_code` tool. Undefined when the
   * deployment has no isolation driver configured — the tool then refuses with
   * a model-actionable message instead of failing open.
   */
  runCodeService?: RunCodeBackend | undefined;
  /**
   * host sink for harvested run_code file bytes (per-turn download
   * persistence, plan §2.1). Invoked by the service after harvest, before
   * run-root cleanup; bytes never enter the model-visible result.
   */
  onRunCodeHarvestedFiles?: ((files: HarvestedFile[]) => Promise<void>) | undefined;
  tracing: AgentTracing;
  logger: Logger;
  /**
   * Sentinel classification context: shared services plus the per-turn
   * identity. When present, toolCallInfo classifies every call and the
   * classifier result replaces the effect-based approval override. Absent,
   * no classification runs and the legacy effect-based approval behavior
   * is preserved.
   */
  sentinel?: SentinelHostContext | undefined;
}

export const SANDBOX_EXEC_TOOL_NAME = 'exec';
export const SANDBOX_RUN_CODE_TOOL_NAME = 'run_code';
export const SANDBOX_APPLY_PATCH_TOOL_NAME = 'apply_patch';
export const SANDBOX_REPLACE_TEXT_TOOL_NAME = 'replace_text';
export const SANDBOX_WRITE_FILE_TOOL_NAME = 'write_file';
export const SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME = 'run_registered_command';
export const SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME = 'submit_implementation_plan';

/**
 * Appended to an `apply_patch` `git apply --check` failure. `check` alone is git's own error
 * text (e.g. "error: <path>: No such file or directory", "error: patch failed"), which does not
 * tell a retrying model what shape it must send. This states the two facts the raw error leaves
 * out: the exact dialect required, and that the target path must already exist.
 */
export const APPLY_PATCH_CHECK_FAILURE_HINT =
  'apply_patch requires a plain Git-format unified diff (file headers "--- a/<path>" / "+++ b/<path>", hunks marked "@@ ... @@") applied against a path that already exists in the repository at that exact relative location. To create a new file, use write_file instead of apply_patch.';

/** The `StructuredEditToolName` a sandbox tool name names, or `undefined` for every other tool. */
function structuredEditToolNameFor(toolName: string): StructuredEditToolName | undefined {
  if (toolName === SANDBOX_APPLY_PATCH_TOOL_NAME) {
    return 'apply_patch';
  }
  if (toolName === SANDBOX_REPLACE_TEXT_TOOL_NAME) {
    return 'replace_text';
  }
  if (toolName === SANDBOX_WRITE_FILE_TOOL_NAME) {
    return 'write_file';
  }
  return undefined;
}
const BOUND_REPOSITORY_STATE_COMMAND =
  'git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD';
const GIT_REFS_COMMAND =
  "git for-each-ref --include-root-refs --sort=refname --format='%(refname)%00%(objectname)%00%(symref)%00'";

export type RegisteredRepositoryCommandPurpose = 'build' | 'test' | 'verify';

export interface RegisteredRepositoryCommand {
  command_id: string;
  purpose: RegisteredRepositoryCommandPurpose;
  command: string;
  timeout_ms: number;
}

export interface BoundRepository {
  repository_id: string;
  revision: number;
  workspace_cwd: string;
  commands: readonly RegisteredRepositoryCommand[];
}

export interface WorkspaceVerificationLeaseInput {
  repository_id: string;
  workspace_cwd: string;
  owner_id: string;
  lease_id: string;
  lease_expires_at: Date;
}

export interface WorkspaceVerificationCoordinator {
  acquireLease(input: WorkspaceVerificationLeaseInput): Promise<{ mutation_epoch: number } | undefined>;
  renewLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id' | 'lease_expires_at'>,
  ): Promise<boolean>;
  releaseLease(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'>,
  ): Promise<void>;
  beginStateObservation(
    input: Pick<WorkspaceVerificationLeaseInput, 'repository_id' | 'workspace_cwd' | 'lease_id'> & {
      invalidate_receipt: boolean;
    },
  ): Promise<boolean>;
  observeState(input: {
    repository_id: string;
    workspace_cwd: string;
    lease_id: string;
    before_state_sha256: string;
    after_state_sha256: string | null;
  }): Promise<number | undefined>;
  activateReceipt(input: {
    repository_id: string;
    workspace_cwd: string;
    lease_id: string;
    mutation_epoch: number;
    state_sha256: string;
    command: string;
    created_at: Date;
    result_event_id: string;
    result_thread_id: string;
    result_tool_call_id: string;
  }): Promise<boolean>;
  consumeReceipt(input: {
    repository_id: string;
    workspace_cwd: string;
    lease_id: string;
    mutation_epoch: number;
    state_sha256: string;
  }): Promise<boolean>;
}

const WORKSPACE_LEASE_RENEWAL_INTERVAL_MS = 10_000;
const WORKSPACE_LEASE_RENEWAL_TTL_MS = 90_000;

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringToolArgument(argumentsValue: unknown, name: string): string | undefined {
  if (!isUnknownRecord(argumentsValue)) {
    return undefined;
  }
  const value = argumentsValue[name];
  return typeof value === 'string' ? value : undefined;
}

function sandboxImplementationPlanScope(input: {
  toolName: string;
  argumentsValue: unknown;
  binding: BoundRepository | undefined;
}): ImplementationPlanGrantScope | undefined {
  const binding = input.binding;
  if (binding === undefined) {
    return undefined;
  }
  let candidate: ImplementationPlanGrantScope | undefined;
  if (input.toolName === SANDBOX_REPLACE_TEXT_TOOL_NAME || input.toolName === SANDBOX_WRITE_FILE_TOOL_NAME) {
    const cwd = stringToolArgument(input.argumentsValue, 'cwd') ?? binding.workspace_cwd;
    const path = stringToolArgument(input.argumentsValue, 'path');
    const resolution =
      path === undefined
        ? undefined
        : extractStructuredEditPaths({
            kind: input.toolName === SANDBOX_REPLACE_TEXT_TOOL_NAME ? 'replace_text' : 'write_file',
            repositoryRoot: binding.workspace_cwd,
            cwd,
            path,
          });
    if (resolution?.status === 'valid') {
      candidate = { kind: 'paths', paths: resolution.paths };
    }
  } else if (input.toolName === SANDBOX_APPLY_PATCH_TOOL_NAME) {
    const cwd = stringToolArgument(input.argumentsValue, 'cwd') ?? binding.workspace_cwd;
    const patch = stringToolArgument(input.argumentsValue, 'patch');
    const resolution =
      patch === undefined
        ? undefined
        : extractStructuredEditPaths({
            kind: 'apply_patch',
            repositoryRoot: binding.workspace_cwd,
            cwd,
            patch,
          });
    if (resolution?.status === 'valid') {
      candidate = { kind: 'paths', paths: resolution.paths };
    }
  } else if (input.toolName === SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME) {
    const commandId = stringToolArgument(input.argumentsValue, 'command_id');
    if (commandId !== undefined && binding.commands.some(command => command.command_id === commandId)) {
      candidate = { kind: 'command', command_id: commandId };
    }
  }
  const parsed = ImplementationPlanGrantScopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export type RepositoryCommandSourceKind = 'agents_md' | 'package_json';

export interface RepositoryCommandSource {
  source_kind: RepositoryCommandSourceKind;
  source_path: string;
  source_fingerprint: string;
  content: string;
}

interface BoundRepositoryState {
  branch: string;
  head_sha: string;
  checkout_id: string;
}

interface ActualBoundRepositoryState extends BoundRepositoryState {
  binding: BoundRepository;
}

interface ImplementationPlanGrantContext extends ImplementationPlanGrantOwner {
  turn_id: string;
  persistGrant: (grant: ImplementationPlanGrant) => Promise<void>;
  loadGrant: (grantId: string) => Promise<ImplementationPlanGrant | undefined>;
  beginDispatch: (input: {
    grant_id: string;
    checkout_id: string;
    dispatch_id: string;
  }) => Promise<{ status: 'admitted' } | { status: 'blocked' }>;
  completeDispatch: (input: { grant_id: string; dispatch_id: string }) => Promise<void>;
}

interface ImplementationPlanDispatchReservation {
  grant_id: string;
  dispatch_id: string;
}

export interface BoundRepositoryContext {
  repository_id: string;
  repository_revision: number;
  workspace_cwd: string;
  branch: string | null;
  head_sha: string | null;
}

export function boundRepositoryContextFromBinding(binding: BoundRepository): BoundRepositoryContext {
  return {
    repository_id: binding.repository_id,
    repository_revision: binding.revision,
    workspace_cwd: binding.workspace_cwd,
    branch: null,
    head_sha: null,
  };
}
const MAX_REPOSITORY_COMMAND_SOURCE_BYTES = 256 * 1024;
const MAX_ABNORMAL_HANDOFF_FILES = 100;
const MAX_ABNORMAL_HANDOFF_INLINE_CHARS = 12_000;
const MAX_ABNORMAL_HANDOFF_CAPTURE_RESPONSE_CHARS = 50_000;
const ABNORMAL_HANDOFF_LOCK_WAIT_TIMEOUT_MS = 2_000;
const ABNORMAL_HANDOFF_PROVIDER_TIMEOUT_MS = 2_000;
const ABNORMAL_HANDOFF_PROVIDER_TIMEOUT_SECONDS = 2;
const ABNORMAL_HANDOFF_GIT_ENVIRONMENT: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};
const ABNORMAL_HANDOFF_GIT_GLOBAL_ARGUMENTS: string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.preloadIndex=false',
  '-c',
  'color.ui=false',
];
const ABNORMAL_HANDOFF_GIT_STATUS_ARGUMENTS: string[] = ['status', '--short', '--untracked-files=all'];
const ABNORMAL_HANDOFF_GIT_DIFF_ARGUMENTS: string[] = [
  'diff',
  '--stat',
  '--no-ext-diff',
  '--no-textconv',
  'HEAD',
  '--',
];
const ABNORMAL_HANDOFF_GIT_ENVIRONMENT_KEYS_TO_REMOVE: string[] = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIFF_OPTS',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
];

const AbnormalHandoffCaptureSchema = z
  .object({
    workspace_root: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(4_096),
    head_sha: z.string().min(1).max(128),
    status: z.array(z.string().max(MAX_ABNORMAL_HANDOFF_INLINE_CHARS)).max(MAX_ABNORMAL_HANDOFF_FILES),
    status_count: z.number().int().nonnegative(),
    status_truncated: z.boolean(),
    diffstat: z.array(z.string().max(MAX_ABNORMAL_HANDOFF_INLINE_CHARS)).max(MAX_ABNORMAL_HANDOFF_FILES),
    diffstat_count: z.number().int().nonnegative(),
    diffstat_truncated: z.boolean(),
    artifact_written: z.boolean(),
  })
  .superRefine((capture, context) => {
    const statusTruncated = capture.status_count > capture.status.length;
    const diffstatTruncated = capture.diffstat_count > capture.diffstat.length;
    if (
      capture.status_count < capture.status.length ||
      capture.status_truncated !== statusTruncated ||
      capture.diffstat_count < capture.diffstat.length ||
      capture.diffstat_truncated !== diffstatTruncated ||
      (capture.artifact_written && !statusTruncated && !diffstatTruncated)
    ) {
      context.addIssue({ code: 'custom', message: 'Inconsistent bounded Git evidence metadata' });
    }
  });

const ABNORMAL_HANDOFF_CAPTURE_SCRIPT = dedent`
  import json
  import os
  import shutil
  import subprocess
  import sys

  expected_root = os.path.realpath(os.path.abspath(sys.argv[2]))
  artifact_candidate = os.path.realpath(os.path.abspath(sys.argv[1]))
  try:
      artifact_is_inside_workspace = os.path.commonpath([expected_root, artifact_candidate]) == expected_root
  except ValueError:
      artifact_is_inside_workspace = True
  # A provider may expose its tool-results directory relative to the sandbox
  # cwd. Never create the overflow artifact, or its temporary index, inside the
  # bound repository: those writes would contaminate the evidence being read.
  artifact_path = None if artifact_is_inside_workspace else artifact_candidate
  max_rows = int(sys.argv[3])
  max_chars = int(sys.argv[4])
  artifact_file = None
  artifact_healthy = False
  temporary_index_path = None
  git_environment = os.environ.copy()
  for key in ${JSON.stringify(ABNORMAL_HANDOFF_GIT_ENVIRONMENT_KEYS_TO_REMOVE)}:
      git_environment.pop(key, None)
  for key in list(git_environment):
      if key.startswith("GIT_CONFIG_KEY_") or key.startswith("GIT_CONFIG_VALUE_") or key.startswith("GIT_TRACE"):
          git_environment.pop(key, None)
  git_environment.pop("GIT_CONFIG_COUNT", None)
  git_environment.update(${JSON.stringify(ABNORMAL_HANDOFF_GIT_ENVIRONMENT)})
  git_environment.update({
      "GIT_ATTR_NOSYSTEM": "1",
      "GIT_CONFIG_GLOBAL": os.devnull,
      "GIT_CONFIG_NOSYSTEM": "1",
      "GIT_TERMINAL_PROMPT": "0",
  })
  git_global_arguments = ${JSON.stringify(ABNORMAL_HANDOFF_GIT_GLOBAL_ARGUMENTS)}

  def normalize_path(value):
      normalized = value.strip().replace("\\\\", "/")
      if len(normalized) > 1:
          normalized = normalized.rstrip("/")
      if len(normalized) >= 3 and normalized[1:3] == ":/":
          normalized = normalized.lower()
      return normalized

  def git_value(arguments):
      result = subprocess.run(
          ["git", *git_global_arguments, *arguments],
          cwd=expected_root,
          env=git_environment,
          stdout=subprocess.PIPE,
          stderr=subprocess.DEVNULL,
          text=True,
          check=False,
      )
      if result.returncode != 0:
          raise RuntimeError("git evidence command failed")
      value = result.stdout.strip()
      if not value:
          raise RuntimeError("git evidence command returned no value")
      return value

  def remove_artifact():
      if artifact_path is None:
          return
      try:
          os.remove(artifact_path)
      except FileNotFoundError:
          pass
      except OSError:
          pass

  def remove_temporary_index():
      if temporary_index_path is None:
          return
      for path in [temporary_index_path, temporary_index_path + ".lock"]:
          try:
              os.remove(path)
          except FileNotFoundError:
              pass
          except OSError:
              pass

  def close_artifact():
      global artifact_file, artifact_healthy
      if artifact_file is None:
          return
      try:
          artifact_file.close()
      except OSError:
          artifact_healthy = False
      artifact_file = None

  def prepare_artifact():
      global artifact_file, artifact_healthy
      if artifact_path is None:
          return
      try:
          parent = os.path.dirname(artifact_path)
          if parent:
              os.makedirs(parent, exist_ok=True)
          artifact_file = open(artifact_path, "w", encoding="utf-8", newline="\\n")
          artifact_healthy = True
      except OSError:
          artifact_file = None
          artifact_healthy = False

  def write_artifact(value):
      global artifact_file, artifact_healthy
      if artifact_file is None:
          return
      try:
          artifact_file.write(value)
      except OSError:
          close_artifact()
          artifact_healthy = False
          remove_artifact()

  def collect(arguments, heading):
      inline = []
      inline_chars = 0
      total = 0
      write_artifact(heading + "\\n")
      process = subprocess.Popen(
          ["git", *git_global_arguments, *arguments],
          cwd=expected_root,
          env=git_environment,
          stdout=subprocess.PIPE,
          stderr=subprocess.DEVNULL,
          text=True,
      )
      if process.stdout is None:
          raise RuntimeError("git evidence stream unavailable")
      for raw_line in process.stdout:
          line = raw_line.rstrip("\\r\\n")
          if not line:
              continue
          total += 1
          write_artifact(line + "\\n")
          if len(inline) < max_rows and inline_chars + len(line) <= max_chars:
              inline.append(line)
              inline_chars += len(line)
      if process.wait() != 0:
          raise RuntimeError("git evidence stream failed")
      write_artifact("\\n")
      return inline, total

  try:
      workspace_root = git_value(["rev-parse", "--show-toplevel"])
      if normalize_path(workspace_root) != normalize_path(expected_root):
          raise RuntimeError("git root does not match bound workspace")
      branch = git_value(["rev-parse", "--abbrev-ref", "HEAD"])
      head_sha = git_value(["rev-parse", "HEAD"])
      prepare_artifact()
      index_path = git_value(["rev-parse", "--path-format=absolute", "--git-path", "index"])
      temporary_index_path = index_path + ".trueforge-evidence-" + str(os.getpid())
      shutil.copyfile(index_path, temporary_index_path)
      git_environment["GIT_INDEX_FILE"] = temporary_index_path
      write_artifact(json.dumps({
          "workspace_root": workspace_root,
          "branch": branch,
          "head_sha": head_sha,
      }, separators=(",", ":")) + "\\n\\n")
      status, status_count = collect(
          ${JSON.stringify(ABNORMAL_HANDOFF_GIT_STATUS_ARGUMENTS)},
          "git status --short --untracked-files=all",
      )
      diffstat, diffstat_count = collect(
          ${JSON.stringify(ABNORMAL_HANDOFF_GIT_DIFF_ARGUMENTS)},
          "git diff --stat --no-ext-diff --no-textconv HEAD --",
      )
      status_truncated = status_count > len(status)
      diffstat_truncated = diffstat_count > len(diffstat)
      close_artifact()
      remove_temporary_index()
      artifact_written = (status_truncated or diffstat_truncated) and artifact_healthy
      if not artifact_written:
          remove_artifact()
      print(json.dumps({
          "workspace_root": workspace_root,
          "branch": branch,
          "head_sha": head_sha,
          "status": status,
          "status_count": status_count,
          "status_truncated": status_truncated,
          "diffstat": diffstat,
          "diffstat_count": diffstat_count,
          "diffstat_truncated": diffstat_truncated,
          "artifact_written": artifact_written,
      }, separators=(",", ":")))
  except Exception:
      close_artifact()
      remove_temporary_index()
      remove_artifact()
      sys.exit(1)
`;

function normalizedRepositoryPath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/');
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized;
  return /^[A-Za-z]:\//u.test(withoutTrailingSlash) ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

function buildAbnormalHandoffCaptureCommand(input: { artifactPath: string; expectedWorkspaceRoot: string }): string {
  return [
    'env -i PATH="$PATH" HOME=/nonexistent python3 -I -S -E -c',
    shellEscape(ABNORMAL_HANDOFF_CAPTURE_SCRIPT),
    shellEscape(input.artifactPath),
    shellEscape(input.expectedWorkspaceRoot),
    String(MAX_ABNORMAL_HANDOFF_FILES),
    String(MAX_ABNORMAL_HANDOFF_INLINE_CHARS),
  ].join(' ');
}

function unavailableHandoffReceipt(): AbnormalHandoffEvidence['verification_receipt'] {
  return {
    status: 'not_available',
    command: null,
    branch: null,
    head_sha: null,
    state_sha256: null,
  };
}
const REPOSITORY_COMMAND_SOURCE_FILES: readonly {
  source_kind: RepositoryCommandSourceKind;
  source_path: string;
}[] = [
  { source_kind: 'agents_md', source_path: 'AGENTS.md' },
  { source_kind: 'package_json', source_path: 'package.json' },
];

function repositorySourceAbsolutePath(workspaceCwd: string, sourcePath: string): string {
  const separator = /^[A-Za-z]:[\\/]/.test(workspaceCwd) || workspaceCwd.includes('\\') ? '\\' : '/';
  return `${workspaceCwd.replace(/[\\/]+$/, '')}${separator}${sourcePath}`;
}
const SANDBOX_MCP_REMINDER_TAG = 'sandbox-mcp-code-mode';
const SANDBOX_FILE_OUTPUT_TAG = 'sandbox-file-output';
export const SANDBOX_SCHEMA_INFER_TAG = 'sandbox-schema-infer';
const SANDBOX_FILE_UPLOADS_TAG = 'sandbox-file-uploads';

// Per-server config sent to mcp_client.py via TFY_MCP_SERVERS.
interface SandboxMcpServerConfig {
  allowed_tools: string[];
}

// Snapshots the active W3C trace context (`traceparent` + optional `tracestate`) into env
// vars consumed by mcp_client.py. Read with TFY_TRACEPARENT / TFY_TRACESTATE on the sandbox
// side and attached as NATS message headers; the bridge extracts them on each message so the
// resulting MCP spans nest under the originating Sandbox: exec span.
function injectTraceContextEnv(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const env: Record<string, string> = {};
  if (carrier['traceparent']) {
    env['TFY_TRACEPARENT'] = carrier['traceparent'];
  }
  if (carrier['tracestate']) {
    env['TFY_TRACESTATE'] = carrier['tracestate'];
  }
  return env;
}

/**
 * Injects environment variables required for mcp_client.py into sandbox_exec arguments.
 * Transport-specific vars (NATS URL/prefix/timeout) come from `codeModeEnv` via transport.start().
 * PYTHONPATH comes from transport.getClientInstall remotePath. PATH is provider-owned:
 * Sandbox never writes PATH (Daytona uses the image PATH; TFY/local set it in exec).
 */
function injectMCPClientEnv(params: {
  env?: Record<string, string> | undefined;
  mcpServers: Record<string, SandboxMcpServerConfig>;
  codeModeEnv?: Record<string, string> | undefined;
  mcpClientInstall?: CodeModeClientInstall | undefined;
}): Record<string, string> {
  const codeModeEnv = params.codeModeEnv ?? {};
  const hasCodeModeTransport = Object.keys(codeModeEnv).length > 0;
  const install = params.mcpClientInstall;
  const layout = install === undefined ? undefined : mcpClientLayout(install.remotePath);
  return {
    ...(params.env ?? {}),
    ...(layout !== undefined && {
      PYTHONPATH: layout.pythonPath,
    }),
    ...(Object.keys(params.mcpServers).length > 0 && {
      TFY_MCP_SERVERS: Buffer.from(JSON.stringify(params.mcpServers)).toString('base64'),
    }),
    ...codeModeEnv,
    ...(hasCodeModeTransport && {
      // W3C trace context captured per-exec so each Code Mode request carries the originating
      // Sandbox: exec span as parent.
      ...injectTraceContextEnv(),
    }),
    // Approvals are always enabled: destructive tools cannot run in code mode.
    TFY_ENABLE_AGENT_APPROVALS: 'true',
  };
}

const sandboxExecSchema = z.object({
  intent: z.string().describe('Why you are running this command (user-facing).'),
  purpose: z
    .enum(SANDBOX_INVOCATION_PURPOSES)
    .describe(
      'Host-enforced execution purpose. Use verify for any command whose successful result should authorize a later commit. The commit purpose is only for running a `git commit` command; to produce a patch, run `git diff` with purpose inspect and read its output, do not redirect it to a file.',
    ),
  command: z.string().describe('Shell command to execute.'),
  cwd: z.string().optional().describe('Working directory.'),
  env: z.record(z.string(), z.string()).optional(),
  output: z
    .object({
      head_lines: z.number().int().min(1).max(1000).optional(),
      tail_lines: z.number().int().min(1).max(1000).optional(),
      grep: z.string().min(1).max(256).optional().describe('Filter lines containing this text.'),
    })
    .refine(value => value.head_lines !== undefined || value.tail_lines !== undefined || value.grep !== undefined, {
      message: 'output must specify head_lines, tail_lines, or grep',
    })
    .optional(),
});

const sandboxRunRegisteredCommandSchema = z.object({
  intent: z.string().describe('A brief, user-facing explanation of why the registered repository check is being run.'),
  command_id: z.string().min(1).describe('Stable ID of a host-confirmed repository command.'),
});

const REGISTERED_COMMAND_OUTPUT_TAIL_LINES = 100;

const sandboxImplementationPlanSchema = ImplementationPlanSchema;

// Every multi-line text field below (`content`, `patch`, `old_text`, `new_text`) is paired with a
// sibling `<field>_lines` array: one array element per line, blank lines as empty strings, joined
// with "\n" by `resolveLineArrayField`. Exactly one of each pair is required. See
// `toolArgumentNormalization.ts`'s module docstring for why: a model reliably produces one array
// element per line but unreliably produces embedded "\n" inside a single JSON string value.
const STRUCTURED_EDIT_LINES_FIELD_DESCRIPTION =
  'one element per line, blank lines as empty strings, joined with "\\n". Provide this or';

/**
 * Resolves a `<field>` / `<field>_lines` pair inside a Zod `.transform()`, reporting a precise
 * issue (missing, conflicting, or out of bounds) and short-circuiting the whole object transform
 * with `z.NEVER` on failure. Every structured-edit schema below calls this once per pair, so the
 * join, the "exactly one" refinement, and the length bound live in one place per field, sourced
 * from the one shared `resolveLineArrayField` (`toolArgumentNormalization.ts`) that also resolves
 * these pairs for the pre-validation `toolCallInfo` approval-card pass.
 */
function resolveOrFailLineArrayField(input: {
  ctx: z.RefinementCtx;
  stringField: string;
  arrayField: string;
  stringValue: string | undefined;
  arrayValue: readonly string[] | undefined;
  minLength?: number;
  maxLength?: number;
}): string | undefined {
  const resolved = resolveLineArrayField(input);
  if (resolved.status !== 'ok') {
    input.ctx.addIssue({ code: 'custom', message: resolved.message, path: [input.stringField] });
    return undefined;
  }
  return resolved.value;
}

const sandboxApplyPatchSchema = z
  .object({
    intent: z.string().describe('Why you are making this change (user-facing).'),
    cwd: z.string().min(1).describe('Repository root path.'),
    patch: z
      .string()
      .optional()
      .describe(
        'Git-format unified diff starting with "diff --git". Never interpolated into a shell command. Provide this or patch_lines, not both.',
      ),
    patch_lines: z
      .array(z.string())
      .optional()
      .describe(
        `The diff as line array, ${STRUCTURED_EDIT_LINES_FIELD_DESCRIPTION} patch, not both. Preferred: single strings with escaped newlines can mangle hunk headers.`,
      ),
  })
  .transform((value, ctx) => {
    const { patch_lines: patchLines, ...rest } = value;
    const patch = resolveOrFailLineArrayField({
      ctx,
      stringField: 'patch',
      arrayField: 'patch_lines',
      stringValue: value.patch,
      arrayValue: patchLines,
      minLength: 1,
      maxLength: 512 * 1024,
    });
    if (patch === undefined) {
      return z.NEVER;
    }
    return { ...rest, patch };
  });

const sandboxReplaceTextSchema = z
  .object({
    intent: z.string().describe('Why you are making this change (user-facing).'),
    cwd: z.string().min(1).describe('Repository root path.'),
    path: z.string().min(1).describe('File path relative to cwd.'),
    old_text: z.string().optional().describe('Text to replace (or use old_text_lines).'),
    old_text_lines: z
      .array(z.string())
      .optional()
      .describe(
        `The exact existing text to replace, as an array of lines, ${STRUCTURED_EDIT_LINES_FIELD_DESCRIPTION} ` +
          'old_text, not both. Preferred over old_text: a single string with escaped or missing newlines is ' +
          'unreliable for some models and will fail the exact match.',
      ),
    new_text: z.string().optional().describe('Replacement text (or use new_text_lines).'),
    new_text_lines: z
      .array(z.string())
      .optional()
      .describe(
        `The replacement text as an array of lines, ${STRUCTURED_EDIT_LINES_FIELD_DESCRIPTION} new_text, not ` +
          'both. Preferred over new_text: a single string with escaped or missing newlines is unreliable for ' +
          'some models.',
      ),
    replace_all: z.boolean().optional().default(false).describe('Replace all occurrences.'),
  })
  .transform((value, ctx) => {
    const { old_text_lines: oldTextLines, new_text_lines: newTextLines, ...rest } = value;
    const oldText = resolveOrFailLineArrayField({
      ctx,
      stringField: 'old_text',
      arrayField: 'old_text_lines',
      stringValue: value.old_text,
      arrayValue: oldTextLines,
      minLength: 1,
      maxLength: 512 * 1024,
    });
    const newText = resolveOrFailLineArrayField({
      ctx,
      stringField: 'new_text',
      arrayField: 'new_text_lines',
      stringValue: value.new_text,
      arrayValue: newTextLines,
      maxLength: 512 * 1024,
    });
    if (oldText === undefined || newText === undefined) {
      return z.NEVER;
    }
    return { ...rest, old_text: oldText, new_text: newText };
  });

const sandboxWriteFileSchema = z
  .object({
    intent: z.string().describe('Why you are creating this file (user-facing).'),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absolute path to the checked-out Git repository or package root. Required when a repository is bound; ' +
          'otherwise defaults to the provider workspace root.',
      ),
    path: z.string().min(1).describe('New file path relative to cwd.'),
    content: z.string().optional().describe('File content (or use content_lines).'),
    content_lines: z
      .array(z.string())
      .optional()
      .describe(
        `UTF-8 content for the new file as an array of lines, ${STRUCTURED_EDIT_LINES_FIELD_DESCRIPTION} content, ` +
          'not both. Preferred over content: a single string with escaped or missing newlines is unreliable for ' +
          'some models.',
      ),
  })
  .transform((value, ctx) => {
    const { content_lines: contentLines, ...rest } = value;
    const content = resolveOrFailLineArrayField({
      ctx,
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: value.content,
      arrayValue: contentLines,
      maxLength: 512 * 1024,
    });
    if (content === undefined) {
      return z.NEVER;
    }
    return { ...rest, content };
  });

const WRITE_FILE_SCRIPT = `import hashlib
import json
import os
import secrets
import sys

def stop(message):
    print(json.dumps({"error": message}))
    raise SystemExit(1)

with open(sys.argv[1], "r", encoding="utf-8") as payload_file:
    payload = json.load(payload_file)

workspace_cwd = payload["workspace_cwd"]
cwd_relative = payload["cwd_relative"]
relative_path = payload["path"]
if not os.path.isabs(workspace_cwd) or "\\x00" in workspace_cwd:
    stop("workspace_cwd must be absolute")
if os.path.isabs(cwd_relative) or "\\x00" in cwd_relative:
    stop("cwd_relative must stay within workspace_cwd")
cwd_relative = cwd_relative.replace("\\\\", "/")
cwd_parts = [part for part in cwd_relative.split("/") if part not in ("", ".")]
if any(part == ".." for part in cwd_parts):
    stop("cwd_relative must stay within workspace_cwd")
if os.path.isabs(relative_path) or "\\x00" in relative_path:
    stop("path must be relative to cwd")
relative_path = relative_path.replace("\\\\", "/")
path_parts = [part for part in relative_path.split("/") if part not in ("", ".")]
if not path_parts or any(part == ".." for part in path_parts):
    stop("path must stay within cwd")
parts = cwd_parts + path_parts

directory_fds = []
root_fd = os.open(workspace_cwd, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
directory_fds.append(root_fd)
parent_fd = root_fd
try:
    for part in parts[:-1]:
        parent_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        directory_fds.append(parent_fd)
    target_name = parts[-1]
    content_bytes = payload["content"].encode("utf-8")
    temporary_name = ".aman-write-%s" % secrets.token_hex(12)
    temporary_fd = -1
    try:
        temporary_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=parent_fd,
        )
        with os.fdopen(temporary_fd, "wb", closefd=False) as temporary_file:
            temporary_file.write(content_bytes)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.close(temporary_fd)
        temporary_fd = -1
        try:
            os.link(temporary_name, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd, follow_symlinks=False)
        except FileExistsError:
            stop("file already exists; write_file is creation-only and will not overwrite it")
        os.fsync(parent_fd)
    finally:
        if temporary_fd >= 0:
            os.close(temporary_fd)
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
finally:
    for directory_fd in reversed(directory_fds):
        os.close(directory_fd)

print(json.dumps({
    "path": relative_path,
    "byte_length": len(content_bytes),
    "sha256": hashlib.sha256(content_bytes).hexdigest(),
}))
`;

// Reads the current bytes of a set of workspace-relative paths, base64-encoded, so an
// OpenAI-format apply_patch conversion can compute exact hunk offsets. Missing files are simply
// absent from the result; this is a best-effort read, never a precondition check.
const OPENAI_PATCH_CONTENT_READ_SCRIPT = `import base64
import json
import os
import sys

root, paths = sys.argv[1], json.loads(sys.argv[2])
result = {}
for path in paths:
    target = os.path.join(root, path)
    if os.path.isfile(target):
        with open(target, "rb") as handle:
            result[path] = base64.b64encode(handle.read()).decode("ascii")
print(json.dumps(result))
`;

const REPLACE_TEXT_SCRIPT = `import hashlib
import json
import os
import secrets
import stat
import sys

def stop(message):
    print(json.dumps({"error": message}))
    raise SystemExit(1)

with open(sys.argv[1], "r", encoding="utf-8") as payload_file:
    payload = json.load(payload_file)

relative_path = payload["path"]
if os.path.isabs(relative_path) or "\\x00" in relative_path:
    stop("path must be relative to cwd")
parts = [part for part in relative_path.split("/") if part not in ("", ".")]
if not parts or any(part == ".." for part in parts):
    stop("path must stay within cwd")

directory_fds = []
root_fd = os.open(".", os.O_RDONLY | os.O_DIRECTORY)
directory_fds.append(root_fd)
parent_fd = root_fd
try:
    for part in parts[:-1]:
        parent_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        directory_fds.append(parent_fd)
    target_name = parts[-1]
    target_fd = os.open(target_name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        source_stat = os.fstat(target_fd)
        if not stat.S_ISREG(source_stat.st_mode):
            stop("target is not a regular file")
        with os.fdopen(target_fd, "rb", closefd=False) as source_file:
            original_bytes = source_file.read()
    finally:
        os.close(target_fd)
except OSError as error:
    stop("target path is unavailable or contains a symlink: %s" % error)

try:
    original = original_bytes.decode("utf-8")
except UnicodeDecodeError:
    stop("target is not valid UTF-8 text")

old_text = payload["old_text"]
new_text = payload["new_text"]
occurrences = original.count(old_text)
if occurrences == 0:
    stop("old_text was not found")
if not payload.get("replace_all", False) and occurrences != 1:
    stop("old_text is ambiguous; it occurs %d times" % occurrences)

updated = original.replace(old_text, new_text) if payload.get("replace_all", False) else original.replace(old_text, new_text, 1)
updated_bytes = updated.encode("utf-8")
if updated_bytes == original_bytes:
    stop("replacement would not change the file")

file_mode = stat.S_IMODE(source_stat.st_mode)
temporary_name = ".aman-replace-%s" % secrets.token_hex(12)
temporary_fd = -1
try:
    temporary_fd = os.open(
        temporary_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        file_mode,
        dir_fd=parent_fd,
    )
    with os.fdopen(temporary_fd, "wb", closefd=False) as temporary_file:
        temporary_file.write(updated_bytes)
        temporary_file.flush()
        os.fsync(temporary_file.fileno())
    os.close(temporary_fd)
    temporary_fd = -1
    current_stat = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    if (
        current_stat.st_dev != source_stat.st_dev
        or current_stat.st_ino != source_stat.st_ino
        or current_stat.st_mtime_ns != source_stat.st_mtime_ns
        or current_stat.st_size != source_stat.st_size
    ):
        stop("target changed while the replacement was being prepared")
    os.replace(temporary_name, target_name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
finally:
    if temporary_fd >= 0:
        os.close(temporary_fd)
    try:
        os.unlink(temporary_name, dir_fd=parent_fd)
    except FileNotFoundError:
        pass
    for directory_fd in reversed(directory_fds):
        os.close(directory_fd)

print(json.dumps({
    "path": relative_path,
    "replacements": occurrences if payload.get("replace_all", False) else 1,
    "before_sha256": hashlib.sha256(original_bytes).hexdigest(),
    "after_sha256": hashlib.sha256(updated_bytes).hexdigest(),
}))
`;

/**
 * Outcome of the replace_text dispatch operation: either the host-side matcher rejected
 * old_text (ambiguous or no acceptable match, so the sandbox script was never invoked) or the
 * script actually ran.
 */
type ReplaceTextDispatchOutcome =
  { kind: 'match_rejected'; rejection: string } | { kind: 'dispatched'; exec: ExecResult; payloadDigest: string };

export const SANDBOX_EXEC_DESCRIPTION = `Execute shell commands in a persistent sandbox environment.
Use the cwd argument for the checked-out repository. Setting HOME does not change the working directory.
IMPORTANT: Never list, print, or expose environment variables or git credential files (~/.git-credentials).
Use write_file to create a new file, apply_patch for source edits, and replace_text for one exact existing-text replacement. Do not bypass these primitives with sed, Perl, Python, heredocs, or temporary shell patch files.
For large output, pass output.head_lines, output.tail_lines, and/or output.grep to bound the model-visible result.
Declare purpose=verify for any command whose successful result should authorize a later commit. Use purpose=commit only for running a \`git commit\` command.
exec MUST NOT be used to run python/node code — use run_code. Interpreter invocations in exec are rejected by a harness guard; use the run_code tool instead.
Result status is "ok" (success), "exited" (command ran, non-zero exit — check exit_code), or "failed" (host could not run it).
Exec provides retrieval of an already identified public source; it does not provide search or discovery. Network egress requires PermissionGate admission. Make separate tool calls in one response; the host runs read-only calls concurrently.
`;

/**
 * Static base of the `run_code` tool description. The harness appends the
 * per-turn `/ingress` file list at render time (see `renderRunCodeDescription`),
 * so attachments staged by the harness are advertised without the model
 * ever base64-encoding them.
 */
export const SANDBOX_RUN_CODE_DESCRIPTION = `Run Python or Node.js code in an isolated, offline sandbox.
language is 'python' (3.13) or 'node' (22). Code runs with cwd=/scratch; read inputs from /ingress/<name>; write result files under /egress (files left in /scratch are collected too). Returns separate stdout/stderr (each capped at 256 KiB), the verbatim exit_code, and files_out metadata (name/size/sha256 — bytes never inline into context; download from the UI). Reference files_out in your response as run_code/<name> (e.g. [chart](run_code/chart.png)) — that is the path the UI uses for download. A non-zero exit is the program's own result, not an infra failure.
Preinstalled: pandas, numpy, matplotlib, seaborn, plotly, openpyxl, pdfplumber, Pillow, requests, genson, pydantic, pyyaml, beautifulsoup4, poppler-utils, tesseract-ocr. No network and no installs at runtime: if a package is missing, say so instead of installing it.
files_in is for content you compose yourself (a small CSV or JSON you write). Never re-upload an /ingress file via files_in.
If run_code fails, do NOT fall back to exec (or any shell tool) to run the code — interpreter invocations in exec are rejected by a harness guard. Fix the code, reduce the input, or report the failure. When you report a run_code failure, quote the error text exactly as returned; do not paraphrase or reword it.
`;

export const SANDBOX_APPLY_PATCH_DESCRIPTION =
  "Apply one focused patch to the checked-out repository, as a git-format unified diff or OpenAI's apply_patch envelope (*** Begin Patch / *** Update File: <path> / *** End Patch). Each hunk needs a real header like @@ -1,2 +1,2 @@ with body lines starting with space, -, or +; placeholder hunk headers like @@… are rejected. Pass the patch as patch_lines, one element per line, blank lines as empty strings. If validation fails, correct the patch rather than editing through exec. This tool never stages, commits, or pushes.";

export const SANDBOX_REPLACE_TEXT_DESCRIPTION =
  'Replace one exact text passage in a UTF-8 file beneath cwd. old_text must match exactly and uniquely. Pass old_text and new_text as old_text_lines and new_text_lines, one element per line, blank lines as empty strings. Use this when unified-diff formatting is unnecessary. Writes atomically. This tool never stages, commits, or pushes.';

export const SANDBOX_WRITE_FILE_DESCRIPTION =
  'Create one new UTF-8 file beneath cwd. Pass content as content_lines, one element per line, blank lines as empty strings. Use replace_text or apply_patch for existing files. This tool never stages, commits, or pushes.';

export const SANDBOX_RUN_REGISTERED_COMMAND_DESCRIPTION =
  'Run one host-confirmed repository build, test, or verification command by its stable command ID. The host owns the exact command, repository cwd, purpose, and timeout. Do not restate the shell command.';

export const SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_DESCRIPTION =
  'Submit a typed implementation plan before editing a bound repository. This tool never edits or executes.';

export function createSandboxLargeToolResponseGuidance(): string {
  return `For a large sandbox exec result, call exec again with output.head_lines, output.tail_lines, and/or output.grep. These host-owned bounds are applied before model context, and the bounded result reports raw_output.storage_status=stored or raw_output.storage_status=failed. Unbounded results do not create a raw_output artifact. For structured MCP processing, write code with the provided MCP client and use <${SANDBOX_MCP_REMINDER_TAG}>.`;
}

export const SANDBOX_MCP_SERVER_ID = 'sandbox';
type SandboxExecInput = z.infer<typeof sandboxExecSchema>;
type SandboxExecOutputInput = z.infer<typeof sandboxExecSchema>['output'];
type SandboxRunRegisteredCommandInput = z.infer<typeof sandboxRunRegisteredCommandSchema>;
type SandboxImplementationPlanInput = z.infer<typeof sandboxImplementationPlanSchema>;
type SandboxRuntimeExecInput = SandboxExecInput & { timeoutSeconds?: number | undefined };
type SandboxApplyPatchInput = z.infer<typeof sandboxApplyPatchSchema>;
type SandboxReplaceTextInput = z.infer<typeof sandboxReplaceTextSchema>;
type SandboxWriteFileInput = z.infer<typeof sandboxWriteFileSchema>;

export function sandboxCommandApprovalIdentity(input: {
  purpose: SandboxInvocationPurpose;
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}): string {
  const effect = sandboxInvocationPolicy({ command: input.command, purpose: input.purpose }).effect;
  // Chat grants are invocation-specific. The same command can execute
  // different code in another directory or under a different environment, so
  // all execution-affecting arguments participate in the identity.
  const sortedEnv = Object.fromEntries(Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right)));
  const digest = createHash('sha256')
    .update(JSON.stringify({ purpose: input.purpose, command: input.command, cwd: input.cwd, env: sortedEnv }))
    .digest('hex')
    .slice(0, 16);
  return `${SANDBOX_EXEC_TOOL_NAME}:${effect}:${digest}`;
}

function commandFromToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || !('command' in argumentsValue)) {
    return '';
  }
  const command = argumentsValue.command;
  return typeof command === 'string' ? command : '';
}

function purposeFromToolArguments(argumentsValue: unknown): SandboxInvocationPurpose | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || !('purpose' in argumentsValue)) {
    return undefined;
  }
  const purpose = argumentsValue.purpose;
  return SANDBOX_INVOCATION_PURPOSES.find(candidate => candidate === purpose);
}

function environmentFromToolArguments(argumentsValue: unknown): Record<string, string> | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || !('env' in argumentsValue)) {
    return undefined;
  }
  const env = argumentsValue.env;
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return undefined;
  }
  const entries = Object.entries(env);
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

function outputFromToolArguments(argumentsValue: unknown): unknown {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || !('output' in argumentsValue)) {
    return undefined;
  }
  return argumentsValue.output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows `unknown` to an object carrying a string `error` property, without an `as` escape. */
function hasStringErrorProperty(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value['error'] === 'string';
}

function sandboxOutputPreflightFailure(output: unknown): string | undefined {
  if (output === undefined) {
    return undefined;
  }
  if (!isRecord(output)) {
    return 'The output parameter must be an object with head_lines, tail_lines, and/or grep.';
  }
  const headLines = output['head_lines'];
  const tailLines = output['tail_lines'];
  const grep = output['grep'];
  if (
    headLines !== undefined &&
    (typeof headLines !== 'number' || !Number.isSafeInteger(headLines) || headLines < 1 || headLines > 1000)
  ) {
    return 'output.head_lines must be an integer between 1 and 1000.';
  }
  if (
    tailLines !== undefined &&
    (typeof tailLines !== 'number' || !Number.isSafeInteger(tailLines) || tailLines < 1 || tailLines > 1000)
  ) {
    return 'output.tail_lines must be an integer between 1 and 1000.';
  }
  if (grep !== undefined && (typeof grep !== 'string' || grep.length < 1 || grep.length > 256)) {
    return 'output.grep must be a non-empty string of at most 256 characters.';
  }
  if (headLines === undefined && tailLines === undefined && grep === undefined) {
    return 'output must specify head_lines, tail_lines, or grep.';
  }
  return undefined;
}

type WriteFilePathPreflight = { status: 'valid'; path: string } | { status: 'invalid'; failure: string };

function writeFilePathOutsideWorkspaceFailure(input: { path: string; cwd: string }): string {
  return `write_file path must be relative to cwd (${input.cwd}) or an absolute path inside it; received ${input.path}`;
}

/**
 * Validates and, for an absolute path inside the effective root, rewrites `path` as the
 * cwd-relative form the rest of write_file (and the sandbox-side script) expects. `root` is the
 * bound repository's workspace_cwd when a repository is bound, otherwise the provider workspace.
 */
function writeFilePathPreflight(input: { path: string; root: string; cwd: string }): WriteFilePathPreflight {
  const rawPath = input.path;
  const looksAbsolute = rawPath.includes('\0') || /^[\\/]/u.test(rawPath) || /^[A-Za-z]:[\\/]/u.test(rawPath);
  let path = rawPath;
  if (looksAbsolute) {
    const normalized = rawPath.includes('\0')
      ? undefined
      : structuredEditCwdRelativePath({ repositoryRoot: input.root, cwd: input.cwd, path: rawPath });
    if (normalized === undefined || /^[\\/]/u.test(normalized) || /^[A-Za-z]:[\\/]/u.test(normalized)) {
      return { status: 'invalid', failure: writeFilePathOutsideWorkspaceFailure({ path: rawPath, cwd: input.cwd }) };
    }
    path = normalized;
  }
  try {
    validateNoPathTraversal(path);
  } catch (error) {
    return {
      status: 'invalid',
      failure: error instanceof Error ? error.message : 'write_file path must stay within cwd.',
    };
  }
  if (path.includes('\\')) {
    return { status: 'invalid', failure: writeFilePathOutsideWorkspaceFailure({ path: rawPath, cwd: input.cwd }) };
  }
  if (path.split(/[\\/]+/u).filter(part => part !== '' && part !== '.').length === 0) {
    return { status: 'invalid', failure: 'write_file path must name a new file relative to cwd.' };
  }
  if (targetsGitMetadata(path)) {
    return {
      status: 'invalid',
      failure: 'write_file cannot modify Git metadata under .git; use the appropriate Git command instead.',
    };
  }
  return { status: 'valid', path };
}

function writeFilePathPreflightFailure(input: { path: string; root: string; cwd: string }): string | undefined {
  const result = writeFilePathPreflight(input);
  return result.status === 'invalid' ? result.failure : undefined;
}

interface WriteFileWorkspaceScope {
  workspaceCwd: string;
  cwd: string;
  cwdRelative: string;
}

type WriteFileWorkspaceScopeResolution =
  { status: 'bound'; scope: WriteFileWorkspaceScope } | { status: 'invalid'; failure: string };

function relativePathEscapesRoot(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith('../') || posix.isAbsolute(relativePath);
}

/**
 * Where a `write_file` may land. A bound repository owns its checkout, and a call against a
 * bound repository must still name its cwd explicitly. Without a bound repository, the
 * provider's own workspace is scratch space for the chat, so a skill or a research task can
 * write its files without pretending to be coding work; an omitted cwd there defaults to that
 * workspace root. Nothing else is writable: a cwd outside the root, or a provider with no
 * workspace, is refused before approval.
 */
function lexicalWriteFileWorkspaceScope({
  cwd,
  binding,
  scratchRoot,
}: {
  cwd: string | undefined;
  binding: BoundRepository | undefined;
  scratchRoot: string | undefined;
}): WriteFileWorkspaceScopeResolution {
  if (binding !== undefined && cwd === undefined) {
    return {
      status: 'invalid',
      failure: 'write_file cwd is required when a repository is bound.',
    };
  }
  const root = binding?.workspace_cwd ?? scratchRoot;
  if (root === undefined) {
    return {
      status: 'invalid',
      failure: 'write_file needs a bound repository or a provider workspace, and this chat has neither.',
    };
  }
  const label = binding === undefined ? 'workspace' : 'bound workspace';
  const requested = cwd ?? root;
  if (root.includes('\0') || requested.includes('\0') || !posix.isAbsolute(root) || !posix.isAbsolute(requested)) {
    return { status: 'invalid', failure: `write_file cwd must be an absolute path inside the ${label}.` };
  }
  const workspaceCwd = posix.normalize(root);
  const requestedCwd = posix.normalize(requested);
  const cwdRelative = posix.relative(workspaceCwd, requestedCwd);
  if (relativePathEscapesRoot(cwdRelative)) {
    return { status: 'invalid', failure: `write_file cwd is outside the ${label}.` };
  }
  return { status: 'bound', scope: { workspaceCwd, cwd: requestedCwd, cwdRelative } };
}

function canonicalPathFromExec(result: ExecResult): string | undefined {
  if (!successfulExec(result)) {
    return undefined;
  }
  const withoutTerminator = result.response.result.replace(/\r?\n$/u, '');
  return posix.isAbsolute(withoutTerminator) ? posix.normalize(withoutTerminator) : undefined;
}

function applyExecOutputBounds(rawOutput: string, output: SandboxExecOutputInput): string {
  if (output === undefined) {
    return rawOutput;
  }
  const hasTrailingNewline = rawOutput.endsWith('\n');
  const sourceLines = rawOutput.split(/\r?\n/u);
  const lineSeparator = rawOutput.includes('\r\n') ? '\r\n' : '\n';
  if (hasTrailingNewline) {
    sourceLines.pop();
  }
  const grep = output.grep;
  const lines = grep === undefined ? sourceLines : sourceLines.filter(line => line.includes(grep));
  const headLines = output.head_lines;
  const tailLines = output.tail_lines;
  const selected =
    headLines === undefined
      ? tailLines === undefined
        ? lines
        : lines.slice(-tailLines)
      : tailLines === undefined
        ? lines.slice(0, headLines)
        : headLines + tailLines >= lines.length
          ? lines
          : [...lines.slice(0, headLines), ...lines.slice(-tailLines)];
  return `${selected.join(lineSeparator)}${hasTrailingNewline && selected.length > 0 ? lineSeparator : ''}`;
}

/**
 * Host binding for the exec interpreter guard (classifier in `./driver/ExecGuard`).
 * Threat model: `exec` is a trusted-operator tool — the operator already consented
 * to shell access in this session. This guard does not try to contain a malicious
 * model (a determined one has git, npm, and awk); it prevents accidental drift back
 * to shell-based code execution now that `run_code` is the supported path, and it
 * stops a run_code failure from becoming an exec workaround.
 *
 * Runs inside `sandboxExecPreflightFailure`, so interpreter invocations are rejected
 * before approval and before the provider ever sees the command. Resolution is
 * best-effort: bare interpreter names are caught without any filesystem access;
 * PATH lookup (from the call's own `env` when it sets PATH — no ambient
 * `process.env` read in core) and shebang reads only sharpen evasion cases.
 * Resolutions are cached per Sandbox because preflight runs on every exec call.
 */
function execInterpreterGuardFailure(input: {
  command: string;
  env: Readonly<Record<string, string>> | undefined;
  resolveCache: Map<string, string | undefined>;
}): string | undefined {
  const pathValue = input.env?.['PATH'];
  const searchDirs = pathValue === undefined || pathValue === '' ? [] : pathValue.split(pathDelimiter);
  const host: ExecGuardHost = {
    resolveExecutable: name => {
      if (input.resolveCache.has(name)) {
        return input.resolveCache.get(name);
      }
      let resolved: string | undefined;
      for (const dir of searchDirs) {
        if (dir === '') {
          continue;
        }
        const candidate = join(dir, name);
        try {
          accessSync(candidate, fsConstants.X_OK);
          resolved = candidate;
          break;
        } catch {
          // Not executable here — keep scanning.
        }
      }
      input.resolveCache.set(name, resolved);
      return resolved;
    },
    readShebang: path => {
      try {
        const head = readFileSync(path, 'utf8').slice(0, 128);
        const newline = head.indexOf('\n');
        const first = newline === -1 ? head : head.slice(0, newline);
        return first.startsWith('#!') ? first.slice(2).trim() : undefined;
      } catch {
        return undefined;
      }
    },
  };
  const verdict = classifyExecCommand({ command: input.command, host });
  return verdict.verdict === 'reject' ? interpreterInvocationRefusal(verdict.reason) : undefined;
}

function sandboxExecPreflightFailure(input: {
  command: string;
  purpose: SandboxInvocationPurpose | undefined;
  cwd: string | undefined;
  env: Readonly<Record<string, string>> | undefined;
  output: unknown;
  webConnectorAttached: boolean;
  webConnectorToolHint: string;
  resolveCache: Map<string, string | undefined>;
}): string | undefined {
  const outputFailure = sandboxOutputPreflightFailure(input.output);
  if (outputFailure !== undefined) {
    return outputFailure;
  }
  const interpreterGuardFailure = execInterpreterGuardFailure({
    command: input.command,
    env: input.env,
    resolveCache: input.resolveCache,
  });
  if (interpreterGuardFailure !== undefined) {
    return interpreterGuardFailure;
  }
  if (input.purpose === undefined) {
    return 'A terminal invocation must declare its purpose explicitly.';
  }
  if (input.cwd === undefined && input.env?.['HOME'] !== undefined) {
    return 'HOME changes the user home and cache location, not the command working directory. Pass the checked-out repository path in cwd.';
  }
  if (
    input.cwd === undefined &&
    (input.purpose === 'verify' || input.purpose === 'commit' || input.purpose === 'push')
  ) {
    return 'No repository binding supplies a default cwd. Pass the checked-out repository path in the cwd parameter or bind this chat to a repository.';
  }
  if (
    sandboxCommandHasGitSubcommand(input.command, 'commit') &&
    sandboxCommandHasGitSubcommand(input.command, 'push')
  ) {
    return 'Run git commit and git push as separate commands so each can be reviewed.';
  }
  if (sandboxCommandUsesEvaluatorWrapper(input.command)) {
    return 'Nested shell and command-evaluator wrappers are not allowed because they hide the operation from approval classification. Run the underlying command directly; use write_file for a new file or apply_patch/replace_text for an edit.';
  }
  if (
    (input.purpose === 'inspect' || input.purpose === 'edit' || input.purpose === 'execute') &&
    sandboxCommandUsesUnstructuredOperation(input.command)
  ) {
    return "Unstructured shell redirection, heredocs, tee, and inline Python evaluation are not allowed for inspect, edit, or execute-purpose exec calls. Use read_file for inspection, write_file for a new file, apply_patch/replace_text for an edit, or run a checked-in script. To trim long output, use the exec tool's output.head_lines, output.tail_lines or output.grep fields instead of a shell pipe.";
  }
  // Verification has to stay observable: redirection, substitution, and
  // backgrounding hide what the check actually ran, so a green result would
  // not prove the repository was verified.
  if (input.purpose === 'verify' && sandboxVerifyCommandUsesUnsafeSyntax(input.command)) {
    return "Verification commands must not use shell redirection, command substitution, backgrounding, or malformed quoting. Run the check in the foreground with observable output; trim long output with the exec tool's output.head_lines, output.tail_lines or output.grep fields instead of a shell redirect.";
  }
  // A "verify" label must not cover opaque code: inline evaluators, heredocs,
  // and tee would let arbitrary code execution ride on a verification
  // approval. Run a checked-in script so the verification step stays reviewable.
  if (
    input.purpose === 'verify' &&
    (sandboxCommandUsesUnstructuredOperation(input.command) || sandboxVerifyCommandUsesInlineEval(input.command))
  ) {
    return 'Inline code evaluation (python -c, node -e), heredocs, and tee are not allowed for verify-purpose exec calls. Put the check in a script and run the script so the verification step stays reviewable.';
  }
  const webEgressRejection = sandboxCommandWebEgressRejection({
    command: input.command,
    webConnectorAttached: input.webConnectorAttached,
    webConnectorToolHint: input.webConnectorToolHint,
  });
  if (webEgressRejection !== undefined) {
    return webEgressRejection;
  }
  const policy = sandboxInvocationPolicy({ command: input.command, purpose: input.purpose });
  if (policy.rejection !== undefined) {
    return policy.rejection;
  }
  return undefined;
}

function replacePathFromToolArguments(argumentsValue: unknown): string {
  if (typeof argumentsValue !== 'object' || argumentsValue === null || !('path' in argumentsValue)) {
    return '';
  }
  const path = argumentsValue.path;
  return typeof path === 'string' ? path : '';
}

function writeFilePathFromToolArguments(argumentsValue: unknown): string {
  return replacePathFromToolArguments(argumentsValue);
}

function targetsGitMetadata(path: string): boolean {
  return path.split(/[\\/]+/u).some(component => component === '.git');
}

interface WorkspaceVerificationIdentity {
  sandboxId: string;
  workspaceRoot: string;
  branch: string;
  head: string;
  refsSha256: string;
  indexSha256: string;
  trackedWorktreeSha256: string;
  untrackedSha256: string;
  stateSha256: string;
}

export interface WorkspaceVerificationReceiptCandidate extends WorkspaceVerificationIdentity {
  repositoryId: string;
  mutationEpoch: number;
  command: string;
}
type VerifiedExecOutcome =
  | { status: 'blocked'; reason: string }
  | {
      status: 'completed';
      result: ExecResult;
      serialized: Record<string, unknown>;
      verificationPassed: boolean | undefined;
      verificationReceiptCandidate: WorkspaceVerificationReceiptCandidate | undefined;
    };

interface DurableWorkspaceLease {
  repositoryId: string;
  workspaceRoot: string;
  leaseId: string;
  mutationEpoch: number;
  ownershipLost: boolean;
  renewalInFlight: boolean;
  renewalTimer: ReturnType<typeof setInterval> | undefined;
}

// Workspace queues coordinate local callers of one provider workspace. They
// are not authorization; the durable repository coordinator owns that state.
const workspaceMutationTails = new Map<string, Promise<void>>();

function gitIndexHidesTrackedPaths(taggedPaths: string): boolean {
  return taggedPaths.split('\0').some(entry => /^[a-zS] /u.test(entry));
}

interface WorkspaceMutationLockWait {
  timeoutMs: number;
  label: string;
}

interface WorkspaceMutationLockLease {
  /** Keep this queue position occupied until remote termination is acknowledged. */
  holdUntilTerminationAcknowledged(promise: Promise<void>): void;
}

async function withWorkspaceMutationLock<T>(
  key: string,
  operation: (lease: WorkspaceMutationLockLease) => Promise<T>,
  wait?: WorkspaceMutationLockWait,
  signal?: AbortSignal,
): Promise<T> {
  throwIfSignalAborted(signal);
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  workspaceMutationTails.set(key, tail);
  let deferredRelease: Promise<void> | undefined;
  const lease: WorkspaceMutationLockLease = {
    holdUntilTerminationAcknowledged(promise): void {
      deferredRelease =
        deferredRelease === undefined ? promise : Promise.all([deferredRelease, promise]).then(() => undefined);
    },
  };
  const finish = (): void => {
    release?.();
    if (workspaceMutationTails.get(key) === tail) {
      workspaceMutationTails.delete(key);
    }
  };
  try {
    const waitForPrevious = wait === undefined ? previous : withTimeout(previous, wait.timeoutMs, wait.label);
    await awaitWithAbort({ operation: waitForPrevious, signal });
    throwIfSignalAborted(signal);
  } catch (error) {
    // Keep this queue position occupied until the preceding mutation exits.
    // Releasing it immediately would let a later mutation overtake that work.
    void previous.then(finish);
    throw error;
  }
  try {
    return await operation(lease);
  } finally {
    if (deferredRelease === undefined) {
      finish();
    } else {
      void deferredRelease.then(finish);
    }
  }
}
function successfulExec(result: ExecResult): result is Extract<ExecResult, { success: true }> {
  return result.success && result.response.exitCode === 0;
}

function providerSuccessfulExec(result: ExecResult): result is Extract<ExecResult, { success: true }> {
  return result.success;
}

/**
 * Determines whether an exec result should set the tool call's `isError` flag.
 * `isError` is true only for a genuine host failure (status "failed"): the
 * command could not be started, was killed by the execution timeout, or was
 * refused by policy - see `execResultSemantics`'s module doc. A command that
 * ran is always "ok" or "exited" - never "failed" - regardless of its exit
 * code or shape, so any command the sandbox actually executed leaves
 * `isError` false.
 */
function isExecResultOk(result: ExecResult): boolean {
  return result.success;
}

/**
 * Wrap a host-side refusal of an exec call - a preflight rejection, an admission block, or a
 * sandbox-initialization failure - in the same status/exit_code/error_summary shape a dispatched
 * command reports, via `buildExecResultShape`'s host-failure branch. The exec tool description
 * promises status "failed" for every host failure, not only the ones that got as far as
 * dispatching a command, so every refusal path in `handleExec` routes through this rather than
 * returning a bare error body.
 */
function hostRefusalResponse(
  message: string,
  overrides?: Parameters<typeof toolResultResponse>[0]['overrides'],
): CallToolResponse {
  const shape = buildExecResultShape(-1, '', message, false);
  return toolResultResponse({
    text: JSON.stringify({ error: message, ...shape }),
    isError: true,
    ...(overrides !== undefined ? { overrides } : {}),
  });
}

/** The command's stdout/stderr text on infra success, or the infra error message otherwise. */
function execResultOutputText(result: ExecResult): string {
  return result.success ? result.response.result : result.error;
}

export class Sandbox extends LocalToolMCP {
  readonly name = SANDBOX_MCP_SERVER_ID;
  readonly displayName = 'Sandbox';
  override readonly description = 'Persistent sandbox environment for code execution';

  private readonly provider: SandboxProvider;
  private readonly sentinelContext: SentinelHostContext | undefined;
  private readonly boundRepository: BoundRepository | undefined;
  private readonly loadBoundRepository: (() => Promise<BoundRepository | undefined>) | undefined;
  private implementationPlanGrantContext: ImplementationPlanGrantContext | undefined;
  private readonly onRepositorySources: RepositoryCommandSourceObserver | undefined;
  private readonly workspaceVerificationCoordinator: WorkspaceVerificationCoordinator | undefined;
  private readonly workspaceLeaseOwnerId: string | undefined;
  private boundRepositoryState: BoundRepositoryState | undefined;
  private readonly existingSandboxId?: string | undefined;
  private existingSandboxInfo: SandboxInfo | undefined;
  // Cached promise to prevent concurrent sub-agents from creating duplicate sandboxes.
  private sandboxCreationPromise?: Promise<SandboxInfo> | undefined;
  private sandboxInitPromise?: Promise<void> | undefined;
  private codeExecToolSets: readonly IToolSet[] = [];
  private readonly fileDownloadEnabled: boolean;
  private readonly requestTimeoutSeconds: number;
  private readonly skillMounter?: ISkillMounter | undefined;
  private cachedSkillsSection?: string | undefined;
  private readonly logger: Logger;
  // Pre-resolved credential-store file content (null = clear / no git auth).
  private readonly resolvedGitCredentialsContent: string | null;
  private readonly githubConnectorAttached: boolean;
  private readonly webConnectorAttached: boolean;
  private readonly webConnectorToolHint: string;
  private readonly ocrLanguages: string;
  private codeModeDispatcher: CodeModeDispatcher | undefined;
  private codeModeTransport: CodeModeTransport | undefined;
  /** Cached from transport.getClientInstall after sandbox init (when Code Mode is configured). */
  private mcpClientInstall: CodeModeClientInstall | undefined;
  /** Cached prerequisite check results: skill name -> reason unavailable. Empty map = all available. */
  private unavailableSkillsCache: Map<string, string> = new Map<string, string>();
  /** Flag to track if we've already checked prerequisites. */
  private prerequisitesChecked = false;
  /** PATH-resolution cache for the exec interpreter guard (preflight runs per call). */
  private readonly execGuardResolveCache = new Map<string, string | undefined>();
  /** Code-execution backend behind `run_code`; undefined when no isolation driver is configured. */
  private readonly runCodeService: RunCodeBackend | undefined;
  /** host sink for harvested run_code file bytes; undefined when the host wires no persistence. */
  private readonly runCodeHarvestSink: ((files: HarvestedFile[]) => Promise<void>) | undefined;
  /**
   * Turn attachments staged by {@link uploadUserFile}, keyed by staged filePath.
   * `run_code` passes these to the isolation driver as `/ingress` files, so the
   * model reads them by filename instead of re-uploading bytes via `files_in`.
   */
  private readonly runCodeIngressStaging = new Map<string, TurnAttachment>();

  private tools = [
    defineTool({
      name: SANDBOX_EXEC_TOOL_NAME,
      description: SANDBOX_EXEC_DESCRIPTION,
      schema: sandboxExecSchema,
      handler: (input, approvalDecision, context) => this.handleExec(input, approvalDecision, context),
    }),
    defineTool({
      name: SANDBOX_RUN_CODE_TOOL_NAME,
      // Description is rendered per turn in getTools(): the /ingress list is dynamic.
      description: SANDBOX_RUN_CODE_DESCRIPTION,
      schema: RunCodeInputSchema,
      handler: (input, _approvalDecision, context) => this.handleRunCode(input, context),
    }),
    defineTool({
      name: SANDBOX_APPLY_PATCH_TOOL_NAME,
      description: SANDBOX_APPLY_PATCH_DESCRIPTION,
      schema: sandboxApplyPatchSchema,
      handler: (input, approvalDecision, context) => this.handleApplyPatch(input, approvalDecision, context),
    }),
    defineTool({
      name: SANDBOX_REPLACE_TEXT_TOOL_NAME,
      description: SANDBOX_REPLACE_TEXT_DESCRIPTION,
      schema: sandboxReplaceTextSchema,
      handler: (input, approvalDecision, context) => this.handleReplaceText(input, approvalDecision, context),
    }),
    defineTool({
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      description: SANDBOX_WRITE_FILE_DESCRIPTION,
      schema: sandboxWriteFileSchema,
      handler: (input, approvalDecision, context) => this.handleWriteFile(input, approvalDecision, context),
    }),
    defineTool({
      name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
      description: SANDBOX_RUN_REGISTERED_COMMAND_DESCRIPTION,
      schema: sandboxRunRegisteredCommandSchema,
      handler: (input, approvalDecision, context) => this.handleRunRegisteredCommand(input, approvalDecision, context),
    }),
    defineTool({
      name: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
      description: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_DESCRIPTION,
      schema: sandboxImplementationPlanSchema,
      handler: (input, approvalDecision) => this.handleSubmitImplementationPlan(input, approvalDecision),
    }),
  ];

  constructor(options: SandboxOptions) {
    super({ tracing: options.tracing });
    this.provider = options.provider;
    this.boundRepository = options.boundRepository;
    this.loadBoundRepository = options.loadBoundRepository;
    this.onRepositorySources = options.onRepositorySources;
    this.workspaceVerificationCoordinator = options.workspaceVerificationCoordinator;
    this.workspaceLeaseOwnerId = options.workspaceLeaseOwnerId;
    this.existingSandboxId = options.existingSandboxId;
    this.skillMounter = options.skillMounter;
    this.fileDownloadEnabled = options.fileDownloadEnabled ?? false;
    const mcpBoundTimeoutMs = options.mcpRequestTimeoutMs + options.mcpConnectTimeoutMs;
    this.requestTimeoutSeconds = Math.ceil(mcpBoundTimeoutMs / 1000) + NATS_REQUEST_TIMEOUT_BUFFER_SECONDS;
    this.logger = options.logger.child({ module: 'Sandbox' });
    this.resolvedGitCredentialsContent = options.resolvedGitCredentialsContent ?? null;
    this.githubConnectorAttached = options.githubConnectorAttached ?? false;
    this.webConnectorAttached = options.webConnectorAttached ?? false;
    this.runCodeService = options.runCodeService;
    this.runCodeHarvestSink = options.onRunCodeHarvestedFiles;
    this.webConnectorToolHint = options.webConnectorToolHint ?? "the web connector's fetch or extract tool";
    this.ocrLanguages = options.ocrLanguages ?? '';
    this.sentinelContext = options.sentinel;

    if (this.existingSandboxId) {
      this.existingSandboxInfo = { sandbox_id: this.existingSandboxId };
    }
  }

  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const requestedCwd = typeof params.arguments?.['cwd'] === 'string' ? params.arguments['cwd'] : undefined;
    const cwd = requestedCwd ?? this.boundRepository?.workspace_cwd ?? this.provider.getWorkspaceDir();
    // Every structured-edit tool call's arguments pass through the same normalisation the
    // dispatch handlers apply, here at proposal time, so the approval card (built from `info`
    // below) and the structured-edit path extraction further down see exactly the arguments
    // `handleApplyPatch`/`handleReplaceText`/`handleWriteFile` will act on.
    const structuredEditToolName = structuredEditToolNameFor(params.name);
    let effectiveArguments = params.arguments;
    if (structuredEditToolName !== undefined && params.arguments !== undefined) {
      const normalization = normalizeStructuredEditArguments({
        toolName: structuredEditToolName,
        args: params.arguments,
        cwd: cwd ?? '',
        repositoryRoot: this.boundRepository?.workspace_cwd ?? cwd ?? '',
      });
      effectiveArguments = normalization.args;
    }
    const effectiveParams = { ...params, arguments: effectiveArguments };
    const info = await super.toolCallInfo(effectiveParams, resolveUnderlyingTool);
    const command = commandFromToolArguments(effectiveArguments);
    const purpose = purposeFromToolArguments(effectiveArguments);
    const env = environmentFromToolArguments(effectiveArguments);
    const output = outputFromToolArguments(effectiveArguments);
    const invocationPolicy = purpose === undefined ? undefined : sandboxInvocationPolicy({ command, purpose });
    const effect =
      params.name === SANDBOX_EXEC_TOOL_NAME
        ? (invocationPolicy?.effect ?? 'execute')
        : params.name === SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME
          ? 'verify'
          : params.name === SANDBOX_APPLY_PATCH_TOOL_NAME ||
              params.name === SANDBOX_REPLACE_TEXT_TOOL_NAME ||
              params.name === SANDBOX_WRITE_FILE_TOOL_NAME
            ? 'edit'
            : undefined;
    // Syntax-only risk signal for the approval prompt (open_world_hint). Never
    // consulted for admission: a network-tool command is already gated by its
    // ordinary effect (only 'inspect' auto-admits), so this only adds
    // information, never changes whether approval is required.
    const networkIntent = params.name === SANDBOX_EXEC_TOOL_NAME && sandboxCommandHasNetworkIntent(command);
    const invalidGitMetadataEdit =
      params.name === SANDBOX_REPLACE_TEXT_TOOL_NAME &&
      targetsGitMetadata(replacePathFromToolArguments(effectiveArguments));
    // Invalid exec requests must reach handleExec without an approval prompt so
    // its deterministic preflight error is returned before any command runs.
    const invalidExecPreflight =
      params.name === SANDBOX_EXEC_TOOL_NAME &&
      sandboxExecPreflightFailure({
        command,
        purpose,
        cwd,
        env,
        output,
        webConnectorAttached: this.webConnectorAttached,
        webConnectorToolHint: this.webConnectorToolHint,
        resolveCache: this.execGuardResolveCache,
      }) !== undefined;
    const invalidWriteFilePath =
      params.name === SANDBOX_WRITE_FILE_TOOL_NAME &&
      writeFilePathPreflightFailure({
        path: writeFilePathFromToolArguments(effectiveArguments),
        root: this.boundRepository?.workspace_cwd ?? this.provider.getWorkspaceDir() ?? '',
        cwd: cwd ?? '',
      }) !== undefined;
    const writeFileScopeFailure =
      params.name === SANDBOX_WRITE_FILE_TOOL_NAME
        ? lexicalWriteFileWorkspaceScope({
            cwd: requestedCwd,
            binding: this.boundRepository,
            scratchRoot: this.provider.getWorkspaceDir(),
          }).status === 'invalid'
        : false;
    const registeredCommandId =
      params.name === SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME && typeof params.arguments?.['command_id'] === 'string'
        ? params.arguments['command_id']
        : undefined;
    const registeredCommand = this.boundRepository?.commands.find(
      candidate => candidate.command_id === registeredCommandId,
    );
    const invalidRegisteredCommand =
      params.name === SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME && registeredCommand === undefined;
    const planInput =
      params.name === SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME
        ? sandboxImplementationPlanSchema.safeParse(params.arguments)
        : undefined;
    const implementationPlanGrant = planInput?.success ? this.mintImplementationPlanGrant(planInput.data) : undefined;
    const implementationPlanScope = sandboxImplementationPlanScope({
      toolName: params.name,
      argumentsValue: effectiveArguments,
      binding: this.boundRepository,
    });
    const implementationPlanBinding =
      implementationPlanScope === undefined ||
      this.boundRepository === undefined ||
      this.boundRepositoryState === undefined
        ? undefined
        : {
            repository_id: this.boundRepository.repository_id,
            repository_revision: this.boundRepository.revision,
            workspace_cwd: this.boundRepository.workspace_cwd,
            checkout_id: this.boundRepositoryState.checkout_id,
            branch: this.boundRepositoryState.branch,
            head_sha: this.boundRepositoryState.head_sha,
          };
    const structuredEditKind =
      params.name === SANDBOX_APPLY_PATCH_TOOL_NAME
        ? ('apply_patch' as const)
        : params.name === SANDBOX_REPLACE_TEXT_TOOL_NAME
          ? ('replace_text' as const)
          : undefined;
    const structuredEditPaths =
      structuredEditKind === 'replace_text'
        ? (() => {
            const resolution = extractStructuredEditPaths({
              kind: 'replace_text',
              repositoryRoot: this.boundRepository?.workspace_cwd ?? cwd ?? '',
              cwd: cwd ?? '',
              path: replacePathFromToolArguments(effectiveArguments),
            });
            return resolution.status === 'valid' ? resolution.paths : [];
          })()
        : structuredEditKind === 'apply_patch'
          ? (() => {
              // effectiveArguments['patch'] has already been normalized above, including an
              // OpenAI-format apply_patch envelope's conversion to a git diff — the single
              // normaliser is the only place that conversion happens now, so the approval
              // identity, precondition capture, and description below are derived from the same
              // real paths handleApplyPatch will act on. No sandbox is touched here, so that
              // conversion used placeholder hunk offsets; exact offsets are computed separately,
              // once the sandbox is available, before actually applying.
              const patch = typeof effectiveArguments?.['patch'] === 'string' ? effectiveArguments['patch'] : '';
              const resolution = extractStructuredEditPaths({
                kind: 'apply_patch',
                repositoryRoot: this.boundRepository?.workspace_cwd ?? cwd ?? '',
                cwd: cwd ?? '',
                patch,
              });
              return resolution.status === 'valid' ? resolution.paths : [];
            })()
          : [];
    let structuredEditPrecondition: StructuredEditPrecondition | undefined;
    let structuredEditPreconditionFailure: string | undefined;
    if (resolveUnderlyingTool === true && structuredEditKind !== undefined && structuredEditPaths.length > 0) {
      // Must match the repositoryRoot used above to derive structuredEditPaths so the
      // observation joins the same root the paths were made relative to. enforceStructuredEditPrecondition
      // at dispatch time recomputes this identical expression as its observationRoot.
      const observationRoot = this.boundRepository?.workspace_cwd ?? cwd;
      if (observationRoot === undefined) {
        structuredEditPreconditionFailure =
          'The host could not identify the workspace for this structured edit. Read the target again and submit a fresh edit request.';
      } else {
        try {
          const { sandboxInfo } = await this.ensureReadySandbox();
          structuredEditPrecondition = await this.captureStructuredEditPrecondition({
            sandboxId: this.providerSandboxId(sandboxInfo.sandbox_id),
            observationRoot,
            lockRoot: observationRoot,
            cwd,
            kind: structuredEditKind,
            paths: structuredEditPaths,
          });
        } catch (error) {
          structuredEditPreconditionFailure = `The host could not observe the structured-edit target before approval: ${
            error instanceof Error ? error.message : 'unknown observation failure'
          }. Read the target again and submit a fresh edit request.`;
        }
      }
    }
    const invalidImplementationPlan =
      params.name === SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME && implementationPlanGrant === undefined;
    const structuredEditPreDispatchFailure: InternalToolCallInfo['pre_dispatch_failure'] =
      structuredEditPreconditionFailure === undefined
        ? undefined
        : {
            kind: 'policy_blocked',
            message: structuredEditPreconditionFailure,
          };
    // Sentinel: authoritative tier classification over the normalized
    // arguments, but only when the host wired a Sentinel context. Without
    // one, no classification runs and the legacy effect-based approval
    // override applies. Invalid calls are fail-closed to
    // approval-required=false with their existing pre-dispatch failure.
    const sentinelHost = this.sentinelContext;
    let sentinelStamp: ReturnType<typeof stampSentinelDecision> | undefined;
    if (sentinelHost !== undefined) {
      const sentinelDecision = await classifyHostToolCall({
        sentinel: sentinelHost,
        repository_id: this.boundRepository?.repository_id ?? null,
        workspace_cwd: this.boundRepository?.workspace_cwd ?? cwd ?? null,
        action: {
          tool_name: params.name,
          canonical_params: effectiveArguments ?? {},
          tool_type: 'truefoundry-system',
          sandbox_effect: effect,
          mcp_hints: {
            read_only_hint: info.read_only_hint,
            destructive_hint: info.destructive_hint,
            open_world_hint: networkIntent ? true : info.open_world_hint,
          },
        },
      });
      sentinelStamp = stampSentinelDecision({ decision: sentinelDecision });
    }
    const invalidCall =
      invalidGitMetadataEdit ||
      invalidExecPreflight ||
      invalidWriteFilePath ||
      writeFileScopeFailure ||
      invalidRegisteredCommand ||
      invalidImplementationPlan ||
      structuredEditPreconditionFailure !== undefined;
    // Legacy approval when Sentinel is not configured: the pre-Sentinel
    // effect-based override. Tools with a classified effect need approval
    // unless the effect is pure inspection; tools without an effect keep the
    // source's own stamping.
    const legacyApprovalRequired =
      effect !== undefined ? sandboxCommandRequiresApproval(effect) : info.is_approval_required;
    return {
      ...info,
      // The approval token (if any) was minted over the invoked name and the
      // normalized effective arguments, not the remapped original_tool_name or
      // the raw wire arguments. Record the exact mint identity so pre-dispatch
      // verification hashes the same values.
      mint_tool_name: params.name,
      mint_canonical_params: toJsonSafeParams(effectiveArguments ?? {}),
      original_tool_name:
        params.name === SANDBOX_EXEC_TOOL_NAME
          ? purpose === undefined
            ? `${SANDBOX_EXEC_TOOL_NAME}:invalid`
            : sandboxCommandApprovalIdentity({ purpose, command, cwd: cwd ?? '', env: env ?? {} })
          : params.name === SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME
            ? registeredCommand === undefined || this.boundRepository === undefined
              ? `${SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME}:invalid`
              : `${SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME}:${this.boundRepository.repository_id}:${String(this.boundRepository.revision)}:${registeredCommand.command_id}`
            : params.name === SANDBOX_APPLY_PATCH_TOOL_NAME ||
                params.name === SANDBOX_REPLACE_TEXT_TOOL_NAME ||
                params.name === SANDBOX_WRITE_FILE_TOOL_NAME
              ? `${params.name}:edit`
              : params.name === SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME
                ? `${SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME}:${implementationPlanGrant?.grant_id ?? 'invalid'}`
                : params.name,
      ...(effect !== undefined && { effect }),
      ...(networkIntent && { open_world_hint: true }),
      ...(params.name !== SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME ||
      registeredCommand === undefined ||
      this.boundRepository === undefined
        ? {}
        : {
            command_execution: {
              repository_id: this.boundRepository.repository_id,
              repository_revision: this.boundRepository.revision,
              command_id: registeredCommand.command_id,
              command: registeredCommand.command,
              cwd: this.boundRepository.workspace_cwd,
              timeout_ms: registeredCommand.timeout_ms,
            },
          }),
      ...(implementationPlanGrant === undefined ? {} : { implementation_plan_grant: implementationPlanGrant }),
      ...(implementationPlanScope === undefined ? {} : { implementation_plan_scope: implementationPlanScope }),
      ...(implementationPlanBinding === undefined ? {} : { implementation_plan_binding: implementationPlanBinding }),
      ...(structuredEditPrecondition === undefined
        ? {}
        : {
            structured_edit_precondition: structuredEditPrecondition,
            description:
              info.description === undefined
                ? structuredEditPrecondition.summary
                : `${info.description} ${structuredEditPrecondition.summary}`,
          }),
      ...(sentinelStamp?.pre_dispatch_failure === undefined
        ? structuredEditPreDispatchFailure === undefined
          ? {}
          : { pre_dispatch_failure: structuredEditPreDispatchFailure }
        : { pre_dispatch_failure: sentinelStamp.pre_dispatch_failure }),
      is_approval_required: invalidCall ? false : (sentinelStamp?.is_approval_required ?? legacyApprovalRequired),
      ...(sentinelStamp === undefined
        ? {}
        : {
            tier: sentinelStamp.tier,
            tier3_card: sentinelStamp.tier3_card,
            tier2_kind: sentinelStamp.tier2_kind,
            approval_token_id: sentinelStamp.approval_token_id,
            approval_binding: sentinelStamp.approval_binding,
            shell_binding: sentinelStamp.shell_binding,
          }),
    };
  }

  /** The SessionHandle supplies owner scope and the durable final-admission reader. */
  setImplementationPlanGrantContext(input: ImplementationPlanGrantContext): void {
    this.implementationPlanGrantContext = input;
  }

  private mintImplementationPlanGrant(plan: ImplementationPlan) {
    const binding = this.boundRepository;
    const context = this.implementationPlanGrantContext;
    const state = this.boundRepositoryState;
    if (
      binding === undefined ||
      context === undefined ||
      state === undefined ||
      plan.repository_id !== binding.repository_id ||
      plan.repository_revision !== binding.revision ||
      plan.branch !== state.branch ||
      plan.head_sha !== state.head_sha ||
      plan.verify_command_ids.some(commandId => !binding.commands.some(command => command.command_id === commandId))
    ) {
      return undefined;
    }
    return mintImplementationPlanGrant({
      tenant_id: context.tenant_id,
      created_by: context.created_by,
      session_id: context.session_id,
      workspace_cwd: binding.workspace_cwd,
      checkout_id: state.checkout_id,
      plan,
    });
  }

  private async readRepositoryStateForBinding(
    sandboxId: string,
    binding: BoundRepository,
    signal?: AbortSignal,
  ): Promise<BoundRepositoryState | undefined> {
    const [stateResult, gitDirResult] = await Promise.all([
      this.execWorkspaceExclusive({
        sandboxId,
        workspaceRoot: binding.workspace_cwd,
        command: BOUND_REPOSITORY_STATE_COMMAND,
        cwd: binding.workspace_cwd,
        signal,
      }),
      this.execWorkspaceExclusive({
        sandboxId,
        workspaceRoot: binding.workspace_cwd,
        command: 'git rev-parse --absolute-git-dir',
        cwd: binding.workspace_cwd,
        signal,
      }),
    ]);
    if (!successfulExec(stateResult) || !successfulExec(gitDirResult)) {
      return undefined;
    }
    const stateFields = stateResult.response.result
      .split(/\r?\n/u)
      .map(field => field.trim())
      .filter(field => field.length > 0);
    const [repositoryRoot, branch, headSha] = stateFields;
    const gitDir = gitDirResult.response.result.trim();
    if (
      stateFields.length !== 3 ||
      repositoryRoot === undefined ||
      branch === undefined ||
      headSha === undefined ||
      repositoryRoot.length === 0 ||
      gitDir.length === 0 ||
      branch.length === 0 ||
      headSha.length === 0
    ) {
      return undefined;
    }
    if (!repositoryRootsMatch({ expected: binding.workspace_cwd, actual: repositoryRoot })) {
      throw new Error(
        `Repository binding ${binding.repository_id} observed Git root ${repositoryRoot}, which does not match bound checkout ${binding.workspace_cwd}.`,
      );
    }
    const checkoutNodesResult = await this.execWorkspaceExclusive({
      sandboxId,
      workspaceRoot: binding.workspace_cwd,
      command: `ls -di -- .git ${shellEscape(gitDir)}`,
      cwd: binding.workspace_cwd,
      signal,
    });
    if (!successfulExec(checkoutNodesResult)) {
      return undefined;
    }
    const checkoutNodes = checkoutNodesResult.response.result.trim();
    if (checkoutNodes.length === 0) {
      return undefined;
    }
    return {
      branch,
      head_sha: headSha,
      checkout_id: implementationPlanCheckoutId({
        provider_type: this.provider.type,
        sandbox_id: sandboxId,
        repository_root: repositoryRoot,
        git_dir: gitDir,
        checkout_nodes: checkoutNodes,
      }),
    };
  }

  private async readActualBoundRepositoryState(sandboxId: string): Promise<ActualBoundRepositoryState | undefined> {
    const loadBoundRepository = this.loadBoundRepository;
    if (loadBoundRepository === undefined) {
      return undefined;
    }
    try {
      // The binding itself is mutable session state, so it must be reloaded before
      // selecting the workspace whose Git identity is measured.
      const actualBinding = await loadBoundRepository();
      if (actualBinding === undefined) {
        return undefined;
      }
      const state = await this.readRepositoryStateForBinding(sandboxId, actualBinding);
      return state === undefined ? undefined : { binding: actualBinding, ...state };
    } catch (error) {
      throw new ToolPreDispatchError(
        'Could not refresh the repository revision, branch, and HEAD before tool dispatch.',
        { cause: error },
      );
    }
  }

  private async assertFinalImplementationPlanAdmission(input: {
    sandboxId: string;
    context: ToolInvocationContext | undefined;
    scope: ImplementationPlanGrantScope | undefined;
    workspaceRoot: string | undefined;
  }): Promise<ImplementationPlanDispatchReservation | undefined> {
    const grantId =
      input.context?.admission_provenance.source === 'implementation_plan_grant'
        ? input.context.admission_provenance.grant_id
        : undefined;
    if (grantId === undefined) {
      return undefined;
    }
    const binding = this.boundRepository;
    const grantContext = this.implementationPlanGrantContext;
    if (binding === undefined || grantContext === undefined) {
      throw new ImplementationPlanAdmissionBlockedError(
        'Implementation plan grant context is unavailable. The action was not dispatched; request approval again.',
      );
    }
    if (input.scope === undefined) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The tool call has no valid host-derived implementation-plan scope. The action was not dispatched; request one-call approval or correct the repository-relative path.',
      );
    }
    if (
      input.workspaceRoot === undefined ||
      !repositoryRootsMatch({ expected: binding.workspace_cwd, actual: input.workspaceRoot })
    ) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The tool cwd does not resolve to the bound repository root. The action was not dispatched; correct the cwd or request one-call approval.',
      );
    }
    const dispatchId = input.context?.dispatch_id;
    if (dispatchId === undefined || dispatchId.length === 0) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The implementation plan dispatch identity is unavailable. The action was not dispatched; request approval again.',
      );
    }
    // Re-read the row for integrity/remediation detail; the atomic reservation
    // below remains authoritative for revocation ordering.
    let loaded: ImplementationPlanGrant | undefined;
    try {
      loaded = await grantContext.loadGrant(grantId);
    } catch (error) {
      throw new ToolPreDispatchError('Could not refresh the durable implementation plan grant before tool dispatch.', {
        cause: error,
      });
    }
    const grant = validateImplementationPlanGrant(loaded);
    if (grant === undefined) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The implementation plan grant was revoked or is no longer valid. The action was not dispatched; request one-call approval or submit a revised plan.',
      );
    }
    const actualState = await this.readActualBoundRepositoryState(input.sandboxId);
    if (actualState === undefined) {
      throw new ImplementationPlanAdmissionBlockedError(
        'Could not refresh the repository checkout, revision, branch, and HEAD for final plan admission. The action was not dispatched.',
      );
    }
    if (
      grant.grant_id !== grantId ||
      grant.tenant_id !== grantContext.tenant_id ||
      grant.created_by !== grantContext.created_by ||
      grant.session_id !== grantContext.session_id ||
      actualState.binding.repository_id !== binding.repository_id ||
      grant.plan.repository_id !== actualState.binding.repository_id ||
      grant.plan.repository_revision !== actualState.binding.revision ||
      grant.plan.verify_command_ids.some(
        commandId => !actualState.binding.commands.some(command => command.command_id === commandId),
      )
    ) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The implementation plan grant no longer matches this user, chat, repository, or repository revision. The action was not dispatched.',
      );
    }
    if (
      actualState.binding.workspace_cwd !== binding.workspace_cwd ||
      grant.workspace_cwd !== actualState.binding.workspace_cwd ||
      grant.checkout_id !== actualState.checkout_id
    ) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The bound workspace checkout changed after implementation plan approval. The action was not dispatched; inspect the checkout and submit a revised plan.',
      );
    }
    if (grant.plan.branch !== actualState.branch) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The repository branch drifted after implementation plan approval. The action was not dispatched; inspect the checkout and submit a revised plan.',
      );
    }
    if (grant.plan.head_sha !== actualState.head_sha) {
      throw new ImplementationPlanAdmissionBlockedError(
        'The repository HEAD drifted after implementation plan approval. The action was not dispatched; inspect the checkout and submit a revised plan.',
      );
    }
    if (!implementationPlanAllowsScope({ grant, scope: input.scope })) {
      throw new ImplementationPlanAdmissionBlockedError(
        'Implementation plan scope no longer admits this action. The action was not dispatched; request one-call approval or submit a revised plan.',
      );
    }
    let reservation: { status: 'admitted' } | { status: 'blocked' };
    try {
      // This commit is the durable cross-replica dispatch boundary and the
      // final await before the requested provider invocation begins.
      reservation = await grantContext.beginDispatch({
        grant_id: grant.grant_id,
        checkout_id: actualState.checkout_id,
        dispatch_id: dispatchId,
      });
    } catch (error) {
      throw new ToolPreDispatchError(
        'Could not reserve the durable implementation plan dispatch boundary. The action was not dispatched.',
        { cause: error },
      );
    }
    if (reservation.status !== 'admitted') {
      throw new ImplementationPlanAdmissionBlockedError(
        'The implementation plan grant was revoked, replaced, or already used for this dispatch. The action was not dispatched; request one-call approval or submit a revised plan.',
      );
    }
    return { grant_id: grant.grant_id, dispatch_id: dispatchId };
  }

  private async runReservedImplementationPlanDispatch<T>(
    reservation: ImplementationPlanDispatchReservation | undefined,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    if (reservation === undefined) {
      return dispatch();
    }
    const context = this.implementationPlanGrantContext;
    if (context === undefined) {
      throw new ImplementationPlanAdmissionBlockedError(
        'Implementation plan grant context disappeared before dispatch. The action was not dispatched.',
      );
    }
    try {
      return await dispatch();
    } finally {
      await context.completeDispatch(reservation);
    }
  }

  /** Filters batch admissions against the current owner binding and concrete checkout. */
  async implementationPlanGrantsForCurrentCheckout(
    grants: readonly ImplementationPlanGrant[],
  ): Promise<ImplementationPlanGrant[]> {
    const binding = this.boundRepository;
    const context = this.implementationPlanGrantContext;
    if (binding === undefined || context === undefined || grants.length === 0) {
      return [];
    }
    try {
      const { sandboxInfo } = await this.ensureReadySandbox();
      const actual = await this.readActualBoundRepositoryState(this.providerSandboxId(sandboxInfo.sandbox_id));
      if (actual?.binding.workspace_cwd !== binding.workspace_cwd) {
        return [];
      }
      return grants.filter(
        grant =>
          grant.tenant_id === context.tenant_id &&
          grant.created_by === context.created_by &&
          grant.session_id === context.session_id &&
          grant.workspace_cwd === actual.binding.workspace_cwd &&
          grant.checkout_id === actual.checkout_id &&
          grant.plan.repository_id === actual.binding.repository_id &&
          grant.plan.repository_revision === actual.binding.revision &&
          grant.plan.branch === actual.branch &&
          grant.plan.head_sha === actual.head_sha,
      );
    } catch (error) {
      this.logger.warn(
        'Could not refresh implementation-plan grants for the current checkout',
        extractErrorLogFields(error),
      );
      return [];
    }
  }

  /** Provider-facing id (unwraps `v1:type:raw`; legacy ids pass through). */
  private providerSandboxId(sessionId: string): string {
    return rawSandboxId(sessionId);
  }

  /** Raw id for prompt layout paths before create (empty when this turn has no existing sandbox). */
  private promptSandboxId(): string {
    return this.existingSandboxId === undefined ? '' : rawSandboxId(this.existingSandboxId);
  }

  private buildMcpServersEnvelope(): Record<string, SandboxMcpServerConfig> {
    const out: Record<string, SandboxMcpServerConfig> = {};
    for (const server of this.codeExecToolSets) {
      const allowedTools = server.getAllowedToolNamesForSandbox?.() ?? [];
      out[server.name] = { allowed_tools: allowedTools };
    }
    return out;
  }

  protected getTools() {
    const base =
      this.boundRepository === undefined
        ? this.tools.filter(
            tool =>
              tool.name !== SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME &&
              tool.name !== SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME,
          )
        : this.tools;
    // run_code's /ingress list is per-turn: re-render its description on every
    // tool-list read so newly staged attachments are advertised.
    return base.map(tool =>
      tool.name === SANDBOX_RUN_CODE_TOOL_NAME ? { ...tool, description: this.renderRunCodeDescription() } : tool,
    );
  }

  /** Atomically refreshes model-visible repository root, branch, and HEAD before each model request. */
  async refreshBoundRepositoryState(options: { signal?: AbortSignal | undefined } = {}): Promise<void> {
    const binding = this.boundRepository;
    if (binding === undefined) {
      return;
    }
    const signal = options.signal;
    throwIfSignalAborted(signal);
    const { sandboxInfo } = await this.ensureReadySandbox(signal);
    const sandboxId = this.providerSandboxId(sandboxInfo.sandbox_id);
    await withWorkspaceMutationLock(
      this.workspaceMutationKey(sandboxId, binding.workspace_cwd),
      async () => {
        const state = await this.readRepositoryStateForBinding(sandboxId, binding, signal);
        if (state === undefined) {
          throw new Error(
            `Repository binding ${binding.repository_id} cannot read canonical Git checkout state at ${binding.workspace_cwd}. Rebind the chat to a valid checkout.`,
          );
        }
        await this.observeRepositoryCommandSources({ sandboxId, binding, signal });
        throwIfSignalAborted(signal);
        this.boundRepositoryState = state;
      },
      undefined,
      signal,
    );
  }

  /** Returns the T2 host-owned identity used for prompts and compaction reinjection. */
  getBoundRepositoryContext(): BoundRepositoryContext | undefined {
    const binding = this.boundRepository;
    if (binding === undefined) {
      return undefined;
    }
    return {
      ...boundRepositoryContextFromBinding(binding),
      branch: this.boundRepositoryState?.branch ?? null,
      head_sha: this.boundRepositoryState?.head_sha ?? null,
    };
  }

  private async observeRepositoryCommandSources(input: {
    sandboxId: string;
    binding: BoundRepository;
    signal: AbortSignal | undefined;
  }): Promise<void> {
    const observer = this.onRepositorySources;
    if (observer === undefined) {
      return;
    }
    const sources: RepositoryCommandSource[] = [];
    for (const source of REPOSITORY_COMMAND_SOURCE_FILES) {
      throwIfSignalAborted(input.signal);
      const absolutePath = repositorySourceAbsolutePath(input.binding.workspace_cwd, source.source_path);
      try {
        const content = await awaitWithAbort({
          operation: this.provider.downloadFile({
            sandboxId: input.sandboxId,
            path: absolutePath,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          }),
          signal: input.signal,
        });
        if (content.byteLength > MAX_REPOSITORY_COMMAND_SOURCE_BYTES) {
          this.logger.warn('Repository command source exceeds the bounded size and was ignored', {
            repositoryId: input.binding.repository_id,
            sourcePath: source.source_path,
            bytes: content.byteLength,
          });
          continue;
        }
        sources.push({
          ...source,
          source_fingerprint: `sha256:${createHash('sha256').update(content).digest('hex')}`,
          content: content.toString('utf8'),
        });
      } catch {
        throwIfSignalAborted(input.signal);
        // These files are optional. A missing source must not block the turn.
      }
    }
    if (sources.length === 0) {
      return;
    }
    try {
      throwIfSignalAborted(input.signal);
      await observer({ sources, signal: input.signal });
      throwIfSignalAborted(input.signal);
    } catch (error) {
      throwIfSignalAborted(input.signal);
      this.logger.warn('Failed to synchronize repository command proposals', {
        repositoryId: input.binding.repository_id,
        ...extractErrorLogFields(error),
      });
    }
  }

  configureCodeMode(servers: readonly IToolSet[]): void {
    if (!servers.length) {
      return;
    }
    if (this.codeModeDispatcher !== undefined || this.codeModeTransport !== undefined) {
      throw new Error('Code Mode is already configured for this Sandbox');
    }
    this.codeExecToolSets = servers;
    this.codeModeDispatcher = new CodeModeDispatcher({ toolSets: servers, logger: this.logger });
    this.codeModeTransport = this.provider.createCodeModeTransport();
  }

  estimateSkillsTokens(): number {
    return Math.round(estimateTokensForString(this.renderSkillsSection()));
  }

  // Single source for the <skills> section, so the prompt and the token estimate can't drift.
  private renderSkillsSection(): string {
    if (this.cachedSkillsSection === undefined) {
      const skills = new InstructionBuilder('skills');
      // Pass unavailable skills (empty map if none checked yet or all available)
      const unavailable = this.unavailableSkillsCache.size > 0 ? this.unavailableSkillsCache : undefined;
      this.skillMounter?.instruction(
        skills,
        { skillsDir: this.provider.getSkillsDir(this.promptSandboxId()) },
        unavailable,
      );
      this.cachedSkillsSection = skills.build();
    }
    return this.cachedSkillsSection;
  }

  buildInstruction(builder: InstructionBuilder): void {
    const providerInstructions = this.provider.getAdditionalInstructions();

    const sandboxInstructions = builder.beginSection('sandbox');
    sandboxInstructions.addContent('The Agent has access to a persistent sandbox environment for executing code.');
    sandboxInstructions.addContent('The Agent must NOT read or modify any git credential files.');
    if (this.boundRepository !== undefined) {
      const state = this.boundRepositoryState;
      const commands = this.boundRepository.commands
        .map(
          command =>
            `- command_id: ${command.command_id}; purpose: ${command.purpose}; timeout_ms: ${String(command.timeout_ms)}`,
        )
        .join('\n');
      sandboxInstructions.addSection(
        'bound-repository',
        dedent`
          This chat is host-bound to a repository. Use this state instead of guessing paths or commands.
          repository_id: ${this.boundRepository.repository_id}
          repository_revision: ${String(this.boundRepository.revision)}
          workspace_cwd: ${this.boundRepository.workspace_cwd}
          branch: ${state?.branch ?? 'unavailable'}
          head_sha: ${state?.head_sha ?? 'unavailable'}
          registered_commands:
          ${commands || '- none'}
          Use ${SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME} with command_id for registered checks. Do not restate their shell commands through exec.
        `,
      );
    } else {
      const workspaceDir = this.provider.getWorkspaceDir();
      if (workspaceDir !== undefined) {
        sandboxInstructions.addSection(
          'unbound-workspace',
          dedent`
            The provider has assigned a writable workspace.
            unbound_workspace_cwd: ${workspaceDir}
            For files this chat needs, such as a skill's references or a research note, use write_file with a cwd inside this directory, or omit cwd to default to it; it is scratch space with no repository behind it.
            For repository work, clone each repository into a named child of this directory. After cloning, pass the child checkout path as cwd for repository commands. The host does not infer or follow the new checkout automatically.
          `,
        );
      }
    }
    sandboxInstructions.addSection(
      'repository-work',
      dedent`
        For coding tasks, work from a checked-out repository in the sandbox. Use GitHub connectors for issues, pull requests, CI status, and repository management, not as the primary file editor.
        If the repository is not checked out, propose one authenticated git clone once. Do not fetch private repository files through web tools.
        Create the task branch immediately after cloning, before broad inspection. Every command starts in a fresh shell, so include the repository working directory explicitly with cwd. Setting HOME does not change the working directory.
        Inspect narrowly: search first, read only the relevant ranges, and normally spend no more than eight inspection calls before the first focused edit. Do not read whole large files or search installed dependency sources when the repository's own types and a compiler check can answer the question. After two searches return no matches, change strategy or ask one concise question instead of rephrasing the search.
        Batch discovery inside one command instead of issuing it one step at a time: read several files in one exec (\`sed -n 1,80p a.ts; echo ----; sed -n 1,80p b.ts\`), search several names in one call (\`rg -n 'nameA|nameB|nameC' src\`), and list with \`rg --files | rg pattern\` rather than one ls per directory. Each budget-consuming inspection step counts toward the host's inspection cap, so batching is how to stay under it.
        Before reading a file by path, confirm it exists with a listing or a search (ls, find, grep -l, rg -l) unless a previous result in this session already showed that path. Do not guess paths from component names.
        Before each tool call, write one short sentence in your visible reply stating what you are about to do and why. Put it in the answer, not in reasoning.
        Resolve repository facts from the local checkout before asking the user. Do not ask whether an API, schema, backend capability, file, or existing implementation exists when local inspection can answer it. Ask only for genuinely missing external information or a product decision whose alternatives would materially change the result.
        Before delegating coding work, include the exact absolute repository cwd in workspace_cwd. A coding sub-agent must use that local checkout and sandbox tools, not GitHub connectors, for source inspection, editing, commands, and verification.
        Once the evidence identifies a narrow integration gap, make the smallest plausible change and let the typechecker or focused test reveal missing details. Do not build parallel UI, storage, or domain abstractions that the repository already provides. If the requested concept has no authoritative persisted model, report that limitation rather than faking it with labels, title parsing, or browser-local state.
        Reproduce failures with the real command, edit local files, then run the relevant formatter, typecheck, tests, and build. Preserve command output and finish by showing the diff and verification results.
        A commit and a push are separate consequential actions. Never combine them. Request approval for the commit only after showing the diff, and request a separate approval before pushing.
      `,
    );

    this.buildSchemaSection(sandboxInstructions);
    this.buildSkillsSection(sandboxInstructions);
    this.buildMCPSection(sandboxInstructions);
    this.buildFileUploadsSection(sandboxInstructions);

    if (this.fileDownloadEnabled) {
      this.buildFileOutputSection(sandboxInstructions);
    }

    if (providerInstructions) {
      sandboxInstructions.addContent(providerInstructions);
    }
  }

  private buildFileUploadsSection(builder: InstructionBuilder): void {
    builder.addSection(
      SANDBOX_FILE_UPLOADS_TAG,
      `User-uploaded files are placed in ${this.provider.getFileUploadsDir(this.promptSandboxId())}/. The Agent must not modify files in this directory. Always create a copy at a different location and work on the copy.`,
    );
  }

  private buildSchemaSection(builder: InstructionBuilder): void {
    builder.addSection(
      SANDBOX_SCHEMA_INFER_TAG,
      dedent`
      To infer the schema of a file, the Agent MUST execute:
      head -c 200 file_path && echo "==" && genson file_path
      This serves two purpose:
      1. The first 200 characters of the file is printed. Do NOT print more than 200 characters.
      2. genson infers and returns JSON schema if the file is JSON.
      Even if the file is not JSON, (1) helps to take the next step in less number of turns
      `,
    );
  }

  private buildFileOutputSection(builder: InstructionBuilder): void {
    builder.addSection(
      SANDBOX_FILE_OUTPUT_TAG,
      dedent`
        ## File outputs

        The user does not have direct access to the sandbox filesystem. Downloads reach the user via the sandbox_artifacts block below (for exec-sandbox outputs) or as run_code/<name> paths (for run_code outputs); a file mentioned in prose without either is invisible to the user. When the Agent wants to output a file to the user, it MUST:
        1. Ensure that the file is present in the sandbox.
        2. Then emit a fenced sandbox_artifacts block referencing the file, using exactly this line format: [display name](/absolute/path), one file per line. Example:

        \`\`\`sandbox_artifacts
        [Lily James tribute video](/opt/tf/workspace/tribute.mp4)
        \`\`\`

        For large outputs or content that can be generated through code, prefer writing to a file and emitting the sandbox_artifacts block.

        Rules:
        - Use absolute paths, not ~/ or relative paths.
        - One line per file, formatted exactly as [display name](/absolute/path). No other format is recognized.`,
    );
  }

  private buildSkillsSection(builder: InstructionBuilder): void {
    builder.addContent(this.renderSkillsSection());
  }

  private buildMCPSection(builder: InstructionBuilder): void {
    const toolSetNames = this.codeExecToolSets.map(m => m.name).join(',');
    if (!toolSetNames) {
      return;
    }

    builder.addSection(
      SANDBOX_MCP_REMINDER_TAG,
      dedent`
        The following MCP servers are accessible for Code Mode from ${SANDBOX_EXEC_TOOL_NAME} via the pre-installed mcp_client module: ${toolSetNames}
        Tool and functions are same.
        Tool and MCP tools are same.

        Use \`from mcp_client import call_tool\` in code, or \`mcp-client\` in shell — both work from any directory with no setup.

        For deferred MCP servers, the Agent MUST:
        1. Discover tools via ${LIST_TOOLS_NAME} from ${DEFERRED_TOOLS_SERVER_ID}. Never call ${GET_TOOL_OUTPUT_SCHEMA_NAME}.
        2. Discover inputSchema, outputSchema via ${GET_TOOL_INFO_NAME} for the selected tools.

        For non-deferred MCP servers, the Agent MUST:
        1. Discover outputSchema via ${GET_TOOL_OUTPUT_SCHEMA_NAME} for the selected tools.

        For both deferred and non-deferred if outputSchema is absent,
        the Agent MUST say: "Given the MCP Server does not define an outputSchema let me figure it out first before entering Code Mode."
        mcp-client call-tool {server} {tool} '{"param":"value"}' > file && ${SANDBOX_SCHEMA_INFER_TAG}.
        the Agent MUST execute a single command for above.
        If the Agent does not get the outputSchema, the Agent will encounters scenarios like:
        Agent: "Let me fix the code - it seems the x might be a string rather than an object in some cases:"
        The Agent MUST not face the above scenario.
        
        Only after the Agent has the above details, it can enter Code Mode.
        Agent: Now I know the inputSchema and outputSchema of tool_a, let me enter Code Mode.

           CLI:   mcp-client call-tool {server} {tool_a} '{"param":"value"}'
                  # The output of the above command MUST be passed through tools like jq or head -c
                  # or should be written to a file. Goal is to reduce content that the Agent prints.

           Code:  from mcp_client import call_tool
                  async def main():
                      result = await call_tool("{server}", "{tool_a}", body={"param1": "value1"})
                      # In most cases, it is safe to assume response is a dict.
                      # To know the dict keys, the Agent still needs to figure out the outputSchema.
                      # The Agent MUST write the code to a file first before executing it.

        Code Mode MUST be used in following scenarios:

        1. Reduce structured tool output by executing logic on top of it. Never present raw output.
          Agent: Now I know the inputSchema and outputSchema of tool_a, let me enter Code Mode.

          from mcp_client import call_tool
          from collections import Counter
          result = await call_tool("{server}", "{tool_a}", body={"param1": "value1"})
          print(Counter(r["a"] for r in result["b"] if r["c"])) # Here we need outputSchema to know a, b and c exists.

        2. Piping result of one tool call to another tool request. Never present raw output.
          Agent: Now I know the inputSchema and outputSchema of tool1, let me enter Code Mode.

          from mcp_client import call_tool
          result1 = await call_tool("{server}", "{tool1}", body={"param1": "value1"})
          result2 = await call_tool("{server}", "{tool2}", body={"param2": result1["value1"]}) # Here we need outputSchema to know value1 exists.
          print(result2) # Note in this case, we do not need outputSchema of result2 as we are not using any fields.

        The Agent MUST NOT use Code Mode just to print the full raw response of a tool. The Agent MUST call the tool directly in this case, there are other mechanisms in place to ensure
        large tool call outputs are not loaded in context.
        
        The Agent must not use Code Mode in the following patterns:
        from mcp_client import call_tool
        import json
        result = await call_tool("{server}", "{tool}", body={"param1": "value1"})
        print(result) # Never do this. Call tool without Code Mode.
        print(json.dumps(result, ...)) # Never do this. Call tool without Code Mode.
        print(result["a"][:100]) # Never do this. Call tool without Code Mode.

        mcp-client call-tool {server} {tool} '{"param":"value"}' > data && cat data # Never do this. Call tool without Code Mode.
        `,
    );
  }

  private get requiredSandboxInfo(): SandboxInfo {
    if (!this.existingSandboxInfo) {
      throw new Error('Sandbox info not available');
    }
    return this.existingSandboxInfo;
  }

  /** Current provider identity, including a sandbox created during bound-state refresh. */
  getCurrentSandboxInfo(): SandboxInfo | undefined {
    return this.existingSandboxInfo;
  }

  private clearExistingSandbox(): void {
    this.existingSandboxInfo = undefined;
    this.sandboxCreationPromise = undefined;
    this.sandboxInitPromise = undefined;
    this.mcpClientInstall = undefined;
  }

  private async ensureSandboxCreated(signal?: AbortSignal): Promise<{
    sandboxInfo: SandboxInfo;
    sandboxCreated: SandboxInfo | undefined;
  }> {
    throwIfSignalAborted(signal);
    if (this.existingSandboxInfo) {
      return { sandboxInfo: this.existingSandboxInfo, sandboxCreated: undefined };
    }
    // Provider returns a raw id; persist the fancy `v1:type:raw` session id.
    if (this.sandboxCreationPromise === undefined) {
      const creation = signal === undefined ? this.provider.createSandbox() : this.provider.createSandbox({ signal });
      this.sandboxCreationPromise = awaitWithAbort({ operation: creation, signal })
        .then(({ sandboxId }) => ({
          sandbox_id: formatSandboxId({ providerType: this.provider.type, rawId: sandboxId }),
        }))
        .catch((e: unknown) => {
          this.sandboxCreationPromise = undefined;
          throw e;
        });
    }

    // Creation ownership is decided by the provider. Once it accepts a sandbox,
    // retain that identity before observing cancellation so provider and Sandbox
    // cannot disagree about an accepted resource.
    const sandboxInfo = await this.sandboxCreationPromise;
    // Concurrent callers may both await the same creation promise; only the first
    // should report sandboxCreated. Read through a method so TS does not keep the
    // pre-await "undefined" narrowing on the field.
    const raced = this.peekExistingSandboxInfo();
    if (raced !== undefined) {
      return { sandboxInfo: raced, sandboxCreated: undefined };
    }
    this.existingSandboxInfo = sandboxInfo;
    return { sandboxInfo, sandboxCreated: sandboxInfo };
  }

  private peekExistingSandboxInfo(): SandboxInfo | undefined {
    return this.existingSandboxInfo;
  }

  /** Same-type missing remote/local root: drop the stale id and create a new fancy id. */
  private async recreateAfterUnavailable(signal?: AbortSignal): Promise<{
    sandboxInfo: SandboxInfo;
    sandboxCreated: SandboxInfo;
  }> {
    this.clearExistingSandbox();
    const created = await this.ensureSandboxCreated(signal);
    if (created.sandboxCreated === undefined) {
      throw new Error('Sandbox recreate did not create a new sandbox');
    }
    return { sandboxInfo: created.sandboxInfo, sandboxCreated: created.sandboxCreated };
  }

  /**
   * Create or reattach, then init. A missing same-type sandbox throws
   * `SandboxNotAvailableError` from the provider; reattach then recreates.
   */
  private async ensureReadySandbox(signal?: AbortSignal): Promise<{
    sandboxInfo: SandboxInfo;
    sandboxCreated: SandboxInfo | undefined;
  }> {
    const first = await this.ensureSandboxCreated(signal);
    try {
      await this.ensureSandboxInitialized(signal);
      // Skill prerequisites gate skill availability in the prompt, so they are
      // resolved here — whenever the sandbox becomes ready — rather than after
      // the first exec call. Runs once per Sandbox (guarded by
      // prerequisitesChecked), including on freshly created sandboxes.
      await this.checkPrerequisites({ sandboxId: this.providerSandboxId(first.sandboxInfo.sandbox_id) });
      return first;
    } catch (error) {
      throwIfSignalAborted(signal);
      if (!(error instanceof SandboxNotAvailableError) || first.sandboxCreated !== undefined) {
        throw error;
      }
      const recreated = await this.recreateAfterUnavailable(signal);
      await this.ensureSandboxInitialized(signal);
      await this.checkPrerequisites({ sandboxId: this.providerSandboxId(recreated.sandboxInfo.sandbox_id) });
      return recreated;
    }
  }

  private async ensureReadySandboxForDispatch(toolName: string): Promise<{
    sandboxInfo: SandboxInfo;
    sandboxCreated: SandboxInfo | undefined;
  }> {
    try {
      return await this.ensureReadySandbox();
    } catch (error) {
      this.logger.error(`${toolName} sandbox setup failed before target dispatch`, extractErrorLogFields(error));
      throw new ToolPreDispatchError(`${toolName} sandbox setup failed before target dispatch.`, { cause: error });
    }
  }

  private async canonicalizeWriteFileWorkspaceScope(
    sandboxId: string,
    scope: WriteFileWorkspaceScope,
  ): Promise<WriteFileWorkspaceScope> {
    let workspaceResult: ExecResult;
    let cwdResult: ExecResult;
    try {
      [workspaceResult, cwdResult] = await Promise.all([
        this.provider.exec({
          sandboxId,
          command: `realpath -e -- ${shellEscape(scope.workspaceCwd)}`,
        }),
        this.provider.exec({
          sandboxId,
          command: `realpath -e -- ${shellEscape(scope.cwd)}`,
        }),
      ]);
    } catch (error) {
      throw new ToolPreDispatchError(
        'write_file cwd could not be canonicalized inside the workspace before dispatch.',
        { cause: error },
      );
    }

    const canonicalWorkspace = canonicalPathFromExec(workspaceResult);
    const canonicalCwd = canonicalPathFromExec(cwdResult);
    if (canonicalWorkspace === undefined || canonicalCwd === undefined) {
      throw new ToolPreDispatchError(
        'write_file cwd could not be canonicalized inside the workspace before dispatch.',
        { cause: new Error('realpath did not return two successful absolute paths') },
      );
    }
    const cwdRelative = posix.relative(canonicalWorkspace, canonicalCwd);
    if (relativePathEscapesRoot(cwdRelative)) {
      throw new ToolPreDispatchError(
        'write_file cwd is outside the workspace after canonicalization; the target was not dispatched.',
      );
    }
    return { workspaceCwd: canonicalWorkspace, cwd: canonicalCwd, cwdRelative };
  }
  private async resolveWorkspaceRoot(sandboxId: string, cwd: string | undefined): Promise<string | undefined> {
    const result = await this.provider.exec({
      sandboxId,
      command: 'git rev-parse --show-toplevel',
      cwd,
      ...(cwd === undefined ? {} : { workspaceLock: { workspaceRoot: cwd } }),
    });
    if (result.success && result.response.exitCode === 125 && cwd !== undefined) {
      // `125` is the provider lease's termination barrier. Treat the caller's
      // already-approved workspace cwd as the lock root so a failed discovery
      // cannot downgrade the retry into an unlocked provider request.
      return cwd;
    }
    if (!successfulExec(result)) {
      return undefined;
    }
    return result.response.result.trim() || undefined;
  }

  private normalizedWorkspacePath(path: string): string {
    const windowsPath = /^[A-Za-z]:[\\/]/u.test(path) || path.includes('\\');
    const normalized = path.replace(/\\/gu, '/').replace(/\/+$/gu, '');
    return windowsPath ? normalized.toLowerCase() : normalized;
  }

  private workspaceMutationKey(sandboxId: string, workspaceRoot: string | undefined): string {
    const normalizedWorkspaceRoot =
      workspaceRoot === undefined ? '<unknown-workspace>' : normalizedRepositoryPath(workspaceRoot);
    return `${sandboxId}\u0000${normalizedWorkspaceRoot}`;
  }

  private async acquireDurableWorkspaceLease(input: {
    sandboxId: string;
    cwd: string | undefined;
    timeoutSeconds: number | undefined;
  }): Promise<({ status: 'acquired' } & DurableWorkspaceLease) | { status: 'blocked'; reason: string }> {
    const binding = this.boundRepository;
    const coordinator = this.workspaceVerificationCoordinator;
    const ownerId = this.workspaceLeaseOwnerId;
    if (binding === undefined || coordinator === undefined || ownerId === undefined) {
      return {
        status: 'blocked',
        reason:
          'Durable repository verification is unavailable for this checkout. Bind the chat to a repository with durable workspace coordination.',
      };
    }
    const workspaceRoot = await this.resolveWorkspaceRoot(input.sandboxId, input.cwd);
    if (
      workspaceRoot === undefined ||
      this.normalizedWorkspacePath(workspaceRoot) !== this.normalizedWorkspacePath(binding.workspace_cwd)
    ) {
      return { status: 'blocked', reason: 'The command cwd does not resolve to the bound repository workspace.' };
    }
    const workspaceKey = this.normalizedWorkspacePath(workspaceRoot);
    const leaseId = randomUUID();
    const commandBudgetMs = Math.max(60_000, (input.timeoutSeconds ?? 60) * 1000);
    const acquired = await coordinator.acquireLease({
      repository_id: binding.repository_id,
      workspace_cwd: workspaceKey,
      owner_id: ownerId,
      lease_id: leaseId,
      lease_expires_at: new Date(Date.now() + commandBudgetMs + 30_000),
    });
    if (acquired === undefined) {
      return {
        status: 'blocked',
        reason:
          'Another replica is currently verifying or mutating this repository workspace. Retry after it finishes.',
      };
    }
    const lease: { status: 'acquired' } & DurableWorkspaceLease = {
      status: 'acquired',
      repositoryId: binding.repository_id,
      workspaceRoot: workspaceKey,
      leaseId,
      mutationEpoch: acquired.mutation_epoch,
      ownershipLost: false,
      renewalInFlight: false,
      renewalTimer: undefined,
    };
    lease.renewalTimer = setInterval(() => {
      if (lease.renewalInFlight || lease.ownershipLost) {
        return;
      }
      lease.renewalInFlight = true;
      void this.renewDurableWorkspaceLease(lease).finally(() => {
        lease.renewalInFlight = false;
      });
    }, WORKSPACE_LEASE_RENEWAL_INTERVAL_MS);
    lease.renewalTimer.unref();
    return lease;
  }

  private async renewDurableWorkspaceLease(lease: DurableWorkspaceLease): Promise<boolean> {
    if (lease.ownershipLost) {
      return false;
    }
    const coordinator = this.workspaceVerificationCoordinator;
    if (coordinator === undefined) {
      lease.ownershipLost = true;
      return false;
    }
    try {
      const renewed = await coordinator.renewLease({
        repository_id: lease.repositoryId,
        workspace_cwd: lease.workspaceRoot,
        lease_id: lease.leaseId,
        lease_expires_at: new Date(Date.now() + WORKSPACE_LEASE_RENEWAL_TTL_MS),
      });
      if (!renewed) {
        lease.ownershipLost = true;
      }
      return renewed;
    } catch (error) {
      lease.ownershipLost = true;
      this.logger.warn('Durable workspace lease renewal failed', extractErrorLogFields(error));
      return false;
    }
  }

  private async beginDurableStateObservation(
    lease: DurableWorkspaceLease,
    invalidateReceipt = false,
  ): Promise<boolean> {
    if (!(await this.renewDurableWorkspaceLease(lease))) {
      return false;
    }
    const coordinator = this.workspaceVerificationCoordinator;
    return (
      coordinator?.beginStateObservation({
        repository_id: lease.repositoryId,
        workspace_cwd: lease.workspaceRoot,
        lease_id: lease.leaseId,
        invalidate_receipt: invalidateReceipt,
      }) ?? Promise.resolve(false)
    );
  }

  private async releaseDurableWorkspaceLease(lease: DurableWorkspaceLease): Promise<void> {
    if (lease.renewalTimer !== undefined) {
      clearInterval(lease.renewalTimer);
    }
    const coordinator = this.workspaceVerificationCoordinator;
    if (coordinator === undefined) {
      throw new Error('Durable workspace coordinator disappeared while a lease was held');
    }
    await coordinator.releaseLease({
      repository_id: lease.repositoryId,
      workspace_cwd: lease.workspaceRoot,
      lease_id: lease.leaseId,
    });
  }

  private async runObservedWorkspaceMutation<T>(input: {
    sandboxId: string;
    cwd: string | undefined;
    operation: () => Promise<T>;
  }): Promise<{ status: 'completed'; value: T } | { status: 'blocked'; reason: string }> {
    if (this.boundRepository === undefined) {
      return { status: 'completed', value: await input.operation() };
    }
    const lease = await this.acquireDurableWorkspaceLease({
      sandboxId: input.sandboxId,
      cwd: input.cwd,
      timeoutSeconds: undefined,
    });
    if (lease.status === 'blocked') {
      return lease;
    }
    const coordinator = this.workspaceVerificationCoordinator;
    if (coordinator === undefined) {
      throw new Error('Durable workspace coordinator disappeared while a lease was held');
    }
    try {
      const before = await this.captureWorkspaceVerificationIdentity(input.sandboxId, input.cwd);
      if (before === undefined) {
        return { status: 'blocked', reason: 'Could not capture Git state before the workspace edit.' };
      }
      if (!(await this.beginDurableStateObservation(lease))) {
        return { status: 'blocked', reason: 'Lost durable workspace ownership before the edit was dispatched.' };
      }
      let value: T;
      try {
        value = await withWorkspaceMutationLock(
          this.workspaceMutationKey(input.sandboxId, lease.workspaceRoot),
          async () => input.operation(),
        );
      } catch (error) {
        if (!(await this.renewDurableWorkspaceLease(lease))) {
          throw error;
        }
        const afterFailure = await this.captureWorkspaceVerificationIdentity(input.sandboxId, input.cwd);
        if (!(await this.renewDurableWorkspaceLease(lease))) {
          throw error;
        }
        await coordinator.observeState({
          repository_id: lease.repositoryId,
          workspace_cwd: lease.workspaceRoot,
          lease_id: lease.leaseId,
          before_state_sha256: before.stateSha256,
          after_state_sha256: afterFailure?.stateSha256 ?? null,
        });
        throw error;
      }
      if (!(await this.renewDurableWorkspaceLease(lease))) {
        throw new Error('Lost durable workspace ownership after the edit was dispatched');
      }
      const after = await this.captureWorkspaceVerificationIdentity(input.sandboxId, input.cwd);
      if (!(await this.renewDurableWorkspaceLease(lease))) {
        throw new Error('Lost durable workspace ownership during post-edit state capture');
      }
      const observed = await coordinator.observeState({
        repository_id: lease.repositoryId,
        workspace_cwd: lease.workspaceRoot,
        lease_id: lease.leaseId,
        before_state_sha256: before.stateSha256,
        after_state_sha256: after?.stateSha256 ?? null,
      });
      if (observed === undefined) {
        throw new Error('Lost durable workspace ownership before the edit outcome could be recorded');
      }
      return { status: 'completed', value };
    } finally {
      await this.releaseDurableWorkspaceLease(lease);
    }
  }

  private async captureStructuredEditPrecondition(input: {
    sandboxId: string;
    /** Root the structured-edit paths are relative to; joined with each path to observe it. Must be the
     * same expression used to derive those paths (`boundRepository?.workspace_cwd ?? cwd`), not the Git
     * toplevel, or the observation targets the wrong file when cwd is not the toplevel. */
    observationRoot: string;
    /** Root passed to the provider as the workspace lock. Independent of observationRoot: this may be the
     * Git toplevel while observationRoot stays cwd-relative. */
    lockRoot: string | undefined;
    cwd: string | undefined;
    kind: StructuredEditPrecondition['kind'];
    paths: readonly string[];
  }): Promise<StructuredEditPrecondition> {
    const result = await this.execWorkspaceExclusive({
      sandboxId: input.sandboxId,
      workspaceRoot: input.lockRoot,
      cwd: input.cwd,
      command: buildStructuredEditObservationCommand({
        kind: input.kind,
        workspaceRoot: input.observationRoot,
        paths: input.paths,
      }),
    });
    if (!successfulExec(result) || result.response.exitCode !== 0) {
      throw new Error(
        successfulExec(result)
          ? `Target observation exited with code ${String(result.response.exitCode)}.`
          : result.error,
      );
    }
    return parseStructuredEditObservation(result.response.result, input.paths);
  }

  private async enforceStructuredEditPrecondition(input: {
    sandboxId: string;
    /** Same root the paths passed for this edit were resolved against; see captureStructuredEditPrecondition. */
    observationRoot: string | undefined;
    /** Workspace lock root (typically the Git toplevel); independent of observationRoot. */
    lockRoot: string | undefined;
    cwd: string | undefined;
    kind: StructuredEditPrecondition['kind'];
    paths: readonly string[];
    approved: StructuredEditPrecondition | undefined;
  }): Promise<void> {
    const observationRoot = input.observationRoot;
    if (observationRoot === undefined) {
      throw new StructuredEditPreconditionBlockedError(
        'The host could not identify the structured-edit workspace. Read the target again and submit a fresh edit request.',
      );
    }
    if (input.approved === undefined) {
      throw new StructuredEditPreconditionBlockedError(
        'The structured edit has no host-observed approval precondition. Read the target again and submit a fresh edit request.',
      );
    }
    let current: StructuredEditPrecondition;
    try {
      current = await this.captureStructuredEditPrecondition({ ...input, observationRoot });
    } catch (error) {
      throw new StructuredEditPreconditionBlockedError(
        `The host could not re-observe the structured-edit target after approval. No edit was dispatched. Read the target again and submit a fresh edit request: ${
          error instanceof Error ? error.message : 'unknown observation failure'
        }`,
        { cause: error },
      );
    }
    if (!structuredEditObservationMatches(input.approved, current)) {
      throw new StructuredEditPreconditionBlockedError(
        'The structured-edit target changed after approval. No edit was dispatched. Read the target again and submit a fresh edit request.',
      );
    }
  }

  private async execWorkspaceExclusive(input: {
    sandboxId: string;
    workspaceRoot: string | undefined;
    command: string;
    cwd: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutSeconds?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<ExecResult> {
    const operation = this.provider.exec({
      sandboxId: input.sandboxId,
      command: input.command,
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.workspaceRoot === undefined ? {} : { workspaceLock: { workspaceRoot: input.workspaceRoot } }),
    });
    return input.signal === undefined ? operation : await awaitWithAbort({ operation, signal: input.signal });
  }

  private async captureWorkspaceVerificationIdentity(
    sandboxId: string,
    cwd: string | undefined,
  ): Promise<WorkspaceVerificationIdentity | undefined> {
    const read = async (input: { command: string; commandCwd: string | undefined }): Promise<string | undefined> => {
      const result = await this.provider.exec({
        sandboxId,
        command: input.command,
        cwd: input.commandCwd,
        ...(input.commandCwd === undefined ? {} : { workspaceLock: { workspaceRoot: input.commandCwd } }),
      });
      return successfulExec(result) ? result.response.result : undefined;
    };

    try {
      const workspaceRoot = (await read({ command: 'git rev-parse --show-toplevel', commandCwd: cwd }))?.trim();
      if (!workspaceRoot) {
        return undefined;
      }
      const branch = (await read({ command: 'git rev-parse --abbrev-ref HEAD', commandCwd: workspaceRoot }))?.trim();
      const head = (await read({ command: 'git rev-parse HEAD', commandCwd: workspaceRoot }))?.trim();
      const refs = await read({ command: GIT_REFS_COMMAND, commandCwd: workspaceRoot });
      const taggedTrackedPaths = await read({ command: 'git ls-files -v -z', commandCwd: workspaceRoot });
      const indexDiff = await read({
        command: 'git diff --cached --binary --no-ext-diff --no-textconv --no-color HEAD --',
        commandCwd: workspaceRoot,
      });
      const trackedWorktreeDiff = await read({
        command: 'git diff --binary --no-ext-diff --no-textconv --no-color --',
        commandCwd: workspaceRoot,
      });
      const untrackedPathList = await read({
        command: 'git ls-files --others --exclude-standard -z',
        commandCwd: workspaceRoot,
      });
      if (
        !branch ||
        !head ||
        refs === undefined ||
        taggedTrackedPaths === undefined ||
        gitIndexHidesTrackedPaths(taggedTrackedPaths) ||
        indexDiff === undefined ||
        trackedWorktreeDiff === undefined ||
        untrackedPathList === undefined
      ) {
        return undefined;
      }
      const untrackedPaths = untrackedPathList
        .split('\0')
        .filter(path => path.length > 0)
        .sort((left, right) => left.localeCompare(right));
      const untrackedFiles: { path: string; objectSha: string }[] = [];
      for (const path of untrackedPaths) {
        const objectSha = (
          await read({
            command: `git hash-object --no-filters -- ${shellEscape(path)}`,
            commandCwd: workspaceRoot,
          })
        )?.trim();
        if (!objectSha) {
          return undefined;
        }
        untrackedFiles.push({ path, objectSha });
      }
      const refsSha256 = createHash('sha256').update(refs).digest('hex');
      const indexSha256 = createHash('sha256').update(indexDiff).digest('hex');
      const trackedWorktreeSha256 = createHash('sha256').update(trackedWorktreeDiff).digest('hex');
      const untrackedSha256 = createHash('sha256').update(JSON.stringify(untrackedFiles)).digest('hex');
      const stateSha256 = createHash('sha256')
        .update(JSON.stringify({ branch, head, refsSha256, indexSha256, trackedWorktreeSha256, untrackedSha256 }))
        .digest('hex');
      return {
        sandboxId,
        workspaceRoot,
        branch,
        head,
        refsSha256,
        indexSha256,
        trackedWorktreeSha256,
        untrackedSha256,
        stateSha256,
      };
    } catch (error) {
      this.logger.warn(
        'Could not capture Git workspace identity for commit verification',
        extractErrorLogFields(error),
      );
      return undefined;
    }
  }

  private async decorateExecResult(
    result: ExecResult,
    sandboxId: string,
    input: SandboxRuntimeExecInput,
  ): Promise<Record<string, unknown>> {
    const decorated = await this.decorateExecResultBase(result, sandboxId, input);

    // Add status, exit_code, and error_summary at the top level for model visibility
    const resultShape = buildExecResultShape(
      result.success ? result.response.exitCode : -1,
      input.command,
      result.success ? result.response.result : result.error,
      result.success,
    );
    const withStatus = {
      status: resultShape.status,
      exit_code: resultShape.exit_code,
      error_summary: resultShape.error_summary,
      note: resultShape.note,
      ...decorated,
    };

    if (!result.success) {
      // Sandbox infra failure — the command never ran, so there is no git output to classify.
      return withStatus;
    }
    if (result.response.exitCode === 0) {
      return withStatus;
    }
    const connectorState: GithubConnectorState = !this.githubConnectorAttached
      ? 'not-attached'
      : this.resolvedGitCredentialsContent === null
        ? 'unresolved'
        : 'attached';
    const remediation = getGithubConnectorHint({
      command: input.command,
      output: execResultOutputText(result),
      connectorState,
    });
    return remediation === undefined ? withStatus : { ...withStatus, remediation };
  }

  private async decorateExecResultBase(
    result: ExecResult,
    sandboxId: string,
    input: SandboxRuntimeExecInput,
  ): Promise<Record<string, unknown>> {
    if (!providerSuccessfulExec(result)) {
      return { ...result };
    }
    if (input.output === undefined) {
      return { ...result };
    }
    const rawOutput = result.response.result;
    const rawOutputBytes = Buffer.from(rawOutput, 'utf-8');
    const rawOutputSha256 = createHash('sha256').update(rawOutputBytes).digest('hex');
    const commandSha256 = createHash('sha256').update(input.command).digest('hex');
    const artifactKey = createHash('sha256')
      .update(
        JSON.stringify({
          command_sha256: commandSha256,
          cwd: input.cwd ?? null,
          purpose: input.purpose,
          output_sha256: rawOutputSha256,
        }),
      )
      .digest('hex');
    const rawOutputPath = `${this.provider.getToolResultDumpDir(sandboxId).replace(/\/+$/g, '')}/exec-output-${artifactKey.slice(0, 32)}.txt`;
    let rawOutputStorageStatus: 'stored' | 'failed' = 'stored';
    try {
      await this.provider.uploadFile({
        sandboxId,
        remotePath: rawOutputPath,
        content: rawOutputBytes,
      });
    } catch (error) {
      rawOutputStorageStatus = 'failed';
      this.logger.warn('Durable raw output storage failed for completed sandbox exec', {
        sandboxId,
        rawOutputPath,
        error: error instanceof Error ? error.name : 'unknown_error',
      });
    }
    return {
      ...result,
      response: {
        ...result.response,
        result: applyExecOutputBounds(rawOutput, input.output),
      },
      raw_output: {
        file_path: rawOutputPath,
        sha256: rawOutputSha256,
        byte_length: rawOutputBytes.byteLength,
        storage_status: rawOutputStorageStatus,
        ...(rawOutputStorageStatus === 'failed'
          ? {
              storage_error:
                'Durable raw output storage failed; the bounded result is available, but complete raw output was not persisted.',
            }
          : {}),
        provenance: {
          command_sha256: commandSha256,
          purpose: input.purpose,
          cwd: input.cwd ?? null,
        },
      },
      output_bounds: input.output,
    };
  }

  /**
   * Captures bounded, host-authenticated repository evidence after abnormal
   * termination. This bypasses model dispatch so a handoff remains available
   * after the normal agent loop has stopped.
   */
  async captureAbnormalHandoffEvidence(): Promise<AbnormalHandoffEvidence> {
    const binding = this.boundRepository;
    const noReceipt = unavailableHandoffReceipt();
    if (binding === undefined) {
      return { repository: null, verification_receipt: noReceipt };
    }

    const unavailableRepository = {
      repository_id: binding.repository_id,
      revision: binding.revision,
      workspace_cwd: binding.workspace_cwd,
      branch: null,
      head_sha: null,
      changed_files: [],
      changed_file_count: 0,
      changed_files_truncated: false,
      diffstat: [],
      diffstat_truncated: false,
      overflow_artifact: null,
    };
    try {
      const sandboxInfo = this.getCurrentSandboxInfo();
      if (sandboxInfo === undefined) {
        return { repository: unavailableRepository, verification_receipt: noReceipt };
      }
      const sandboxId = this.providerSandboxId(sandboxInfo.sandbox_id);
      return await withWorkspaceMutationLock(
        this.workspaceMutationKey(sandboxId, binding.workspace_cwd),
        async (lease): Promise<AbnormalHandoffEvidence> => {
          const artifactPath = `${this.provider.getToolResultDumpDir(sandboxId).replace(/\/+$/u, '')}/abnormal-handoff-${randomUUID()}.txt`;
          const command = buildAbnormalHandoffCaptureCommand({
            artifactPath,
            expectedWorkspaceRoot: binding.workspace_cwd,
          });
          const operationId = randomUUID();
          const providerWork = this.provider.exec({
            sandboxId,
            command,
            env: { ...ABNORMAL_HANDOFF_GIT_ENVIRONMENT },
            timeoutSeconds: ABNORMAL_HANDOFF_PROVIDER_TIMEOUT_SECONDS,
            workspaceLock: { workspaceRoot: binding.workspace_cwd, operationId },
          });
          let result: ExecResult;
          try {
            result = await withTimeout(
              providerWork,
              ABNORMAL_HANDOFF_PROVIDER_TIMEOUT_MS,
              'abnormal handoff Git evidence',
            );
          } catch (error) {
            if (error instanceof PromiseTimeoutError) {
              void providerWork.catch(() => undefined);
              const termination = this.provider
                .acknowledgeWorkspaceTermination({
                  sandboxId,
                  workspaceRoot: binding.workspace_cwd,
                  operationId,
                  timeoutSeconds: ABNORMAL_HANDOFF_PROVIDER_TIMEOUT_SECONDS,
                })
                .catch((terminationError: unknown) => {
                  this.logger.error(
                    'Could not acknowledge timed-out abnormal-handoff evidence termination; retaining local lease',
                    extractErrorLogFields(terminationError),
                  );
                  return new Promise<void>(() => undefined);
                });
              lease.holdUntilTerminationAcknowledged(termination);
            }
            throw error;
          }
          if (!successfulExec(result) || result.response.result.length > MAX_ABNORMAL_HANDOFF_CAPTURE_RESPONSE_CHARS) {
            return { repository: unavailableRepository, verification_receipt: noReceipt };
          }

          const capture = AbnormalHandoffCaptureSchema.parse(JSON.parse(result.response.result));
          const statusChars = capture.status.reduce((total, line) => total + line.length, 0);
          const diffstatChars = capture.diffstat.reduce((total, line) => total + line.length, 0);
          if (
            statusChars > MAX_ABNORMAL_HANDOFF_INLINE_CHARS ||
            diffstatChars > MAX_ABNORMAL_HANDOFF_INLINE_CHARS ||
            normalizedRepositoryPath(capture.workspace_root) !== normalizedRepositoryPath(binding.workspace_cwd)
          ) {
            return { repository: unavailableRepository, verification_receipt: noReceipt };
          }

          const changedFiles = capture.status.map(line => ({
            status: line.slice(0, 2).trim() || '??',
            path: line.slice(3),
          }));
          return {
            repository: {
              repository_id: binding.repository_id,
              revision: binding.revision,
              workspace_cwd: binding.workspace_cwd,
              branch: capture.branch,
              head_sha: capture.head_sha,
              changed_files: changedFiles,
              changed_file_count: capture.status_count,
              changed_files_truncated: capture.status_truncated,
              diffstat: capture.diffstat,
              diffstat_truncated: capture.diffstat_truncated,
              overflow_artifact: capture.artifact_written ? artifactPath : null,
            },
            // Durable receipt state stays in the repository coordinator. The
            // bounded handoff capture cannot prove that receipt is still fresh.
            verification_receipt: noReceipt,
          };
        },
        {
          timeoutMs: ABNORMAL_HANDOFF_LOCK_WAIT_TIMEOUT_MS,
          label: 'abnormal handoff workspace mutation lock',
        },
      );
    } catch (error) {
      this.logger.warn('Could not capture abnormal handoff repository evidence', extractErrorLogFields(error));
      return { repository: unavailableRepository, verification_receipt: noReceipt };
    }
  }

  private async runExecWithVerification(
    sandboxId: string,
    input: SandboxRuntimeExecInput,
    env: Record<string, string>,
    effect: SandboxCommandEffect,
    planAdmission: { context: ToolInvocationContext | undefined; scope: ImplementationPlanGrantScope } | undefined,
    dispatchMarker: { dispatched: boolean },
  ): Promise<VerifiedExecOutcome> {
    const guarded = effect === 'verify' || effect === 'commit' || effect === 'edit' || effect === 'execute';
    // A verify or commit purpose only takes the durable coordination path when a repository
    // is bound. With no bound repository there is nothing to verify durably against, so the
    // command runs through the same plain path as any other execute-class command.
    const requiresDurableCoordination = guarded && this.boundRepository !== undefined;
    if (!requiresDurableCoordination) {
      const workspaceRoot = await this.resolveWorkspaceRoot(sandboxId, input.cwd);
      const execute = (): Promise<ExecResult> =>
        workspaceRoot === undefined
          ? this.provider.exec({
              sandboxId,
              command: input.command,
              cwd: input.cwd,
              env,
              ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
            })
          : this.execWorkspaceExclusive({
              sandboxId,
              workspaceRoot,
              command: input.command,
              cwd: input.cwd,
              env,
              timeoutSeconds: input.timeoutSeconds,
            });
      // Workspace-root discovery above (unbound path) is complete; the target
      // command is about to reach the provider. A SandboxNotAvailableError from
      // this point on means the target may have run, so replay must stop being
      // safe for verify/commit once this flips.
      dispatchMarker.dispatched = true;
      const result =
        workspaceRoot === undefined
          ? await execute()
          : await withWorkspaceMutationLock(this.workspaceMutationKey(sandboxId, workspaceRoot), async () => execute());
      return {
        status: 'completed',
        result,
        serialized: await this.decorateExecResult(result, sandboxId, input),
        verificationPassed: undefined,
        verificationReceiptCandidate: undefined,
      };
    }
    const lease = await this.acquireDurableWorkspaceLease({
      sandboxId,
      cwd: input.cwd,
      timeoutSeconds: input.timeoutSeconds,
    });
    if (lease.status === 'blocked') {
      return lease;
    }
    const coordinator = this.workspaceVerificationCoordinator;
    if (coordinator === undefined) {
      throw new Error('Durable workspace coordinator disappeared while a lease was held');
    }
    try {
      const before = await this.captureWorkspaceVerificationIdentity(sandboxId, input.cwd);
      if (before === undefined) {
        return {
          status: 'blocked',
          reason: `Could not capture the Git repository state before ${effect === 'verify' ? 'verification' : 'execution'}. The command was not run.`,
        };
      }
      if (effect === 'commit') {
        const consumed = await coordinator.consumeReceipt({
          repository_id: lease.repositoryId,
          workspace_cwd: lease.workspaceRoot,
          lease_id: lease.leaseId,
          mutation_epoch: lease.mutationEpoch,
          state_sha256: before.stateSha256,
        });
        if (!consumed) {
          return {
            status: 'blocked',
            reason: 'Run a successful command with purpose verify against the current Git state before committing.',
          };
        }
      }
      const reservation =
        planAdmission === undefined
          ? undefined
          : await this.assertFinalImplementationPlanAdmission({
              sandboxId,
              context: planAdmission.context,
              scope: planAdmission.scope,
              workspaceRoot: lease.workspaceRoot,
            });
      return await this.runReservedImplementationPlanDispatch(reservation, async () => {
        if (!(await this.beginDurableStateObservation(lease, effect === 'verify'))) {
          return {
            status: 'blocked',
            reason: 'Lost durable workspace ownership before the command was dispatched.',
          };
        }

        let dispatch: { status: 'completed'; result: ExecResult } | { status: 'blocked'; reason: string };
        try {
          dispatch = await withWorkspaceMutationLock(
            this.workspaceMutationKey(sandboxId, lease.workspaceRoot),
            async () => {
              // Lease acquisition, receipt consumption, and durable-state observation
              // above are all pre-dispatch bookkeeping. The target command (or the
              // atomic commit) is about to reach the provider from here, so a
              // SandboxNotAvailableError from this point on can no longer be treated
              // as safe to replay for verify/commit.
              dispatchMarker.dispatched = true;
              if (effect !== 'commit') {
                return {
                  status: 'completed' as const,
                  result: await this.execWorkspaceExclusive({
                    sandboxId,
                    workspaceRoot: lease.workspaceRoot,
                    command: input.command,
                    cwd: input.cwd,
                    env,
                    timeoutSeconds: input.timeoutSeconds,
                  }),
                };
              }
              const commit = await this.provider.executeVerifiedWorkspaceCommit({
                sandboxId,
                workspaceRoot: lease.workspaceRoot,
                cwd: input.cwd,
                env,
                timeoutSeconds: input.timeoutSeconds,
                command: input.command,
                receipt: {
                  branch: before.branch,
                  head: before.head,
                  refsSha256: before.refsSha256,
                  indexSha256: before.indexSha256,
                  trackedWorktreeSha256: before.trackedWorktreeSha256,
                  untrackedSha256: before.untrackedSha256,
                },
              });
              if (commit.status !== 'indeterminate') {
                return commit;
              }
              const detail = commit.result.success
                ? `(exit code ${String(commit.result.response.exitCode)}): ${commit.result.response.result}`
                : commit.result.error;
              return {
                status: 'completed' as const,
                result: {
                  success: false as const,
                  error: `The atomic commit outcome could not be established. ${detail}`,
                },
              };
            },
          );
        } catch (error) {
          if (!(await this.renewDurableWorkspaceLease(lease))) {
            throw error;
          }
          const failedAfter = await this.captureWorkspaceVerificationIdentity(sandboxId, input.cwd);
          if (!(await this.renewDurableWorkspaceLease(lease))) {
            throw error;
          }
          await coordinator.observeState({
            repository_id: lease.repositoryId,
            workspace_cwd: lease.workspaceRoot,
            lease_id: lease.leaseId,
            before_state_sha256: before.stateSha256,
            after_state_sha256: failedAfter?.stateSha256 ?? null,
          });
          throw error;
        }
        if (dispatch.status === 'blocked') {
          if (!(await this.renewDurableWorkspaceLease(lease))) {
            return dispatch;
          }
          const blockedAfter = await this.captureWorkspaceVerificationIdentity(sandboxId, input.cwd);
          if (!(await this.renewDurableWorkspaceLease(lease))) {
            return dispatch;
          }
          await coordinator.observeState({
            repository_id: lease.repositoryId,
            workspace_cwd: lease.workspaceRoot,
            lease_id: lease.leaseId,
            before_state_sha256: before.stateSha256,
            after_state_sha256: blockedAfter?.stateSha256 ?? null,
          });
          return dispatch;
        }
        const result = dispatch.result;
        if (!(await this.renewDurableWorkspaceLease(lease))) {
          throw new Error('Lost durable workspace ownership after the command was dispatched');
        }
        const after = await this.captureWorkspaceVerificationIdentity(sandboxId, input.cwd);
        if (!(await this.renewDurableWorkspaceLease(lease))) {
          throw new Error('Lost durable workspace ownership during post-command state capture');
        }
        const mutationEpoch = await coordinator.observeState({
          repository_id: lease.repositoryId,
          workspace_cwd: lease.workspaceRoot,
          lease_id: lease.leaseId,
          before_state_sha256: before.stateSha256,
          after_state_sha256: after?.stateSha256 ?? null,
        });
        if (mutationEpoch === undefined) {
          throw new Error('Lost durable workspace ownership before repository state could be recorded');
        }
        if (effect !== 'verify') {
          return {
            status: 'completed',
            result,
            serialized: await this.decorateExecResult(result, sandboxId, input),
            verificationPassed: undefined,
            verificationReceiptCandidate: undefined,
          };
        }

        const executionSucceeded = successfulExec(result);
        const repositoryUnchanged = after?.stateSha256 === before.stateSha256;
        let verificationReceiptCandidate: WorkspaceVerificationReceiptCandidate | undefined;
        if (after !== undefined && executionSucceeded && repositoryUnchanged) {
          verificationReceiptCandidate = {
            ...after,
            repositoryId: lease.repositoryId,
            mutationEpoch,
            command: input.command,
          };
        }
        const verificationPassed = verificationReceiptCandidate !== undefined;
        const reason =
          after === undefined
            ? 'The Git repository state could not be captured after execution.'
            : !executionSucceeded
              ? 'The verification command did not complete successfully with exit code 0.'
              : !repositoryUnchanged
                ? 'The verification command changed Git-visible repository state.'
                : !verificationPassed
                  ? 'Durable verification ownership was lost before a receipt candidate could be produced.'
                  : undefined;
        return {
          status: 'completed',
          result,
          serialized: {
            ...(await this.decorateExecResult(result, sandboxId, input)),
            verification: {
              passed: verificationPassed,
              reason,
              workspace_root: before.workspaceRoot,
              head: before.head,
              before_state_sha256: before.stateSha256,
              after_state_sha256: after?.stateSha256,
              execution_succeeded: executionSucceeded,
              repository_unchanged: repositoryUnchanged,
              command: input.command,
            },
          },
          verificationPassed,
          verificationReceiptCandidate,
        };
      });
    } finally {
      // T7's provider-workspace termination lease remains an integration dependency;
      // this database lease fences cooperating replicas but cannot stop an orphaned provider process.
      await this.releaseDurableWorkspaceLease(lease);
    }
  }

  /**
   * Publishes a host-only verification candidate only after AgentThread's
   * terminal-result and tool-context persistence yields have been accepted.
   * A fresh durable lease and semantic recapture fence publication against any
   * mutation between provider completion and this activation boundary.
   */
  async activateVerificationReceipt(
    candidate: WorkspaceVerificationReceiptCandidate,
    result: { event_id: string; thread_id: string; tool_call_id: string },
  ): Promise<boolean> {
    const binding = this.boundRepository;
    const coordinator = this.workspaceVerificationCoordinator;
    if (
      binding === undefined ||
      coordinator === undefined ||
      candidate.repositoryId !== binding.repository_id ||
      this.normalizedWorkspacePath(candidate.workspaceRoot) !== this.normalizedWorkspacePath(binding.workspace_cwd)
    ) {
      return false;
    }
    const lease = await this.acquireDurableWorkspaceLease({
      sandboxId: candidate.sandboxId,
      cwd: candidate.workspaceRoot,
      timeoutSeconds: undefined,
    });
    if (lease.status === 'blocked') {
      return false;
    }
    try {
      if (lease.mutationEpoch !== candidate.mutationEpoch) {
        return false;
      }
      const current = await this.captureWorkspaceVerificationIdentity(candidate.sandboxId, candidate.workspaceRoot);
      if (current?.stateSha256 !== candidate.stateSha256) {
        return false;
      }
      if (!(await this.renewDurableWorkspaceLease(lease))) {
        return false;
      }
      return await coordinator.activateReceipt({
        repository_id: lease.repositoryId,
        workspace_cwd: lease.workspaceRoot,
        lease_id: lease.leaseId,
        mutation_epoch: candidate.mutationEpoch,
        state_sha256: candidate.stateSha256,
        command: candidate.command,
        created_at: new Date(),
        result_event_id: result.event_id,
        result_thread_id: result.thread_id,
        result_tool_call_id: result.tool_call_id,
      });
    } catch (error) {
      this.logger.warn('Durable verification receipt activation failed', extractErrorLogFields(error));
      return false;
    } finally {
      await this.releaseDurableWorkspaceLease(lease);
    }
  }

  /**
   * Check prerequisites for skills in the sandbox and cache the results. Runs
   * from ensureReadySandbox once the sandbox is live, so it also covers freshly
   * created sandboxes (there is no "existing" id on the first turn).
   */
  private async checkPrerequisites(input: { sandboxId: string }): Promise<void> {
    if (this.prerequisitesChecked) {
      // Already checked
      return;
    }

    // Only check if there are skills; the sandbox is guaranteed live here.
    if (!this.skillMounter) {
      this.prerequisitesChecked = true;
      return;
    }

    // Get skills with prerequisites
    const skillsWithRequires = this.skillMounter.skillPrerequisites();
    if (skillsWithRequires.length === 0) {
      this.prerequisitesChecked = true;
      return;
    }

    try {
      // Reset cache to avoid stale data from a previous failed check
      this.unavailableSkillsCache.clear();

      // Collect all required binaries
      const requiredBinaries = new Set<string>();
      const skillsByBinary = new Map<string, string[]>(); // binary -> skills that need it

      const getOrCreateBinaryEntry = (binary: string): string[] => {
        const existing = skillsByBinary.get(binary);
        if (existing !== undefined) {
          return existing;
        }
        const created: string[] = [];
        skillsByBinary.set(binary, created);
        return created;
      };

      for (const skill of skillsWithRequires) {
        for (const binary of skill.requires) {
          requiredBinaries.add(binary);
          getOrCreateBinaryEntry(binary).push(skill.name);
        }
      }

      if (requiredBinaries.size === 0) {
        this.prerequisitesChecked = true;
        return;
      }

      // Check each binary individually and report missing ones
      const binaryNames = Array.from(requiredBinaries);
      const checkCommands = binaryNames
        .map(bin => `command -v ${shellEscape(bin)} || echo MISSING ${shellEscape(bin)}`)
        .join('; ');

      const result = await this.provider.exec({
        sandboxId: input.sandboxId,
        command: checkCommands,
        cwd: '/',
        env: {},
      });

      // Parse output to identify missing binaries
      if (result.success && result.response.result) {
        const missingBinaries = new Set<string>();
        for (const line of result.response.result.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('MISSING ')) {
            const binary = trimmed.slice('MISSING '.length).trim();
            missingBinaries.add(binary);
          }
        }

        // Mark only skills whose required binary is missing
        for (const binary of missingBinaries) {
          const skillNames = skillsByBinary.get(binary) ?? [];
          for (const skillName of skillNames) {
            const prev = this.unavailableSkillsCache.get(skillName);
            const newReason = `missing prerequisite: ${binary}`;
            this.unavailableSkillsCache.set(skillName, prev ? `${prev}, ${newReason}` : newReason);
          }
        }
        // Invalidate cached skills section so it includes unavailable skills info
        this.cachedSkillsSection = undefined;
      }
      // Check succeeded, mark as checked
      this.prerequisitesChecked = true;
    } catch (error) {
      this.logger.warn('Failed to check skill prerequisites', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep prerequisitesChecked false to allow retry on next call
    }
  }

  /**
   * Renders the model-visible `run_code` description with the current turn's
   * `/ingress` file list appended. Attachments staged by the harness (via
   * {@link uploadUserFile}) are advertised with filename and size so the model
   * reads them directly instead of re-uploading bytes through `files_in`.
   */
  private renderRunCodeDescription(): string {
    const staged = [...this.runCodeIngressStaging.values()];
    if (staged.length === 0) {
      return SANDBOX_RUN_CODE_DESCRIPTION;
    }
    const lines = staged.map(attachment => `- ${attachment.name} (${String(attachment.bytes.length)} bytes)`);
    return (
      SANDBOX_RUN_CODE_DESCRIPTION +
      `Available in /ingress (read directly by filename, do NOT re-upload via files_in):\n` +
      `${lines.join('\n')}\n`
    );
  }

  /** Dispatches `run_code` through the configured isolation driver. */
  private async handleRunCode(input: RunCodeInput, context?: ToolInvocationContext): Promise<CallToolResponse> {
    const service = this.runCodeService;
    if (service === undefined) {
      return hostRefusalResponse(
        'run_code is not available: no sandbox isolation driver is configured for this deployment. Report the failure instead of running the code another way.',
      );
    }
    // the turn's abort signal reaches the backend (provisioning observes
    // it); provisioning progress is honest — every driver message is logged
    // immediately and, when the step ran, rides a passthrough event to the
    // UI/chat stream on the tool response.
    const provisioningMessages: string[] = [];
    let result: RunCodeResult;
    try {
      result = await service.runCode(input, {
        signal: context?.signal,
        attachments: [...this.runCodeIngressStaging.values()],
        onProgress: (message: string) => {
          provisioningMessages.push(message);
          this.logger.info('run_code provisioning progress', { message });
        },
        onHarvestedFiles: this.runCodeHarvestSink,
      });
    } catch (error) {
      // The service contract reports failures as data; a throw means dispatch
      // itself broke before a runRoot existed — still model-visible, still
      // never an exec fallback, and host paths scrubbed via the backend-owned
      // scrubber. Also log it host-side with the cause chain intact.
      const rawText = error instanceof Error ? error.message : String(error);
      this.logger.error('run_code dispatch throw escaped the service', {
        error: error instanceof Error ? error : String(error),
      });
      return toolResultResponse({
        text: JSON.stringify({
          status: 'failed',
          error_code: 'internal',
          detail: service.scrubDispatchErrorText(rawText),
        }),
        isError: true,
      });
    }
    return toolResultResponse({
      text: JSON.stringify(result),
      isError: result.status === 'failed',
      ...(provisioningMessages.length > 0
        ? {
            overrides: {
              events: [
                buildProvisioningEvent({
                  succeeded: !(result.status === 'failed' && result.error_code === 'image_unavailable'),
                  messages: provisioningMessages,
                }),
              ],
            },
          }
        : {}),
    });
  }

  /**
   * Sentinel: record agent-created or agent-modified files as tracked
   * executables, so a later attempt to execute them escalates for approval.
   * Best effort and host-side: paths that do not resolve on the host (for
   * example a remote sandbox checkout) are skipped silently.
   */
  private observeSentinelWrites(input: { paths: readonly string[]; cwd: string }): void {
    const ctx = classifyContextFor({
      host: this.sentinelContext,
      repository_id: this.boundRepository?.repository_id ?? null,
      workspace_cwd: this.boundRepository?.workspace_cwd ?? null,
    });
    const store = ctx.services.tracked_store;
    const scope = {
      tenant_id: ctx.tenant_id,
      created_by: ctx.created_by,
      repository_id: ctx.repository_id,
      workspace_cwd: ctx.workspace_cwd,
    };
    for (const p of input.paths) {
      const identity = canonicalFileIdentity({ p, cwd: input.cwd }) ?? canonicalWriteTarget({ p, cwd: input.cwd });
      if (identity === null) {
        continue;
      }
      store.track({ scope, file_identity: identity });
    }
  }

  private async handleExec(
    input: SandboxRuntimeExecInput,
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
    planScope?: ImplementationPlanGrantScope,
  ): Promise<CallToolResponse> {
    const resolvedInput: SandboxRuntimeExecInput = {
      ...input,
      cwd: input.cwd ?? this.boundRepository?.workspace_cwd ?? this.provider.getWorkspaceDir(),
    };
    const preflightFailure = sandboxExecPreflightFailure({
      command: resolvedInput.command,
      purpose: resolvedInput.purpose,
      cwd: resolvedInput.cwd,
      env: resolvedInput.env,
      output: resolvedInput.output,
      webConnectorAttached: this.webConnectorAttached,
      webConnectorToolHint: this.webConnectorToolHint,
      resolveCache: this.execGuardResolveCache,
    });
    if (preflightFailure !== undefined) {
      return hostRefusalResponse(preflightFailure);
    }
    const effect = sandboxInvocationPolicy({ command: resolvedInput.command, purpose: resolvedInput.purpose }).effect;
    if (approvalDecision === undefined) {
      // Same authoritative classification as toolCallInfo: auto-denied calls
      // are refused, and Tier 3 calls surface the approval card instead of
      // the old effect-based gate.
      const tool_info = await this.toolCallInfo({ name: SANDBOX_EXEC_TOOL_NAME, arguments: input });
      if (tool_info.pre_dispatch_failure !== undefined) {
        return hostRefusalResponse(tool_info.pre_dispatch_failure.message);
      }
      if (tool_info.is_approval_required) {
        return {
          approvalRequired: { tool_info },
        };
      }
    }
    let sandboxInfo: SandboxInfo;
    let sandboxCreated: SandboxInfo | undefined;
    try {
      ({ sandboxInfo, sandboxCreated } = await this.ensureReadySandbox());
    } catch (e) {
      this.logger.error('Sandbox initialization failed', extractErrorLogFields(e));
      const message = e instanceof Error ? e.message : 'Sandbox initialization failed';
      const fallback = this.existingSandboxInfo;
      return hostRefusalResponse(`Sandbox initialization failed: ${message}`, {
        sandboxCreated: Boolean(fallback),
        ...(fallback !== undefined ? { sandboxInfo: fallback } : {}),
      });
    }
    const sandboxCreatedFlag = Boolean(sandboxCreated);
    const rawId = this.providerSandboxId(sandboxInfo.sandbox_id);
    // Host-side skill-use telemetry: the prompt advertises mounted skills, so
    // detect when the model actually reaches for one. Cheap string matching on
    // the authored command and chosen cwd; runs on every exec.
    const skillUsedEvents = detectSkillUsedEvents({
      command: resolvedInput.command,
      cwd: resolvedInput.cwd,
      skillsDir: this.provider.getSkillsDir(rawId),
      skillNames: this.skillMounter?.skillNames() ?? [],
    });
    const codeModeEnv = await this.ensureCodeModeStarted(rawId);
    const mcpClientEnv = injectMCPClientEnv({
      env: input.env,
      mcpServers: this.buildMcpServersEnvelope(),
      codeModeEnv,
      mcpClientInstall: this.mcpClientInstall,
    });
    const gitAuthEnv =
      this.resolvedGitCredentialsContent !== null
        ? buildGitCredentialHelperEnv(this.provider.getGitCredentialsPath(rawId))
        : {};
    const env = { ...mcpClientEnv, ...gitAuthEnv };

    const dispatchMarker = { dispatched: false };
    try {
      const execution = await this.runExecWithVerification(
        rawId,
        resolvedInput,
        env,
        effect,
        planScope === undefined ? undefined : { context, scope: planScope },
        dispatchMarker,
      );
      if (execution.status === 'blocked') {
        return hostRefusalResponse(execution.reason);
      }
      if (isExecResultOk(execution.result) && typeof resolvedInput.cwd === 'string') {
        this.observeSentinelWrites({
          paths: observeShellCreatedFiles({ command: resolvedInput.command }),
          cwd: resolvedInput.cwd,
        });
      }

      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(execution.serialized) }],
          isError: !isExecResultOk(execution.result) || execution.verificationPassed === false,
        },
        wasInitialized: undefined,
        sandboxCreated: sandboxCreatedFlag,
        sandboxInfo,
        verificationReceiptCandidate: execution.verificationReceiptCandidate,
        events: skillUsedEvents.length > 0 ? skillUsedEvents : undefined,
      };
    } catch (error) {
      // A provider disconnect after the target command (or atomic commit) has
      // reached the provider leaves the verification or commit outcome
      // uncertain. Never replay either kind of command in a replacement sandbox
      // once dispatched: the first dispatch may already have run (or already
      // committed), and re-dispatching could execute it twice. A disconnect
      // before dispatch — e.g. unbound workspace-root discovery, or durable
      // lease/receipt bookkeeping for a bound repository — never reached the
      // provider with the target command, so it is safe to recreate the
      // sandbox and retry there.
      if (
        !(error instanceof SandboxNotAvailableError) ||
        sandboxCreated !== undefined ||
        ((effect === 'verify' || effect === 'commit') && dispatchMarker.dispatched)
      ) {
        throw error;
      }
      const recreated = await this.recreateAfterUnavailable();
      await this.ensureSandboxInitialized();
      const recreatedRawId = this.providerSandboxId(recreated.sandboxInfo.sandbox_id);
      const retryCodeModeEnv = await this.ensureCodeModeStarted(recreatedRawId);
      const retryEnv = {
        ...injectMCPClientEnv({
          env: input.env,
          mcpServers: this.buildMcpServersEnvelope(),
          codeModeEnv: retryCodeModeEnv,
          mcpClientInstall: this.mcpClientInstall,
        }),
        ...(this.resolvedGitCredentialsContent !== null
          ? buildGitCredentialHelperEnv(this.provider.getGitCredentialsPath(recreatedRawId))
          : {}),
      };
      const retryDispatchMarker = { dispatched: false };
      const retryExecution = await this.runExecWithVerification(
        recreatedRawId,
        resolvedInput,
        retryEnv,
        effect,
        planScope === undefined ? undefined : { context, scope: planScope },
        retryDispatchMarker,
      );
      if (retryExecution.status === 'blocked') {
        return hostRefusalResponse(retryExecution.reason);
      }
      return {
        result: {
          content: [{ type: 'text', text: JSON.stringify(retryExecution.serialized) }],
          isError: !isExecResultOk(retryExecution.result) || retryExecution.verificationPassed === false,
        },
        wasInitialized: undefined,
        sandboxCreated: true,
        sandboxInfo: recreated.sandboxInfo,
        verificationReceiptCandidate: retryExecution.verificationReceiptCandidate,
        events: skillUsedEvents.length > 0 ? skillUsedEvents : undefined,
      };
    }
  }

  private async handleRunRegisteredCommand(
    input: SandboxRunRegisteredCommandInput,
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    const binding = this.boundRepository;
    const registered = binding?.commands.find(candidate => candidate.command_id === input.command_id);
    if (binding === undefined || registered === undefined) {
      const available = binding?.commands.map(candidate => candidate.command_id) ?? [];
      return toolResultResponse({
        text: JSON.stringify({
          error: `Unknown registered command '${input.command_id}'.`,
          available_command_ids: available,
        }),
        isError: true,
      });
    }
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({
            name: SANDBOX_RUN_REGISTERED_COMMAND_TOOL_NAME,
            arguments: input,
          }),
        },
      };
    }
    return await this.handleExec(
      {
        intent: input.intent,
        purpose: 'verify',
        command: registered.command,
        cwd: binding.workspace_cwd,
        timeoutSeconds: registered.timeout_ms / 1000,
        output: { tail_lines: REGISTERED_COMMAND_OUTPUT_TAIL_LINES },
      },
      approvalDecision,
      context,
      { kind: 'command', command_id: input.command_id },
    );
  }

  /**
   * Runs `normalizeStructuredEditArguments` over one structured-edit tool's already-validated
   * input and returns it with the same shape, notes discarded (the notes surfaced to the
   * approval card come from the `toolCallInfo` pass over the same, still-unnormalized input;
   * this call is idempotent on an already-normalized argument, so calling it again here, once
   * more per dispatch, only ever removes cosmetic shape differences it would otherwise reject on).
   */
  private normalizeStructuredEditInput<T extends Record<string, unknown>>(
    toolName: StructuredEditToolName,
    input: T,
    context: { cwd: string; repositoryRoot: string; applyPatchDialect?: boolean },
  ): T {
    const normalization = normalizeStructuredEditArguments<T>({
      toolName,
      args: input,
      cwd: context.cwd,
      repositoryRoot: context.repositoryRoot,
      ...(context.applyPatchDialect === undefined ? {} : { applyPatchDialect: context.applyPatchDialect }),
    });
    return normalization.args;
  }

  private async handleWriteFile(
    rawInput: SandboxWriteFileInput,
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    const scopeResolution = lexicalWriteFileWorkspaceScope({
      cwd: rawInput.cwd,
      binding: this.boundRepository,
      scratchRoot: this.provider.getWorkspaceDir(),
    });
    if (scopeResolution.status === 'invalid') {
      if (approvalDecision !== undefined) {
        throw new ToolPreDispatchError(scopeResolution.failure);
      }
      return toolResultResponse({ text: JSON.stringify({ error: scopeResolution.failure }), isError: true });
    }
    const input = this.normalizeStructuredEditInput('write_file', rawInput, {
      cwd: scopeResolution.scope.cwd,
      repositoryRoot: scopeResolution.scope.workspaceCwd,
    });
    const pathPreflight = writeFilePathPreflight({
      path: input.path,
      root: scopeResolution.scope.workspaceCwd,
      cwd: scopeResolution.scope.cwd,
    });
    if (pathPreflight.status === 'invalid') {
      return toolResultResponse({ text: JSON.stringify({ error: pathPreflight.failure }), isError: true });
    }
    const normalizedPath = pathPreflight.path;
    const implementationPlanScope = sandboxImplementationPlanScope({
      toolName: SANDBOX_WRITE_FILE_TOOL_NAME,
      argumentsValue: input,
      binding: this.boundRepository,
    });
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({ name: SANDBOX_WRITE_FILE_TOOL_NAME, arguments: input }),
        },
      };
    }

    const { sandboxInfo, sandboxCreated } = await this.ensureReadySandboxForDispatch(SANDBOX_WRITE_FILE_TOOL_NAME);

    const rawId = this.providerSandboxId(sandboxInfo.sandbox_id);
    const canonicalScope = await this.canonicalizeWriteFileWorkspaceScope(rawId, scopeResolution.scope);
    const dumpDir = this.provider.getToolResultDumpDir(rawId).replace(/\/+$/g, '');
    const payload = JSON.stringify({
      workspace_cwd: canonicalScope.workspaceCwd,
      cwd_relative: canonicalScope.cwdRelative,
      path: normalizedPath,
      content: input.content,
    });
    const payloadDigest = createHash('sha256').update(payload).digest('hex');
    const scriptDigest = createHash('sha256').update(WRITE_FILE_SCRIPT).digest('hex');
    const payloadPath = `${dumpDir}/write-file-${payloadDigest.slice(0, 16)}.json`;
    const scriptPath = `${dumpDir}/write-file-${scriptDigest.slice(0, 16)}.py`;
    try {
      await this.provider.uploadFile({
        sandboxId: rawId,
        remotePath: payloadPath,
        content: Buffer.from(payload, 'utf-8'),
      });
      await this.provider.uploadFile({
        sandboxId: rawId,
        remotePath: scriptPath,
        content: Buffer.from(WRITE_FILE_SCRIPT, 'utf-8'),
      });
    } catch (error) {
      throw new ToolPreDispatchError('write_file setup upload failed before repository command dispatch.', {
        cause: error,
      });
    }

    const workspaceRoot = canonicalScope.workspaceCwd;
    // The workspace lock is a Git-metadata boundary (see commandWithWorkspaceLock in
    // provider/Provider.ts): it shells out to `git -C <root> rev-parse --git-path ...`
    // to find a lock directory inside `.git`. A scratch workspace (no bound repository)
    // has no `.git`, so that lookup fails with exit 128 and the write is reported as
    // failed even though the file was written. Only request the lock when a repository
    // is actually bound; a scratch write has no concurrent-checkout to guard against.
    const workspaceLockRoot = this.boundRepository === undefined ? undefined : workspaceRoot;
    const observedWrite = await this.runObservedWorkspaceMutation({
      sandboxId: rawId,
      cwd: canonicalScope.cwd,
      operation: async () => {
        const reservation = await this.assertFinalImplementationPlanAdmission({
          sandboxId: rawId,
          context,
          scope: implementationPlanScope,
          workspaceRoot,
        });
        return this.runReservedImplementationPlanDispatch(reservation, () =>
          this.execWorkspaceExclusive({
            sandboxId: rawId,
            workspaceRoot: workspaceLockRoot,
            command: `python3 ${shellEscape(scriptPath)} ${shellEscape(payloadPath)}`,
            cwd: undefined,
          }),
        );
      },
    });
    if (observedWrite.status === 'blocked') {
      return toolResultResponse({ text: JSON.stringify({ error: observedWrite.reason }), isError: true });
    }
    const write = observedWrite.value;
    const succeeded = write.success && write.response.exitCode === 0;
    if (succeeded) {
      this.observeSentinelWrites({ paths: [normalizedPath], cwd: scopeResolution.scope.cwd });
    }
    if (!succeeded) {
      // Unwrap the script's own JSON error (`{"error": "..."}` on stdout) so a failed write
      // surfaces as a top-level rejection, never nested inside a `write` field a caller has to
      // dig into.
      let scriptError: string | undefined;
      const rawResult = write.success ? write.response.result : write.error;
      try {
        const parsedResult: unknown = JSON.parse(rawResult);
        if (hasStringErrorProperty(parsedResult)) {
          scriptError = parsedResult.error;
        }
      } catch {
        // Not JSON (e.g. a raw stderr capture); fall through to the generic rejection below.
      }
      return toolResultResponse({
        text: JSON.stringify({
          payload_sha256: payloadDigest,
          script_sha256: scriptDigest,
          error:
            scriptError ??
            structuredEditRejection({
              tool: 'write_file',
              what: 'the write',
              received: structuredEditReceivedSnippet(rawResult),
              expected: 'a successful write_file script run',
            }),
        }),
        isError: true,
        overrides: { sandboxCreated: Boolean(sandboxCreated), sandboxInfo },
      });
    }

    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              path: normalizedPath,
              payload_sha256: payloadDigest,
              script_sha256: scriptDigest,
              write,
            }),
          },
        ],
        isError: !succeeded,
      },
      wasInitialized: undefined,
      sandboxCreated: Boolean(sandboxCreated),
      sandboxInfo,
      verificationReceiptCandidate: undefined,
    };
  }

  /**
   * Resolves one apply_patch request to a git-format unified diff, converting from OpenAI's
   * `apply_patch` envelope when necessary. `fileContents`, when supplied, lets the OpenAI-format
   * converter compute exact hunk offsets instead of falling back to a placeholder start of 1.
   */
  private resolveApplyPatchGitDiff(
    patchText: string,
    fileContents?: ReadonlyMap<string, string>,
  ):
    | { status: 'ok'; text: string; format: 'git' | 'openai'; contentPaths: string[] }
    | { status: 'error'; reason: string } {
    const format = detectApplyPatchFormat(patchText);
    if (format.status === 'invalid') {
      return { status: 'error', reason: format.reason };
    }
    if (format.status === 'git') {
      return { status: 'ok', text: patchText, format: 'git', contentPaths: [] };
    }
    const converted = convertOpenAIPatchToGitDiff(patchText, fileContents);
    if (converted.status === 'invalid') {
      return { status: 'error', reason: converted.reason };
    }
    return { status: 'ok', text: converted.gitDiff, format: 'openai', contentPaths: converted.contentPaths };
  }

  /**
   * Reads the current content of workspace files, for computing exact OpenAI-format apply_patch
   * hunk offsets. Best-effort: a file that cannot be read or decoded is simply absent from the
   * returned map, and its hunks fall back to the placeholder offset.
   *
   * `paths` are raw OpenAI-patch paths, which the rest of the apply_patch pipeline (structured
   * path extraction) interprets as relative to `cwd`, not to the workspace root. Every path is
   * first normalized the same way — repository-root-relative, via the same safety checks the
   * structured-edit path extractor applies — before it is joined against the workspace root and
   * read, so a nested `cwd` reads the file the converted diff actually targets, and a path that
   * would resolve outside the workspace is never sent to the sandbox at all.
   */
  private async readWorkspaceFileContentsForPaths(input: {
    sandboxId: string;
    workspaceRoot: string | undefined;
    cwd: string;
    paths: readonly string[];
  }): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (input.paths.length === 0 || input.workspaceRoot === undefined) {
      return map;
    }
    const repositoryRelativeByRawPath = new Map<string, string>();
    for (const rawPath of new Set(input.paths)) {
      const repositoryRelative = repositoryRelativeStructuredEditPath({
        repositoryRoot: input.workspaceRoot,
        cwd: input.cwd,
        path: rawPath,
      });
      if (repositoryRelative !== undefined) {
        repositoryRelativeByRawPath.set(rawPath, repositoryRelative);
      }
    }
    if (repositoryRelativeByRawPath.size === 0) {
      return map;
    }
    const result = await this.execWorkspaceExclusive({
      sandboxId: input.sandboxId,
      workspaceRoot: input.workspaceRoot,
      command: `python3 -c ${shellEscape(OPENAI_PATCH_CONTENT_READ_SCRIPT)} ${shellEscape(input.workspaceRoot)} ${shellEscape(JSON.stringify([...repositoryRelativeByRawPath.values()]))}`,
      cwd: input.cwd,
    });
    if (!successfulExec(result)) {
      return map;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.response.result);
    } catch {
      return map;
    }
    if (parsed === null || typeof parsed !== 'object') {
      return map;
    }
    const contentByRepositoryRelativePath = new Map<string, string>();
    for (const [path, encoded] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof encoded !== 'string') {
        continue;
      }
      try {
        contentByRepositoryRelativePath.set(path, Buffer.from(encoded, 'base64').toString('utf-8'));
      } catch {
        // Skip undecodable content; the caller falls back to a placeholder offset for this path.
      }
    }
    for (const [rawPath, repositoryRelative] of repositoryRelativeByRawPath) {
      const content = contentByRepositoryRelativePath.get(repositoryRelative);
      if (content !== undefined) {
        map.set(rawPath, content);
      }
    }
    return map;
  }

  private async handleApplyPatch(
    rawInput: SandboxApplyPatchInput,
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    const input = this.normalizeStructuredEditInput('apply_patch', rawInput, {
      cwd: rawInput.cwd,
      repositoryRoot: this.boundRepository?.workspace_cwd ?? rawInput.cwd,
      // resolveApplyPatchGitDiff below runs its own two-pass OpenAI-dialect conversion (a
      // placeholder-offset pass now, an exact-offset pass once the sandbox is available); the
      // normaliser here only strips cosmetic wrapping (BOM, code fence, CRLF, blank lines) so
      // that conversion sees the same shape a well-behaved model would have sent.
      applyPatchDialect: false,
    });
    const patchDigest = createHash('sha256').update(input.patch).digest('hex');
    // Accepts a git-format unified diff unchanged, or converts OpenAI's `apply_patch` envelope
    // format (gpt-oss and other harmony-format models emit this even when asked for a git diff)
    // into one first. This first pass never touches the sandbox, so an OpenAI-format conversion
    // here uses placeholder hunk offsets; it is only used for path extraction, the implementation
    // plan scope, and the approval identity below. The exact-offset conversion happens further
    // down, once the sandbox is available to read the real file content.
    const initialResolution = this.resolveApplyPatchGitDiff(input.patch);
    if (initialResolution.status === 'error') {
      return toolResultResponse({
        text: JSON.stringify({ patch_sha256: patchDigest, error: initialResolution.reason }),
        isError: true,
      });
    }
    const isOpenAIFormat = initialResolution.format === 'openai';
    const initialAnalysis = extractStructuredEditPaths({
      kind: 'apply_patch',
      repositoryRoot: this.boundRepository?.workspace_cwd ?? input.cwd,
      cwd: input.cwd,
      patch: initialResolution.text,
    });
    if (initialAnalysis.status === 'invalid' || initialAnalysis.normalized_patch === undefined) {
      return toolResultResponse({
        text: JSON.stringify({
          patch_sha256: patchDigest,
          error:
            initialAnalysis.status === 'invalid'
              ? initialAnalysis.failure
              : 'apply_patch requires a normalized Git-format unified diff',
        }),
        isError: true,
      });
    }
    // These are overwritten below with the exact-offset conversion once the sandbox is available,
    // for an OpenAI-format patch. Declared with explicit types (rather than reassigning
    // initialAnalysis) so control-flow narrowing at every read site is unambiguous.
    let finalNormalizedPatch: string = initialAnalysis.normalized_patch;
    let finalPaths: string[] = initialAnalysis.paths;
    const implementationPlanScope: ImplementationPlanGrantScope | undefined =
      this.boundRepository === undefined ? undefined : { kind: 'paths', paths: finalPaths };
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({ name: SANDBOX_APPLY_PATCH_TOOL_NAME, arguments: input }),
        },
      };
    }

    let sandboxInfo: SandboxInfo;
    let sandboxCreated: SandboxInfo | undefined;
    try {
      ({ sandboxInfo, sandboxCreated } = await this.ensureReadySandbox());
    } catch (error) {
      this.logger.error('Sandbox initialization failed', extractErrorLogFields(error));
      const message = error instanceof Error ? error.message : 'Sandbox initialization failed';
      return toolResultResponse({ text: JSON.stringify({ error: message }), isError: true });
    }

    const rawId = this.providerSandboxId(sandboxInfo.sandbox_id);
    let earlyWorkspaceRoot: string | undefined;
    if (isOpenAIFormat && initialResolution.contentPaths.length > 0) {
      earlyWorkspaceRoot = await this.resolveWorkspaceRoot(rawId, input.cwd);
      const fileContents = await this.readWorkspaceFileContentsForPaths({
        sandboxId: rawId,
        workspaceRoot: earlyWorkspaceRoot,
        cwd: input.cwd,
        paths: initialResolution.contentPaths,
      });
      const exactResolution = this.resolveApplyPatchGitDiff(input.patch, fileContents);
      if (exactResolution.status === 'error') {
        return toolResultResponse({
          text: JSON.stringify({ patch_sha256: patchDigest, error: exactResolution.reason }),
          isError: true,
        });
      }
      const exactAnalysis = extractStructuredEditPaths({
        kind: 'apply_patch',
        repositoryRoot: this.boundRepository?.workspace_cwd ?? input.cwd,
        cwd: input.cwd,
        patch: exactResolution.text,
      });
      if (exactAnalysis.status === 'invalid' || exactAnalysis.normalized_patch === undefined) {
        return toolResultResponse({
          text: JSON.stringify({
            patch_sha256: patchDigest,
            error:
              exactAnalysis.status === 'invalid'
                ? exactAnalysis.failure
                : 'apply_patch requires a normalized Git-format unified diff',
          }),
          isError: true,
        });
      }
      finalNormalizedPatch = exactAnalysis.normalized_patch;
      finalPaths = exactAnalysis.paths;
    }
    const normalizedPatch = finalNormalizedPatch;
    const normalizedPatchDigest = createHash('sha256').update(normalizedPatch).digest('hex');
    const patchPath = `${this.provider.getToolResultDumpDir(rawId).replace(/\/+$/, '')}/apply-patch-${normalizedPatchDigest.slice(0, 16)}.diff`;
    await this.provider.uploadFile({
      sandboxId: rawId,
      remotePath: patchPath,
      content: Buffer.from(normalizedPatch, 'utf-8'),
    });

    const workspaceRoot = await this.resolveWorkspaceRoot(rawId, input.cwd);
    // Must match the repositoryRoot used above to derive finalPaths (same expression, evaluated
    // again since resolveWorkspaceRoot may have run since then) so precondition observation joins the
    // same root the paths are relative to, rather than the (possibly different) Git toplevel.
    const observationRoot = this.boundRepository?.workspace_cwd ?? input.cwd;
    const observedMutation = await this.runObservedWorkspaceMutation({
      sandboxId: rawId,
      cwd: input.cwd,
      operation: async (): Promise<{ check: ExecResult; apply?: ExecResult }> => {
        await this.enforceStructuredEditPrecondition({
          sandboxId: rawId,
          observationRoot,
          lockRoot: workspaceRoot,
          cwd: input.cwd,
          kind: 'apply_patch',
          paths: finalPaths,
          approved: context?.structured_edit_precondition,
        });
        const check = await this.execWorkspaceExclusive({
          sandboxId: rawId,
          workspaceRoot,
          // --unidiff-zero: a hunk with only added lines (a pure insertion, e.g. from an
          // OpenAI-format apply_patch hunk with no removed/context lines) declares a zero-length
          // old side. Without this flag `git apply` silently mis-locates such a hunk — it applies
          // without error, but at the wrong offset — instead of honoring the declared position.
          command: `git apply --recount --unidiff-zero --check -- ${shellEscape(patchPath)}`,
          cwd: input.cwd,
        });
        if (!successfulExec(check)) {
          return { check };
        }
        await this.enforceStructuredEditPrecondition({
          sandboxId: rawId,
          observationRoot,
          lockRoot: workspaceRoot,
          cwd: input.cwd,
          kind: 'apply_patch',
          paths: finalPaths,
          approved: context?.structured_edit_precondition,
        });
        const reservation = await this.assertFinalImplementationPlanAdmission({
          sandboxId: rawId,
          context,
          scope: implementationPlanScope,
          workspaceRoot,
        });
        // runObservedWorkspaceMutation durably invalidates the prior receipt
        // before this callback can dispatch the repository mutation.
        const apply = await this.runReservedImplementationPlanDispatch(reservation, () =>
          this.execWorkspaceExclusive({
            sandboxId: rawId,
            workspaceRoot,
            command: `git apply --recount --unidiff-zero -- ${shellEscape(patchPath)}`,
            cwd: input.cwd,
          }),
        );
        return { check, apply };
      },
    });
    if (observedMutation.status === 'blocked') {
      return toolResultResponse({ text: JSON.stringify({ error: observedMutation.reason }), isError: true });
    }
    const mutation = observedMutation.value;
    const { check } = mutation;
    if (!check.success || check.response.exitCode !== 0) {
      return {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                patch_sha256: patchDigest,
                normalized_patch_sha256: normalizedPatchDigest,
                check,
                hint: APPLY_PATCH_CHECK_FAILURE_HINT,
              }),
            },
          ],
          isError: true,
        },
        wasInitialized: undefined,
        sandboxCreated: Boolean(sandboxCreated),
        sandboxInfo,
        verificationReceiptCandidate: undefined,
      };
    }

    const apply = mutation.apply;
    if (apply === undefined) {
      throw new Error('Patch validation succeeded without an apply result');
    }
    const succeeded = apply.success && apply.response.exitCode === 0;
    if (succeeded && workspaceRoot !== undefined) {
      this.observeSentinelWrites({ paths: finalPaths, cwd: workspaceRoot });
    }
    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              patch_sha256: patchDigest,
              normalized_patch_sha256: normalizedPatchDigest,
              check,
              apply,
            }),
          },
        ],
        isError: !succeeded,
      },
      wasInitialized: undefined,
      sandboxCreated: Boolean(sandboxCreated),
      sandboxInfo,
      verificationReceiptCandidate: undefined,
    };
  }

  private async handleReplaceText(
    rawInput: SandboxReplaceTextInput,
    approvalDecision?: ApprovalDecision,
    context?: ToolInvocationContext,
  ): Promise<CallToolResponse> {
    const input = this.normalizeStructuredEditInput('replace_text', rawInput, {
      cwd: rawInput.cwd,
      repositoryRoot: this.boundRepository?.workspace_cwd ?? rawInput.cwd,
    });
    const pathResolution = extractStructuredEditPaths({
      kind: 'replace_text',
      repositoryRoot: this.boundRepository?.workspace_cwd ?? input.cwd,
      cwd: input.cwd,
      path: input.path,
    });
    if (pathResolution.status === 'invalid') {
      return toolResultResponse({ text: JSON.stringify({ error: pathResolution.failure }), isError: true });
    }
    // pathResolution.status === 'valid' means structuredEditCwdRelativePath already accepted
    // input.path, so this always resolves; the sandbox script needs the cwd-relative form, not
    // the possibly-absolute input.path.
    const normalizedPath =
      structuredEditCwdRelativePath({
        repositoryRoot: this.boundRepository?.workspace_cwd ?? input.cwd,
        cwd: input.cwd,
        path: input.path,
      }) ?? input.path;
    const implementationPlanScope: ImplementationPlanGrantScope | undefined =
      this.boundRepository === undefined ? undefined : { kind: 'paths', paths: pathResolution.paths };
    if (pathResolution.paths.some(targetsGitMetadata)) {
      return toolResultResponse({
        text: JSON.stringify({
          error: 'replace_text cannot modify Git metadata under .git; use the appropriate Git command instead',
        }),
        isError: true,
      });
    }
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({ name: SANDBOX_REPLACE_TEXT_TOOL_NAME, arguments: input }),
        },
      };
    }

    let sandboxInfo: SandboxInfo;
    let sandboxCreated: SandboxInfo | undefined;
    try {
      ({ sandboxInfo, sandboxCreated } = await this.ensureReadySandbox());
    } catch (error) {
      this.logger.error('Sandbox initialization failed', extractErrorLogFields(error));
      const message = error instanceof Error ? error.message : 'Sandbox initialization failed';
      return toolResultResponse({ text: JSON.stringify({ error: message }), isError: true });
    }

    const rawId = this.providerSandboxId(sandboxInfo.sandbox_id);
    const workspaceRoot = await this.resolveWorkspaceRoot(rawId, input.cwd);
    const dumpDir = this.provider.getToolResultDumpDir(rawId).replace(/\/+$/, '');
    const scriptDigest = createHash('sha256').update(REPLACE_TEXT_SCRIPT).digest('hex');
    const scriptPath = `${dumpDir}/replace-text-${scriptDigest.slice(0, 16)}.py`;
    await this.provider.uploadFile({
      sandboxId: rawId,
      remotePath: scriptPath,
      content: Buffer.from(REPLACE_TEXT_SCRIPT, 'utf-8'),
    });

    // Must match the repositoryRoot used above to derive pathResolution.paths so precondition
    // observation joins the same root the paths are relative to, rather than the (possibly
    // different) Git toplevel.
    const observationRoot = this.boundRepository?.workspace_cwd ?? input.cwd;
    const observedReplace = await this.runObservedWorkspaceMutation({
      sandboxId: rawId,
      cwd: input.cwd,
      operation: async (): Promise<ReplaceTextDispatchOutcome> => {
        const reservation = await this.assertFinalImplementationPlanAdmission({
          sandboxId: rawId,
          context,
          scope: implementationPlanScope,
          workspaceRoot,
        });
        await this.enforceStructuredEditPrecondition({
          sandboxId: rawId,
          observationRoot,
          lockRoot: workspaceRoot,
          cwd: input.cwd,
          kind: 'replace_text',
          paths: pathResolution.paths,
          approved: context?.structured_edit_precondition,
        });

        // Read the current target content under the same workspace lock (and after the same
        // admission/precondition gates) the OpenAI exact-offset apply_patch pass uses, and
        // require old_text to occur exactly once in it before dispatching: the host never
        // guesses. An ambiguous (more than one exact occurrence, without replace_all) or absent
        // match is rejected here, with a diagnostic, without ever reaching the sandbox script.
        // Doing this only after admission/precondition succeed keeps a blocked plan from
        // dispatching anything at all, including this read.
        const currentContents = await this.readWorkspaceFileContentsForPaths({
          sandboxId: rawId,
          workspaceRoot,
          cwd: input.cwd,
          paths: [normalizedPath],
        });
        const currentContent = currentContents.get(normalizedPath);
        // `matchReplaceText` may resolve `old_text` to the model-supplied bytes verbatim, or —
        // only if those do not match uniquely — to the gutter-stripped reading of them (see
        // replaceTextDiagnostics.ts). Whichever it resolves to is the exact text that occurs in
        // the file, and is what must be sent on for dispatch; sending the original, possibly
        // still-guttered `input.old_text` here instead would make the sandbox script's own exact
        // match fail even though the host just confirmed one exists.
        let dispatchOldText = input.old_text;
        if (currentContent !== undefined) {
          const matchResult = matchReplaceText({
            fileContent: currentContent,
            oldText: input.old_text,
            replaceAll: input.replace_all,
            path: normalizedPath,
          });
          if (matchResult.status === 'ambiguous' || matchResult.status === 'no_match') {
            return { kind: 'match_rejected', rejection: matchResult.rejection };
          }
          dispatchOldText = matchResult.matchedText;
        }

        const payload = JSON.stringify({
          path: normalizedPath,
          old_text: dispatchOldText,
          new_text: input.new_text,
          replace_all: input.replace_all,
        });
        const payloadDigest = createHash('sha256').update(payload).digest('hex');
        const payloadPath = `${dumpDir}/replace-text-${payloadDigest.slice(0, 16)}.json`;
        await this.provider.uploadFile({
          sandboxId: rawId,
          remotePath: payloadPath,
          content: Buffer.from(payload, 'utf-8'),
        });

        // runObservedWorkspaceMutation durably invalidates the prior receipt
        // before this callback can dispatch the repository mutation.
        return this.runReservedImplementationPlanDispatch(
          reservation,
          async (): Promise<ReplaceTextDispatchOutcome> => {
            const exec = await this.execWorkspaceExclusive({
              sandboxId: rawId,
              workspaceRoot,
              command: `python3 ${shellEscape(scriptPath)} ${shellEscape(payloadPath)}`,
              cwd: input.cwd,
            });
            return { kind: 'dispatched', exec, payloadDigest };
          },
        );
      },
    });
    if (observedReplace.status === 'blocked') {
      return toolResultResponse({ text: JSON.stringify({ error: observedReplace.reason }), isError: true });
    }
    const outcome = observedReplace.value;
    if (outcome.kind === 'match_rejected') {
      return toolResultResponse({
        text: JSON.stringify({ error: outcome.rejection }),
        isError: true,
        overrides: { sandboxCreated: Boolean(sandboxCreated), sandboxInfo },
      });
    }
    const { exec: replace, payloadDigest } = outcome;
    const succeeded = replace.success && replace.response.exitCode === 0;
    if (succeeded) {
      this.observeSentinelWrites({ paths: [normalizedPath], cwd: input.cwd });
    }
    if (!succeeded) {
      // Unwrap the script's own JSON error (`{"error": "..."}` on stdout) so a failed replace
      // surfaces as a top-level rejection, never nested inside a `replace` field a caller has to
      // dig into.
      let scriptError: string | undefined;
      const rawResult = replace.success ? replace.response.result : replace.error;
      try {
        const parsedResult: unknown = JSON.parse(rawResult);
        if (hasStringErrorProperty(parsedResult)) {
          scriptError = parsedResult.error;
        }
      } catch {
        // Not JSON (e.g. a raw stderr capture); fall through to the generic rejection below.
      }
      return toolResultResponse({
        text: JSON.stringify({
          payload_sha256: payloadDigest,
          script_sha256: scriptDigest,
          error:
            scriptError ??
            structuredEditRejection({
              tool: 'replace_text',
              what: 'the replacement',
              received: structuredEditReceivedSnippet(rawResult),
              expected: 'a successful replace_text script run',
            }),
        }),
        isError: true,
        overrides: { sandboxCreated: Boolean(sandboxCreated), sandboxInfo },
      });
    }
    return {
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              payload_sha256: payloadDigest,
              script_sha256: scriptDigest,
              replace,
            }),
          },
        ],
        isError: false,
      },
      wasInitialized: undefined,
      sandboxCreated: Boolean(sandboxCreated),
      sandboxInfo,
      verificationReceiptCandidate: undefined,
    };
  }

  private async handleSubmitImplementationPlan(
    input: SandboxImplementationPlanInput,
    approvalDecision?: ApprovalDecision,
  ): Promise<CallToolResponse> {
    const grant = this.mintImplementationPlanGrant(input);
    if (grant === undefined) {
      const binding = this.boundRepository;
      const state = this.boundRepositoryState;
      const availableVerifyCommandIds = binding?.commands.map(command => command.command_id).sort() ?? [];
      const mismatches: string[] = [];
      if (binding !== undefined) {
        if (input.repository_id !== binding.repository_id) {
          mismatches.push('repository_id');
        }
        if (input.repository_revision !== binding.revision) {
          mismatches.push('repository_revision');
        }
        if (state === undefined) {
          mismatches.push('repository_state');
        } else {
          if (input.branch !== state.branch) {
            mismatches.push('branch');
          }
          if (input.head_sha !== state.head_sha) {
            mismatches.push('head_sha');
          }
        }
        if (input.verify_command_ids.some(commandId => !availableVerifyCommandIds.includes(commandId))) {
          mismatches.push('verify_command_ids');
        }
        if (this.implementationPlanGrantContext === undefined) {
          mismatches.push('grant_context');
        }
      }
      const noRegisteredCommands = binding !== undefined && availableVerifyCommandIds.length === 0;
      return toolResultResponse({
        text: JSON.stringify({
          error:
            binding === undefined
              ? 'Implementation plans require a repository-bound chat. Bind this chat to a repository and retry; no action was dispatched.'
              : noRegisteredCommands
                ? 'This repository has no confirmed verification commands. Confirm a proposed command in repository settings before submitting an implementation plan; no action was dispatched.'
                : 'The implementation plan is stale or does not match the current bound repository. Resubmit it with the current identity below; no action was dispatched.',
          reason_code:
            binding === undefined
              ? 'repository_not_bound'
              : noRegisteredCommands
                ? 'no_registered_commands'
                : 'stale_plan',
          mismatches,
          current:
            binding === undefined
              ? null
              : {
                  repository_id: binding.repository_id,
                  repository_revision: binding.revision,
                  branch: state?.branch ?? null,
                  head_sha: state?.head_sha ?? null,
                  available_verify_command_ids: availableVerifyCommandIds,
                },
        }),
        isError: true,
      });
    }
    if (approvalDecision === undefined) {
      return {
        approvalRequired: {
          tool_info: await this.toolCallInfo({ name: SANDBOX_SUBMIT_IMPLEMENTATION_PLAN_TOOL_NAME, arguments: input }),
        },
      };
    }
    const persisted = approvalDecision.status === 'allow' && approvalDecision.scope === 'chat';
    if (persisted) {
      const context = this.implementationPlanGrantContext;
      const binding = this.boundRepository;
      if (context === undefined || binding === undefined) {
        return toolResultResponse({
          text: JSON.stringify({
            error: 'Implementation plan grant persistence is unavailable. No reusable grant was created.',
          }),
          isError: true,
        });
      }
      const { sandboxInfo } = await this.ensureReadySandbox();
      const sandboxId = this.providerSandboxId(sandboxInfo.sandbox_id);
      const lease = await this.acquireDurableWorkspaceLease({
        sandboxId,
        cwd: binding.workspace_cwd,
        timeoutSeconds: undefined,
      });
      if (lease.status === 'blocked') {
        return toolResultResponse({ text: JSON.stringify({ error: lease.reason }), isError: true });
      }
      let activationFailure: string | undefined;
      try {
        const actualState = await this.readActualBoundRepositoryState(sandboxId);
        if (actualState === undefined) {
          activationFailure =
            'Could not refresh the repository revision, branch, and HEAD before activating the implementation plan. No reusable grant was created.';
        } else if (
          actualState.binding.repository_id !== binding.repository_id ||
          actualState.binding.workspace_cwd !== binding.workspace_cwd ||
          actualState.checkout_id !== grant.checkout_id ||
          actualState.binding.repository_id !== grant.plan.repository_id ||
          actualState.binding.revision !== grant.plan.repository_revision ||
          actualState.branch !== grant.plan.branch ||
          actualState.head_sha !== grant.plan.head_sha ||
          grant.plan.verify_command_ids.some(
            commandId => !actualState.binding.commands.some(command => command.command_id === commandId),
          )
        ) {
          activationFailure =
            'The repository revision, branch, HEAD, or registered commands drifted while implementation-plan approval was pending. No reusable grant was created.';
        } else if (!(await this.renewDurableWorkspaceLease(lease))) {
          activationFailure =
            'Lost durable workspace ownership before activating the implementation plan. No reusable grant was created.';
        } else {
          await context.persistGrant(grant);
        }
      } finally {
        await this.releaseDurableWorkspaceLease(lease);
      }
      if (activationFailure !== undefined) {
        return toolResultResponse({ text: JSON.stringify({ error: activationFailure }), isError: true });
      }
    }
    return toolResultResponse({
      text: JSON.stringify({
        grant_id: grant.grant_id,
        status: persisted ? 'active' : 'submission_approved_once',
        message: persisted
          ? 'The implementation plan grant is active for this chat until revoked or repository state drifts.'
          : 'The plan submission was allowed once, but no reusable plan grant was created. Choose Allow in this chat to create one.',
      }),
    });
  }

  async getToolResultDumpDir(): Promise<{ dir: string; sandboxCreated: SandboxInfo | undefined }> {
    const { sandboxCreated, sandboxInfo } = await this.ensureSandboxCreated();
    const dir = this.provider.getToolResultDumpDir(this.providerSandboxId(sandboxInfo.sandbox_id)).replace(/\/+$/, '');
    return { dir, sandboxCreated };
  }

  async uploadFile(params: {
    targetDir: string;
    fileName: string;
    content: Buffer;
  }): Promise<{ filePath: string; sandboxCreated: SandboxInfo | undefined }> {
    const { sandboxCreated, sandboxInfo } = await this.ensureReadySandbox();
    const fileName = params.fileName.replace(/^\/+/, '');
    const targetDir = params.targetDir.replace(/\/+$/, '');
    const filePath = `${targetDir}/${fileName}`;
    await this.provider.uploadFile({
      sandboxId: this.providerSandboxId(sandboxInfo.sandbox_id),
      remotePath: filePath,
      content: params.content,
    });
    return { filePath, sandboxCreated };
  }

  /** Whether the `run_code` tool is backed by an isolation driver in this turn. */
  isRunCodeAvailable(): boolean {
    return this.runCodeService !== undefined;
  }

  async uploadUserFile(input: { fileName: string; content: Buffer; mime: string }): Promise<SandboxStoredFile> {
    validateNoPathTraversal(input.fileName);
    const { sandboxCreated, sandboxInfo } = await this.ensureReadySandbox();
    let result: { filePath: string; sandboxCreated: SandboxInfo | undefined };
    try {
      result = await this.uploadFile({
        targetDir: this.provider.getFileUploadsDir(this.providerSandboxId(sandboxInfo.sandbox_id)),
        fileName: input.fileName,
        content: input.content,
      });
    } catch (error) {
      if (sandboxCreated !== undefined) {
        throw new SandboxFileUploadError('User-file upload failed after creating a sandbox', sandboxCreated, {
          cause: error,
        });
      }
      throw error;
    }
    const created = sandboxCreated ?? result.sandboxCreated;
    // Stage for run_code: the isolation driver serves these bytes as /ingress
    // files, so the model reads attachments by filename instead of
    // re-uploading them via files_in.
    this.runCodeIngressStaging.set(result.filePath, { name: input.fileName, bytes: input.content });
    return {
      filePath: result.filePath,
      ...(created && { sandboxCreated: created }),
    };
  }

  /** Remove a file staged by {@link uploadUserFile}, for atomic multipart rollback. */
  async deleteUserFile(input: { filePath: string }): Promise<void> {
    const { sandboxId, canonicalFilePath } = await this.canonicalStagedFilePath(input.filePath);
    this.runCodeIngressStaging.delete(input.filePath);
    this.runCodeIngressStaging.delete(canonicalFilePath);
    await this.removeSandboxFile({ sandboxId, filePath: canonicalFilePath });
  }

  /** Download an attachment previously staged by {@link uploadUserFile}. */
  async downloadUserFile(filePath: string): Promise<Buffer> {
    const { sandboxId, canonicalFilePath } = await this.canonicalStagedFilePath(filePath);
    return await this.provider.downloadFile({ sandboxId, path: canonicalFilePath });
  }

  /**
   * Copy a staged upload through an already-open file descriptor into a private, bounded snapshot.
   * Hashing and parsers then operate on the same immutable bytes rather than racing the user path.
   */
  async createDocumentSnapshot(input: {
    filePath: string;
    maxBytes: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<SandboxDocumentSnapshot> {
    const maxBytes = input.maxBytes ?? MAX_BYTES_PER_DOCUMENT;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES_PER_DOCUMENT) {
      throw new Error(
        `Document snapshot byte limit must be an integer between 1 and ${String(MAX_BYTES_PER_DOCUMENT)}`,
      );
    }
    const { sandboxId, canonicalFilePath, canonicalUploadDir } = await this.canonicalStagedFilePath(input.filePath);
    const uploadDir = this.provider.getFileUploadsDir(sandboxId).replace(/\/+$/g, '');
    const snapshotPath = `${uploadDir}/.amanuensis-document-${randomUUID().replace(/-/g, '')}`;
    const marker = `AMAN_DOCUMENT_SNAPSHOT_${randomUUID().replace(/-/g, '')}`;
    const command = `set -eu; exec 3<${shellEscape(canonicalFilePath)}; opened_path=$(realpath -e -- /proc/self/fd/3); case "$opened_path" in ${shellEscape(`${canonicalUploadDir}/`)}*) ;; *) printf '%sUNSAFE_PATH\\n' ${shellEscape(`${marker}:`)}; exit 0 ;; esac; if [ ! -f /proc/self/fd/3 ]; then printf '%sUNSAFE_TYPE\\n' ${shellEscape(`${marker}:`)}; exit 0; fi; before=$(stat -Lc '%s:%i:%y' /proc/self/fd/3); original_size=$(stat -Lc %s /proc/self/fd/3); if [ "$original_size" -gt ${String(maxBytes)} ]; then printf '%sTOO_LARGE:%s\\n' ${shellEscape(`${marker}:`)} "$original_size"; exit 0; fi; source_hash_before=$(sha256sum /proc/self/fd/3 | awk '{print $1}'); head -c ${String(maxBytes)} <&3 > ${shellEscape(snapshotPath)}; source_hash_after=$(sha256sum /proc/self/fd/3 | awk '{print $1}'); snapshot_hash=$(sha256sum ${shellEscape(snapshotPath)} | awk '{print $1}'); after=$(stat -Lc '%s:%i:%y' /proc/self/fd/3); snapshot_size=$(stat -Lc %s -- ${shellEscape(snapshotPath)}); if [ "$before" != "$after" ] || [ "$snapshot_size" -ne "$original_size" ] || [ "$source_hash_before" != "$source_hash_after" ] || [ "$source_hash_after" != "$snapshot_hash" ]; then rm -f -- ${shellEscape(snapshotPath)}; printf '%sCHANGED\\n' ${shellEscape(`${marker}:`)}; exit 0; fi; chmod 400 -- ${shellEscape(snapshotPath)}; printf '%sOK:%s:%s\\n' ${shellEscape(`${marker}:`)} "$snapshot_size" "$snapshot_hash"`;
    const cleanup = async (): Promise<void> => {
      await this.removeSandboxFile({ sandboxId, filePath: snapshotPath });
    };
    try {
      const result = await this.provider.exec({
        sandboxId,
        command,
        timeoutSeconds: SKILL_DOWNLOAD_TIMEOUT_SECONDS,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      ensureExecSuccess(result);
      if (!result.success) {
        throw new Error('Unreachable: document snapshot result was not successful');
      }
      const status = result.response.result.split(`${marker}:`)[1]?.trim();
      if (status?.startsWith('TOO_LARGE:')) {
        throw new Error(`Document exceeds the ${String(maxBytes)} byte limit`);
      }
      if (status === 'CHANGED') {
        throw new Error('Document changed while it was being snapshotted; upload it again and retry');
      }
      if (status === 'UNSAFE_PATH' || status === 'UNSAFE_TYPE') {
        throw new Error('Document snapshot source is not a regular staged upload');
      }
      const ok = /^OK:(\d+):([0-9a-f]{64})$/.exec(status ?? '');
      const size = ok?.[1] === undefined ? Number.NaN : Number(ok[1]);
      const expectedHash = ok?.[2];
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
        throw new Error('Document snapshot did not return a valid bounded size');
      }
      const content = await this.provider.downloadFile({
        sandboxId,
        path: snapshotPath,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (content.length !== size || createHash('sha256').update(content).digest('hex') !== expectedHash) {
        throw new Error('Document snapshot bytes changed before they could be read');
      }
      const verify = async (): Promise<void> => {
        const current = await this.provider.downloadFile({ sandboxId, path: snapshotPath });
        if (!content.equals(current)) {
          throw new Error('Document snapshot changed during extraction');
        }
      };
      return { filePath: snapshotPath, content, verify, cleanup };
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Document snapshot failed and cleanup did not complete', {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }

  private async removeSandboxFile(input: { sandboxId: string; filePath: string }): Promise<void> {
    const result = await this.provider.exec({
      sandboxId: input.sandboxId,
      command: `rm -f -- ${shellEscape(input.filePath)}`,
    });
    ensureExecSuccess(result);
  }

  private async canonicalStagedFilePath(
    filePath: string,
  ): Promise<{ sandboxId: string; canonicalFilePath: string; canonicalUploadDir: string }> {
    validateNoPathTraversal(filePath);
    const { sandboxInfo } = await this.ensureReadySandbox();
    const sandboxId = this.providerSandboxId(sandboxInfo.sandbox_id);
    const uploadDir = this.provider.getFileUploadsDir(sandboxId).replace(/\\+$/g, '').replace(/\\/g, '/');
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath !== uploadDir && !normalizedPath.startsWith(`${uploadDir}/`)) {
      throw new Error(`Document path must refer to a staged upload: ${filePath}`);
    }
    const canonicalize = async (path: string): Promise<string> => {
      const result = await this.provider.exec({ sandboxId, command: `realpath -e -- ${shellEscape(path)}` });
      ensureExecSuccess(result);
      if (!result.success) {
        throw new Error('Unreachable: canonical path result was not successful');
      }
      const canonical = result.response.result.trim();
      if (!canonical) {
        throw new Error(`Could not canonicalize staged upload path: ${path}`);
      }
      return canonical;
    };
    const canonicalUploadDir = await canonicalize(uploadDir);
    const canonicalFilePath = await canonicalize(filePath);
    const canonicalPrefix = canonicalUploadDir.replace(/\\/g, '/').replace(/\/+$/g, '');
    const normalizedCanonicalFilePath = canonicalFilePath.replace(/\\/g, '/');
    if (!normalizedCanonicalFilePath.startsWith(`${canonicalPrefix}/`)) {
      throw new Error(`Document path resolves outside staged uploads: ${filePath}`);
    }
    return { sandboxId, canonicalFilePath, canonicalUploadDir: canonicalPrefix };
  }

  /**
   * Extract native PDF text inside the selected sandbox, preserving page order and empty pages.
   * Extraction starts at firstPage; returned pages carry absolute 1-based
   * page numbers and total_pages is the true document total, never capped.
   */
  async runDocumentText(input: {
    filePath: string;
    firstPage?: number | undefined;
    maxPages: number;
    signal?: AbortSignal | undefined;
  }): Promise<{
    total_pages: number;
    pages: { page_number: number; text: string }[];
  }> {
    const maxPages = validateDocumentPageLimit(input.maxPages);
    const firstPage = input.firstPage ?? 1;
    if (!Number.isSafeInteger(firstPage) || firstPage < 1) {
      throw new Error('Document first page must be a positive integer');
    }
    const { sandboxId, canonicalFilePath } = await this.canonicalStagedFilePath(input.filePath);
    const operationId = randomUUID().replace(/-/g, '');
    const marker = `AMAN_PDF_TEXT_${operationId}`;
    // Efficiency: single pdftotext invocation for the whole range. pdftotext
    // emits a form-feed (\x0C) between pages; Node.js splits on it. The old
    // per-page loop re-parsed the PDF's xref tree N times (up to 100 spawns).
    const command = `set -eu; ulimit -v 2097152; total=$(pdfinfo ${shellEscape(canonicalFilePath)} | awk '/^Pages:/ {print $2}'); test -n "$total"; page=${shellEscape(String(firstPage))}; end=$((page + ${String(maxPages)} - 1)); if [ "$end" -gt "$total" ]; then end=$total; fi; printf '%sTOTAL:%s\\n' ${shellEscape(`${marker}:`)} "$total"; printf '%sRANGE:%s-%s\\n' ${shellEscape(`${marker}:`)} "$page" "$end"; pdftotext -f "$page" -l "$end" -layout ${shellEscape(canonicalFilePath)} - | head -c ${String(MAX_CHARS_PER_DOCUMENT)}`;
    const result = await this.provider.exec({
      sandboxId,
      command,
      timeoutSeconds: SKILL_DOWNLOAD_TIMEOUT_SECONDS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    ensureExecSuccess(result);
    if (!result.success) {
      throw new Error('Unreachable: PDF text result was not successful');
    }
    let total_pages = 0;
    const totalMarker = `${marker}:TOTAL:`;
    const totalMatch = result.response.result.split(totalMarker)[1]?.split('\n')[0];
    if (totalMatch !== undefined) {
      total_pages = Number(totalMatch.trim());
    }
    // Parse RANGE:start-end, then split the text on form-feeds into pages.
    const rangeMarker = `${marker}:RANGE:`;
    const rangePart = result.response.result.split(rangeMarker)[1];
    let rangeStart = firstPage;
    let rangeText = '';
    if (rangePart !== undefined) {
      const rangeLineEnd = rangePart.indexOf('\n');
      const rangeSpec = (rangeLineEnd < 0 ? rangePart : rangePart.slice(0, rangeLineEnd)).trim();
      const dash = rangeSpec.indexOf('-');
      if (dash > 0) {
        const parsed = Number(rangeSpec.slice(0, dash));
        if (Number.isInteger(parsed) && parsed > 0) {
          rangeStart = parsed;
        }
      }
      rangeText = rangeLineEnd < 0 ? '' : rangePart.slice(rangeLineEnd + 1);
    }
    const pages = rangeText
      .split('\x0C')
      .map((text, index) => ({ page_number: rangeStart + index, text: text.trim() }))
      .filter(page => page.text.length > 0);
    if (!Number.isInteger(total_pages) || total_pages < 1) {
      throw new Error('PDF text extraction did not return a page count');
    }
    return { total_pages, pages };
  }

  /** Run the pinned local OCR tools inside the selected sandbox, never in the server process. */
  async runDocumentOcr(input: {
    filePath: string;
    kind: 'pdf' | 'image';
    pages: readonly number[] | undefined;
    maxPages: number;
    signal?: AbortSignal | undefined;
  }): Promise<{ page_number: number; text: string }[]> {
    // maxPages bounds the OCR work (how many pages), not the page numbers:
    // callers address absolute page numbers, which may exceed the per-call
    // work bound for documents longer than one window.
    const maxPages = validateDocumentPageLimit(input.maxPages);
    if (input.pages !== undefined) {
      if (input.pages.length > maxPages) {
        throw new Error('OCR page selection exceeds the per-call page budget');
      }
      for (const page of input.pages) {
        if (!Number.isSafeInteger(page) || page < 1) {
          throw new Error('OCR page selection contains an invalid page number');
        }
      }
    }
    const { sandboxId, canonicalFilePath } = await this.canonicalStagedFilePath(input.filePath);
    const operationId = randomUUID().replace(/-/g, '');
    const directory = this.provider.getToolResultDumpDir(sandboxId).replace(/\/+$/g, '');
    const outputPrefix = `${directory}/document-ocr-${operationId}`;
    const marker = `AMAN_OCR_PAGE_${operationId}`;
    const cleanup =
      input.kind === 'pdf'
        ? `rm -f -- ${shellEscape(outputPrefix)}-*.png ${shellEscape(outputPrefix)}-*.txt`
        : `rm -f -- ${shellEscape(`${outputPrefix}.ocr.txt`)} ${shellEscape(`${outputPrefix}.txt`)}`;
    const cleanupTrap = `trap ${shellEscape(cleanup)} EXIT;`;
    const requestedPages = [...new Set(input.pages ?? [])].sort((left, right) => left - right);
    const tesseractLangFlags = this.ocrLanguages ? ` -l ${this.ocrLanguages.split(/\s+/).join('+')}` : '';
    const command =
      input.kind === 'pdf'
        ? requestedPages.length > 0
          ? `${cleanupTrap} set -eu; ulimit -v 2097152; remaining=${String(MAX_CHARS_PER_DOCUMENT)}; for page_number in ${requestedPages.map(page => shellEscape(String(page))).join(' ')}; do [ "$remaining" -gt 0 ] || break; page_prefix=${shellEscape(outputPrefix)}-$page_number; pdftoppm -f "$page_number" -l "$page_number" -png -r 150 -scale-to 4096 -singlefile ${shellEscape(canonicalFilePath)} "$page_prefix"; raw_text_file="$page_prefix.ocr.txt"; text_file="$page_prefix.txt"; tesseract "$page_prefix.png" stdout${tesseractLangFlags} --psm 6 > "$raw_text_file"; head -c "$remaining" < "$raw_text_file" > "$text_file"; printf '%s%s\\n' ${shellEscape(`${marker}:`)} "$page_number"; cat "$text_file"; printf '\\n'; used=$(wc -c < "$text_file"); remaining=$((remaining - used)); done`
          : `${cleanupTrap} set -eu; ulimit -v 2097152; total=$(pdfinfo ${shellEscape(canonicalFilePath)} | awk '/^Pages:/ {print $2}'); limit=$total; if [ "$limit" -gt ${String(maxPages)} ]; then limit=${String(maxPages)}; fi; remaining=${String(MAX_CHARS_PER_DOCUMENT)}; page_number=1; while [ "$page_number" -le "$limit" ] && [ "$remaining" -gt 0 ]; do page_prefix=${shellEscape(outputPrefix)}-$page_number; pdftoppm -f "$page_number" -l "$page_number" -png -r 150 -scale-to 4096 -singlefile ${shellEscape(canonicalFilePath)} "$page_prefix"; raw_text_file="$page_prefix.ocr.txt"; text_file="$page_prefix.txt"; tesseract "$page_prefix.png" stdout${tesseractLangFlags} --psm 6 > "$raw_text_file"; head -c "$remaining" < "$raw_text_file" > "$text_file"; printf '%s%s\\n' ${shellEscape(`${marker}:`)} "$page_number"; cat "$text_file"; printf '\\n'; used=$(wc -c < "$text_file"); remaining=$((remaining - used)); page_number=$((page_number + 1)); done`
        : `${cleanupTrap} set -eu; ulimit -v 2097152; raw_text_file=${shellEscape(`${outputPrefix}.ocr.txt`)}; text_file=${shellEscape(`${outputPrefix}.txt`)}; tesseract ${shellEscape(canonicalFilePath)} stdout${tesseractLangFlags} --psm 6 > "$raw_text_file"; head -c ${String(MAX_CHARS_PER_DOCUMENT)} < "$raw_text_file" > "$text_file"; printf '%s1\\n' ${shellEscape(`${marker}:`)}; cat "$text_file"`;
    const result = await this.provider.exec({
      sandboxId,
      command,
      timeoutSeconds: SKILL_DOWNLOAD_TIMEOUT_SECONDS,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    ensureExecSuccess(result);
    if (!result.success) {
      throw new Error('Unreachable: OCR result was not successful');
    }
    const pages = result.response.result
      .split(`${marker}:`)
      .slice(1)
      .flatMap(chunk => {
        const newline = chunk.indexOf('\n');
        if (newline < 0) {
          return [];
        }
        const page_number = Number(chunk.slice(0, newline).trim());
        return Number.isInteger(page_number) && page_number > 0
          ? [{ page_number, text: chunk.slice(newline + 1).trim() }]
          : [];
      });
    if (pages.length === 0) {
      throw new Error('OCR completed without producing a page result');
    }
    return pages;
  }

  async writeArtifact(input: {
    fileName: string;
    content: Buffer;
    sourceTool?: MappedMCPTool | undefined;
  }): Promise<SandboxStoredFile> {
    validateNoPathTraversal(input.fileName);
    const { dir, sandboxCreated: dumpDirCreated } = await this.getToolResultDumpDir();
    const result = await this.uploadFile({
      targetDir: dir,
      fileName: input.fileName,
      content: input.content,
    });
    const sandboxCreated = dumpDirCreated ?? result.sandboxCreated;
    return {
      filePath: result.filePath,
      ...(sandboxCreated && { sandboxCreated }),
    };
  }

  /**
   * Upload the MCP client Python script to the sandbox on the first tool call.
   * The sandbox filesystem is persistent within a session, so this only needs to run once.
   */
  private async ensureSandboxInitialized(signal?: AbortSignal): Promise<void> {
    throwIfSignalAborted(signal);
    this.sandboxInitPromise ??= this.initSandboxEnvironment(signal).catch((e: unknown) => {
      this.sandboxInitPromise = undefined;
      throw e;
    });
    await awaitWithAbort({ operation: this.sandboxInitPromise, signal });
  }

  private async writeGitCredentials(signal?: AbortSignal): Promise<void> {
    const sandboxId = this.providerSandboxId(this.requiredSandboxInfo.sandbox_id);
    const credentialsPath = this.provider.getGitCredentialsPath(sandboxId);
    const result = await awaitWithAbort({
      operation: this.provider.exec({
        sandboxId,
        command: buildSyncGitCredentialsCommand(this.resolvedGitCredentialsContent, credentialsPath),
        ...(signal === undefined ? {} : { signal }),
      }),
      signal,
    });
    ensureExecSuccess(result);
  }

  private async initSandboxEnvironment(signal?: AbortSignal): Promise<void> {
    throwIfSignalAborted(signal);
    const sandboxId = this.providerSandboxId(this.requiredSandboxInfo.sandbox_id);
    const fileUploadsDir = this.provider.getFileUploadsDir(sandboxId);
    const skillsDir = this.provider.getSkillsDir(sandboxId);
    const toolResultDumpDir = this.provider.getToolResultDumpDir(sandboxId);
    const workspaceDir = this.boundRepository === undefined ? this.provider.getWorkspaceDir() : undefined;

    this.logger.info('Uploading MCP client script and preparing skills directory in sandbox');

    this.mcpClientInstall = this.codeModeTransport?.getClientInstall({ sandboxId });
    const install = this.mcpClientInstall;

    const dirs = [shellEscape(fileUploadsDir), shellEscape(toolResultDumpDir), shellEscape(skillsDir)];
    if (workspaceDir !== undefined) {
      dirs.push(shellEscape(workspaceDir));
    }
    if (install !== undefined) {
      const { pythonPath, binDir } = mcpClientLayout(install.remotePath);
      dirs.push(shellEscape(pythonPath));
      // Layout bin is only for providers that put that dir on PATH (no image-PATH symlink).
      if (install.pathBinSymlink === undefined) {
        dirs.push(shellEscape(binDir));
      }
    }
    ensureExecSuccess(
      await awaitWithAbort({
        operation: this.provider.exec({
          sandboxId,
          command: `mkdir -p ${dirs.join(' ')}`,
          ...(signal === undefined ? {} : { signal }),
        }),
        signal,
      }),
    );

    const initSteps: string[] = [];
    if (install !== undefined) {
      const stagedPath = `${install.remotePath}.new`;
      await awaitWithAbort({
        operation: this.provider.uploadFile({
          sandboxId,
          remotePath: stagedPath,
          content: Buffer.from(install.content, 'utf-8'),
          ...(signal === undefined ? {} : { signal }),
        }),
        signal,
      });
      initSteps.push(
        `chmod 0555 ${shellEscape(stagedPath)}`,
        `mv -f ${shellEscape(stagedPath)} ${shellEscape(install.remotePath)}`,
      );
      if (install.pathBinSymlink !== undefined) {
        const escapedTarget = shellEscape(install.remotePath);
        const escapedLink = shellEscape(install.pathBinSymlink);
        // Release images may pre-create an image-PATH link as root. Keep an
        // already-correct link instead of requiring the sandbox user to
        // replace an entry in a root-owned directory on every initialization.
        initSteps.push(
          `if [ "$(readlink ${escapedLink} 2>/dev/null)" != ${escapedTarget} ]; then ln -sf ${escapedTarget} ${escapedLink} 2>/dev/null || sudo -n ln -sf ${escapedTarget} ${escapedLink}; fi`,
        );
      } else {
        // Link target is relative to binDir (`mcp-client/mcp_client.py` from `mcp-client/bin`
        // would resolve to `mcp-client/bin/mcp-client/mcp_client.py`).
        const { binDir, binLink } = mcpClientLayout(install.remotePath);
        initSteps.push(`ln -sf ${shellEscape(relative(binDir, install.remotePath))} ${shellEscape(binLink)}`);
      }
    }

    // Fold skill installation into this single init exec. The mounter returns a declarative
    // command + env + timeout; runs even when empty so existing skills are cleaned up.
    const skillInit = this.skillMounter?.getSandboxInit({
      skillsDir,
      skillDownloaderPath: this.provider.getSkillDownloaderPath(sandboxId),
    });
    if (skillInit) {
      for (const upload of skillInit.uploads) {
        await this.provider.uploadFile({
          sandboxId,
          remotePath: upload.remotePath,
          content: upload.content,
        });
      }
      initSteps.push(skillInit.command);
    }

    if (initSteps.length > 0) {
      ensureExecSuccess(
        await awaitWithAbort({
          operation: this.provider.exec({
            sandboxId,
            command: initSteps.join(' && '),
            env: skillInit?.env,
            timeoutSeconds: skillInit?.timeoutSeconds,
            ...(signal === undefined ? {} : { signal }),
          }),
          signal,
        }),
      );
    }

    this.logger.info(
      install === undefined
        ? `Sandbox initialized: skills dir ${skillsDir}`
        : `Sandbox initialized: MCP client at ${install.remotePath}; skills dir ${skillsDir}`,
    );

    await this.writeGitCredentials(signal);
  }

  /**
   * Lazily start Code Mode transport. Single-flight and idempotent inside the transport.
   * Skipped when code mode was never configured. Connect failures resolve to `undefined`
   * (no Code Mode env for that exec); mcp_client then errors at call time — no HTTPS fallback.
   */
  private async ensureCodeModeStarted(sandboxId: string): Promise<Record<string, string> | undefined> {
    const dispatcher = this.codeModeDispatcher;
    const transport = this.codeModeTransport;
    if (dispatcher === undefined || transport === undefined) {
      return undefined;
    }
    try {
      const { env } = await transport.start({
        codeModeDispatcher: dispatcher,
        sandboxId,
        requestTimeoutSeconds: this.requestTimeoutSeconds,
      });
      return env;
    } catch (e) {
      // Connect-level errors are not sticky: transport clears its session so a later exec may retry.
      this.logger.error('Code Mode transport start failed', {
        ...extractErrorLogFields(e),
        sandboxId,
      });
      return undefined;
    }
  }

  // Tears down per-Sandbox Code Mode resources. Dispatcher close first (in-flight requests get
  // source: transport), then transport.stop() — always safe whether start succeeded, failed, or never ran.
  async close(): Promise<void> {
    this.codeModeDispatcher?.close();
    this.codeModeDispatcher = undefined;
    const transport = this.codeModeTransport;
    this.codeModeTransport = undefined;
    if (transport === undefined) {
      return;
    }
    try {
      await transport.stop();
    } catch (e) {
      this.logger.warn('Error stopping Code Mode transport', extractErrorLogFields(e));
    }
  }
}
