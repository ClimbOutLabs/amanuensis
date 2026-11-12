/**
 * Maps the notes folder port onto the server's settings notes folder routes (see
 * accountSetupRequest.ts for how the calls are made). The routes are browser-session only: they
 * accept the browser session cookie and refuse any bearer token.
 */
import { z } from 'zod';
import type {
  NotesFolderSaveRequest,
  NotesFolderSetupPort,
  NotesFolderStatus,
} from '../../../server/notesFolderSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';
import { AccountConnectionStateWireSchema, createAccountSetupRequest } from './accountSetupRequest.js';

const NotesFolderStatusWireSchema = z.object({
  state: AccountConnectionStateWireSchema,
  folder_path: z.string().nullable(),
  inbox_file: z.string(),
  note_count: z.number().nullable(),
});

type NotesFolderStatusWire = z.infer<typeof NotesFolderStatusWireSchema>;

function toNotesFolderStatus(wire: NotesFolderStatusWire): NotesFolderStatus {
  return {
    state: wire.state,
    folderPath: wire.folder_path,
    inboxFile: wire.inbox_file,
    noteCount: wire.note_count,
  };
}

export function createNotesFolderSetupApi(options: CreateTrueForgeClientOptions = {}): NotesFolderSetupPort {
  const request = createAccountSetupRequest({
    options,
    path: '/api/v1/user/settings/notes-folder',
    wireSchema: NotesFolderStatusWireSchema,
    toStatus: toNotesFolderStatus,
  });

  return {
    getNotesFolderStatus: async () => request({ method: 'GET' }),
    saveNotesFolder: async (req: NotesFolderSaveRequest) =>
      request({
        method: 'POST',
        body: {
          folder_path: req.folderPath,
          ...(req.inboxFile === undefined ? {} : { inbox_file: req.inboxFile }),
        },
      }),
    // A JSON body is sent on purpose: a bodiless state-changing call can be refused as
    // not-from-this-app when the instance is reached through its proxy address.
    removeNotesFolder: async () => request({ method: 'DELETE', body: {} }),
  };
}
