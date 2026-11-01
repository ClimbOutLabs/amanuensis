/**
 * Converts an export's sessions/ files into the format 1 sessions.json: one entry per chat, each
 * turn with its whole snapshot. Import still reads that file, so tests that rewrite chats edit
 * this shape and import it through the old-format path.
 */
import { sessionPartIndex } from '../../src/dataExport/sessionRecords';
import { listAt, parseJson, recordAt, type JsonRecord } from './jsonGuards';
import type { ZipEntryData } from './zipReader';

type ArchiveFiles = ReadonlyMap<string, Buffer> | readonly ZipEntryData[];

function isEntryList(files: ArchiveFiles): files is readonly ZipEntryData[] {
  return Array.isArray(files);
}

function partFiles(files: ArchiveFiles): [string, Buffer][] {
  const pairs: [string, Buffer][] = isEntryList(files)
    ? files.map(entry => [entry.name, entry.data])
    : [...files.entries()];
  return pairs
    .filter(([name]) => sessionPartIndex(name) !== undefined)
    .sort(([a], [b]) => (sessionPartIndex(a) ?? 0) - (sessionPartIndex(b) ?? 0));
}

/** The chats of an export as format 1 entries, with every thread's context written out in full. */
export function legacySessionsOf(files: ArchiveFiles): unknown[] {
  const legacy = isEntryList(files)
    ? files.find(entry => entry.name === 'sessions.json')?.data
    : files.get('sessions.json');
  if (legacy !== undefined) {
    return listAt(parseJson(legacy, 'sessions.json'), 'sessions.json');
  }
  const sessions: JsonRecord[] = [];
  let contexts = new Map<string, unknown[]>();
  for (const [name, data] of partFiles(files)) {
    for (const item of listAt(parseJson(data, name), name)) {
      const record = recordAt(item, `${name} record`);
      if (record['kind'] === 'session') {
        sessions.push({
          session: record['session'],
          turns: [],
          artifacts: [],
          persona_activations: record['persona_activations'],
        });
        contexts = new Map();
        continue;
      }
      const entry = recordAt(sessions.at(-1), 'chat of a turn record');
      const turn = recordAt(record['turn'], 'turn');
      const threads = recordAt(recordAt(turn['snapshot'], 'snapshot')['threads'], 'threads');
      const next = new Map<string, unknown[]>();
      const fullThreads: JsonRecord = {};
      for (const [threadId, value] of Object.entries(threads)) {
        const { context_base: base, context, ...fields } = recordAt(value, 'thread');
        const full = [...(contexts.get(threadId) ?? []).slice(0, Number(base)), ...listAt(context, 'context')];
        next.set(threadId, full);
        fullThreads[threadId] = { ...fields, context: full };
      }
      contexts = next;
      listAt(entry['turns'], 'turns').push({
        turn: { ...turn, snapshot: { threads: fullThreads } },
        events: record['events'],
      });
      listAt(entry['artifacts'], 'artifacts').push(...listAt(record['artifacts'], 'artifacts'));
    }
  }
  return sessions;
}

/** Replaces an archive's sessions/ files with one format 1 sessions.json holding `sessions`. */
export function setLegacySessions(entries: Map<string, Buffer>, sessions: unknown[]): void {
  for (const name of [...entries.keys()]) {
    if (sessionPartIndex(name) !== undefined) {
      entries.delete(name);
    }
  }
  entries.set('sessions.json', Buffer.from(JSON.stringify(sessions)));
}
