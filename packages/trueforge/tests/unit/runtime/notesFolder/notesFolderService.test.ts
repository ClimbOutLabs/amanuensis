import { appendFile, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';
import type { IGlobalSettingsStore } from '../../../../src/db/globalSettingsStore';
import {
  NOTE_ALREADY_THERE_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_PATH_MESSAGE,
  NOTES_FOLDER_OVERLAP_MESSAGE,
} from '../../../../src/runtime/notesFolder/notesFolderPaths';
import {
  NotesFolderProblem,
  NotesFolderService,
  type NotesEmbedder,
} from '../../../../src/runtime/notesFolder/notesFolderService';
import { writeNotesFolderSettings } from '../../../../src/runtime/notesFolder/notesFolderSettings';

/** A settings store over a map; the service reads the notes choice through it like the real one. */
function makeSettingsStore() {
  const rows = new Map<string, string>();
  const store: IGlobalSettingsStore = {
    getSetting: input => {
      const value = rows.get(input.key);
      return Promise.resolve(
        value === undefined ? undefined : { key: input.key, value, updated_at: '2026-01-01T00:00:00.000Z' },
      );
    },
    setSetting: input => {
      rows.set(input.key, input.value);
      return Promise.resolve({ key: input.key, value: input.value, updated_at: '2026-01-01T00:00:00.000Z' });
    },
    deleteSetting: input => {
      rows.delete(input.key);
      return Promise.resolve();
    },
    compareAndSetSetting: () => Promise.resolve(false),
  };
  return { store, rows };
}

const GARDEN_STEMS = ['tomato', 'garden', 'plant', 'seed'];
const KITCHEN_STEMS = ['pasta', 'sauce', 'recipe', 'boil'];

/** A stand-in model: two topic directions, counted from word stems, so meaning rank is deterministic. */
function vectorFor(text: string): number[] {
  // The store keeps only vectors of the model's full dimension, like the real model's output.
  const vector = Array.from({ length: 384 }, () => 0.05);
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (GARDEN_STEMS.some(stem => word.startsWith(stem))) {
      vector[0] = (vector[0] ?? 0) + 1;
    }
    if (KITCHEN_STEMS.some(stem => word.startsWith(stem))) {
      vector[1] = (vector[1] ?? 0) + 1;
    }
  }
  return vector;
}

function makeEmbedder() {
  const calls = { passages: 0 };
  const embedder: NotesEmbedder = {
    ensureReady: () => Promise.resolve(true),
    embedPassages: texts => {
      calls.passages += texts.length;
      return Promise.resolve(texts.map(vectorFor));
    },
    embedQueries: texts => Promise.resolve(texts.map(vectorFor)),
  };
  return { embedder, calls };
}

interface World {
  root: string;
  vault: string;
  memoryDir: string;
  indexDir: string;
  settingsStore: IGlobalSettingsStore;
  service: NotesFolderService;
}

