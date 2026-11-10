/**
 * The one notes folder service for the process: the Settings endpoints, the per-turn tools and
 * the background indexing all share it, so the index is built once and the watcher has one
 * owner. The index cache lives in Aman's app data folder, never in the person's notes folder
 * and never in Aman's memory folder.
 */
import path from 'node:path';
import type { Logger } from 'winston';
import configuration from '../../config';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import { getSharedEmbeddingModel } from '../memory/embeddingModel';
import { NotesFolderService, type NotesFolderServiceDeps } from './notesFolderService';

let shared: NotesFolderService | undefined;

/**
 * Every folder Aman keeps its own data in, resolved: its memory, its persona knowledge, and
 * the app data folder that holds its database, its sandbox workspaces and the files skills
 * download while they work. A notes folder may never overlap any of these.
 */
export function notesFolderProtectedDirs(): string[] {
  return [
    path.resolve(configuration.MEMORY_MARKDOWN_DIR),
    path.resolve(configuration.PERSONA_KNOWLEDGE_DIR),
    path.resolve(configuration.APP_DATA_DIR),
  ];
}

/** The service's dependencies from the instance configuration; the first caller's win. */
export function notesFolderServiceDeps({
  settings,
  logger,
}: {
  settings: Pick<IGlobalSettingsStore, 'getSetting'>;
  logger: Pick<Logger, 'warn' | 'info'>;
}): NotesFolderServiceDeps {
  return {
    settings,
    protectedDirs: notesFolderProtectedDirs(),
    indexDir: path.join(path.resolve(configuration.APP_DATA_DIR), 'notes-folder-index'),
    embedder: configuration.MEMORY_EMBEDDINGS_ENABLED
      ? getSharedEmbeddingModel({ modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR })
      : undefined,
    logger,
  };
}

/** The process-wide service, built on first use. */
export function sharedNotesFolderService(deps: NotesFolderServiceDeps): NotesFolderService {
  shared ??= new NotesFolderService(deps);
  return shared;
}

/** Starts background indexing at boot; a no-op when the folder was never connected. */
export function startNotesFolderIndexing({
  settings,
  logger,
}: {
  settings: Pick<IGlobalSettingsStore, 'getSetting'>;
  logger: Pick<Logger, 'warn' | 'info'>;
}): void {
  sharedNotesFolderService(notesFolderServiceDeps({ settings, logger })).start();
}
