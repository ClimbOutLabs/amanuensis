/** The parts of the Drive, Docs and Sheets REST responses Aman reads. Fields Google may leave out are optional. */
import { z } from 'zod';

export const DOC_MIME_TYPE = 'application/vnd.google-apps.document';
export const SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export const DrivePermissionSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  role: z.string().optional(),
});
export type DrivePermission = z.infer<typeof DrivePermissionSchema>;

export const DriveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string().optional(),
  size: z.string().optional(),
  webViewLink: z.string().optional(),
  shared: z.boolean().optional(),
  permissions: z.array(DrivePermissionSchema).optional(),
});
export type DriveFile = z.infer<typeof DriveFileSchema>;

export const DriveFileListSchema = z.object({
  files: z.array(DriveFileSchema).optional(),
  nextPageToken: z.string().optional(),
});

/** What a file is called in words a person uses, for lists and cards. */
export function driveKindLabel(mimeType: string): string {
  switch (mimeType) {
    case DOC_MIME_TYPE:
      return 'Google Doc';
    case SHEET_MIME_TYPE:
      return 'Google Sheet';
    case FOLDER_MIME_TYPE:
      return 'folder';
    default:
      return 'file';
  }
}

export const DocsDocumentSchema = z.object({
  documentId: z.string(),
  title: z.string().optional(),
  body: z.object({ content: z.array(z.unknown()).optional() }).optional(),
});
export type DocsDocument = z.infer<typeof DocsDocumentSchema>;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function textRunsOf(paragraph: Record<string, unknown>): string {
  const elements = Array.isArray(paragraph['elements']) ? paragraph['elements'] : [];
  let text = '';
  for (const element of elements) {
    const run = recordOf(element)?.['textRun'];
    const content = recordOf(run)?.['content'];
    if (typeof content === 'string') {
      text += content;
    }
  }
  return text;
}

/**
 * The plain text of a Google Doc, in reading order: paragraphs as they come, and a table's cells row by
 * row, joined with tabs. Anything that carries no text (a drawing, a section break) adds nothing.
 */
export function docTextOf(document: DocsDocument): string {
  const content = document.body?.content ?? [];
  const parts: string[] = [];
  const walk = (elements: readonly unknown[]): void => {
    for (const element of elements) {
      const record = recordOf(element);
      if (record === undefined) {
        continue;
      }
      const paragraph = recordOf(record['paragraph']);
      if (paragraph !== undefined) {
        parts.push(textRunsOf(paragraph));
        continue;
      }
      const table = recordOf(record['table']);
      const rows = table !== undefined && Array.isArray(table['tableRows']) ? table['tableRows'] : undefined;
      if (rows !== undefined) {
        for (const row of rows) {
          const cells = recordOf(row)?.['tableCells'];
          if (!Array.isArray(cells)) {
            continue;
          }
          const cellTexts: string[] = [];
          for (const cell of cells) {
            const inner = recordOf(cell)?.['content'];
            const before = parts.length;
            if (Array.isArray(inner)) {
              walk(inner);
            }
            cellTexts.push(parts.splice(before).join(''));
          }
          parts.push(cellTexts.join('\t'));
        }
      }
    }
  };
  walk(content);
  return parts.join('');
}

const SheetPropertiesSchema = z.object({
  properties: z.object({ title: z.string(), index: z.number().optional() }).optional(),
});

export const SpreadsheetSchema = z.object({
  spreadsheetId: z.string(),
  properties: z.object({ title: z.string().optional() }).optional(),
  sheets: z.array(SheetPropertiesSchema).optional(),
});
export type Spreadsheet = z.infer<typeof SpreadsheetSchema>;

/** The tab names of a spreadsheet, in tab order. */
export function sheetTitlesOf(spreadsheet: Spreadsheet): string[] {
  return (spreadsheet.sheets ?? [])
    .map(sheet => sheet.properties?.title)
    .filter((title): title is string => title !== undefined);
}

export const SheetValuesSchema = z.object({
  range: z.string().optional(),
  majorDimension: z.string().optional(),
  values: z.array(z.array(z.string())).optional(),
});
export type SheetValues = z.infer<typeof SheetValuesSchema>;

export const AppendValuesResponseSchema = z.object({
  spreadsheetId: z.string().optional(),
  updates: z
    .object({
      updatedRange: z.string().optional(),
      updatedRows: z.number().optional(),
      updatedCells: z.number().optional(),
    })
    .optional(),
});
