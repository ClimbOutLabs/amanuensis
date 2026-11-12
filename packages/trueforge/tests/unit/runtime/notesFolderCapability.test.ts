import { isAuthRequired } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';
import type { IGlobalSettingsStore } from '../../../src/db/globalSettingsStore';
import { NotesFolderService } from '../../../src/runtime/notesFolder/notesFolderService';
import { writeNotesFolderSettings } from '../../../src/runtime/notesFolder/notesFolderSettings';
import { notesFolderCapability } from '../../../src/runtime/notesFolderCapability';

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

describe('the notes folder capability', () => {
  it('mounts the notes tools only while a folder is connected and there', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'notes-capability-'));
    const vault = path.join(root, 'vault');
    await mkdir(vault, { recursive: true });
    await writeFile(path.join(vault, 'Garden.md'), '# Garden\n\nTomatoes.\n');
    const settingsStore = makeSettingsStore();
    const service = new NotesFolderService({
      settings: settingsStore,
      protectedDirs: [path.join(root, 'memory')],
      indexDir: path.join(root, 'index'),
      embedder: undefined,
      logger: createLogger({ silent: true }),
    });
    const mount = () => notesFolderCapability({ service, tracing: NOOP_AGENT_TRACING, keepsNothing: false });

    expect(await mount()).toBeUndefined();

    await writeNotesFolderSettings(settingsStore, { folder_path: vault, inbox_file: 'Aman inbox.md' });
    const capability = await mount();
    expect(capability?.systemToolSets).toHaveLength(1);
    expect(capability?.systemToolSets?.[0]?.name).toBe('notes_folder');
    expect(capability?.instructionBuilders).toHaveLength(1);

    await rm(vault, { recursive: true, force: true });
    expect(await mount()).toBeUndefined();
  });

  it('offers an incognito chat the tools that read notes and not the ones that add to them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'notes-capability-'));
    const vault = path.join(root, 'vault');
    await mkdir(vault, { recursive: true });
    const settingsStore = makeSettingsStore();
    const service = new NotesFolderService({
      settings: settingsStore,
      protectedDirs: [path.join(root, 'memory')],
      indexDir: path.join(root, 'index'),
      embedder: undefined,
      logger: createLogger({ silent: true }),
    });
    await writeNotesFolderSettings(settingsStore, { folder_path: vault, inbox_file: 'Aman inbox.md' });
    const offered = async (keepsNothing: boolean): Promise<string[]> => {
      const capability = await notesFolderCapability({ service, tracing: NOOP_AGENT_TRACING, keepsNothing });
      const listed = await capability?.systemToolSets?.[0]?.listTools();
      return listed === undefined || isAuthRequired(listed) ? [] : listed.result.tools.map(tool => tool.name).sort();
    };

    expect(await offered(true)).toEqual(['read_note', 'search_notes']);
    expect(await offered(false)).toEqual(['append_to_inbox', 'create_note', 'read_note', 'search_notes']);
    await rm(root, { recursive: true, force: true });
  });
});
