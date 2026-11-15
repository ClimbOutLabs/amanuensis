/**
 * Notes folder API under /api/v1/user/settings/notes-folder: the Settings Notes folder card's
 * endpoints. There is no account and nothing to sign in to: saving checks the folder itself
 * (there, a folder, and not one of Aman's own data folders) and stores only its path and the
 * inbox file name.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { stat } from 'node:fs/promises';
import type { Logger } from 'winston';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { notesFolderRoutes } from '../routes/notesFolderRoutes';
import {
  folderOverlapProblem,
  inboxFileNameProblem,
  NOTES_FOLDER_EMPTY_MESSAGE,
  NOTES_FOLDER_NOT_A_FOLDER_MESSAGE,
  NOTES_FOLDER_NOT_FOUND_MESSAGE,
  resolveFolderPath,
} from '../runtime/notesFolder/notesFolderPaths';
import {
  notesFolderProtectedDirs,
  notesFolderServiceDeps,
  sharedNotesFolderService,
} from '../runtime/notesFolder/notesFolderRuntime';
import { countNoteFiles } from '../runtime/notesFolder/notesFolderScan';
import type { NotesFolderService } from '../runtime/notesFolder/notesFolderService';
import {
  DEFAULT_INBOX_FILE_NAME,
  deleteNotesFolderSettings,
  readNotesFolderSettings,
  writeNotesFolderSettings,
  type NotesFolderSettings,
} from '../runtime/notesFolder/notesFolderSettings';
import type { NotesFolderStatus, SaveNotesFolderRequest } from '../schemas/notesFolder';
import { requireJsonOrSameOrigin } from './crossSite';

export const NOTES_FOLDER_SETTINGS_BASE_PATH = '/api/v1/user/settings/notes-folder';

interface NotesFolderRouterDeps {
  logger: Logger;
  settingsStore: IGlobalSettingsStore;
  /** Replaceable so tests use their own service over a temp folder. */
  service?: NotesFolderService | undefined;
}

/** The card's status from the saved settings and the folder as it stands now. */
async function statusBody(settingsStore: Pick<IGlobalSettingsStore, 'getSetting'>): Promise<NotesFolderStatus> {
  const settings = await readNotesFolderSettings(settingsStore);
  if (settings === undefined) {
    return { state: 'not_connected', folder_path: null, inbox_file: DEFAULT_INBOX_FILE_NAME, note_count: null };
  }
  const folder = resolveFolderPath(settings.folder_path);
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) {
    return {
      state: 'not_working',
      folder_path: settings.folder_path,
      inbox_file: settings.inbox_file,
      note_count: null,
    };
  }
  return {
    state: 'connected',
    folder_path: settings.folder_path,
    inbox_file: settings.inbox_file,
    note_count: await countNoteFiles(folder),
  };
}

/** Why a folder cannot be saved, in one plain sentence, or null when it can. */
async function saveProblem(request: SaveNotesFolderRequest): Promise<string | null> {
  const folderPath = request.folder_path.trim();
  if (folderPath === '') {
    return NOTES_FOLDER_EMPTY_MESSAGE;
  }
  const resolved = resolveFolderPath(folderPath);
  const info = await stat(resolved).catch(() => null);
  if (info === null) {
    return NOTES_FOLDER_NOT_FOUND_MESSAGE;
  }
  if (!info.isDirectory()) {
    return NOTES_FOLDER_NOT_A_FOLDER_MESSAGE;
  }
  const overlap = await folderOverlapProblem({
    folderPath: resolved,
    protectedDirs: notesFolderProtectedDirs(),
  });
  if (overlap !== null) {
    return overlap;
  }
  if (request.inbox_file !== undefined) {
    return inboxFileNameProblem(request.inbox_file);
  }
  return null;
}

export function createNotesFolderRouter(deps: NotesFolderRouterDeps) {
  const service =
    deps.service ??
    sharedNotesFolderService(notesFolderServiceDeps({ settings: deps.settingsStore, logger: deps.logger }));
  const router = new OpenAPIHono();
  router.use('/', requireJsonOrSameOrigin());
  router.openapi(notesFolderRoutes.status, async c => {
    return c.json({ data: await statusBody(deps.settingsStore) }, 200);
  });
  router.openapi(notesFolderRoutes.save, async c => {
    const request = c.req.valid('json');
    const problem = await saveProblem(request);
    if (problem !== null) {
      return c.json({ error: { message: problem, type: 'validation' } }, 400);
    }
    const inboxFile = request.inbox_file?.trim();
    const settings: NotesFolderSettings = {
      folder_path: request.folder_path.trim(),
      inbox_file: inboxFile === undefined || inboxFile === '' ? DEFAULT_INBOX_FILE_NAME : inboxFile,
    };
    await writeNotesFolderSettings(deps.settingsStore, settings);
    service.poke();
    return c.json({ data: await statusBody(deps.settingsStore) }, 201);
  });
  router.openapi(notesFolderRoutes.remove, async c => {
    await deleteNotesFolderSettings(deps.settingsStore);
    service.poke();
    return c.json({ data: await statusBody(deps.settingsStore) }, 200);
  });
  return router;
}
