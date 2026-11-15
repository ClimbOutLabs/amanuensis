import {
  DocsDocumentSchema,
  docTextOf,
  driveKindLabel,
  sheetTitlesOf,
  SpreadsheetSchema,
} from '../../../src/core/drive/driveWire';

describe('docTextOf', () => {
  it('joins paragraphs in order and a table row by tabs', () => {
    const document = DocsDocumentSchema.parse({
      documentId: 'd1',
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: 'One\n' } }, { textRun: { content: 'Two' } }] } },
          { sectionBreak: {} },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    { content: [{ paragraph: { elements: [{ textRun: { content: 'A' } }] } }] },
                    { content: [{ paragraph: { elements: [{ textRun: { content: 'B' } }] } }] },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    expect(docTextOf(document)).toBe('One\nTwoA\tB');
  });

  it('reads an empty document as empty text', () => {
    expect(docTextOf(DocsDocumentSchema.parse({ documentId: 'd1' }))).toBe('');
  });
});

describe('sheetTitlesOf', () => {
  it('returns tab names in order, skipping a sheet with none recorded', () => {
    const spreadsheet = SpreadsheetSchema.parse({
      spreadsheetId: 's1',
      sheets: [{ properties: { title: 'Costs', index: 0 } }, {}, { properties: { title: 'Trips', index: 2 } }],
    });
    expect(sheetTitlesOf(spreadsheet)).toEqual(['Costs', 'Trips']);
  });
});

describe('driveKindLabel', () => {
  it('names the kinds a person uses', () => {
    expect(driveKindLabel('application/vnd.google-apps.document')).toBe('Google Doc');
    expect(driveKindLabel('application/vnd.google-apps.spreadsheet')).toBe('Google Sheet');
    expect(driveKindLabel('application/vnd.google-apps.folder')).toBe('folder');
    expect(driveKindLabel('image/jpeg')).toBe('file');
  });
});
