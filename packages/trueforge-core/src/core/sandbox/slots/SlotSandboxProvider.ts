import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Logger } from 'winston';
import { signalAbortError, throwIfSignalAborted } from '../../util/abort';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '../SandboxErrors';
import type { CodeModeTransport } from '../codeMode/CodeModeTransport';
import {
  executeVerifiedWorkspaceCommit,
  type ExecResult,
  type SandboxBuild,
  type SandboxCreateParams,
  type SandboxDownloadFileParams,
  type SandboxExecParams,
  type SandboxProvider,
  type SandboxUploadFileParams,
  type VerifiedWorkspaceCommitParams,
  type VerifiedWorkspaceCommitResult,
} from '../provider/Provider';
import { SlotClient, type SlotCallError } from './SlotClient';
import { attestationProblem, SLOT_FIX_COMMAND } from './SlotDriver';
import type { SlotExecResponse } from './slotContract';

const WORKSPACE_DIR = '/workspace';
const STATE_DIR = `${WORKSPACE_DIR}/.aman`;
const SANDBOX_ID_PATTERN = /^s([1-9][0-9]{0,2})-([0-9a-f]{32})$/;
const QUEUE_POLL_MS = 250;
/** How long a call waits for its slot when other sessions hold it, beyond the call's own limit. */
const QUEUE_GRACE_MS = 120_000;
const AGENT_TIMEOUT_MARGIN_MS = 750;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 2_000;
const HEALTH_TIMEOUT_MS = 120_000;

export interface SlotSandboxProviderOptions {
  /** Unix socket path of each slot agent, in slot order. */
  socketPaths: readonly string[];
  defaultExecTimeoutSeconds: number;
  /** Per-session tree quota in MiB. */
  treeDiskMb: number;
  fileMaxBytesForDownload: number;
  logger: Logger;
  sleepMs: ((ms: number) => Promise<void>) | undefined;
}

function parseSandboxId(sandboxId: string): { slot: number; sessionId: string } | undefined {
  const match = SANDBOX_ID_PATTERN.exec(sandboxId);
  const slot = match?.[1];
  const sessionId = match?.[2];
  if (slot === undefined || sessionId === undefined) {
    return undefined;
  }
  return { slot: Number.parseInt(slot, 10) - 1, sessionId };
}

function describeAgentError(error: SlotCallError): string {
  if (error.kind === 'agent' && error.code === 'isolation_refused') {
    return `The sandbox could not prove its safety limits, so nothing was run (${error.message}). Run \`${SLOT_FIX_COMMAND}\`, then try again.`;
  }
  if (error.kind === 'unreachable') {
    return `The sandbox slot for this chat is not reachable. Run \`${SLOT_FIX_COMMAND}\`, then try again.`;
  }
  return `The sandbox failed: ${error.message}`;
}

/**
 * Shell and file tools on sandbox slots. A sandbox is a workspace tree pinned to one slot; every command
 * runs in a fresh gVisor guest that mounts that tree at /workspace. Background processes end with the call.
 */
export class SlotSandboxProvider implements SandboxProvider {
  readonly type = 'slots';

  private readonly clients: SlotClient[];
  private readonly defaultExecTimeoutSeconds: number;
  private readonly treeDiskMb: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly logger: Logger;
  private readonly sleepMs: (ms: number) => Promise<void>;

