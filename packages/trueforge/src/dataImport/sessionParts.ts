import { damagedExportError } from './importError';
import {
  withoutArchivedAdmissions,
  type ImportContextMessage,
  type ImportSessionEntry,
  type ImportSessionPartRecord,
  type ImportThreadSnapshot,
} from './importSchemas';

interface OpenChat {
  entry: ImportSessionEntry;
  /** Each thread's messages as of the previous turn record, before open calls are answered. */
  contexts: Map<string, ImportContextMessage[]>;
}

/**
 * Rebuilds whole chats from the records of the sessions/ files, in order: a chat record, then
 * its turns. Each turn's threads are rebuilt from the previous turn's messages, which are shared
 * rather than copied, so a long chat costs memory for its messages once.
 */
export function* assembleSessionParts(records: Iterable<ImportSessionPartRecord>): Generator<ImportSessionEntry> {
  let open: OpenChat | undefined;
  for (const record of records) {
    if (record.kind === 'session') {
      if (open !== undefined) {
        yield open.entry;
      }
      open = {
        entry: { session: record.session, turns: [], artifacts: [], persona_activations: record.persona_activations },
        contexts: new Map(),
      };
      continue;
    }
    const { snapshot, ...turnFields } = record.turn;
    const sessionId = turnFields.session_id;
    if (open?.entry.session.session_id !== sessionId) {
      throw damagedExportError(`turn ${turnFields.turn_id} is not listed after its chat ${sessionId}.`);
    }
    const contexts = new Map<string, ImportContextMessage[]>();
    const threads: Record<string, ImportThreadSnapshot> = {};
    for (const [threadId, thread] of Object.entries(snapshot.threads)) {
      const { context_base: base, context: added, ...fields } = thread;
      const before = open.contexts.get(threadId) ?? [];
      if (base > before.length) {
        throw damagedExportError(
          `turn ${turnFields.turn_id} in chat ${sessionId} builds on messages that are not in it.`,
        );
      }
      const context = before.slice(0, base).concat(added);
      contexts.set(threadId, context);
      threads[threadId] = { ...fields, context: withoutArchivedAdmissions(context) };
    }
    open.contexts = contexts;
    open.entry.turns.push({ turn: { ...turnFields, snapshot: { threads } }, events: record.events });
    open.entry.artifacts.push(...record.artifacts);
  }
  if (open !== undefined) {
    yield open.entry;
  }
}
