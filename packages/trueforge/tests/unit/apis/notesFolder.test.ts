import { Hono } from 'hono';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';
import { createNotesFolderRouter, NOTES_FOLDER_SETTINGS_BASE_PATH } from '../../../src/apis/notesFolder';
import configuration from '../../../src/config';
import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import {
  INBOX_FILE_NAME_MESSAGE,
  NOTES_FOLDER_NOT_A_FOLDER_MESSAGE,
  NOTES_FOLDER_NOT_FOUND_MESSAGE,
  NOTES_FOLDER_OVERLAP_MESSAGE,
} from '../../../src/runtime/notesFolder/notesFolderPaths';
import { NotesFolderService } from '../../../src/runtime/notesFolder/notesFolderService';

const BASE = NOTES_FOLDER_SETTINGS_BASE_PATH;

function makeSettingsStore(): IGlobalSettingsStore {
  const rows = new Map<string, string>();
  return {
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
}

describe('the notes folder settings endpoints', () => {
  const originalMemoryDir = configuration.MEMORY_MARKDOWN_DIR;
  const originalPersonaKnowledgeDir = configuration.PERSONA_KNOWLEDGE_DIR;
  const originalAppDataDir = configuration.APP_DATA_DIR;
  const originalSlotsDiskRoot = configuration.SANDBOX_SLOTS_DISK_ROOT;
  let root: string;
  let vault: string;
  let memoryDir: string;
  let personaKnowledgeDir: string;
  let appDataDir: string;
  let slotsRoot: string;
  let slotWorkspace: string;
  let app: Hono;
  let service: NotesFolderService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'notes-api-'));
    vault = path.join(root, 'vault');
    memoryDir = path.join(root, 'memory');
    personaKnowledgeDir = path.join(root, 'persona-knowledge');
    appDataDir = path.join(root, 'app-data');
    slotsRoot = path.join(root, 'aman-slots');
    slotWorkspace = path.join(slotsRoot, 'main');
    await mkdir(vault, { recursive: true });
    await mkdir(memoryDir, { recursive: true });
    await mkdir(personaKnowledgeDir, { recursive: true });
    await mkdir(slotWorkspace, { recursive: true });
    await mkdir(appDataDir, { recursive: true });
    await writeFile(path.join(vault, 'Garden.md'), '# Garden\n\nTomatoes.\n');
    await writeFile(path.join(vault, 'Kitchen.md'), '# Kitchen\n\nPasta.\n');
    configuration.MEMORY_MARKDOWN_DIR = memoryDir;
    configuration.PERSONA_KNOWLEDGE_DIR = personaKnowledgeDir;
    configuration.APP_DATA_DIR = appDataDir;
    configuration.SANDBOX_SLOTS_DISK_ROOT = slotsRoot;
    const settingsStore = makeSettingsStore();
    service = new NotesFolderService({
      settings: settingsStore,
      protectedDirs: [memoryDir, personaKnowledgeDir, appDataDir],
      indexDir: path.join(root, 'index'),
      embedder: undefined,
      logger: createLogger({ silent: true }),
    });
    const router = createNotesFolderRouter({ logger: createLogger({ silent: true }), settingsStore, service });
    app = new Hono();
    app.route(BASE, router);
  });

  afterEach(() => {
    configuration.MEMORY_MARKDOWN_DIR = originalMemoryDir;
    configuration.PERSONA_KNOWLEDGE_DIR = originalPersonaKnowledgeDir;
    configuration.APP_DATA_DIR = originalAppDataDir;
    configuration.SANDBOX_SLOTS_DISK_ROOT = originalSlotsDiskRoot;
    service.stop();
  });

  async function call(input: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<{ status: number; text: string }> {
    const init: RequestInit = { method: input.method, headers: { 'content-type': 'application/json' } };
    if (input.body !== undefined) {
      init.body = JSON.stringify(input.body);
    }
    const suffix = input.path === '/' ? '' : input.path;
    const response = await app.request(`http://localhost${BASE}${suffix}`, init);
    return { status: response.status, text: await response.text() };
  }

  it('reports Not connected when no folder is saved', async () => {
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    const data = JSON.parse(text).data;
    expect(data.state).toBe('not_connected');
    expect(data.folder_path).toBeNull();
    expect(data.inbox_file).toBe('Aman inbox.md');
    expect(data.note_count).toBeNull();
  });

  it('connects a folder and counts its notes', async () => {
    const saved = await call({ method: 'POST', path: '/', body: { folder_path: vault } });
    expect(saved.status).toBe(201);
    const data = JSON.parse(saved.text).data;
    expect(data.state).toBe('connected');
    expect(data.folder_path).toBe(vault);
    expect(data.inbox_file).toBe('Aman inbox.md');
    expect(data.note_count).toBe(2);

    const status = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(status.text).data.state).toBe('connected');
  });

  it('saves the inbox file name the person picked', async () => {
    const saved = await call({ method: 'POST', path: '/', body: { folder_path: vault, inbox_file: 'Ideas in.md' } });
    expect(saved.status).toBe(201);
    expect(JSON.parse(saved.text).data.inbox_file).toBe('Ideas in.md');
  });

  it('removes the folder and changes nothing inside it', async () => {
    await call({ method: 'POST', path: '/', body: { folder_path: vault } });
    const removed = await call({ method: 'DELETE', path: '/' });
    expect(removed.status).toBe(200);
    expect(JSON.parse(removed.text).data.state).toBe('not_connected');
    const status = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(status.text).data.state).toBe('not_connected');
  });

  it('refuses a folder that is not there, a file, and an inbox name with folders in it', async () => {
    const missing = await call({ method: 'POST', path: '/', body: { folder_path: path.join(root, 'nope') } });
    expect(missing.status).toBe(400);
    expect(JSON.parse(missing.text).error.message).toBe(NOTES_FOLDER_NOT_FOUND_MESSAGE);

    const file = await call({ method: 'POST', path: '/', body: { folder_path: path.join(vault, 'Garden.md') } });
    expect(file.status).toBe(400);
    expect(JSON.parse(file.text).error.message).toBe(NOTES_FOLDER_NOT_A_FOLDER_MESSAGE);

    const inbox = await call({ method: 'POST', path: '/', body: { folder_path: vault, inbox_file: 'sub/inbox.md' } });
    expect(inbox.status).toBe(400);
    expect(JSON.parse(inbox.text).error.message).toBe(INBOX_FILE_NAME_MESSAGE);
  });

  it('refuses the folder Aman keeps its own memory in, and says which folder to pick instead', async () => {
    const refused = await call({ method: 'POST', path: '/', body: { folder_path: memoryDir } });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const parent = await call({ method: 'POST', path: '/', body: { folder_path: root } });
    expect(parent.status).toBe(400);
    expect(JSON.parse(parent.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const status = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(status.text).data.state).toBe('not_connected');
  });

  it("refuses Aman's persona knowledge folder and its app data folder at save time", async () => {
    const knowledge = await call({ method: 'POST', path: '/', body: { folder_path: personaKnowledgeDir } });
    expect(knowledge.status).toBe(400);
    expect(JSON.parse(knowledge.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const appData = await call({ method: 'POST', path: '/', body: { folder_path: appDataDir } });
    expect(appData.status).toBe(400);
    expect(JSON.parse(appData.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const status = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(status.text).data.state).toBe('not_connected');
  });

  it('refuses the folder the sandbox slot workspaces live under at save time, a workspace in it, and a link to one', async () => {
    const diskRootPick = await call({ method: 'POST', path: '/', body: { folder_path: slotsRoot } });
    expect(diskRootPick.status).toBe(400);
    expect(JSON.parse(diskRootPick.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const workspace = await call({ method: 'POST', path: '/', body: { folder_path: slotWorkspace } });
    expect(workspace.status).toBe(400);
    expect(JSON.parse(workspace.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const toWorkspace = path.join(root, 'link-to-slot-workspace');
    await symlink(slotWorkspace, toWorkspace, 'dir');
    const linked = await call({ method: 'POST', path: '/', body: { folder_path: toWorkspace } });
    expect(linked.status).toBe(400);
    expect(JSON.parse(linked.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const status = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(status.text).data.state).toBe('not_connected');
  });

  it('refuses a link that leads to the memory folder, and one that leads around it', async () => {
    const toMemory = path.join(root, 'link-to-memory');
    await symlink(memoryDir, toMemory, 'dir');
    const refused = await call({ method: 'POST', path: '/', body: { folder_path: toMemory } });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const aroundMemory = path.join(root, 'link-around-memory');
    await symlink(root, aroundMemory, 'dir');
    const parent = await call({ method: 'POST', path: '/', body: { folder_path: aroundMemory } });
    expect(parent.status).toBe(400);
    expect(JSON.parse(parent.text).error.message).toBe(NOTES_FOLDER_OVERLAP_MESSAGE);

    const status = await call({ method: 'GET', path: '/status' });
    expect(JSON.parse(status.text).data.state).toBe('not_connected');
  });

  it('reports Not working when the connected folder is gone', async () => {
    await call({ method: 'POST', path: '/', body: { folder_path: vault } });
    await rm(vault, { recursive: true, force: true });
    const { status, text } = await call({ method: 'GET', path: '/status' });
    expect(status).toBe(200);
    const data = JSON.parse(text).data;
    expect(data.state).toBe('not_working');
    expect(data.folder_path).toBe(vault);
    expect(data.note_count).toBeNull();
  });
});
