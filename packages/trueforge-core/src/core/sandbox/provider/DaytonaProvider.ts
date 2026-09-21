import type { Sandbox, Snapshot } from '@daytona/sdk';
import { Daytona, DaytonaError } from '@daytona/sdk';
import { context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path/posix';
import type { Logger } from 'winston';
import { awaitWithAbort, signalAbortError, throwIfSignalAborted } from '../../util/abort';
import { extractErrorLogFields } from '../../util/errorLogFields';
import { withTimeout } from '../../util/promiseUtils';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  validateSandboxOwnedByTenant,
} from '../SandboxErrors';
import type { CodeModeTransport } from '../codeMode/CodeModeTransport';
import { CodeModeNatsTransport, type CodeModeNatsEndpoint } from '../codeMode/nats/CodeModeNatsTransport';
import { DEFAULT_PREVIEW_URL_EXPIRY_SECONDS, DEFAULT_SANDBOX_NATS_WS_PORT } from '../constants';
import { sandboxEgressDomainAllowList } from '../egressPolicy';
import {
  commandWithWorkspaceLock,
  ensureExecSuccess,
  executeVerifiedWorkspaceCommit,
  workspaceTerminationCommand,
  type ExecResult,
  type SandboxBuild,
  type SandboxCreateParams,
  type SandboxDownloadFileParams,
  type SandboxExecParams,
  type SandboxFileInfo,
  type SandboxProvider,
  type SandboxUploadFileParams,
  type VerifiedWorkspaceCommitParams,
  type VerifiedWorkspaceCommitResult,
  type WorkspaceTerminationParams,
} from './Provider';

const SANDBOX_NOT_FOUND_STATUS = 404;
/** Another replica already registered this build name; its create is the one that counts. */
const SNAPSHOT_CONFLICT_STATUS = 409;
const SANDBOX_STATE_STARTED = 'started';

const BUILD_STATE_ACTIVE = 'active';
const BUILD_STATE_INACTIVE = 'inactive';
const BUILD_STATE_ERROR = 'error';
const BUILD_STATE_BUILD_FAILED = 'build_failed';

const IMAGE_BUILD_NAME_PREFIX = 'trueforge-build-';
const DAYTONA_WORKSPACE_DIR = join('/opt', 'tf', 'workspace');
/** Same default the Daytona SDK applies when `DaytonaConfig.apiUrl` is omitted. */
const DEFAULT_DAYTONA_API_URL = 'https://app.daytona.io/api';
const ABORTED_CREATE_DELETE_TIMEOUT_SECONDS = 10;
const ABORTED_CREATE_CLEANUP_TIMEOUT_MS = 10_000;

interface DaytonaSandboxEntry {
  sandbox: Sandbox;
  defaultTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Digest portion of a container image reference (the tag/digest after the final `:`)
 * The release image is always published with an explicit digest tag
 */
function imageDigest(image: string): string {
  const lastSegment = image.slice(image.lastIndexOf('/') + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon === -1) {
    throw new Error(`Sandbox image reference has no tag/digest: ${image}`);
  }
  return lastSegment.slice(colon + 1);
}

/** Deterministic build name per image digest so every server replica converges on one build. */
function deriveImageBuildName(digest: string): string {
  return `${IMAGE_BUILD_NAME_PREFIX}${digest}`;
}

/** Terminal-failure build states: a build stuck here never becomes ready on its own. */
function isFailedBuildState(state: Snapshot['state']): boolean {
  return state === BUILD_STATE_ERROR || state === BUILD_STATE_BUILD_FAILED;
}

/** Convert Daytona https preview URLs to wss for the NATS client. */
function httpUrlToWsUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  }
  return parsed.toString();
}

/**
 * Nightona's local preview host is a logical Host-routing key, not a hostname an
 * application container can resolve. Dial its SDK-reported toolbox proxy while
 * leaving normal Daytona and custom resolvable preview domains untouched.
 */
