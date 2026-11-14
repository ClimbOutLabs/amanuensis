/**
 * The Notes folder connector at work: keeping a search index of the folder, answering
 * searches, and making the only two writes the connector can make. The index is the existing
 * embedding store (see ../memory/embeddingStore.ts) over chunks of the notes, kept in Aman's
 * own area, never in the person's folder. It is rebuilt on a schedule and when files change
 * (a watcher on the folder), and a search refreshes it first when it has gone stale.
 *
 * The writes are shaped so sync can never lose the person's words: an append only ever adds
 * bytes at the end of the one inbox file, after checking the file did not change while the
 * entry was being prepared, and a create only makes a file that does not exist yet. There is
 * deliberately no edit and no delete here.
 */
import { watch, type FSWatcher } from 'node:fs';
import { appendFile, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'winston';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import { orderVectorFirst, rankByCosine } from '../memory/embeddingRetrieval';
import { EmbeddingStore, hashEntryText, LOG_VECTORS_FILE } from '../memory/embeddingStore';
import {
  folderOverlapProblem,
  INBOX_FILE_MISSING_MESSAGE,
  isUnder,
  normalizeNotePath,
  NOTE_ALREADY_THERE_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_PATH_MESSAGE,
  notePathProblem,
  resolveFolderPath,
} from './notesFolderPaths';
import { chunkNote, scanNotesFolder, type NoteChunk } from './notesFolderScan';
import { readNotesFolderSettings, type NotesFolderSettings } from './notesFolderSettings';

/** The slice of the shared embedding model the index needs; tests hand in a fake. */
export interface NotesEmbedder {
  ensureReady(): Promise<boolean>;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQueries(texts: string[]): Promise<number[][]>;
}

/** A failure the person or the model can act on; the message is the whole contract. */
export class NotesFolderProblem extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NotesFolderProblem';
  }
}

export interface NotesFolderServiceDeps {
  settings: Pick<IGlobalSettingsStore, 'getSetting'>;
  /** Aman's own data folders, resolved; the notes folder may never overlap any of them. */
  protectedDirs: readonly string[];
  /** Where the index cache lives, inside Aman's app data folder. */
  indexDir: string;
  /** The shared embedding model, or undefined when embeddings are off: search is keywords only. */
  embedder: NotesEmbedder | undefined;
  logger: Pick<Logger, 'warn' | 'info'>;
  /** Test seam: the clock for entry headings and staleness. */
  now?: (() => number) | undefined;
  /** Test seam: runs inside an append after the tail is read, so a test can land a sync write there. */
  beforeAppend?: (() => Promise<void>) | undefined;
}

export interface NotesSearchHit {
  path: string;
  heading: string | null;
  snippet: string;
  /** The meaning match, when the meaning leg placed this hit; null for a keyword-only match. */
  score: number | null;
}

export type NotesFolderState = 'not_connected' | 'connected' | 'not_working';

/** How long a refresh stays fresh; matches the memory warm window. */
const STALE_AFTER_MS = 10 * 60_000;
/** The schedule the index is rebuilt on, watcher or not. */
const REBUILD_EVERY_MS = 15 * 60_000;
/** A burst of file changes settles for this long before one rebuild. */
const WATCH_DEBOUNCE_MS = 1500;
/** How much of a chunk a search result shows. */
const SNIPPET_CHARS = 600;
/** Passages embedded per model call during a rebuild. */
const EMBED_BATCH = 32;

interface IndexCache {
  folder: string;
  chunks: NoteChunk[];
  refreshedAt: number;
}

export class NotesFolderService {
  private cache: IndexCache | undefined;
  private store: EmbeddingStore | undefined;
  private refreshing: Promise<void> | undefined;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private watchedFolder: string | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private watchFailed = false;

