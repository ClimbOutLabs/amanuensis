/**
 * Canonical owner of the Google Drive tool contract: names, parameter schemas and annotations. Parameters are
 * snake_case like the other Google tools; the mapping onto Drive, Docs and Sheets field names stays inside
 * the API client. There is no delete and no sharing change, here or in the client.
 */
import { z } from 'zod';
import { fewSelectors, TOO_MANY_SELECTORS, visible } from '../email/gmail/toolContract';

export const DRIVE_SERVER_ID = 'google_drive';

export const LIST_FILES_TOOL_NAME = 'list_files';
export const READ_DRIVE_FILE_TOOL_NAME = 'read_drive_file';
export const CREATE_DOC_TOOL_NAME = 'create_doc';
export const APPEND_ROWS_TOOL_NAME = 'append_rows';

export const DRIVE_READ_TOOL_NAMES = [LIST_FILES_TOOL_NAME, READ_DRIVE_FILE_TOOL_NAME] as const;

const DRIVE_WRITE_TOOL_NAMES = [CREATE_DOC_TOOL_NAME, APPEND_ROWS_TOOL_NAME] as const;

export function isDriveReadToolName(tool_name: string): boolean {
  return DRIVE_READ_TOOL_NAMES.some(name => name === tool_name);
}

export function isDriveWriteToolName(tool_name: string): boolean {
  return DRIVE_WRITE_TOOL_NAMES.some(name => name === tool_name);
}

const MAX_RESULTS_CAP = 100;
const DEFAULT_MAX_RESULTS = 25;

/** Drive file ids are longer than a mail id; the cap only refuses what cannot be one. */
const FileId = z.string().min(1).max(256);

export const ListFilesSchema = z
  .object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Words to look for in file names. Leave out to list the files most recently changed.'),
    max_results: z.number().int().min(1).max(MAX_RESULTS_CAP).default(DEFAULT_MAX_RESULTS),
    page_token: z.string().max(1024).optional(),
  })
  .strict();

export const ReadDriveFileSchema = z
  .object({
    file_id: FileId,
    sheet: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('For a Google Sheet only: the tab to read. Leave out for the first tab.'),
  })
  .strict();

/** Longest document text one create writes, the same bound a mail body has. */
export const MAX_DOC_TEXT_CHARS = 20_000;

export const CreateDocSchema = z
  .object({
    title: visible(z.string().trim().min(1).max(300)),
    text: visible(z.string().max(MAX_DOC_TEXT_CHARS)).default(''),
  })
  .strict()
  .refine(input => fewSelectors([input.title, input.text]), TOO_MANY_SELECTORS);

export type CreateDocInput = z.infer<typeof CreateDocSchema>;

/** Bounds on one append, so the card can show every row and the write stays one small change. */
export const MAX_APPEND_ROWS = 100;
export const MAX_APPEND_CELLS_PER_ROW = 50;
export const MAX_CELL_CHARS = 1_000;

export const AppendRowsSchema = z
  .object({
    file_id: FileId,
    sheet: z.string().min(1).max(100).optional().describe('The tab to add to. Leave out for the first tab.'),
    rows: z
      .array(
        z
          .array(visible(z.string().max(MAX_CELL_CHARS)))
          .min(1)
          .max(MAX_APPEND_CELLS_PER_ROW),
      )
      .min(1)
      .max(MAX_APPEND_ROWS),
  })
  .strict()
  .refine(input => fewSelectors(input.rows.flat()), TOO_MANY_SELECTORS);

export type AppendRowsInput = z.infer<typeof AppendRowsSchema>;

/**
 * File content is third-party text (anyone the person shares a file with can write in it), so every read is
 * open-world: the tool-output screen looks at it and the classifier treats a turn that read a file as one
 * that holds private data.
 */
export const DRIVE_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
export const DRIVE_WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
