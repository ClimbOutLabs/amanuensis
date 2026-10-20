import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';
import type { ITurnArtifactStore, TurnArtifactRecord } from '../../db/turnArtifactStore';
import { runCodeArtifactPathFor } from './persistRunCodeHarvests';

/** The parts of a turn the lookup walks: its parent and whether a person started it. */
export interface ArtifactLookupTurn {
  turn_id: string;
  previous_turn_id: string | null;
  input: TurnInputItem[];
}

/** Bounds the walk back through approval continuations of one request. */
const MAX_CONTINUATION_TURNS = 32;

/**
 * Finds the kept copy of a file a reply names. The reply's turn is checked first, then the earlier
 * turns of the same request (an approval continues a request as a new turn, and the file may have
 * been made before the pause). A run_code file named by its in-run folder also matches its stored
 * `run_code/<name>` copy. Returns the first kept copy, else this turn's own row for the path (a
 * skip reason), else undefined.
 */
export async function findTurnArtifact({
  store,
  tenantId,
  sessionId,
  turn,
  path,
  getTurn,
}: {
  store: ITurnArtifactStore;
  tenantId: string;
  sessionId: string;
  turn: ArtifactLookupTurn;
  path: string;
  getTurn: (turnId: string) => Promise<ArtifactLookupTurn | undefined>;
}): Promise<TurnArtifactRecord | undefined> {
  const alias = runCodeArtifactPathFor(path);
  const paths = alias === undefined ? [path] : [path, alias];
  let ownRow: TurnArtifactRecord | undefined;
  let current: ArtifactLookupTurn | undefined = turn;
  for (let depth = 0; current !== undefined && depth < MAX_CONTINUATION_TURNS; depth += 1) {
    for (const candidate of paths) {
      const row = await store.getArtifact({
        tenant_id: tenantId,
        session_id: sessionId,
        turn_id: current.turn_id,
        path: candidate,
      });
      if (row?.status === 'stored') {
        return row;
      }
      if (depth === 0 && candidate === path) {
        ownRow = row;
      }
    }
    const startedByPerson = current.input.some(item => item.type === EventType.USER_MESSAGE);
    if (startedByPerson || current.previous_turn_id === null) {
      break;
    }
    current = await getTurn(current.previous_turn_id);
  }
  return ownRow;
}