  constructor(private readonly deps: NotesFolderServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The saved settings, read fresh: a Settings change applies without a restart. */
  async settings(): Promise<NotesFolderSettings | undefined> {
    return readNotesFolderSettings(this.deps.settings);
  }

  /** Where the connector stands, for the Settings card and for mounting the tools. One stat, no walk. */
  async connectionState(): Promise<{ settings: NotesFolderSettings | undefined; state: NotesFolderState }> {
    const settings = await this.settings();
    if (settings === undefined) {
      return { settings: undefined, state: 'not_connected' };
    }
    const folder = resolveFolderPath(settings.folder_path);
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) {
      return { settings, state: 'not_working' };
    }
    return { settings, state: 'connected' };
  }

  /** Starts the schedule and the file watcher. Safe to call more than once. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, REBUILD_EVERY_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Stops the schedule and the watcher; the server does not call this, tests do. */
  stop(): void {
    this.started = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.closeWatch();
    if (this.watchTimer !== undefined) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  /** A Settings change pokes the service: rebuild now and re-point the watcher. */
  poke(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    await this.refresh().catch((error: unknown) => {
      this.deps.logger.warn('Notes folder index could not be rebuilt', { error: String(error) });
    });
    this.syncWatch();
  }

  /** Rebuilds the index now; concurrent callers share the one rebuild. */
  async refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Rebuilds only when the index is older than the stale window or the folder moved. */
  async refreshIfStale(): Promise<void> {
    const settings = await this.settings();
    if (settings === undefined) {
      if (this.cache !== undefined) {
        await this.refresh();
      }
      return;
    }
    const folder = resolveFolderPath(settings.folder_path);
    const cache = this.cache;
    const age = cache === undefined ? Number.POSITIVE_INFINITY : this.now() - cache.refreshedAt;
    if (cache?.folder !== folder || age > STALE_AFTER_MS) {
      await this.refresh();
    }
  }

  private async doRefresh(): Promise<void> {
    const settings = await this.settings();
    if (settings === undefined) {
      this.cache = undefined;
      return;
    }
    const folder = resolveFolderPath(settings.folder_path);
    // A backstop behind the Settings check: however the settings were written, Aman never
    // indexes one of its own data folders as the person's notes.
    if ((await folderOverlapProblem({ folderPath: folder, protectedDirs: this.deps.protectedDirs })) !== null) {
      this.deps.logger.warn(
        'Notes folder overlaps one of the folders Aman keeps its own data in. The notes tools stay off',
      );
      this.cache = undefined;
      return;
    }
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) {
      // A sync folder can vanish for a moment; the last good index keeps serving.
      return;
    }
    const notes = await scanNotesFolder(folder);
    const chunks = notes.flatMap(note => chunkNote(note));
    const store = (this.store ??= await EmbeddingStore.load({
      namespaceDir: this.deps.indexDir,
      fileName: LOG_VECTORS_FILE,
    }));
    await this.embedChanged({ store, chunks });
    store.reconcile(new Set(chunks.map(chunk => chunk.id)));
    await store.save();
    this.cache = { folder, chunks, refreshedAt: this.now() };
  }

  /** Embeds the chunks that are new or changed since the last rebuild; leaves the rest cached. */
  private async embedChanged({ store, chunks }: { store: EmbeddingStore; chunks: NoteChunk[] }): Promise<void> {
    const embedder = this.deps.embedder;
    if (embedder === undefined) {
      return;
    }
    const changed = chunks.filter(chunk => store.get(chunk.id)?.hash !== hashEntryText(chunk.text));
    if (changed.length === 0) {
      return;
    }
    let ready: boolean;
    try {
      ready = await embedder.ensureReady();
    } catch {
      ready = false;
    }
    if (!ready) {
      return;
    }
    for (let at = 0; at < changed.length; at += EMBED_BATCH) {
      const batch = changed.slice(at, at + EMBED_BATCH);
      let vectors: number[][];
      try {
        vectors = await embedder.embedPassages(batch.map(chunk => chunk.text));
      } catch (error) {
        this.deps.logger.warn('Notes folder indexing stopped early: the search model could not be used', {
          error: String(error),
        });
        return;
      }
      for (const [index, chunk] of batch.entries()) {
        const vector = vectors[index];
        if (vector !== undefined) {
          store.set({ id: chunk.id, text: chunk.text, vector });
        }
      }
    }
  }