export function resolveDaytonaCodeModeNatsEndpoint(params: {
  signedPreviewUrl: string;
  toolboxProxyUrl: string;
}): CodeModeNatsEndpoint {
  const signedUrl = httpUrlToWsUrl(params.signedPreviewUrl);
  const signed = new URL(signedUrl);
  if (!signed.hostname.endsWith('.proxy.localhost')) {
    return signedUrl;
  }

  const dial = new URL(httpUrlToWsUrl(params.toolboxProxyUrl));
  dial.pathname = signed.pathname;
  dial.search = signed.search;
  dial.hash = signed.hash;
  return { url: signedUrl, dialUrl: dial.toString() };
}

export interface DaytonaSandboxProviderOptions {
  /** Caller-owned Daytona SDK client (credentials / lifetime). */
  client: Daytona;
  /**
   * Same API key the client was built with; used for the register-only snapshot POST because the
   * SDK's `snapshot.create` polls to a terminal state instead of returning once registered.
   */
  apiKey: string;
  /** Daytona API base URL (including `/api`). Defaults to the SDK's public cloud endpoint. */
  apiUrl?: string | undefined;
  tenantName: string;
  /** Release-owned sandbox image reference; built into a Daytona snapshot and cloned per sandbox. */
  sandboxImage: string;
  /**
   * Daytona snapshot name to clone sandboxes from. When omitted it is derived from the image
   * digest. Callers that create sandboxes pass the persisted build_ref so cloning targets the
   * snapshot that was actually built, not a speculative name derived from the current image.
   */
  buildRef?: string | undefined;
  timeoutMs: number;
  autoStopIntervalInMinutes: number;
  autoArchiveIntervalInMinutes: number;
  autoDeleteIntervalInMinutes: number;
  fileMaxBytesForDownload: number;
  /** Defaults to the built-in sandbox NATS WebSocket port (4444). */
  natsBridgePort?: number;
  /** Defaults to 1 hour (same as the gateway's max agent execution time). */
  previewUrlExpirySeconds?: number;
  logger: Logger;
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly type = 'daytona';
  private readonly tenantName: string;
  /** Release-owned sandbox image reference; built into a Daytona snapshot and cloned per sandbox. */
  private readonly imageUri: string;
  /** Daytona snapshot name sandboxes are cloned from; the persisted build_ref, or derived from the image digest. */
  private readonly buildRef: string;
  private readonly timeoutMs: number;
  private readonly autoStopIntervalInMinutes: number;
  private readonly autoArchiveIntervalInMinutes: number;
  private readonly autoDeleteIntervalInMinutes: number;
  private readonly fileMaxBytesForDownload: number;
  private readonly natsBridgePort: number;
  private readonly previewUrlExpirySeconds: number;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly logger: Logger;
  private readonly daytona: Daytona;
  private static readonly cachedSandboxes = new Map<string, DaytonaSandboxEntry>();
  // De-dupes concurrent recovery attempts on the same sandbox to a single refreshData+start round-trip.
  private static readonly inFlightRecoveries = new Map<string, Promise<boolean>>();

  constructor(options: DaytonaSandboxProviderOptions) {
    this.daytona = options.client;
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl ?? DEFAULT_DAYTONA_API_URL;
    this.tenantName = options.tenantName;
    this.imageUri = options.sandboxImage;
    this.buildRef = options.buildRef ?? deriveImageBuildName(imageDigest(options.sandboxImage));
    this.timeoutMs = options.timeoutMs;
    this.autoStopIntervalInMinutes = options.autoStopIntervalInMinutes;
    this.autoArchiveIntervalInMinutes = options.autoArchiveIntervalInMinutes;
    this.autoDeleteIntervalInMinutes = options.autoDeleteIntervalInMinutes;
    this.fileMaxBytesForDownload = options.fileMaxBytesForDownload;
    this.natsBridgePort = options.natsBridgePort ?? DEFAULT_SANDBOX_NATS_WS_PORT;
    this.previewUrlExpirySeconds = options.previewUrlExpirySeconds ?? DEFAULT_PREVIEW_URL_EXPIRY_SECONDS;
    this.logger = options.logger.child({ module: 'DaytonaProvider' });
  }