  constructor(options: SlotSandboxProviderOptions) {
    this.clients = options.socketPaths.map(path => new SlotClient(path));
    this.defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds;
    this.treeDiskMb = options.treeDiskMb;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload;
    this.logger = options.logger.child({ module: 'SlotSandboxProvider' });
    this.sleepMs = options.sleepMs ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async buildImage(): Promise<SandboxBuild> {
    return this.getImageBuildStatus();
  }

  /** Ready when at least one slot proves its isolation; slots are prepared outside the app. */
  async getImageBuildStatus(): Promise<SandboxBuild> {
    const slot = await this.firstAttestedSlot(undefined);
    return slot.ok
      ? { status: 'ready', reason: null, metadata: null }
      : { status: 'failed', reason: slot.reason, metadata: null };
  }

  async createSandbox(params?: SandboxCreateParams): Promise<{ sandboxId: string }> {
    throwIfSignalAborted(params?.signal);
    const slot = await this.firstAttestedSlot(params?.signal);
    if (!slot.ok) {
      throw new Error(slot.reason);
    }
    const sandboxId = `s${String(slot.index + 1)}-${randomBytes(16).toString('hex')}`;
    this.logger.debug('Sandbox created', { slot: slot.index + 1 });
    return { sandboxId };
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    throwIfSignalAborted(params.signal);
    const target = this.resolve(params.sandboxId);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, (params.timeoutSeconds ?? this.defaultExecTimeoutSeconds) * 1000),
    );
    const cwd = params.cwd === undefined ? WORKSPACE_DIR : posix.resolve(WORKSPACE_DIR, params.cwd);
    const request = {
      session_id: target.sessionId,
      argv: ['bash', '-c', params.command],
      cwd,
      env: params.env ?? {},
      timeout_ms: Math.max(MIN_TIMEOUT_MS, timeoutMs - AGENT_TIMEOUT_MARGIN_MS),
      disk_mb: this.treeDiskMb,
    };
    const deadline = Date.now() + timeoutMs + QUEUE_GRACE_MS;
    for (;;) {
      throwIfSignalAborted(params.signal);
      const result = await target.client.exec({ request, signal: params.signal });
      if (result.ok) {
        return this.toExecResult({ response: result.value, timeoutMs });
      }
      if (result.error.kind === 'aborted' && params.signal !== undefined) {
        throw signalAbortError(params.signal);
      }
      if (result.error.kind === 'agent' && result.error.code === 'busy' && Date.now() < deadline) {
        await this.sleepMs(QUEUE_POLL_MS);
        continue;
      }
      return { success: false, error: describeAgentError(result.error) };
    }
  }

  /** A cancelled call ends its whole guest, so nothing outlives the call and there is nothing to wait for. */
  acknowledgeWorkspaceTermination(): Promise<void> {
    return Promise.resolve();
  }

  executeVerifiedWorkspaceCommit(params: VerifiedWorkspaceCommitParams): Promise<VerifiedWorkspaceCommitResult> {
    return executeVerifiedWorkspaceCommit({ execute: next => this.exec(next), params });
  }

  async downloadFile(params: SandboxDownloadFileParams): Promise<Buffer> {
    const target = this.resolve(params.sandboxId);
    const result = await target.client.fsRead({
      sessionId: target.sessionId,
      path: params.path,
      signal: params.signal,
    });
    if (!result.ok) {
      if (result.error.kind === 'aborted' && params.signal !== undefined) {
        throw signalAbortError(params.signal);
      }
      if (result.error.kind === 'agent' && result.error.code === 'not_found') {
        throw new SandboxFileNotFoundError(params.path);
      }
      if (result.error.kind === 'agent' && result.error.message.includes('directory')) {
        throw new SandboxPathIsDirectoryError(params.path);
      }
      if (result.error.kind === 'agent' && result.error.message.includes('larger than')) {
        throw new SandboxFileTooLargeError(params.path, this.fileMaxBytesForDownload + 1, this.fileMaxBytesForDownload);
      }
      throw new Error(`Failed to download file: ${describeAgentError(result.error)}`);
    }
    if (result.value.size_bytes > this.fileMaxBytesForDownload) {
      throw new SandboxFileTooLargeError(params.path, result.value.size_bytes, this.fileMaxBytesForDownload);
    }
    return Buffer.from(result.value.content_base64, 'base64');
  }

  async uploadFile(params: SandboxUploadFileParams): Promise<void> {
    const target = this.resolve(params.sandboxId);
    const result = await target.client.fsWrite({
      sessionId: target.sessionId,
      path: posix.resolve(WORKSPACE_DIR, params.remotePath),
      content: params.content,
      mode: 0o644,
      signal: params.signal,
    });
    if (!result.ok) {
      if (result.error.kind === 'aborted' && params.signal !== undefined) {
        throw signalAbortError(params.signal);
      }
      throw new Error(`Failed to upload file: ${describeAgentError(result.error)}`);
    }
  }

  createCodeModeTransport(): CodeModeTransport {
    throw new Error('Code Mode is not available in sandbox slots.');
  }

  getAdditionalInstructions(): string {
    return [
      'SANDBOX RULES:',
      '- Every command starts in a fresh, offline sandbox. Files under /workspace persist between commands; processes do not, so a background process ends when its command returns.',
      '- Python 3, Node.js with TypeScript, bash, git and gcc/g++/make are installed. Packages cannot be downloaded.',
    ].join('\n');
  }

  getWorkspaceDir(): string {
    return WORKSPACE_DIR;
  }

  getToolResultDumpDir(): string {
    return `${STATE_DIR}/tool-results`;
  }

  getGitCredentialsPath(): string {
    return `${STATE_DIR}/.git-credentials`;
  }

  getFileUploadsDir(): string {
    return `${STATE_DIR}/uploads`;
  }

  getSkillsDir(): string {
    return `${STATE_DIR}/skills`;
  }

  getSkillDownloaderPath(): string {
    return `${STATE_DIR}/skill_downloader.py`;
  }

  private resolve(sandboxId: string): { client: SlotClient; sessionId: string } {
    const parsed = parseSandboxId(sandboxId);
    const client = parsed === undefined ? undefined : this.clients[parsed.slot];
    if (parsed === undefined || client === undefined) {
      throw new SandboxNotAvailableError(sandboxId);
    }
    return { client, sessionId: parsed.sessionId };
  }

  private async firstAttestedSlot(
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; index: number } | { ok: false; reason: string }> {
    const problems: string[] = [];
    for (const [index, client] of this.clients.entries()) {
      const health = await client.health({ signal, timeoutMs: HEALTH_TIMEOUT_MS });
      if (!health.ok) {
        problems.push(`slot ${String(index + 1)} is not reachable`);
        continue;
      }
      const problem = attestationProblem(health.value.attestation);
      if (problem === undefined) {
        return { ok: true, index };
      }
      problems.push(`slot ${String(index + 1)} failed its checks (${problem})`);
    }
    return {
      ok: false,
      reason: `The sandbox is not available: ${problems.join('; ') || 'no slots are configured'}. Run \`${SLOT_FIX_COMMAND}\`, then try again.`,
    };
  }

  private toExecResult(input: { response: SlotExecResponse; timeoutMs: number }): ExecResult {
    const { response } = input;
    const tail = response.output.slice(-OUTPUT_TAIL_CHARS);
    const withTail = (message: string): string => (tail === '' ? message : `${message}\nOutput so far:\n${tail}`);
    switch (response.terminated_by) {
      case 'completed':
        return { success: true, response: { exitCode: response.exit_code, result: response.output } };
      case 'timeout':
        return {
          success: false,
          error: withTail(
            `The command timed out after ${String(Math.round(input.timeoutMs / 1000))}s and was stopped.`,
          ),
        };
      case 'oom':
        return { success: false, error: withTail('The command ran out of memory and was stopped.') };
      case 'disk_exceeded':
        return { success: false, error: withTail('The workspace reached its disk limit and the command was stopped.') };
      case 'output_exceeded':
        return { success: false, error: 'The command wrote too much output and was stopped. Narrow what it prints.' };
      case 'killed':
        return { success: false, error: withTail('The command was stopped.') };
      case 'internal':
        return {
          success: false,
          error: `The sandbox failed to run the command${response.internal_error === '' ? '' : `: ${response.internal_error}`}.`,
        };
    }
  }
}