  /** Searches the notes by meaning when the model is there, and by words in any case. */
  async search({ query, limit }: { query: string; limit: number }): Promise<NotesSearchHit[]> {
    await this.refreshIfStale();
    const cache = this.cache;
    if (cache === undefined || cache.chunks.length === 0 || query.trim() === '') {
      return [];
    }
    const vectorOrder = await this.vectorOrder({ query, chunks: cache.chunks });
    const keywordOrder = keywordRank({ query, chunks: cache.chunks });
    const byId = new Map(cache.chunks.map(chunk => [chunk.id, chunk]));
    const ordered = orderVectorFirst({ vectorOrder: vectorOrder.ids, keywordOrder });
    return ordered.slice(0, Math.max(1, limit)).flatMap(id => {
      const chunk = byId.get(id);
      if (chunk === undefined) {
        return [];
      }
      return [
        {
          path: chunk.relativePath,
          heading: chunk.heading,
          snippet: chunk.text.length > SNIPPET_CHARS ? `${chunk.text.slice(0, SNIPPET_CHARS)}…` : chunk.text,
          score: vectorOrder.scores.get(id) ?? null,
        },
      ];
    });
  }

  /** The meaning leg's order and scores; empty when the model cannot help this time. */
  private async vectorOrder({
    query,
    chunks,
  }: {
    query: string;
    chunks: NoteChunk[];
  }): Promise<{ ids: string[]; scores: Map<string, number> }> {
    const empty = { ids: [], scores: new Map<string, number>() };
    const embedder = this.deps.embedder;
    const store = this.store;
    if (embedder === undefined || store === undefined) {
      return empty;
    }
    let ready: boolean;
    try {
      ready = await embedder.ensureReady();
    } catch {
      return empty;
    }
    if (!ready) {
      return empty;
    }
    const candidates = chunks.flatMap(chunk => {
      const stored = store.get(chunk.id);
      return stored === undefined ? [] : [{ id: chunk.id, vector: stored.vector }];
    });
    if (candidates.length === 0) {
      return empty;
    }
    let queryVector: number[] | undefined;
    try {
      queryVector = (await embedder.embedQueries([query]))[0];
    } catch {
      return empty;
    }
    if (queryVector === undefined) {
      return empty;
    }
    const ranked = rankByCosine(queryVector, candidates).filter(entry => entry.similarity > 0);
    const scores = new Map(ranked.map(entry => [entry.id, Math.round(entry.similarity * 100) / 100]));
    return { ids: ranked.map(entry => entry.id), scores };
  }

  /** One note in full, from a path the search handed back or the person named. */
  async readNote(relativePath: string): Promise<{ path: string; content: string }> {
    const { folder } = await this.connectedFolder();
    const problem = notePathProblem(relativePath);
    if (problem !== null) {
      throw new NotesFolderProblem(problem);
    }
    const real = await this.resolveInside({ folder, relativePath });
    if (real === null) {
      throw new NotesFolderProblem(NOTE_NOT_FOUND_MESSAGE);
    }
    const content = await readFile(real, 'utf8').catch((error: unknown) => {
      throw new NotesFolderProblem(NOTE_NOT_FOUND_MESSAGE, { cause: error });
    });
    return { path: normalizeNotePath(relativePath).split(path.sep).join('/'), content };
  }