  private async createNewSandbox(): Promise<DaytonaSandboxEntry> {
    const sandbox = await this.daytona.create({
      name: `${this.tenantName}.${randomUUID()}`,
      snapshot: this.buildRef,
      autoStopInterval: this.autoStopIntervalInMinutes,
      autoArchiveInterval: this.autoArchiveIntervalInMinutes,
      autoDeleteInterval: this.autoDeleteIntervalInMinutes,
      // Same allowlist the local SRT sandbox enforces (see egressPolicy.ts). The
      // `@daytona/sdk` client type documents this as a runner-applied iptables
      // egress allowlist, not client-side routing, so it holds even though the
      // sandbox otherwise runs unrestricted. Whether it is actually enforced
      // depends on the configured Daytona-compatible API (e.g. self-hosted
      // Nightona) honoring `domainAllowList` on sandbox creation the way
      // upstream Daytona does; that enforcement lives outside this repo.
      domainAllowList: sandboxEgressDomainAllowList(),
    });
    return { sandbox, defaultTimeoutMs: this.timeoutMs };
  }

  private cacheSandbox(entry: DaytonaSandboxEntry): void {
    DaytonaSandboxProvider.cachedSandboxes.set(entry.sandbox.name, entry);
  }

  private async getOrCreateSandbox(sandboxId?: string): Promise<DaytonaSandboxEntry> {
    if (sandboxId) {
      validateSandboxOwnedByTenant({ sandboxId, tenantName: this.tenantName });
      const cached = DaytonaSandboxProvider.cachedSandboxes.get(sandboxId);
      if (cached) {
        return cached;
      }
    }

    const entry =
      sandboxId === undefined
        ? await this.createNewSandbox()
        : { sandbox: await this.restoreExistingSandbox(sandboxId), defaultTimeoutMs: this.timeoutMs };
    this.cacheSandbox(entry);
    return entry;
  }

  // Returns true iff the caller should retry: either we restarted a stopped sandbox, or the cache entry is missing and the retry will rebuild it via the cold path.
  private static recoverSandboxIfStopped(sandboxId: string): Promise<boolean> {
    const existing = DaytonaSandboxProvider.inFlightRecoveries.get(sandboxId);
    if (existing) {
      return existing;
    }

    const cached = DaytonaSandboxProvider.cachedSandboxes.get(sandboxId);
    // Cache may have been evicted by a concurrent error path; signal retry so getOrCreateSandbox rebuilds via restoreExistingSandbox.
    if (!cached) {
      return Promise.resolve(true);
    }

    const recovery = (async () => {
      await cached.sandbox.refreshData();
      if (cached.sandbox.state === SANDBOX_STATE_STARTED) {
        return false;
      }
      // start() covers both stopped and archived per Daytona; throws on unrecoverable states (error/destroyed).
      await cached.sandbox.start();
      return true;
    })().finally(() => {
      DaytonaSandboxProvider.inFlightRecoveries.delete(sandboxId);
    });

    DaytonaSandboxProvider.inFlightRecoveries.set(sandboxId, recovery);
    return recovery;
  }

