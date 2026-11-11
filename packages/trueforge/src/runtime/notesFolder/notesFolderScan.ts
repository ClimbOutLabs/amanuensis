/**
 * Reading the notes folder: which files count as notes and how a note becomes searchable
 * chunks. A note is a Markdown file under the folder; hidden files and folders (such as
 * Obsidian's own `.obsidian`) are not notes, links that lead out of the folder are not
 * followed, and a file too large to be a note is left out. Chunking follows the headings,
 * so a search hit can name the part of the note it came from.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isUnder } from './notesFolderPaths';

/** A note file read from the folder; the path is the folder-relative form results hand back. */
export interface NoteFile {
  relativePath: string;
  content: string;
}

/** One searchable piece of a note. The id is stable for a file and a position: `<path>#<index>`. */
export interface NoteChunk {
  id: string;
  relativePath: string;
  /** The heading the chunk sits under, or null when it comes before any heading. */
  heading: string | null;
  text: string;
}

/** Larger than this, a file is not treated as a note for searching. */
const MAX_NOTE_BYTES = 1024 * 1024;
/** The size a chunk grows to before the next one starts; a long section makes several. */
const MAX_CHUNK_CHARS = 1200;

/** Every note in the folder, in path order. A folder that cannot be read reads as empty. */
export async function scanNotesFolder(folder: string): Promise<NoteFile[]> {
  const root = await realpath(folder).catch(() => null);
  if (root === null) {
    return [];
  }
  const files: NoteFile[] = [];
  for (const found of await collectNotePaths({ dir: root, root })) {
    const content = await readFile(found.real, 'utf8').catch(() => null);
    if (content !== null) {
      files.push({ relativePath: found.relativePath, content });
    }
  }
  return files;
}

/** How many notes the folder holds, without reading them. Zero when it cannot be read. */
export async function countNoteFiles(folder: string): Promise<number> {
  const root = await realpath(folder).catch(() => null);
  if (root === null) {
    return 0;
  }
  return (await collectNotePaths({ dir: root, root })).length;
}

/** The notes under a directory: folder-relative paths with the real path each resolves to. */
async function collectNotePaths({
  dir,
  root,
}: {
  dir: string;
  root: string;
}): Promise<{ relativePath: string; real: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return [];
  }
  const found: { relativePath: string; real: string }[] = [];
  for (const entry of entries) {
    // Hidden entries are the apps' own workings (`.obsidian`, `.trash`, sync state), not notes.
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectNotePaths({ dir: full, root })));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    // A link is followed only when where it lands is still inside the folder.
    const real = await realpath(full).catch(() => null);
    if (real === null || !isUnder({ child: real, parent: root })) {
      continue;
    }
    const info = await stat(real).catch(() => null);
    if (info === null || !info.isFile() || info.size > MAX_NOTE_BYTES) {
      continue;
    }
    found.push({ relativePath: path.relative(root, full).split(path.sep).join('/'), real });
  }
  found.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return found;
}

/** A note's frontmatter block, when the file opens with one; it is metadata, not note text. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return content;
  }
  const after = content.indexOf('\n', end + 1);
  return after === -1 ? '' : content.slice(after + 1);
}

const HEADING_LINE = /^#{1,6}\s+(.*)$/;

/** The searchable chunks of one note, in order. */
export function chunkNote(note: NoteFile): NoteChunk[] {
  const body = stripFrontmatter(note.content);
  const sections: { heading: string | null; lines: string[] }[] = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  sections.push(current);
  for (const line of body.split('\n')) {
    const heading = HEADING_LINE.exec(line.trim());
    if (heading?.[1] !== undefined) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }
  const chunks: NoteChunk[] = [];
  for (const section of sections) {
    for (const text of packSection(section.lines.join('\n'))) {
      chunks.push({
        id: `${note.relativePath}#${String(chunks.length)}`,
        relativePath: note.relativePath,
        heading: section.heading,
        text,
      });
    }
  }
  return chunks;
}

/** Paragraphs packed up to the chunk size; a paragraph longer than the size is cut into pieces. */
function packSection(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '');
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHUNK_CHARS) {
      flush();
      for (let at = 0; at < paragraph.length; at += MAX_CHUNK_CHARS) {
        chunks.push(paragraph.slice(at, at + MAX_CHUNK_CHARS));
      }
      continue;
    }
    if (current !== '' && current.length + 2 + paragraph.length > MAX_CHUNK_CHARS) {
      flush();
    }
    current = current === '' ? paragraph : `${current}\n\n${paragraph}`;
  }
  flush();
  return chunks;
}
