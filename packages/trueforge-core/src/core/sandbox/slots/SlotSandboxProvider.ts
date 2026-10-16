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
  type HostGitCapability,
  type SandboxBuild,
  type SandboxCreateParams,
  type SandboxDownloadFileParams,
  type SandboxExecParams,
  type SandboxProvider,
  type SandboxUploadFileParams,
  type VerifiedWorkspaceCommitParams,
  type VerifiedWorkspaceCommitResult,
} from '../provider/Provider';
import { SlotClient, type SlotCallError, type SlotCallResult } from './SlotClient';
import { attestationProblem, SLOT_FIX_COMMAND, SLOT_NOT_READY_MESSAGE } from './SlotDriver';
import { GitBridge, type BridgeGuest } from './git/gitBridge';
import {
  SLOT_AGENT_TIMEOUT_MARGIN_MS,
  SLOT_HEALTH_TIMEOUT_MS,
  SLOT_MIN_AGENT_TIMEOUT_MS,
  SLOT_QUEUE_POLL_MS,
  type SlotExecResponse,
} from './slotContract';

const WORKSPACE_DIR = '/workspace';
const STATE_DIR = `${WORKSPACE_DIR}/.aman`;
const SANDBOX_ID_PATTERN = /^s([1-9][0-9]{0,2})-([0-9a-f]{32})$/;
/** How long a call waits for its slot when other sessions hold it, beyond the call's own limit. */
const QUEUE_GRACE_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 2_000;

export interface SlotSandboxProviderOptions {
  /** Unix socket path of each slot agent, in slot order. */
  socketPaths: readonly string[];
  defaultExecTimeoutSeconds: number;
  /** Per-session tree quota in MiB. */
  treeDiskMb: number;
  fileMaxBytesForDownload: number;
  logger: Logger;
  sleepMs: ((ms: number) => Promise<void>) | undefined;
  /** Carries out network git on the host; without it, git commands that need the network simply fail offline. */
  gitBridge: GitBridge | undefined;
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

/** Notices from the slot, set apart from the command's own output. */
function noticeText(notices: readonly string[]): string {
  return notices.length === 0 ? '' : `\n${notices.map(notice => `[sandbox] ${notice}`).join('\n')}\n`;
}

/** How many chats' full quotas a slot's own disk holds, keeping 1 GiB free; undefined when the disk is not the slot's own. */
export function chatCapacity(input: {
  facts: { disk_mode: string; workspace_bytes: number };
  treeDiskMb: number;
}): number | undefined {
  if (input.facts.disk_mode !== 'hard' || input.facts.workspace_bytes <= 0) {
    return undefined;
  }
  const usable = input.facts.workspace_bytes - 1024 * 1024 * 1024;
  return Math.max(1, Math.floor(usable / (input.treeDiskMb * 1024 * 1024)));
}

const STORAGE_FULL_MESSAGE =
  'The sandbox storage is almost full, so nothing was run. Free some disk space on this machine, then try again.';

function describeAgentError(error: SlotCallError): string {
  if (error.kind === 'agent' && error.code === 'isolation_refused') {
    return `The sandbox could not prove its safety limits, so nothing was run (${error.message}). Run \`${SLOT_FIX_COMMAND}\`, then try again.`;
  }
  if (error.kind === 'agent' && error.code === 'storage_full') {
    return STORAGE_FULL_MESSAGE;
  }
  if (error.kind === 'unreachable') {
    return SLOT_NOT_READY_MESSAGE;
  }
  return `The sandbox failed: ${error.message}`;
}

/**
 * Shell and file tools on sandbox slots. A sandbox is a workspace tree pinned to one slot; every command
 * runs in a fresh gVisor guest that mounts that tree at /workspace. Background processes end with the call.
 */
export class SlotSandboxProvider implements SandboxProvider {
  readonly type = 'slots';
  /** The slots are offline, so sandbox code cannot reach connectors through a bridge. */
  readonly supportsCodeMode = false;
  /** The workspace exists only inside the slot; the slot agent walks every path with O_NOFOLLOW. */
  readonly filesystem: 'host' | 'remote' = 'remote';

  private readonly clients: SlotClient[];
  private readonly defaultExecTimeoutSeconds: number;
  private readonly treeDiskMb: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly logger: Logger;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly gitBridge: GitBridge | undefined;
  private gitToken: string | null = null;
  readonly hostGit: HostGitCapability | undefined;

  constructor(options: SlotSandboxProviderOptions) {
    this.clients = options.socketPaths.map(path => new SlotClient(path));
    this.defaultExecTimeoutSeconds = options.defaultExecTimeoutSeconds;
    this.treeDiskMb = options.treeDiskMb;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload;
    this.logger = options.logger.child({ module: 'SlotSandboxProvider' });
    this.sleepMs = options.sleepMs ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.gitBridge = options.gitBridge;
    this.hostGit = options.gitBridge === undefined ? undefined : this.createHostGit(options.gitBridge);
  }