  private async executeWithSandboxRecovery<T>(sandboxId: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (originalError) {
      // TODO: Narrow to a specific Daytona error code once @daytona/sdk exposes one for "sandbox not running".
      if (!(originalError instanceof DaytonaError)) {
        throw originalError;
      }

      let recovered: boolean;
      try {
        recovered = await DaytonaSandboxProvider.recoverSandboxIfStopped(sandboxId);
      } catch (recoveryError) {
        this.logger.error('Sandbox recovery failed', {
          ...extractErrorLogFields(recoveryError),
          originalError: extractErrorLogFields(originalError),
        });
        throw new Error('Sandbox is unavailable; recovery attempt failed.', { cause: recoveryError });
      }

      if (!recovered) {
        throw originalError;
      }

      try {
        return await operation();
      } catch (retryError) {
        this.logger.error('Sandbox operation failed after successful recovery', {
          ...extractErrorLogFields(retryError),
          originalError: extractErrorLogFields(originalError),
        });
        // Rethrow as-is so callers can match domain error types (SandboxPathIsDirectoryError, DaytonaError statusCode mappings, etc.).
        throw retryError;
      }
    }
  }

  private async restoreExistingSandbox(sandboxId: string): Promise<Sandbox> {
    try {
      const sandbox = await this.daytona.get(sandboxId);
      if (sandbox.state !== SANDBOX_STATE_STARTED) {
        await sandbox.start();
      }
      return sandbox;
    } catch (ex) {
      if (ex instanceof DaytonaError && ex.statusCode === SANDBOX_NOT_FOUND_STATUS) {
        throw new SandboxNotAvailableError(sandboxId);
      }
      throw ex;
    }
  }

  private async cleanUpAbortedCreation(entry: DaytonaSandboxEntry): Promise<void> {
    const cached = DaytonaSandboxProvider.cachedSandboxes.get(entry.sandbox.name);
    if (cached?.sandbox === entry.sandbox) {
      DaytonaSandboxProvider.cachedSandboxes.delete(entry.sandbox.name);
    }
    try {
      await withTimeout(
        this.daytona.delete(entry.sandbox, ABORTED_CREATE_DELETE_TIMEOUT_SECONDS, false),
        ABORTED_CREATE_CLEANUP_TIMEOUT_MS,
        'aborted Daytona sandbox cleanup',
      );
    } catch (error) {
      this.logger.error('Failed to clean up sandbox created after caller cancellation', {
        sandboxId: entry.sandbox.name,
        ...extractErrorLogFields(error),
      });
    }
  }

  private createSandboxWithCancellation(signal: AbortSignal): Promise<{ sandboxId: string }> {
    return new Promise((resolve, reject) => {
      // Cancellation and creation acceptance are serialized by the JavaScript
      // job queue. The first branch to set ownership determines cleanup.
      let cancellationWon = false;
      let creationAccepted = false;
      const settleFromAbort = () => {
        if (cancellationWon || creationAccepted) {
          return;
        }
        cancellationWon = true;
        reject(signalAbortError(signal));
      };
      signal.addEventListener('abort', settleFromAbort, { once: true });
      if (signal.aborted) {
        settleFromAbort();
        return;
      }

      this.createNewSandbox().then(
        entry => {
          signal.removeEventListener('abort', settleFromAbort);
          if (cancellationWon || signal.aborted) {
            cancellationWon = true;
            void this.cleanUpAbortedCreation(entry);
            return;
          }
          creationAccepted = true;
          this.cacheSandbox(entry);
          this.logger.debug(`Sandbox created: name=${entry.sandbox.name}`);
          resolve({ sandboxId: entry.sandbox.name });
        },
        (error: unknown) => {
          signal.removeEventListener('abort', settleFromAbort);
          if (cancellationWon) {
            return;
          }
          reject(error instanceof Error ? error : new Error('Sandbox creation failed.', { cause: error }));
        },
      );
    });
  }

  async createSandbox(params?: SandboxCreateParams): Promise<{ sandboxId: string }> {
    const signal = params?.signal;
    throwIfSignalAborted(signal);
    return await context.with(suppressTracing(context.active()), async () => {
      if (signal !== undefined) {
        return await this.createSandboxWithCancellation(signal);
      }
      const entry = await this.createNewSandbox();
      this.cacheSandbox(entry);
      this.logger.debug(`Sandbox created: name=${entry.sandbox.name}`);
      return { sandboxId: entry.sandbox.name };
    });
  }

