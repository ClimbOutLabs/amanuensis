/**
 * Persists run_code's harvested result files as turn artifacts at harvest time,
 * BEFORE the service cleans up the run root.
 *
 * run_code harvests result files (egress first, then scratch, egress winning
 * name collisions) into `files_out` metadata plus raw bytes. Without this sink
 * the bytes are discarded at cleanup: the agent reports success and names
 * files the user can never download. The sink stores every harvested file
 * through the turn artifact store under the `run_code/` path namespace, so the
 * existing turns download route serves them by path and the artifacts list
 * endpoint exposes them without any assistant-authored `sandbox_artifacts`
 * prose fence.
 *
 * Failure contract: per-file best effort — every file is attempted, failures
 * are logged with their names, and an aggregate error is thrown only when at
 * least one file failed. The service converts a sink throw into a harvest
 * warning on the result (the run itself still succeeds); the metadata-only
 * `files_out` still stands.
 */
import type { HarvestedFile } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import type { ITurnArtifactStore } from '../../db/turnArtifactStore';
import { PERSISTED_ARTIFACT_MIME } from './persistTurnArtifacts';

/**
 * Path namespace for run_code harvests in the turn artifact store. Harvested
 * names are unique per run (egress wins collisions at harvest), and the prefix
 * keeps them from colliding with exec-sandbox `sandbox_artifacts` paths from
 * the same turn.
 */
export const RUN_CODE_ARTIFACT_PATH_PREFIX = 'run_code/';

export interface PersistRunCodeHarvestsParams {
  store: ITurnArtifactStore;
  tenantId: string;
  sessionId: string;
  turnId: string;
  logger: Logger;
}

/** Builds the `onRunCodeHarvestedFiles` sink for one turn. Pure constructor — no I/O. */
export function buildRunCodeHarvestSink(
  params: PersistRunCodeHarvestsParams,
): (files: HarvestedFile[]) => Promise<void> {
  const { store, tenantId, sessionId, turnId, logger } = params;
  return async (files: HarvestedFile[]): Promise<void> => {
    const failures: string[] = [];
    for (const file of files) {
      const path = `${RUN_CODE_ARTIFACT_PATH_PREFIX}${file.name}`;
      try {
        await store.recordStoredArtifact({
          tenant_id: tenantId,
          session_id: sessionId,
          turn_id: turnId,
          path,
          name: file.name,
          data: file.bytes,
          mime: PERSISTED_ARTIFACT_MIME,
        });
      } catch (error) {
        failures.push(file.name);
        logger.error('Failed to persist a run_code harvested file', {
          sessionId,
          turnId,
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Could not save ${String(failures.length)} run_code result file(s) for download: ${failures.join(', ')}`,
      );
    }
  };
}
