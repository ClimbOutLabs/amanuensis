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
import { PACKAGE_UNAVAILABLE_RULE, PYTHON_PROJECT_ENVIRONMENT_RULE } from '../packageMirrors';
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
  /**
   * Remembers whether the slots were last seen full, so the warning is logged when that changes rather than on
   * every check. A host that makes a provider per call passes one shared log; without it each provider keeps its own.
   */
  fullStateLog?: SlotFullStateLog | undefined;
}

/** Logs "every sandbox slot is full" once when the slots fill up, and again only after room came back. */
export class SlotFullStateLog {
  #full = false;

  report(input: {
    logger: Logger;
    full: readonly { index: number; sessions: number; capacity: number }[] | null;
  }): void {
    if (input.full === null) {
      this.#full = false;
      return;
    }
    if (this.#full) {
      return;
    }
    this.#full = true;
    input.logger.warn('every sandbox slot is full', {
      slots: input.full.map(slot => ({ slot: slot.index + 1, sessions: slot.sessions, capacity: slot.capacity })),
    });
  }
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
  readonly network = 'none';
  /** The workspace exists only inside the slot; the slot agent walks every path with O_NOFOLLOW. */
  readonly filesystem: 'host' | 'remote' = 'remote';

  private readonly clients: SlotClient[];
  private readonly defaultExecTimeoutSeconds: number;
  private readonly treeDiskMb: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly logger: Logger;
  private readonly sleepMs: (ms: number) => Promise<void>;
  private readonly gitBridge: GitBridge | undefined;
  private readonly fullStateLog: SlotFullStateLog;
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
    this.fullStateLog = options.fullStateLog ?? new SlotFullStateLog();
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
      argv: params.argv === undefined ? ['bash', '-c', params.command] : [...params.argv],
      cwd,
      env: params.env ?? {},
      timeout_ms: Math.max(SLOT_MIN_AGENT_TIMEOUT_MS, timeoutMs - SLOT_AGENT_TIMEOUT_MARGIN_MS),
      disk_mb: this.treeDiskMb,
      ...(params.packageMirrorToken === undefined ? {} : { package_mirror_token: params.packageMirrorToken }),
      ...(params.skillNetworkToken === undefined ? {} : { skill_network_token: params.skillNetworkToken }),
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

  async destroySandbox(params: { sandboxId: string; signal?: AbortSignal | undefined }): Promise<void> {
    const target = this.resolve(params.sandboxId);
    const result = await this.whileBusy({
      call: () => target.client.destroySession({ sessionId: target.sessionId, signal: params.signal }),
      signal: params.signal,
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
      '- Python 3, Node.js with TypeScript, bash, git and gcc/g++/make are installed.',
      '- No general network from code or the shell, by design. The one exception is package downloads: when the person has allowed downloads for this chat (per repository, or one switch for chats without a project), pip, npm, Go and Cargo can fetch packages from the public package sites. Packages that come from a git address cannot be fetched. When downloads are not allowed, packages cannot be downloaded; ' +
        PACKAGE_UNAVAILABLE_RULE,
      `- ${PYTHON_PROJECT_ENVIRONMENT_RULE}`,
      "- run_code runs only the code it is given, in an empty folder: it cannot see /workspace or anything installed there. Check a project's files with exec and its code with its tests, not with run_code.",
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

  /** Reads below the transfer directory may be as large as a document; ordinary reads are capped lower by the agent. */
  getDocumentSnapshotDir(): string {
    return `${STATE_DIR}/transfer`;
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
      approvedRemotes: params.approvedGitRemotes,
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
          approvedRemotes: undefined,
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
          ...(input.env === undefined ? {} : { env: input.env }),
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

  /** The slot a retired slot's chats went to, as an index: slot 3 to slot 1, slot 4 to slot 2, and no other slot. */
  private retiredIndex(slot: number): number | undefined {
    const target = slot === 2 ? 0 : slot === 3 ? 1 : undefined;
    return target !== undefined && target < this.clients.length ? target : undefined;
  }

  private resolve(sandboxId: string): { client: SlotClient; sessionId: string } {
    const parsed = parseSandboxId(sandboxId);
    // Installs from before had four slots; the setup moved the chats of slots 3 and 4 into slots 1 and 2
    // before removing the old slots, so an old id still resolves: slot 3 to slot 1, slot 4 to slot 2. That
    // mapping is fixed and does not follow the number of slots in use: with one slot in use a slot 4 id
    // does not resolve, because its chats are on slot 2, and a slot 2 id does not resolve either.
    let index: number | undefined;
    if (parsed !== undefined && this.clients.length > 0) {
      index = parsed.slot < this.clients.length ? parsed.slot : this.retiredIndex(parsed.slot);
    }
    const client = index === undefined ? undefined : this.clients[index];
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
    const full: { index: number; sessions: number; capacity: number }[] = [];
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
          full.push({ index, sessions: health.value.sessions, capacity });
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
      this.fullStateLog.report({ logger: this.logger, full: null });
      return { ok: true, index: chosen.index };
    }
    if (problems.length === 0 && full.length > 0) {
      this.fullStateLog.report({ logger: this.logger, full });
      return {
        ok: false,
        reason: `The sandbox is full: every slot already holds as many chats as its disk fits (${full
          .map(slot => `slot ${String(slot.index + 1)} holds ${String(slot.capacity)} chats`)
          .join('; ')}). Delete old chats, then try again.`,
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