  /** Resolves undefined when no snapshot carries that name; auth/other failures throw. */
  private async getSnapshot(name: string): Promise<Snapshot | undefined> {
    try {
      return await this.daytona.snapshot.get(name);
    } catch (error) {
      if (error instanceof DaytonaError && error.statusCode === SANDBOX_NOT_FOUND_STATUS) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Drops a build stuck in a terminal-failure state so a fresh create can reuse its
   * deterministic name. A concurrent replica may have deleted it already (404) — that
   * is fine and treated as success.
   */
  private async deleteFailedBuild(snapshot: Snapshot): Promise<void> {
    try {
      await this.daytona.snapshot.delete(snapshot);
    } catch (error) {
      if (error instanceof DaytonaError && error.statusCode === SANDBOX_NOT_FOUND_STATUS) {
        return;
      }
      throw error;
    }
  }

  private toBuild(state: string, errorReason: string | null): SandboxBuild {
    const metadata = { build_ref: this.buildRef, image_uri: this.imageUri };
    switch (state) {
      case BUILD_STATE_ACTIVE:
        return { status: 'ready', reason: null, metadata };
      case BUILD_STATE_ERROR:
      case BUILD_STATE_BUILD_FAILED:
        return { status: 'failed', reason: errorReason ?? `Sandbox image build failed (${state}).`, metadata };
      default:
        // pending / building / pulling / removing / future states: not ready yet.
        return { status: 'pending', reason: `Sandbox image build in progress (${state}).`, metadata };
    }
  }

  /**
   * Registers the snapshot and returns its initial state without waiting for the build.
   *
   * The SDK's `snapshot.create` issues this same POST and then polls until the snapshot is active
   * or failed (minutes on a cold image pull). Configure only needs the registration result, so
   * credential errors surface on the request while build progress stays observable via `getSnapshot`.
   */
  private async registerSnapshot(): Promise<{ state: string; errorReason: string | null }> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/snapshots`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: this.buildRef, imageName: this.imageUri }),
      });
    } catch (error) {
      throw new Error('Daytona snapshot registration request failed.', { cause: error });
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        isRecord(body) && typeof body['message'] === 'string'
          ? body['message']
          : `Daytona snapshot registration failed (${String(response.status)})`;
      throw new DaytonaError(message, response.status);
    }
    if (!isRecord(body) || typeof body['state'] !== 'string') {
      throw new DaytonaError("Failed to register snapshot. Daytona didn't return a snapshot state.");
    }
    return {
      state: body['state'],
      errorReason: typeof body['errorReason'] === 'string' ? body['errorReason'] : null,
    };
  }

  async buildImage(): Promise<SandboxBuild> {
    const existing = await this.getSnapshot(this.buildRef);
    if (existing) {
      // Daytona parks unused snapshots as 'inactive' after ~2 idle weeks; reactivate rather than rebuild.
      if (existing.state === BUILD_STATE_INACTIVE) {
        const activated = await this.daytona.snapshot.activate(existing);
        return this.toBuild(activated.state, activated.errorReason);
      }
      if (!isFailedBuildState(existing.state)) {
        return this.toBuild(existing.state, existing.errorReason);
      }
      // A failed build keeps the deterministic name occupied and never self-heals, so
      // re-saving settings (which calls buildImage) could never retry. Drop it, then recreate.
      await this.deleteFailedBuild(existing);
    }

    try {
      const registered = await this.registerSnapshot();
      // Registration returns pending almost always; map whatever Daytona sent so a fast
      // active/error still surfaces correctly without a follow-up GET.
      return this.toBuild(registered.state, registered.errorReason);
    } catch (error) {
      // A losing concurrent create is not a build failure: the winner owns the deterministic name.
      if (error instanceof DaytonaError && error.statusCode === SNAPSHOT_CONFLICT_STATUS) {
        this.logger.info(`Daytona snapshot already created concurrently: name=${this.buildRef}`);
        return {
          status: 'pending',
          reason: 'Sandbox image build started by another server replica.',
          metadata: { build_ref: this.buildRef, image_uri: this.imageUri },
        };
      }
      throw error;
    }
  }

  async getImageBuildStatus(): Promise<SandboxBuild> {
    const snapshot = await this.getSnapshot(this.buildRef);
    // Read-only: a missing build reports pending; PUT /settings/sandbox-providers starts the build.
    if (!snapshot) {
      return {
        status: 'pending',
        reason: 'Sandbox image build not started.',
        metadata: { build_ref: this.buildRef, image_uri: this.imageUri },
      };
    }
    return this.toBuild(snapshot.state, snapshot.errorReason);
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    const lockedParams = commandWithWorkspaceLock(params);
    return context.with(suppressTracing(context.active()), async (): Promise<ExecResult> => {
      try {
        throwIfSignalAborted(params.signal);
        return await awaitWithAbort({
          operation: this.executeWithSandboxRecovery(lockedParams.sandboxId, async () => {
            const { sandbox, defaultTimeoutMs } = await this.getOrCreateSandbox(lockedParams.sandboxId);
            const response = await sandbox.process.executeCommand(
              lockedParams.command,
              lockedParams.cwd,
              lockedParams.env ?? {},
              lockedParams.timeoutSeconds ?? defaultTimeoutMs / 1000,
            );
            return {
              success: true,
              response: { exitCode: response.exitCode, result: response.result },
            };
          }),
          signal: params.signal,
        });
      } catch (e: unknown) {
        if (params.signal?.aborted) {
          throw signalAbortError(params.signal);
        }
        DaytonaSandboxProvider.cachedSandboxes.delete(lockedParams.sandboxId);
        if (e instanceof SandboxNotAvailableError) {
          throw e;
        }
        this.logger.error('Sandbox execution error', extractErrorLogFields(e));
        const message = e instanceof Error ? e.message : 'Unknown error';
        return { success: false, error: message };
      }
    });
  }

  async acknowledgeWorkspaceTermination(params: WorkspaceTerminationParams): Promise<void> {
    const result = await this.exec({
      sandboxId: params.sandboxId,
      command: workspaceTerminationCommand({
        workspaceRoot: params.workspaceRoot,
        operationId: params.operationId,
      }),
      timeoutSeconds: params.timeoutSeconds,
    });
    ensureExecSuccess(result);
  }

  async executeVerifiedWorkspaceCommit(params: VerifiedWorkspaceCommitParams): Promise<VerifiedWorkspaceCommitResult> {
    return await executeVerifiedWorkspaceCommit({ execute: next => this.exec(next), params });
  }

  private async getFileInfo(sandbox: Sandbox, path: string): Promise<SandboxFileInfo> {
    const details = await sandbox.fs.getFileDetails(path);
    return { size: details.size, isDir: details.isDir };
  }

  async downloadFile(params: SandboxDownloadFileParams): Promise<Buffer> {
    return context.with(suppressTracing(context.active()), async () => {
      try {
        throwIfSignalAborted(params.signal);
        return await awaitWithAbort({
          operation: this.executeWithSandboxRecovery(params.sandboxId, async () => {
            const { sandbox } = await this.getOrCreateSandbox(params.sandboxId);

            const info = await this.getFileInfo(sandbox, params.path);
            if (info.isDir) {
              throw new SandboxPathIsDirectoryError(params.path);
            }
            if (info.size > this.fileMaxBytesForDownload) {
              throw new SandboxFileTooLargeError(params.path, info.size, this.fileMaxBytesForDownload);
            }

            return await sandbox.fs.downloadFile(params.path);
          }),
          signal: params.signal,
        });
      } catch (e: unknown) {
        if (params.signal?.aborted) {
          throw signalAbortError(params.signal);
        }
        if (e instanceof SandboxPathIsDirectoryError || e instanceof SandboxFileTooLargeError) {
          throw e;
        }
        if (e instanceof DaytonaError && e.statusCode === SANDBOX_NOT_FOUND_STATUS) {
          throw new SandboxFileNotFoundError(params.path);
        }
        DaytonaSandboxProvider.cachedSandboxes.delete(params.sandboxId);
        throw e;
      }
    });
  }

  async uploadFile(params: SandboxUploadFileParams): Promise<void> {
    return context.with(suppressTracing(context.active()), async () => {
      try {
        throwIfSignalAborted(params.signal);
        await awaitWithAbort({
          operation: this.executeWithSandboxRecovery(params.sandboxId, async () => {
            const { sandbox } = await this.getOrCreateSandbox(params.sandboxId);
            await sandbox.fs.uploadFile(params.content, params.remotePath);
          }),
          signal: params.signal,
        });
      } catch (e: unknown) {
        if (params.signal?.aborted) {
          throw signalAbortError(params.signal);
        }
        DaytonaSandboxProvider.cachedSandboxes.delete(params.sandboxId);
        throw e;
      }
    });
  }

  // Mints a signed, time-limited https preview URL exposing the given sandbox port.
  private async getPreviewUrl(params: {
    sandboxId: string;
    port: number;
    expiresInSeconds: number;
  }): Promise<{ signedPreviewUrl: string; toolboxProxyUrl: string }> {
    return context.with(suppressTracing(context.active()), async () => {
      try {
        return await this.executeWithSandboxRecovery(params.sandboxId, async () => {
          const { sandbox } = await this.getOrCreateSandbox(params.sandboxId);
          const signed = await sandbox.getSignedPreviewUrl(params.port, params.expiresInSeconds);
          return { signedPreviewUrl: signed.url, toolboxProxyUrl: sandbox.toolboxProxyUrl };
        });
      } catch (e: unknown) {
        DaytonaSandboxProvider.cachedSandboxes.delete(params.sandboxId);
        this.logger.error('Failed to create signed preview URL', extractErrorLogFields(e));
        throw e;
      }
    });
  }

  createCodeModeTransport(): CodeModeTransport {
    return new CodeModeNatsTransport({
      resolveHostUrl: async (sandboxId: string) => {
        const preview = await this.getPreviewUrl({
          sandboxId,
          port: this.natsBridgePort,
          expiresInSeconds: this.previewUrlExpirySeconds,
        });
        return resolveDaytonaCodeModeNatsEndpoint(preview);
      },
      sandboxClientNatsUrl: `ws://localhost:${String(this.natsBridgePort)}`,
      logger: this.logger,
      mcpClientInstall: {
        remotePath: join('/opt', 'tf', 'mcp-client', 'mcp_client.py'),
        pathBinSymlink: join('/usr', 'local', 'bin', 'mcp-client'),
      },
    });
  }

  getAdditionalInstructions(): string | undefined {
    return undefined;
  }

  getWorkspaceDir(): string {
    return DAYTONA_WORKSPACE_DIR;
  }

  // Isolated container: image-absolute layout. GIT_CONFIG store --file needs an absolute path.
  //   /opt/tf/{workspace,uploads,skills,tool-results,skill_downloader.py,.git-credentials}
  //   /opt/tfy/mcp-client/mcp_client.py  +  /usr/local/bin/mcp-client (image PATH; no layout bin)
  getToolResultDumpDir(): string {
    return join('/opt', 'tf', 'tool-results');
  }

  getGitCredentialsPath(): string {
    return join('/opt', 'tf', '.git-credentials');
  }

  getFileUploadsDir(): string {
    return join('/opt', 'tf', 'uploads');
  }

  getSkillsDir(): string {
    return join('/opt', 'tf', 'skills');
  }

  getSkillDownloaderPath(): string {
    return join('/opt', 'tf', 'skill_downloader.py');
  }
}
