/**
 * Canonical owner of the notes folder tool contract: names, parameter schemas and annotations.
 * The folder is the person's own notes on their own computer: searching and reading them, adding
 * an entry to the inbox file they named, and making a new note all run without a card, the same
 * way a reminder does, unless the chat has read content that is not the person's own words, in
 * which case a write asks first. Nothing here edits or deletes a note: the write tools can only
 * add, never change what is already written.
 */
import { z } from 'zod';

export const NOTES_FOLDER_SERVER_ID = 'notes_folder';

export const SEARCH_NOTES_TOOL_NAME = 'search_notes';
export const READ_NOTE_TOOL_NAME = 'read_note';
export const APPEND_TO_INBOX_TOOL_NAME = 'append_to_inbox';
export const CREATE_NOTE_TOOL_NAME = 'create_note';

/** Calls that only look at the notes: searching them and reading one in full. */
export function isNotesFolderReadToolName(tool_name: string): boolean {
  return tool_name === SEARCH_NOTES_TOOL_NAME || tool_name === READ_NOTE_TOOL_NAME;
}

/** Calls that add to the folder: an entry in the inbox file, or a new note. Neither can edit or delete. */
export function isNotesFolderWriteToolName(tool_name: string): boolean {
  return tool_name === APPEND_TO_INBOX_TOOL_NAME || tool_name === CREATE_NOTE_TOOL_NAME;
}

/** The notes are the person's own files on their own computer, so no call here is open-world. */
export const NOTES_READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
export const NOTES_WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const notePath = z.string().min(1).max(1024);

export const SearchNotesSchema = z
  .object({
    query: z.string().min(1).max(512),
    max_results: z.number().int().min(1).max(20).default(8),
  })
  .strict();

export const ReadNoteSchema = z
  .object({
    path: notePath,
  })
  .strict();

export const AppendToInboxSchema = z
  .object({
    text: z.string().min(1).max(20_000),
  })
  .strict();

export const CreateNoteSchema = z
  .object({
    path: notePath,
    text: z.string().max(100_000).default(''),
  })
  .strict();
