/**
 * Copies every file a completed turn declared in its final `sandbox_artifacts` block from the
 * sandbox into host storage, so a download still works after the provider auto-stops (minutes
 * later) and eventually deletes the sandbox that produced it. Fire-and-forget from the turn's
 * drain hook, the same shape as `submitRetain` (memoryRetain.ts): a persistence failure here
 * must never fail or delay the turn it belongs to.
 */
import {
  extractErrorLogFields,
  extractSandboxArtifactsFromMessage,
  rawSandboxId,
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  type SandboxProvider,
} from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import type { ITurnArtifactStore } from '../../db/turnArtifactStore';

/**
 * The existing download route always serves sandbox files as `application/octet-stream`
 * (see `downloadSandboxFileHandler` in apis/turns.ts); persisted bytes are served the same way,
 * so the stored mime matches the contract the route already has with clients.
 */
export const PERSISTED_ARTIFACT_MIME = 'application/octet-stream';

export interface SubmitArtifactPersistenceParams {
  store: ITurnArtifactStore;
  provider: SandboxProvider;
  sandboxId: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  /** The turn's final assistant message text, parsed for `sandbox_artifacts` fences. */
  assistantText: string;
  logger: Logger;
}

async function recordSkipped(
  store: ITurnArtifactStore,
  input: {
    tenantId: string;
    sessionId: string;
    turnId: string;
    path: string;
    name: string;
    status: 'skipped_size' | 'skipped_missing';
    reason: string;
    size?: number | undefined;
  },
  logger: Logger,
): Promise<void> {
  try {
    await store.recordSkippedArtifact({
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      turn_id: input.turnId,
      path: input.path,
      name: input.name,
      status: input.status,
      skip_reason: input.reason,
      size: input.size,
    });
  } catch (error) {
    logger.error('Failed to record a skipped sandbox artifact', {
      ...extractErrorLogFields(error),
      sessionId: input.sessionId,
      turnId: input.turnId,
      path: input.path,
    });
  }
}

/**
 * Fire-and-forget for one turn's declared artifacts. Never throws: every failure, per file or
 * for the whole batch, is logged and swallowed. Does not record any pending-operation state:
 * unlike memory retain there is no reliability-loop resubmission; a turn whose persistence pass
 * never ran (e.g. a host crash mid-drain) simply has no `turn_artifact` rows, and the download
 * route falls back to the live sandbox for it exactly as it did before this feature existed.
 */
export async function submitArtifactPersistence(params: SubmitArtifactPersistenceParams): Promise<void> {
  const { store, provider, sandboxId, tenantId, sessionId, turnId, assistantText, logger } = params;
  let artifacts;
  try {
    artifacts = extractSandboxArtifactsFromMessage(assistantText);
  } catch (error) {
    logger.error('Failed to parse sandbox_artifacts from the completed turn', {
      ...extractErrorLogFields(error),
      sessionId,
      turnId,
    });
    return;
  }
  if (artifacts.length === 0) {
    return;
  }

  for (const artifact of artifacts) {
    try {
      const data = await provider.downloadFile({ sandboxId: rawSandboxId(sandboxId), path: artifact.path });
      await store.recordStoredArtifact({
        tenant_id: tenantId,
        session_id: sessionId,
        turn_id: turnId,
        path: artifact.path,
        name: artifact.name,
        data,
        mime: PERSISTED_ARTIFACT_MIME,
      });
    } catch (error) {
      if (error instanceof SandboxFileTooLargeError) {
        await recordSkipped(
          store,
          {
            tenantId,
            sessionId,
            turnId,
            path: artifact.path,
            name: artifact.name,
            status: 'skipped_size',
            reason: error.message,
            size: error.fileSize,
          },
          logger,
        );
        continue;
      }
      if (error instanceof SandboxFileNotFoundError || error instanceof SandboxPathIsDirectoryError) {
        await recordSkipped(
          store,
          {
            tenantId,
            sessionId,
            turnId,
            path: artifact.path,
            name: artifact.name,
            status: 'skipped_missing',
            reason: error.message,
          },
          logger,
        );
        continue;
      }
      if (error instanceof SandboxNotAvailableError) {
        // The sandbox itself is gone: no other declared path will succeed either, so stop the
        // batch instead of retrying the same failure for every remaining artifact.
        logger.warn('Sandbox artifact persistence stopped: sandbox no longer exists', {
          ...extractErrorLogFields(error),
          sessionId,
          turnId,
        });
        return;
      }
      logger.error('Sandbox artifact persistence failed for one file', {
        ...extractErrorLogFields(error),
        sessionId,
        turnId,
        path: artifact.path,
      });
    }
  }
}
