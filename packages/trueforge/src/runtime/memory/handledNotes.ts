/**
 * The list of daily-log notes the sorter has already put on pages. It is one file in the vault folder with a
 * note id on each line, only ever added to, so a missing file means nothing has been handled yet.
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const HANDLED_NOTES_FILE = '.handled-notes';
const NOTE_ID_PATTERN = /^md:[^:\s]+:\d{4}-\d{2}-\d{2}\.md#\d+$/;

/** The ids of the notes of this vault that were put on pages. A line that is not a note id is skipped. */
export async function readHandledNotes(vaultDir: string): Promise<Set<string>> {
  let content: string;
  try {
    content = await readFile(path.join(vaultDir, HANDLED_NOTES_FILE), 'utf8');
  } catch {
    return new Set();
  }
  return new Set(
    content
      .split('\n')
      .map(line => line.trim())
      .filter(line => NOTE_ID_PATTERN.test(line)),
  );
}

/** Adds note ids to the list in one write. Ids that are not note ids are not written. The leading line break keeps a write cut short earlier from joining the first new id to a torn line. */
export async function appendHandledNotes({
  vaultDir,
  ids,
}: {
  vaultDir: string;
  ids: readonly string[];
}): Promise<void> {
  const lines = ids.filter(id => NOTE_ID_PATTERN.test(id));
  if (lines.length === 0) {
    return;
  }
  await appendFile(path.join(vaultDir, HANDLED_NOTES_FILE), `\n${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
