import path from 'node:path';
import { createLogger } from 'winston';
import configuration from '../../../../src/config';
import type { IGlobalSettingsStore } from '../../../../src/db/globalSettingsStore';
import {
  notesFolderProtectedDirs,
  notesFolderServiceDeps,
} from '../../../../src/runtime/notesFolder/notesFolderRuntime';

function makeSettingsStore(): Pick<IGlobalSettingsStore, 'getSetting'> {
  return {
    getSetting: () => Promise.resolve(undefined),
  };
}

describe('the notes folder service wiring', () => {
  const original = {
    memory: configuration.MEMORY_MARKDOWN_DIR,
    personaKnowledge: configuration.PERSONA_KNOWLEDGE_DIR,
    appData: configuration.APP_DATA_DIR,
    slotsDiskRoot: configuration.SANDBOX_SLOTS_DISK_ROOT,
    slotsDir: configuration.SANDBOX_SLOTS_DIR,
  };

  afterEach(() => {
    configuration.MEMORY_MARKDOWN_DIR = original.memory;
    configuration.PERSONA_KNOWLEDGE_DIR = original.personaKnowledge;
    configuration.APP_DATA_DIR = original.appData;
    configuration.SANDBOX_SLOTS_DISK_ROOT = original.slotsDiskRoot;
    configuration.SANDBOX_SLOTS_DIR = original.slotsDir;
  });

  it('keeps the search index in the app data folder, not in the memory folder', () => {
    configuration.MEMORY_MARKDOWN_DIR = '/aman/memory';
    configuration.APP_DATA_DIR = '/aman/app-data';
    const deps = notesFolderServiceDeps({
      settings: makeSettingsStore(),
      logger: createLogger({ silent: true }),
    });
    expect(deps.indexDir).toBe(path.join('/aman/app-data', 'notes-folder-index'));
    expect(deps.indexDir.startsWith(path.join('/aman/memory'))).toBe(false);
  });

  it('protects every folder Aman keeps its own data in, not just memory', () => {
    configuration.MEMORY_MARKDOWN_DIR = '/aman/memory';
    configuration.PERSONA_KNOWLEDGE_DIR = '/aman/persona-knowledge';
    configuration.APP_DATA_DIR = '/aman/app-data';
    configuration.SANDBOX_SLOTS_DISK_ROOT = '/aman/aman-slots';
    configuration.SANDBOX_SLOTS_DIR = '';
    expect(notesFolderProtectedDirs()).toEqual([
      '/aman/memory',
      '/aman/persona-knowledge',
      '/aman/app-data',
      '/aman/aman-slots',
    ]);
  });

  it('protects the slots control folder too when one is set', () => {
    configuration.SANDBOX_SLOTS_DISK_ROOT = '/aman/aman-slots';
    configuration.SANDBOX_SLOTS_DIR = '/aman/slot-control';
    expect(notesFolderProtectedDirs()).toContain('/aman/slot-control');
    expect(notesFolderProtectedDirs()).toContain('/aman/aman-slots');
  });
});