  async buildImage(): Promise<SandboxBuild> {
    return this.getImageBuildStatus();
  }

  /** Ready when at least one slot proves its isolation; slots are prepared outside the app. */
  async getImageBuildStatus(): Promise<SandboxBuild> {
    const slot = await this.leastLoadedSlot(undefined);
    return slot.ok
      ? { status: 'ready', reason: null, metadata: null }
      : { status: 'failed', reason: slot.reason, metadata: null };
  }

  async createSandbox(params?: SandboxCreateParams): Promise<{ sandboxId: string }> {
    throwIfSignalAborted(params?.signal);
    const slot = await this.leastLoadedSlot(params?.signal);
    if (!slot.ok) {
      throw new Error(slot.reason);
    }
    const sandboxId = `s${String(slot.index + 1)}-${randomBytes(16).toString('hex')}`;
    this.logger.debug('Sandbox created', { slot: slot.index + 1 });
    return { sandboxId };
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    throwIfSignalAborted(params.signal);
    const bridged = this.bridgedGit(params);
    if (bridged !== undefined) {
      return bridged;
    }
    return this.execInGuest(params);
  }

  private async execInGuest(params: SandboxExecParams): Promise<ExecResult> {
    const target = this.resolve(params.sandboxId);
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(SLOT_MIN_AGENT_TIMEOUT_MS, (params.timeoutSeconds ?? this.defaultExecTimeoutSeconds) * 1000),
    );
    const cwd = params.cwd === undefined ? WORKSPACE_DIR : posix.resolve(WORKSPACE_DIR, params.cwd);
    const request = {
      session_id: target.sessionId,
      argv: ['bash', '-c', params.command],
      cwd,
      env: params.env ?? {},
      timeout_ms: Math.max(SLOT_MIN_AGENT_TIMEOUT_MS, timeoutMs - SLOT_AGENT_TIMEOUT_MARGIN_MS),
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
        await this.sleepMs(SLOT_QUEUE_POLL_MS);
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
    const result = await this.whileBusy({
      call: () => target.client.fsRead({ sessionId: target.sessionId, path: params.path, signal: params.signal }),
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
    const result = await this.whileBusy({
      call: () =>
        target.client.fsWrite({
          sessionId: target.sessionId,
          path: posix.resolve(WORKSPACE_DIR, params.remotePath),
          content: params.content,
          mode: 0o644,
          signal: params.signal,
        }),
      signal: params.signal,
    });
    if (!result.ok) {
      if (result.error.kind === 'aborted' && params.signal !== undefined) {
        throw signalAbortError(params.signal);
      }
      throw new Error(`Failed to upload file: ${describeAgentError(result.error)}`);
    }
  }

  async destroySandbox(params: { sandboxId: string }): Promise<void> {
    const target = this.resolve(params.sandboxId);
    const result = await this.whileBusy({
      call: () => target.client.destroySession({ sessionId: target.sessionId, signal: undefined }),
      signal: undefined,
    });
    if (!result.ok) {
      throw new Error(`Failed to remove the sandbox workspace: ${describeAgentError(result.error)}`);
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

  /** Network git as one plain command is done by the host; everything else runs in the guest. */
  private bridgedGit(params: SandboxExecParams): Promise<ExecResult> | undefined {
    const bridge = this.gitBridge;
    const plan = bridge?.plan(params.command);
    if (bridge === undefined || plan === undefined || Object.keys(params.env ?? {}).length > 0) {
      return undefined;
    }
    return bridge.run({
      command: params.command,
      plan,
      token: this.gitToken,
      guest: this.guestFor(params.sandboxId),
      sandboxId: params.sandboxId,
      cwd: params.cwd === undefined ? WORKSPACE_DIR : posix.resolve(WORKSPACE_DIR, params.cwd),
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
    });
  }

  private createHostGit(bridge: GitBridge): HostGitCapability {
    return {
      setToken: token => {
        this.gitToken = token;
      },
      isPush: command => bridge.plan(command)?.subcommand === 'push',
      previewPush: async input => {
        const plan = bridge.plan(input.command);
        if (plan === undefined) {
          return { status: 'refused', message: 'This is not a push the sandbox can carry out.' };
        }
        return bridge.previewPush({
          command: input.command,
          plan,
          token: this.gitToken,
          guest: this.guestFor(input.sandboxId),
          sandboxId: input.sandboxId,
          cwd: input.cwd === undefined ? WORKSPACE_DIR : posix.resolve(WORKSPACE_DIR, input.cwd),
          timeoutSeconds: undefined,
          signal: input.signal,
        });
      },
    };
  }

  /** The bridge's view of one sandbox; transfers use the agent's larger limits, not the download cap. */
  private guestFor(sandboxId: string): BridgeGuest {
    return {
      exec: input =>
        this.execInGuest({
          sandboxId,
          command: input.command,
          cwd: input.cwd,
          ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
          signal: input.signal,
        }),
      putFile: async input => {
        const target = this.resolve(sandboxId);
        const written = await this.whileBusy({
          call: () =>
            target.client.fsWrite({
              sessionId: target.sessionId,
              path: input.path,
              content: input.content,
              mode: 0o644,
              signal: input.signal,
            }),
          signal: input.signal,
        });
        if (!written.ok) {
          throw new Error(`Failed to move a file into the sandbox: ${describeAgentError(written.error)}`);
        }
      },
      getFile: async input => {
        const target = this.resolve(sandboxId);
        const read = await this.whileBusy({
          call: () => target.client.fsRead({ sessionId: target.sessionId, path: input.path, signal: input.signal }),
          signal: input.signal,
        });
        if (!read.ok) {
          throw new Error(`Failed to read a file from the sandbox: ${describeAgentError(read.error)}`);
        }
        return Buffer.from(read.value.content_base64, 'base64');
      },
    };
  }

  /** File transfers and removal wait while a command holds the same chat's workspace or its slot. */
  private async whileBusy<T>(input: {
    call: () => Promise<SlotCallResult<T>>;
    signal: AbortSignal | undefined;
  }): Promise<SlotCallResult<T>> {
    const deadline = Date.now() + MAX_TIMEOUT_MS + QUEUE_GRACE_MS;
    for (;;) {
      throwIfSignalAborted(input.signal);
      const result = await input.call();
      if (result.ok || result.error.kind !== 'agent' || result.error.code !== 'busy' || Date.now() >= deadline) {
        return result;
      }
      await this.sleepMs(SLOT_QUEUE_POLL_MS);
    }
  }

  private resolve(sandboxId: string): { client: SlotClient; sessionId: string } {
    const parsed = parseSandboxId(sandboxId);
    const client = parsed === undefined ? undefined : this.clients[parsed.slot];
    if (parsed === undefined || client === undefined) {
      throw new SandboxNotAvailableError(sandboxId);
    }
    return { client, sessionId: parsed.sessionId };
  }

  /**
   * The attested slot holding the fewest chats, so one long command cannot block every chat. The slot is
   * recorded in the sandbox id, which keeps a chat on the same slot across turns and restarts.
   */
  private async leastLoadedSlot(
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true; index: number } | { ok: false; reason: string }> {
    const probes = await Promise.all(
      this.clients.map(async (client, index) => ({
        index,
        health: await client.health({ signal, timeoutMs: SLOT_HEALTH_TIMEOUT_MS }),
      })),
    );
    const problems: string[] = [];
    const full: string[] = [];
    const usable: { index: number; sessions: number }[] = [];
    for (const { index, health } of probes) {
      if (!health.ok) {
        problems.push(`slot ${String(index + 1)} is not reachable`);
        continue;
      }
      const problem = attestationProblem(health.value.attestation, Date.now());
      if (problem === undefined) {
        // On a slot with its own fixed disk the chats' quotas must fit, or one slot filling up fails for all its chats.
        const capacity = chatCapacity({ facts: health.value.attestation.facts, treeDiskMb: this.treeDiskMb });
        if (capacity !== undefined && health.value.sessions >= capacity) {
          full.push(`slot ${String(index + 1)} holds ${String(capacity)} chats`);
        } else {
          usable.push({ index, sessions: health.value.sessions });
        }
      } else {
        problems.push(`slot ${String(index + 1)} failed its checks (${problem})`);
      }
    }
    const fewest = Math.min(...usable.map(slot => slot.sessions));
    const emptiest = usable.filter(slot => slot.sessions === fewest);
    const chosen = emptiest[Math.floor(Math.random() * emptiest.length)];
    if (chosen !== undefined) {
      return { ok: true, index: chosen.index };
    }
    if (problems.length === 0 && full.length > 0) {
      return {
        ok: false,
        reason: `The sandbox is full: every slot already holds as many chats as its disk fits (${full.join('; ')}). Delete old chats, then try again.`,
      };
    }
    this.logger.warn('no sandbox slot is usable', { problems });
    return { ok: false, reason: SLOT_NOT_READY_MESSAGE };
  }

  private toExecResult(input: { response: SlotExecResponse; timeoutMs: number }): ExecResult {
    const { response } = input;
    const tail = response.output.slice(-OUTPUT_TAIL_CHARS);
    const withTail = (message: string): string => (tail === '' ? message : `${message}\nOutput so far:\n${tail}`);
    switch (response.terminated_by) {
      case 'completed':
        return {
          success: true,
          response: { exitCode: response.exit_code, result: `${response.output}${noticeText(response.notices)}` },
        };
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
        return {
          success: false,
          error: `${withTail('The workspace reached its disk limit and the command was stopped.')}${noticeText(response.notices)}`,
        };
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