  /**
   * Adds one entry to the inbox file, under a heading with the date and time. The write is an
   * append of new bytes only, made after a final check that the file did not change while the
   * entry was prepared, so a sync landing at the same moment is never overwritten.
   */
  async appendToInbox(text: string): Promise<{ file: string }> {
    const { settings, folder } = await this.connectedFolder();
    const body = text.trim();
    if (body === '') {
      throw new NotesFolderProblem('There is nothing to add. Say what the entry should say.');
    }
    const filePath = path.join(folder, settings.inbox_file);
    const entry = `## ${entryStamp(new Date(this.now()))}\n\n${body}\n`;
    let prefix = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await readTail(filePath);
      await this.deps.beforeAppend?.();
      const after = await stat(filePath).catch(() => null);
      const unchanged =
        before.exists === (after !== null) &&
        (after === null || (before.size === after.size && before.mtimeMs === after.mtimeMs));
      prefix = separatorFor(before.tail);
      if (unchanged) {
        break;
      }
      // The file changed under the entry (a sync, most likely): read the new tail and try
      // again. Appending stays safe even if it keeps changing; only the spacing could be off.
      if (attempt === 2) {
        prefix = separatorFor((await readTail(filePath)).tail);
      }
    }
    await appendFile(filePath, `${prefix}${entry}`, 'utf8').catch((error: unknown) => {
      throw new NotesFolderProblem(INBOX_FILE_MISSING_MESSAGE, { cause: error });
    });
    return { file: settings.inbox_file };
  }

  /** Makes a new note. A name that is already taken is refused, never overwritten. */
  async createNote({ relativePath, text }: { relativePath: string; text: string }): Promise<{ path: string }> {
    const { folder } = await this.connectedFolder();
    const problem = notePathProblem(relativePath);
    if (problem !== null) {
      throw new NotesFolderProblem(problem);
    }
    const rel = normalizeNotePath(relativePath);
    const target = path.join(folder, rel);
    const parent = path.dirname(target);
    const realFolder = await realpath(folder).catch(() => null);
    if (realFolder === null) {
      throw new NotesFolderProblem(NOTE_PATH_MESSAGE);
    }
    // The place the new folders would be made is judged before any are made: a subfolder
    // that is a link out of the notes folder refuses here, so a refusal leaves nothing
    // behind outside the folder.
    const anchor = await deepestExistingPath(parent);
    const realAnchor = anchor === null ? null : await realpath(anchor).catch(() => null);
    if (realAnchor === null || (realAnchor !== realFolder && !isUnder({ child: realAnchor, parent: realFolder }))) {
      throw new NotesFolderProblem(NOTE_PATH_MESSAGE);
    }
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent).catch(() => null);
    if (realParent === null || (realParent !== realFolder && !isUnder({ child: realParent, parent: realFolder }))) {
      throw new NotesFolderProblem(NOTE_PATH_MESSAGE);
    }
    const body = text.trim();
    const content = body === '' ? '' : `${body}\n`;
    try {
      const handle = await open(target, 'wx');
      try {
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new NotesFolderProblem(NOTE_ALREADY_THERE_MESSAGE, { cause: error });
      }
      throw new NotesFolderProblem('Aman could not make that note. Check the folder in Settings and try again.', {
        cause: error,
      });
    }
    // The new note belongs in the index right away, not at the next rebuild.
    void this.refresh();
    return { path: rel.split(path.sep).join('/') };
  }

  /** The settings and the resolved folder, or the plain problem when the connector is not usable. */
  private async connectedFolder(): Promise<{ settings: NotesFolderSettings; folder: string }> {
    const settings = await this.settings();
    if (settings === undefined) {
      throw new NotesFolderProblem(
        'No notes folder is connected. Connect one in Settings, under Connectors, Notes folder.',
      );
    }
    const folder = resolveFolderPath(settings.folder_path);
    // The same backstop as the index: however the settings were written, one of Aman's own
    // data folders is never read or added to as if it were the person's notes.
    const overlap = await folderOverlapProblem({ folderPath: folder, protectedDirs: this.deps.protectedDirs });
    if (overlap !== null) {
      throw new NotesFolderProblem(overlap);
    }
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) {
      throw new NotesFolderProblem(
        'Aman cannot find your notes folder. Check the folder in Settings, under Connectors, Notes folder.',
      );
    }
    return { settings, folder };
  }

  /** The real path of a note inside the folder, or null when it is not there or leads out. */
  private async resolveInside({
    folder,
    relativePath,
  }: {
    folder: string;
    relativePath: string;
  }): Promise<string | null> {
    const realFolder = await realpath(folder).catch(() => null);
    if (realFolder === null) {
      return null;
    }
    const real = await realpath(path.join(folder, normalizeNotePath(relativePath))).catch(() => null);
    if (real === null || !isUnder({ child: real, parent: realFolder })) {
      return null;
    }
    return real;
  }

  /** Keeps the watcher pointed at the folder the settings name now; called after every rebuild. */
  private syncWatch(): void {
    // Watching is background work: it belongs to the started lifecycle, so a poke before
    // start (or after stop) refreshes the index but opens no watcher.
    if (!this.started) {
      return;
    }
    const target = this.cache?.folder;
    if (target === this.watchedFolder) {
      return;
    }
    this.closeWatch();
    if (target === undefined || this.watchFailed) {
      return;
    }
    try {
      this.watcher = watch(target, { recursive: true }, () => {
        if (this.watchTimer !== undefined) {
          clearTimeout(this.watchTimer);
        }
        this.watchTimer = setTimeout(() => {
          void this.refresh().catch((error: unknown) => {
            this.deps.logger.warn('Notes folder index could not be rebuilt after a change', { error: String(error) });
          });
        }, WATCH_DEBOUNCE_MS);
        this.watchTimer.unref();
      });
      this.watcher.on('error', () => {
        this.watchFailed = true;
        this.closeWatch();
        this.deps.logger.warn('Notes folder watching stopped; the index still rebuilds on its schedule');
      });
      this.watchedFolder = target;
    } catch {
      this.watchFailed = true;
      this.deps.logger.warn('Notes folder watching could not start; the index still rebuilds on its schedule');
    }
  }

  private closeWatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.watchedFolder = undefined;
  }
}

