/**
 * Erases deleted and replaced note text from a vault's dated files. The delete and update markers stay the
 * source of truth for readers; this keeps the files themselves from holding what a person removed.
 * Callers hold the vault lock, so a note being saved cannot be lost to the rewrite.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ERASED_ENTRY,
  dailyLogEntries,
  formatVaultTombstone,
  latestTombstonesByEntry,
  namespaceDirFor,
  parseVaultTombstones,
  readReviewedMarks,
  sanitizeNamespace,
  splitEntries,
  upgradeLegacyEntries,
  vaultTombstonesFileFor,
  withOriginalHiddenMarkers,
  type ReviewedMarks,
  type VaultTombstone,
} from './markdownMemoryFiles';

/** Thrown when text could not be removed from disk. The message is for the person. */
export class VaultEraseError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Aman could not finish removing the old text from your disk. Try again in a moment.', options);
    this.name = 'VaultEraseError';
  }
}

const ENTRY_SEPARATOR = '\n## ';
const ENTRY_ID_PATTERN = /^md:([^:]+):(\d{4}-\d{2}-\d{2}\.md)#\d+$/;
/** Heading for an edited note whose own heading was not a `## ` line, so the entry still starts with one. */
const EDITED_HEADING = '## [edited]';

/** Size of each vault's marker file when it was last fully applied, so a write can skip a vault with nothing new. */
const appliedMarkerSizes = new Map<string, number>();

/** `## ` lines inside an entry would split it into two, so edited text keeps them as plain text. */
function withoutHeadingLines(text: string): string {
  return text
    .split('\n')
    .map((line, index) => (index > 0 && line.startsWith('## ') ? `\\${line}` : line))
    .join('\n');
}

/** The file text of one entry once its marker is applied: a bare placeholder or the new wording. */
function erasedText({ marker, current, first }: { marker: VaultTombstone; current: string; first: boolean }): string {
  if (marker.action === 'deleted' || marker.text === undefined) {
    return ERASED_ENTRY;
  }
  const edited = withoutHeadingLines(withOriginalHiddenMarkers({ original: current, edited: marker.text }));
  return first || edited.startsWith('## ') ? edited : `${EDITED_HEADING}\n\n${edited}`;
}

/**
 * One dated file with the given markers applied, or undefined when nothing in it changes. An entry keeps
 * its place, so every later entry keeps its id. Entries are matched by position the way readers count them.
 */
function rewriteDailyLog({
  safeNamespace,
  file,
  content,
  markers,
  reviewed,
}: {
  safeNamespace: string;
  file: string;
  content: string;
  markers: ReadonlyMap<string, VaultTombstone>;
  reviewed: ReviewedMarks;
}): string | undefined {
  const parts = content.split(ENTRY_SEPARATOR);
  const entryParts = parts.flatMap((part, position) => (part.trim() === '' ? [] : [position]));
  if (entryParts.length !== splitEntries(upgradeLegacyEntries(content)).length) {
    throw new Error(`Entries of ${file} could not be matched to their positions.`);
  }
  let changed = false;
  // An edit keeps the source the note had for readers, so a note reviewed as the person's own stays theirs.
  for (const entry of dailyLogEntries({ safeNamespace, file, content, reviewed })) {
    const marker = markers.get(entry.id);
    const position = entryParts[entry.index];
    const part = position === undefined ? undefined : parts[position];
    if (marker === undefined || position === undefined || part === undefined) {
      continue;
    }
    const text = erasedText({ marker, current: entry.text, first: position === 0 });
    const present = (position === 0 ? part : `## ${part}`).trim();
    if (present !== text) {
      parts[position] = `${position === 0 ? text : text.slice('## '.length)}\n`;
      changed = true;
    }
  }
  return changed ? parts.join(ENTRY_SEPARATOR) : undefined;
}

/** Writes the whole file beside the old one and renames it over, so a reader never sees half a file. */
export async function replaceFile({ file, content }: { file: string; content: string }): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Keeps only each note's latest marker. An earlier edit's text would otherwise stay in the marker file after
 * a later edit or a delete. A file with nothing superseded is left alone.
 */
async function compactMarkers({ file, content }: { file: string; content: string }): Promise<void> {
  const markers = parseVaultTombstones(content);
  const latest = latestTombstonesByEntry(markers);
  if (!markers.some(marker => marker.action === 'updated' && latest.get(marker.entryId) !== marker)) {
    return;
  }
  const kept = markers.filter(marker => latest.get(marker.entryId) === marker);
  await replaceFile({ file, content: kept.map(marker => `${formatVaultTombstone(marker)}\n\n`).join('') });
}

async function sizeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).size;
  } catch {
    return undefined;
  }
}

/**
 * Applies every vault marker to the dated files: a deleted note's text is replaced by a bare placeholder
 * and an edited note's old wording by the new wording. Safe to run again and safe to stop halfway; a run
 * that fails leaves the markers, so the next one finishes. With `onlyIfNew`, a vault whose marker file has
 * not changed since the last complete run is skipped. Call it holding the vault lock.
 */
export async function eraseMarkedEntries(options: {
  baseDir: string;
  namespace: string;
  onlyIfNew?: boolean;
}): Promise<void> {
  const dir = namespaceDirFor(options.baseDir, options.namespace);
  const markerFile = vaultTombstonesFileFor(options.baseDir, options.namespace);
  const size = await sizeOf(markerFile);
  if (size === undefined || (options.onlyIfNew === true && appliedMarkerSizes.get(dir) === size)) {
    return;
  }
  try {
    const content = await readFile(markerFile, 'utf8');
    const safeNamespace = sanitizeNamespace(options.namespace);
    const reviewed = await readReviewedMarks({ baseDir: options.baseDir, namespace: options.namespace });
    const byFile = new Map<string, Map<string, VaultTombstone>>();
    for (const [entryId, marker] of latestTombstonesByEntry(parseVaultTombstones(content))) {
      const match = ENTRY_ID_PATTERN.exec(entryId);
      if (match?.[1] === safeNamespace && match[2] !== undefined) {
        const markers = byFile.get(match[2]) ?? new Map<string, VaultTombstone>();
        markers.set(entryId, marker);
        byFile.set(match[2], markers);
      }
    }
    for (const [file, markers] of byFile) {
      const target = path.join(dir, 'memory', file);
      let text: string;
      try {
        text = await readFile(target, 'utf8');
      } catch {
        continue;
      }
      const rewritten = rewriteDailyLog({ safeNamespace, file, content: text, markers, reviewed });
      if (rewritten !== undefined) {
        await replaceFile({ file: target, content: rewritten });
      }
    }
    await compactMarkers({ file: markerFile, content });
    appliedMarkerSizes.set(dir, (await sizeOf(markerFile)) ?? 0);
  } catch (error) {
    appliedMarkerSizes.delete(dir);
    throw new VaultEraseError({ cause: error });
  }
}