async function makeWorld(options?: {
  embedder?: NotesEmbedder | undefined;
  now?: (() => number) | undefined;
  beforeAppend?: (() => Promise<void>) | undefined;
}): Promise<World> {
  const root = await mkdtemp(path.join(tmpdir(), 'notes-service-'));
  const vault = path.join(root, 'vault');
  const memoryDir = path.join(root, 'memory');
  await mkdir(vault, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  const { store } = makeSettingsStore();
  const service = new NotesFolderService({
    settings: store,
    protectedDirs: [memoryDir, path.join(root, 'persona-knowledge'), path.join(root, 'app-data')],
    indexDir: path.join(root, 'index'),
    embedder: options?.embedder,
    logger: createLogger({ silent: true }),
    now: options?.now,
    beforeAppend: options?.beforeAppend,
  });
  return { root, vault, memoryDir, indexDir: path.join(root, 'index'), settingsStore: store, service };
}

async function connect(world: World, inboxFile = 'Aman inbox.md'): Promise<void> {
  await writeNotesFolderSettings(world.settingsStore, { folder_path: world.vault, inbox_file: inboxFile });
}

async function seedNotes(world: World): Promise<void> {
  await writeFile(
    path.join(world.vault, 'Garden.md'),
    '# Garden\n\nTomatoes need deep watering, and the seedlings want sun.\n',
  );
  await writeFile(
    path.join(world.vault, 'Kitchen.md'),
    '# Kitchen\n\nBoil the pasta and save a cup of water for the sauce recipe.\n',
  );
}

describe('indexing and searching the notes folder', () => {
  it('ranks by meaning when the model is there, and keeps the index out of the folder', async () => {
    const { embedder } = makeEmbedder();
    const world = await makeWorld({ embedder });
    await connect(world);
    await seedNotes(world);

    const hits = await world.service.search({ query: 'tomato plants', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe('Garden.md');
    expect(hits[0]?.heading).toBe('Garden');
    expect(hits[0]?.score).not.toBeNull();

    // The index cache is Aman's, in Aman's area; the person's folder gains nothing.
    await expect(stat(path.join(world.indexDir, '.embeddings.json'))).resolves.toBeDefined();
    await expect(stat(path.join(world.vault, '.embeddings.json'))).rejects.toThrow();
  });

  it('does not embed again what has not changed', async () => {
    const { embedder, calls } = makeEmbedder();
    const world = await makeWorld({ embedder });
    await connect(world);
    await seedNotes(world);
    await world.service.refresh();
    const afterFirst = calls.passages;
    expect(afterFirst).toBeGreaterThan(0);
    await world.service.refresh();
    expect(calls.passages).toBe(afterFirst);
  });

  it('falls back to words when there is no model, and finds nothing for empty folders', async () => {
    const world = await makeWorld({ embedder: undefined });
    await connect(world);
    await seedNotes(world);
    const hits = await world.service.search({ query: 'pasta sauce', limit: 5 });
    expect(hits[0]?.path).toBe('Kitchen.md');
    expect(hits[0]?.score).toBeNull();

    const empty = await makeWorld({ embedder: undefined });
    await connect(empty);
    expect(await empty.service.search({ query: 'anything', limit: 5 })).toEqual([]);
  });

  it('sees a note change on the next rebuild', async () => {
    const world = await makeWorld({ embedder: undefined });
    await connect(world);
    await seedNotes(world);
    await world.service.refresh();
    await writeFile(path.join(world.vault, 'Garden.md'), '# Garden\n\nAll about compost and mulch.\n');
    await world.service.refresh();
    const hits = await world.service.search({ query: 'compost', limit: 5 });
    expect(hits[0]?.path).toBe('Garden.md');
    expect(await world.service.search({ query: 'seedlings', limit: 5 })).toEqual([]);
  });
});

describe('reading notes', () => {
  it('reads a note in full and refuses paths that leave the folder', async () => {
    const world = await makeWorld({});
    await connect(world);
    await seedNotes(world);
    const note = await world.service.readNote('Garden.md');
    expect(note.content).toContain('Tomatoes need deep watering');
    await expect(world.service.readNote('../outside.md')).rejects.toThrow(NOTE_PATH_MESSAGE);
    await expect(world.service.readNote('/etc/passwd.md')).rejects.toThrow(NOTE_PATH_MESSAGE);
    await expect(world.service.readNote('Missing.md')).rejects.toThrow(NOTE_NOT_FOUND_MESSAGE);
  });
});

describe('appending to the inbox', () => {
  const fixedNow = () => Date.parse('2026-11-07T09:41:00');

  it('makes the inbox file with a dated heading, then adds under a new heading, never rewriting', async () => {
    const world = await makeWorld({ now: fixedNow });
    await connect(world);
    await world.service.appendToInbox('First entry.');
    const inboxPath = path.join(world.vault, 'Aman inbox.md');
    const afterFirst = await readFile(inboxPath, 'utf8');
    expect(afterFirst).toBe('## 2026-11-07 09:41\n\nFirst entry.\n');

    await world.service.appendToInbox('Second entry.');
    const afterSecond = await readFile(inboxPath, 'utf8');
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond).toBe(`${afterFirst}\n## 2026-11-07 09:41\n\nSecond entry.\n`);
  });

  it('keeps both halves when a sync lands mid-append', async () => {
    const inboxPath = { current: '' };
    let landed = false;
    const world = await makeWorld({
      now: fixedNow,
      beforeAppend: async () => {
        if (landed) {
          return;
        }
        landed = true;
        await appendFile(inboxPath.current, 'A line sync brought in.\n');
      },
    });
    await connect(world);
    inboxPath.current = path.join(world.vault, 'Aman inbox.md');
    await writeFile(inboxPath.current, 'Already here.\n');
    await world.service.appendToInbox('My new entry.');
    const content = await readFile(inboxPath.current, 'utf8');
    expect(content.startsWith('Already here.\n')).toBe(true);
    expect(content).toContain('A line sync brought in.\n');
    expect(content).toContain('## 2026-11-07 09:41\n\nMy new entry.\n');
    expect(content.indexOf('A line sync brought in.')).toBeLessThan(content.indexOf('My new entry.'));
  });

  it('appends to the inbox file the person named, not the default', async () => {
    const world = await makeWorld({ now: fixedNow });
    await connect(world, 'Ideas in.md');
    await world.service.appendToInbox('Named inbox.');
    await expect(readFile(path.join(world.vault, 'Ideas in.md'), 'utf8')).resolves.toContain('Named inbox.');
  });
});

describe('creating notes', () => {
  it('makes a new note, in a new subfolder when asked, and never overwrites one that is there', async () => {
    const world = await makeWorld({});
    await connect(world);
    await seedNotes(world);
    const created = await world.service.createNote({ relativePath: 'Projects/Plan.md', text: 'The plan.' });
    expect(created.path).toBe('Projects/Plan.md');
    await expect(readFile(path.join(world.vault, 'Projects', 'Plan.md'), 'utf8')).resolves.toBe('The plan.\n');

    await expect(world.service.createNote({ relativePath: 'Projects/Plan.md', text: 'Other words.' })).rejects.toThrow(
      NOTE_ALREADY_THERE_MESSAGE,
    );
    await expect(readFile(path.join(world.vault, 'Projects', 'Plan.md'), 'utf8')).resolves.toBe('The plan.\n');
    await expect(world.service.createNote({ relativePath: '../Escape.md', text: 'No.' })).rejects.toThrow(
      NOTE_PATH_MESSAGE,
    );
  });

  it('makes nothing outside the folder when a subfolder is a link out of it', async () => {
    const world = await makeWorld({});
    await connect(world);
    const outside = path.join(world.root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(world.vault, 'Linked'), 'dir');
    await expect(world.service.createNote({ relativePath: 'Linked/Deep/Note.md', text: 'No.' })).rejects.toThrow(
      NOTE_PATH_MESSAGE,
    );
    await expect(stat(path.join(outside, 'Deep'))).rejects.toThrow();
    await expect(stat(path.join(outside, 'Note.md'))).rejects.toThrow();
  });

  it('puts a new note in search results', async () => {
    const world = await makeWorld({ embedder: undefined });
    await connect(world);
    await world.service.createNote({ relativePath: 'Compost.md', text: 'Compost turns scraps into soil.' });
    await world.service.refresh();
    const hits = await world.service.search({ query: 'compost', limit: 5 });
    expect(hits[0]?.path).toBe('Compost.md');
  });
});

describe('the folder overlap refusal', () => {
  it("refuses Aman's own memory folder for reading, writing and searching", async () => {
    const world = await makeWorld({ embedder: undefined });
    await writeFile(path.join(world.memoryDir, 'Memory.md'), '# Memory\n\nAman remembers this.\n');
    await writeNotesFolderSettings(world.settingsStore, { folder_path: world.memoryDir, inbox_file: 'Aman inbox.md' });

    expect(await world.service.search({ query: 'remembers', limit: 5 })).toEqual([]);
    await expect(world.service.readNote('Memory.md')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
    await expect(world.service.createNote({ relativePath: 'New.md', text: 'No.' })).rejects.toThrow(
      NOTES_FOLDER_OVERLAP_MESSAGE,
    );
    await expect(stat(path.join(world.memoryDir, 'Aman inbox.md'))).rejects.toThrow();
  });

  it('refuses a folder inside the memory folder, and one the memory folder sits inside', async () => {
    const world = await makeWorld({ embedder: undefined });
    const inside = path.join(world.memoryDir, 'sub');
    await mkdir(inside, { recursive: true });
    await writeNotesFolderSettings(world.settingsStore, { folder_path: inside, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);

    await writeNotesFolderSettings(world.settingsStore, { folder_path: world.root, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NotesFolderProblem);
  });

  it('refuses a link to the memory folder, a link into it, and a link around it', async () => {
    const world = await makeWorld({ embedder: undefined });
    await writeFile(path.join(world.memoryDir, 'Memory.md'), '# Memory\n\nAman remembers this.\n');

    const toMemory = path.join(world.root, 'link-to-memory');
    await symlink(world.memoryDir, toMemory, 'dir');
    await writeNotesFolderSettings(world.settingsStore, { folder_path: toMemory, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
    await expect(world.service.readNote('Memory.md')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
    expect(await world.service.search({ query: 'remembers', limit: 5 })).toEqual([]);
    await expect(stat(path.join(world.memoryDir, 'Aman inbox.md'))).rejects.toThrow();

    const inside = path.join(world.memoryDir, 'sub');
    await mkdir(inside, { recursive: true });
    const intoMemory = path.join(world.root, 'link-into-memory');
    await symlink(inside, intoMemory, 'dir');
    await writeNotesFolderSettings(world.settingsStore, { folder_path: intoMemory, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);

    const aroundMemory = path.join(world.root, 'link-around-memory');
    await symlink(world.root, aroundMemory, 'dir');
    await writeNotesFolderSettings(world.settingsStore, { folder_path: aroundMemory, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
  });

  it("refuses Aman's persona knowledge folder and its app data folder, directly and through a link", async () => {
    const world = await makeWorld({ embedder: undefined });
    const personaKnowledge = path.join(world.root, 'persona-knowledge');
    const appData = path.join(world.root, 'app-data');
    await mkdir(personaKnowledge, { recursive: true });
    await mkdir(appData, { recursive: true });

    await writeNotesFolderSettings(world.settingsStore, { folder_path: personaKnowledge, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);

    await writeNotesFolderSettings(world.settingsStore, { folder_path: appData, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
    await expect(world.service.createNote({ relativePath: 'New.md', text: 'No.' })).rejects.toThrow(
      NOTES_FOLDER_OVERLAP_MESSAGE,
    );

    const toAppData = path.join(world.root, 'link-to-app-data');
    await symlink(appData, toAppData, 'dir');
    await writeNotesFolderSettings(world.settingsStore, { folder_path: toAppData, inbox_file: 'Aman inbox.md' });
    await expect(world.service.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
    await expect(stat(path.join(appData, 'Aman inbox.md'))).rejects.toThrow();
  });

  it('refuses the folder the sandbox slot workspaces live under, and a workspace in it, directly and through a link', async () => {
    const world = await makeWorld({ embedder: undefined });
    const slotsRoot = path.join(world.root, 'aman-slots');
    const workspace = path.join(slotsRoot, 'main');
    await mkdir(workspace, { recursive: true });
    const slotted = new NotesFolderService({
      settings: world.settingsStore,
      protectedDirs: [
        world.memoryDir,
        path.join(world.root, 'persona-knowledge'),
        path.join(world.root, 'app-data'),
        slotsRoot,
      ],
      indexDir: path.join(world.root, 'index-slots'),
      embedder: undefined,
      logger: createLogger({ silent: true }),
    });
    try {
      await writeNotesFolderSettings(world.settingsStore, { folder_path: slotsRoot, inbox_file: 'Aman inbox.md' });
      await expect(slotted.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);

      await writeNotesFolderSettings(world.settingsStore, { folder_path: workspace, inbox_file: 'Aman inbox.md' });
      await expect(slotted.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
      await expect(slotted.createNote({ relativePath: 'New.md', text: 'No.' })).rejects.toThrow(
        NOTES_FOLDER_OVERLAP_MESSAGE,
      );

      const toWorkspace = path.join(world.root, 'link-to-slot-workspace');
      await symlink(workspace, toWorkspace, 'dir');
      await writeNotesFolderSettings(world.settingsStore, { folder_path: toWorkspace, inbox_file: 'Aman inbox.md' });
      await expect(slotted.appendToInbox('An entry.')).rejects.toThrow(NOTES_FOLDER_OVERLAP_MESSAGE);
      await expect(stat(path.join(workspace, 'Aman inbox.md'))).rejects.toThrow();
    } finally {
      slotted.stop();
    }
  });

  it('still connects through a link to a folder that is not the memory folder', async () => {
    const world = await makeWorld({ embedder: undefined });
    await seedNotes(world);
    const link = path.join(world.root, 'link-to-vault');
    await symlink(world.vault, link, 'dir');
    await writeNotesFolderSettings(world.settingsStore, { folder_path: link, inbox_file: 'Aman inbox.md' });
    await world.service.appendToInbox('Through the link.');
    await expect(readFile(path.join(world.vault, 'Aman inbox.md'), 'utf8')).resolves.toContain('Through the link.');
  });
});
