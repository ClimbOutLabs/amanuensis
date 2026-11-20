/**
 * Reads a goal's selected sources that are Spaces: the document's current body,
 * stamped with the Space's own revision. The read is scoped to the goal's owner,
 * so a Space id that belongs to someone else reads as unreadable, never as content.
 * Other source kinds are read by their own readers as they are wired in.
 */
import type { ISpaceStore } from '../../db/spaceStore';
import type { GoalSourceReader } from './goalCheck';

export function createSpaceGoalSourceReader(input: { spaceStore: Pick<ISpaceStore, 'getSpace'> }): GoalSourceReader {
  return {
    async read({ goal, source }) {
      if (source.source_kind !== 'space') {
        return undefined;
      }
      const record = await input.spaceStore.getSpace({
        tenant_id: goal.tenant_id,
        created_by: goal.created_by.subject_id,
        space_id: source.source_ref,
      });
      if (record === undefined) {
        return undefined;
      }
      return {
        content: record.body,
        source_revision: `space-revision:${String(record.revision)}`,
        claimed_event_at: record.updated_at,
      };
    },
  };
}

/** Tries each reader in order; the first that can read the source answers. */
export function chainGoalSourceReaders(readers: readonly GoalSourceReader[]): GoalSourceReader {
  return {
    async read(readInput) {
      for (const reader of readers) {
        const read = await reader.read(readInput);
        if (read !== undefined) {
          return read;
        }
      }
      return undefined;
    },
  };
}
