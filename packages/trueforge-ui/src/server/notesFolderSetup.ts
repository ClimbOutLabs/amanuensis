import type { AccountConnectionState } from './accountSetup.js';

/**
 * The notes folder port the Harness adds on top of the runtime's connector port.
 * Hand-written wire types: the generated SDK has no notes folder settings routes yet, so the
 * adapter calls the server endpoints directly and maps their snake_case fields here.
 * There is no account and no secret: the folder path and the inbox file name are all it holds.
 */

/** The Notes folder card's state. */
export interface NotesFolderStatus {
  state: AccountConnectionState;
  /** The folder of notes the person connected; null when none is connected. */
  folderPath: string | null;
  /** The file inside the folder that inbox entries are added to. */
  inboxFile: string;
  /** How many notes the folder holds; null when none is connected or it cannot be read right now. */
  noteCount: number | null;
}

/** What the person entered in the form. */
export interface NotesFolderSaveRequest {
  folderPath: string;
  inboxFile?: string;
}

/** Operations behind Settings, Connectors, Notes folder. */
export interface NotesFolderSetupPort {
  getNotesFolderStatus(): Promise<NotesFolderStatus>;
  /** Checks the folder first; a folder that cannot be used saves nothing and the error says why. */
  saveNotesFolder(req: NotesFolderSaveRequest): Promise<NotesFolderStatus>;
  /** Forgets the folder. Nothing inside the folder is changed or removed. */
  removeNotesFolder(): Promise<NotesFolderStatus>;
}

/** Whether a catalog implements the notes folder port; another host's catalog may not. */
export function hasNotesFolderSetup(catalog: object): catalog is NotesFolderSetupPort {
  return typeof Reflect.get(catalog, 'getNotesFolderStatus') === 'function';
}
