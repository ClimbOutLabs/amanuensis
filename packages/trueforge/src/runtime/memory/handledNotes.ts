/**
 * The list of daily-log notes that need no sorting any more, and why: the sorter put a note's facts on a page, the
 * sorter put nothing on any page, or the chat wrote to the pages itself in the reply the note was saved from. It is one file in the vault folder with `note id`, a tab and the outcome on each
 * line, only ever added to, so a missing file means nothing has been handled yet.
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const HANDLED_NOTES_FILE = '.handled-notes';
const NOTE_ID_PATTERN = /^md:[^:\s]+:\d{4}-\d{2}-\d{2}\.md#\d+$/;

/**
 * Why a note needs no sorting: `page`, the sorter put its facts on a page; `none`, the sorter put nothing on any
 * page; `chat`, the reply it was saved from wrote to the pages with the page tools, so the message already has
 * its one writer and the sorter never sees the note.
 */
export const HandledOutcomeSchema = z.enum(['page', 'none', 'chat']);
export type HandledOutcome = z.infer<typeof HandledOutcomeSchema>;

/**
 * The outcome of each handled note of this vault. A line with no outcome, an unknown outcome or an id that is not
 * a note id is skipped. A later line for the same note wins.
 */
export async function readHandledNotes(vaultDir: string): Promise<Map<string, HandledOutcome>> {
  const handled = new Map<string, HandledOutcome>();
  let content: string;
  try {
    content = await readFile(path.join(vaultDir, HANDLED_NOTES_FILE), 'utf8');
  } catch {
    return handled;
  }
  for (const line of content.split('\n')) {
    const [noteId, outcome, ...rest] = line.trim().split('\t');
    const parsed = HandledOutcomeSchema.safeParse(outcome);
    if (noteId !== undefined && rest.length === 0 && NOTE_ID_PATTERN.test(noteId) && parsed.success) {
      handled.set(noteId, parsed.data);
    }
  }
  return handled;
}

/** Records why one note needs no sorting. Something that is not a note id is not written. The leading line break keeps a write cut short earlier from joining this line to a torn one. */
export async function appendHandledNote({
  vaultDir,
  noteId,
  outcome,
}: {
  vaultDir: string;
  noteId: string;
  outcome: HandledOutcome;
}): Promise<void> {
  if (!NOTE_ID_PATTERN.test(noteId)) {
    return;
  }
  await appendFile(path.join(vaultDir, HANDLED_NOTES_FILE), `\n${noteId}\t${outcome}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
