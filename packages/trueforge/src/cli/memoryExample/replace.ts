import { mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { MarkdownMemoryClient } from '../../runtime/memory/markdownMemoryClient';
import { sanitizeNamespace } from '../../runtime/memory/markdownMemoryFiles';
import type { RetainItem } from '../../runtime/memory/memoryClient';
import { labeledNoteText, noteLabel } from '../../runtime/memory/memoryNotes';
import { USER_STATED_ORIGIN } from '../../runtime/memory/memoryOrigin';
import { buildRetainItem, noteRetainItem } from '../../runtime/memory/memoryRetain';
import { EXAMPLE_NOTES, type ExampleNote } from './notes';

const DAY_MS = 86_400_000;
const WRITE_TIMEOUT_MS = 10_000;
/** The chat the made-up notes are filed under; no real chat has this id. */
const EXAMPLE_SESSION = 'memory-example';

/**
 * Moves the shared memory folder and every persona's memory folder into one dated folder beside them, and
 * returns that folder, or null when there was nothing to move. A rename keeps every file as it was.
 */
async function setMemoryAside({
  baseDir,
  namespace,
  now,
}: {
  baseDir: string;
  namespace: string;
  now: Date;
}): Promise<string | null> {
  await mkdir(baseDir, { recursive: true });
  const shared = sanitizeNamespace(namespace);
  const folders = (await readdir(baseDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && (entry.name === shared || entry.name.startsWith(`${shared}__`)))
    .map(entry => entry.name);
  if (folders.length === 0) {
    return null;
  }
  const target = path.join(baseDir, '.set-aside', now.toISOString().replace(/[:.]/g, '-'));
  await mkdir(target, { recursive: true });
  for (const folder of folders) {
    await rename(path.join(baseDir, folder), path.join(target, folder));
  }
  return target;
}

function retainItemOf({ note, now }: { note: ExampleNote; now: Date }): RetainItem {
  const at = new Date(now.getTime() - note.daysAgo * DAY_MS).toISOString();
  const turnId = `example-${note.key}`;
  if (note.from === 'person') {
    const item = buildRetainItem({
      sessionId: EXAMPLE_SESSION,
      turnId,
      userText: note.text,
      completedAt: at,
      memoryText: note.text,
      origin: USER_STATED_ORIGIN,
    });
    if (item === undefined) {
      throw new Error(`The example note "${note.key}" is empty.`);
    }
    return item;
  }
  const date = at.slice(0, 10);
  return noteRetainItem({
    sessionId: EXAMPLE_SESSION,
    turnId,
    completedAt: at,
    note: {
      source: 'email',
      date,
      text: labeledNoteText({ label: noteLabel({ source: 'email', date, assistantName: undefined }), text: note.text }),
    },
    documentId: `aman-${EXAMPLE_SESSION}-${turnId}-note`,
    chatReadNothing: false,
  });
}

async function writeNotes({ baseDir, namespace, now }: { baseDir: string; namespace: string; now: Date }) {
  const memory = new MarkdownMemoryClient({ baseDir, namespace });
  // Oldest first, so the daily files are written in the order a real two years would have made them.
  const notes = [...EXAMPLE_NOTES].sort((a, b) => b.daysAgo - a.daysAgo);
  for (const note of notes) {
    const outcome = await memory.retain({
      items: [retainItemOf({ note, now })],
      operationId: ulid(),
      timeoutMs: WRITE_TIMEOUT_MS,
    });
    if (!outcome.ok) {
      throw new Error(`Could not write the example note "${note.key}": ${outcome.reason ?? 'unknown error'}`);
    }
  }
  return notes.length;
}

/** Sets the memory in `baseDir` aside, then writes the example notes dated back from `now`. */
export async function replaceMemoryWithExample(place: {
  baseDir: string;
  namespace: string;
  now: Date;
}): Promise<MemoryExampleResult> {
  const setAside = await setMemoryAside(place);
  return { notes: await writeNotes(place), setAside };
}

export interface MemoryExampleResult {
  notes: number;
  /** The folder the earlier memory was moved to, or null when there was none. */
  setAside: string | null;
}
