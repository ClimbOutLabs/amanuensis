/**
 * The saved Notes folder settings: which folder of Markdown notes Aman may read, search and add
 * to, and the name of the one file in it Aman appends to. Stored as one JSON value in the global
 * settings, like the other instance-wide choices. Nothing here checks the folder itself; that is
 * the service's and the Settings endpoint's job (see notesFolderPaths.ts).
 */
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';

/** The one global-settings key this connector owns. */
export const NOTES_FOLDER_SETTINGS_KEY = 'notes_folder';

/** The inbox file name a fresh setup uses until the person names another. */
export const DEFAULT_INBOX_FILE_NAME = 'Aman inbox.md';

export interface NotesFolderSettings {
  /** The folder the person pointed Aman at, as they typed it. */
  folder_path: string;
  /** The file inside the folder that appends go to; a plain file name, never a path. */
  inbox_file: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The saved settings from a stored value; a value of any other shape reads as no settings. */
export function parseNotesFolderSettings(raw: string | undefined): NotesFolderSettings | undefined {
  if (raw === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const folderPath = parsed['folder_path'];
  const inboxFile = parsed['inbox_file'];
  if (typeof folderPath !== 'string' || folderPath.trim() === '') {
    return undefined;
  }
  return {
    folder_path: folderPath,
    inbox_file: typeof inboxFile === 'string' && inboxFile.trim() !== '' ? inboxFile : DEFAULT_INBOX_FILE_NAME,
  };
}

/** The saved Notes folder settings, or undefined when the person has not set the folder up. */
export async function readNotesFolderSettings(
  store: Pick<IGlobalSettingsStore, 'getSetting'>,
): Promise<NotesFolderSettings | undefined> {
  const record = await store.getSetting({ key: NOTES_FOLDER_SETTINGS_KEY });
  return parseNotesFolderSettings(record?.value);
}

/** Saves the settings, replacing any that were there. */
export async function writeNotesFolderSettings(
  store: Pick<IGlobalSettingsStore, 'setSetting'>,
  settings: NotesFolderSettings,
): Promise<void> {
  await store.setSetting({ key: NOTES_FOLDER_SETTINGS_KEY, value: JSON.stringify(settings) });
}

/** Removes the settings; the folder is simply no longer connected. */
export async function deleteNotesFolderSettings(store: Pick<IGlobalSettingsStore, 'deleteSetting'>): Promise<void> {
  await store.deleteSetting({ key: NOTES_FOLDER_SETTINGS_KEY });
}
