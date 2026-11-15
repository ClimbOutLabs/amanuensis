/** Google Drive, Docs and Sheets REST APIs, called directly with the user's own login. No adapter process, no container. */
import { z } from 'zod';
import type { GoogleAccessTokens } from '../google/GoogleAccessTokens';
import { GoogleRestClient, type GoogleRestProduct } from '../google/restClient';
import {
  AppendValuesResponseSchema,
  DocsDocumentSchema,
  DriveFileListSchema,
  DriveFileSchema,
  SheetValuesSchema,
  SpreadsheetSchema,
  type DocsDocument,
  type DriveFile,
  type SheetValues,
  type Spreadsheet,
} from './driveWire';

const SCOPE_MESSAGE =
  "Google hasn't given Aman permission to use your Drive files. Open Settings, Connectors, Google and connect Google Drive.";

const DRIVE: GoogleRestProduct = {
  name: 'Google Drive',
  baseUrl: 'https://www.googleapis.com/drive/v3',
  apiOffMessage:
    "The Google Drive API isn't turned on in your Google project. Open Settings, Connectors, Google, open the Drive API link in the Google Drive section, select Enable, then try again.",
  scopeMessage: SCOPE_MESSAGE,
  notFoundMessage:
    'Google Drive has no such file that Aman can see. Aman sees only files it created or that you opened with it.',
  tooLargeMessage: 'Google Drive sent back more than Aman will read at once. Ask for fewer results.',
};

const DOCS: GoogleRestProduct = {
  name: 'Google Docs',
  baseUrl: 'https://docs.googleapis.com/v1',
  apiOffMessage:
    "The Google Docs API isn't turned on in your Google project. Open Settings, Connectors, Google, open the Docs API link in the Google Drive section, select Enable, then try again.",
  scopeMessage: SCOPE_MESSAGE,
  notFoundMessage: 'Google Docs has no such document.',
  tooLargeMessage: 'That document is longer than Aman will read at once.',
};

const SHEETS: GoogleRestProduct = {
  name: 'Google Sheets',
  baseUrl: 'https://sheets.googleapis.com/v4',
  apiOffMessage:
    "The Google Sheets API isn't turned on in your Google project. Open Settings, Connectors, Google, open the Sheets API link in the Google Drive section, select Enable, then try again.",
  scopeMessage: SCOPE_MESSAGE,
  notFoundMessage: 'Google Sheets has no such spreadsheet.',
  tooLargeMessage: 'That sheet is larger than Aman will read at once. Read one tab at a time.',
};

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,shared,permissions(id,type,role)';

/** One word of a name search, safe inside the quoted query string Drive takes. */
function quotedWord(word: string): string {
  return `'${word.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A tab name as a Sheets range: quoted, so a name with spaces or an apostrophe still reads as one tab. */
export function sheetRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

interface FilePage {
  files: DriveFile[];
  nextPageToken: string | undefined;
}

export interface AppendOutcome {
  updatedRange: string | undefined;
  updatedRows: number | undefined;
}

/** The public calls a Drive source must answer. The live client and the eval fixtures both satisfy it. */
export type DriveApiPort = Pick<DriveApi, keyof DriveApi>;

export class DriveApi {
  readonly #drive: GoogleRestClient;
  readonly #docs: GoogleRestClient;
  readonly #sheets: GoogleRestClient;

  constructor(input: {
    tokens: GoogleAccessTokens;
    fetchImpl: typeof fetch | undefined;
    /** Replaceable so tests do not wait. */
    sleep: ((ms: number) => Promise<void>) | undefined;
  }) {
    const shared = { tokens: input.tokens, fetchImpl: input.fetchImpl, sleep: input.sleep };
    this.#drive = new GoogleRestClient({ product: DRIVE, ...shared });
    this.#docs = new GoogleRestClient({ product: DOCS, ...shared });
    this.#sheets = new GoogleRestClient({ product: SHEETS, ...shared });
  }

  /**
   * The files Aman may see: the ones it created or the person opened with it, most recently changed first.
   * A search word matches file names, as Drive's own search by name does.
   */
  async listFiles(input: {
    query: string | undefined;
    maxResults: number;
    pageToken: string | undefined;
  }): Promise<FilePage> {
    const clauses = ['trashed = false'];
    const word = input.query?.trim();
    if (word !== undefined && word !== '') {
      clauses.push(`name contains ${quotedWord(word)}`);
    }
    const list = await this.#drive.parsed(DriveFileListSchema, {
      body: undefined,
      method: 'GET',
      path: '/files',
      query: {
        q: clauses.join(' and '),
        orderBy: 'modifiedTime desc',
        pageSize: input.maxResults,
        pageToken: input.pageToken,
        fields: `files(${FILE_FIELDS}),nextPageToken`,
      },
    });
    return { files: list.files ?? [], nextPageToken: list.nextPageToken };
  }

  async getFile(fileId: string): Promise<DriveFile> {
    return await this.#drive.parsed(DriveFileSchema, {
      body: undefined,
      method: 'GET',
      path: `/files/${encodeURIComponent(fileId)}`,
      query: { fields: FILE_FIELDS },
    });
  }

  /** Creates an empty Google Doc with this title; the text goes in with insertText, as a second call. */
  async createDocument(input: { title: string }): Promise<DriveFile> {
    return await this.#drive.parsed(DriveFileSchema, {
      query: { fields: FILE_FIELDS },
      method: 'POST',
      path: '/files',
      body: { name: input.title, mimeType: 'application/vnd.google-apps.document' },
      unknownOutcome: 'The Doc may have been created. Check Google Drive before trying again.',
    });
  }

  /** Puts text at the start of a Doc. An empty Doc's first character sits at index 1. */
  async insertText(input: { documentId: string; text: string }): Promise<void> {
    await this.#docs.parsed(z.object({ documentId: z.string().optional() }), {
      query: undefined,
      method: 'POST',
      path: `/documents/${encodeURIComponent(input.documentId)}:batchUpdate`,
      body: { requests: [{ insertText: { location: { index: 1 }, text: input.text } }] },
      unknownOutcome: 'The text may have been added to the Doc. Open it in Google Drive before trying again.',
    });
  }

  async getDocument(documentId: string): Promise<DocsDocument> {
    return await this.#docs.parsed(DocsDocumentSchema, {
      body: undefined,
      method: 'GET',
      path: `/documents/${encodeURIComponent(documentId)}`,
      query: undefined,
    });
  }

  async getSpreadsheet(spreadsheetId: string): Promise<Spreadsheet> {
    return await this.#sheets.parsed(SpreadsheetSchema, {
      body: undefined,
      method: 'GET',
      path: `/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
      query: { fields: 'spreadsheetId,properties.title,sheets.properties' },
    });
  }

  async getSheetValues(input: { spreadsheetId: string; range: string }): Promise<SheetValues> {
    return await this.#sheets.parsed(SheetValuesSchema, {
      body: undefined,
      method: 'GET',
      path: `/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}`,
      query: undefined,
    });
  }

  /** Adds rows after the tab's existing rows, letting Google read values like a person typed them. */
  async appendRows(input: { spreadsheetId: string; range: string; rows: string[][] }): Promise<AppendOutcome> {
    const outcome = await this.#sheets.parsed(AppendValuesResponseSchema, {
      method: 'POST',
      path: `/spreadsheets/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.range)}:append`,
      query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
      body: { range: input.range, majorDimension: 'ROWS', values: input.rows },
      unknownOutcome: 'The rows may have been added. Check the Sheet before trying again.',
    });
    return { updatedRange: outcome.updates?.updatedRange, updatedRows: outcome.updates?.updatedRows };
  }
}
