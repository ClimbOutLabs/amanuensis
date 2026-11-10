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
  };

  afterEach(() => {
    configuration.MEMORY_MARKDOWN_DIR = original.memory;
    configuration.PERSONA_KNOWLEDGE_DIR = original.personaKnowledge;
    configuration.APP_DATA_DIR = original.appData;
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
    expect(notesFolderProtectedDirs()).toEqual(['/aman/memory', '/aman/persona-knowledge', '/aman/app-data']);
  });
});