/** Keyword order over the chunks: how many of the query's words a chunk carries, heading first. */
function keywordRank({ query, chunks }: { query: string; chunks: NoteChunk[] }): string[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(term => term !== ''),
    ),
  ];
  if (terms.length === 0) {
    return [];
  }
  const scored: { id: string; score: number }[] = [];
  for (const chunk of chunks) {
    const text = chunk.text.toLowerCase();
    const heading = (chunk.heading ?? '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      score += occurrences({ haystack: text, needle: term });
      if (heading.includes(term)) {
        score += 2;
      }
    }
    if (score > 0) {
      scored.push({ id: chunk.id, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.map(entry => entry.id);
}

function occurrences({ haystack, needle }: { haystack: string; needle: string }): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** The deepest part of a path that is already on disk, or null when none of it is. */
async function deepestExistingPath(target: string): Promise<string | null> {
  let current: string | null = target;
  while (current !== null) {
    const info = await stat(current).catch(() => null);
    if (info !== null) {
      return current;
    }
    const parent = path.dirname(current);
    current = parent === current ? null : parent;
  }
  return null;
}

/** The end of a file as an append needs it: whether it is there, its size and change time, and its last bytes. */
async function readTail(filePath: string): Promise<{ exists: boolean; size: number; mtimeMs: number; tail: string }> {
  const info = await stat(filePath).catch(() => null);
  if (info === null) {
    return { exists: false, size: 0, mtimeMs: 0, tail: '' };
  }
  const length = Math.min(info.size, 4096);
  if (length === 0) {
    return { exists: true, size: info.size, mtimeMs: info.mtimeMs, tail: '' };
  }
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return { exists: true, size: info.size, mtimeMs: info.mtimeMs, tail: buffer.toString('utf8') };
  } finally {
    await handle.close();
  }
}

/** The spacing an entry needs so its heading starts on its own line, after a blank line. */
function separatorFor(tail: string): string {
  if (tail === '' || tail.endsWith('\n\n')) {
    return '';
  }
  return tail.endsWith('\n') ? '\n' : '\n\n';
}

/** The dated heading of an entry: `2026-11-07 09:41` in the server's local time. */
function entryStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
