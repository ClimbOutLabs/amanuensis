import { DOC_MIME_TYPE, SHEET_MIME_TYPE } from '../../../src/core/drive/driveWire';
import { build, json, route, text, type Route } from './harness';

const DOC_FILE = {
  id: 'doc1',
  name: 'Trip notes',
  mimeType: DOC_MIME_TYPE,
  modifiedTime: '2026-11-01T10:00:00.000Z',
  webViewLink: 'https://docs.google.com/document/d/doc1',
};

const SHEET_FILE = {
  id: 'sheet1',
  name: 'Expenses',
  mimeType: SHEET_MIME_TYPE,
  modifiedTime: '2026-11-02T10:00:00.000Z',
};

const listRoute: Route = route('/drive/v3/files', { files: [DOC_FILE, SHEET_FILE] });

const fileRoute: Route = url => {
  if (url.pathname === '/drive/v3/files/doc1') {
    return json(DOC_FILE);
  }
  if (url.pathname === '/drive/v3/files/sheet1') {
    return json(SHEET_FILE);
  }
  if (url.pathname === '/drive/v3/files/photo1') {
    return json({ id: 'photo1', name: 'Beach', mimeType: 'image/jpeg' });
  }
  return undefined;
};

/** A Doc whose body is two paragraphs and a two-cell table row. */
const docRoute: Route = route('/v1/documents/doc1', {
  documentId: 'doc1',
  title: 'Trip notes',
  body: {
    content: [
      { paragraph: { elements: [{ textRun: { content: 'Fly out Friday.\n' } }] } },
      { paragraph: { elements: [{ textRun: { content: 'Pack light.' } }] } },
      {
        table: {
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Hotel' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Alfama Suites' } }] } }] },
              ],
            },
          ],
        },
      },
    ],
  },
});

const spreadsheetRoute: Route = route('/v4/spreadsheets/sheet1', {
  spreadsheetId: 'sheet1',
  properties: { title: 'Expenses' },
  sheets: [{ properties: { title: 'Costs', index: 0 } }, { properties: { title: 'Trips', index: 1 } }],
});

const valuesRoute: Route = url => {
  const path = decodeURIComponent(url.pathname);
  if (path === "/v4/spreadsheets/sheet1/values/'Costs'") {
    return json({
      range: "'Costs'",
      values: [
        ['Item', 'Cost'],
        ['Coffee', '4'],
      ],
    });
  }
  if (path === "/v4/spreadsheets/sheet1/values/'Trips'") {
    return json({ range: "'Trips'", values: [['City'], ['Lisbon']] });
  }
  return undefined;
};

describe('tools offered', () => {
  it('offers all four tools when Drive is granted', async () => {
    const { tools } = await build({ routes: [] });
    const names = (await tools.listTools()).result.tools.map(tool => tool.name);
    expect(names).toEqual(['list_files', 'read_drive_file', 'create_doc', 'append_rows']);
  });

  it('offers nothing without the Drive grant', async () => {
    const { tools } = await build({ routes: [], features: ['gmail_read'] });
    expect((await tools.listTools()).result.tools).toEqual([]);
  });
});

describe('list_files', () => {
  it('lists the files with their kinds and says what Aman cannot see', async () => {
    const { tools } = await build({ routes: [listRoute] });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_files', arguments: {} })));
    expect(result.account).toBe('ada@example.com');
    expect(result.note).toContain('Aman sees only files it created');
    expect(result.files).toEqual([
      {
        file_id: 'doc1',
        name: 'Trip notes',
        kind: 'Google Doc',
        last_changed: '2026-11-01T10:00:00.000Z',
        link: 'https://docs.google.com/document/d/doc1',
      },
      { file_id: 'sheet1', name: 'Expenses', kind: 'Google Sheet', last_changed: '2026-11-02T10:00:00.000Z' },
    ]);
  });

  it('passes a name search to Drive as a contains query', async () => {
    const { tools, google } = await build({ routes: [listRoute] });
    await tools.callTool({ name: 'list_files', arguments: { query: 'expense' } });
    const listCall = google.urls.find(url => url.includes('/drive/v3/files'));
    expect(listCall).toBeDefined();
    const query = new URLSearchParams((listCall ?? '').split('?')[1] ?? '');
    expect(query.get('q')).toBe("trashed = false and name contains 'expense'");
  });

  it('classifies as a silent sensitive read', async () => {
    const { tools } = await build({ routes: [listRoute] });
    const info = await tools.toolCallInfo({ name: 'list_files', arguments: {} });
    expect(info).toMatchObject({ tier: 1, tier_reason: 'google_drive_read' });
  });
});

describe('read_drive_file', () => {
  it('reads a Doc as text, tables included, marked untrusted', async () => {
    const { tools } = await build({ routes: [fileRoute, docRoute] });
    const result = JSON.parse(text(await tools.callTool({ name: 'read_drive_file', arguments: { file_id: 'doc1' } })));
    expect(result.kind).toBe('Google Doc');
    expect(result.text).toBe('Fly out Friday.\nPack light.Hotel\tAlfama Suites');
    expect(result.untrusted_content).toContain('untrusted data');
  });

  it('reads the first tab of a Sheet when none is named, and names every tab', async () => {
    const { tools } = await build({ routes: [fileRoute, spreadsheetRoute, valuesRoute] });
    const result = JSON.parse(
      text(await tools.callTool({ name: 'read_drive_file', arguments: { file_id: 'sheet1' } })),
    );
    expect(result.sheet).toBe('Costs');
    expect(result.sheets).toEqual(['Costs', 'Trips']);
    expect(result.rows).toEqual([
      ['Item', 'Cost'],
      ['Coffee', '4'],
    ]);
  });

  it('reads a named tab', async () => {
    const { tools } = await build({ routes: [fileRoute, spreadsheetRoute, valuesRoute] });
    const result = JSON.parse(
      text(await tools.callTool({ name: 'read_drive_file', arguments: { file_id: 'sheet1', sheet: 'Trips' } })),
    );
    expect(result.rows).toEqual([['City'], ['Lisbon']]);
  });

  it('names the real tabs when the named one does not exist', async () => {
    const { tools } = await build({ routes: [fileRoute, spreadsheetRoute, valuesRoute] });
    const answer = JSON.parse(
      text(await tools.callTool({ name: 'read_drive_file', arguments: { file_id: 'sheet1', sheet: 'Nope' } })),
    );
    expect(answer.error).toContain('That Sheet has no tab named "Nope". Its tabs are: Costs, Trips.');
  });

  it('refuses a tab name on a Doc in plain words', async () => {
    const { tools } = await build({ routes: [fileRoute, docRoute] });
    const answer = text(
      await tools.callTool({ name: 'read_drive_file', arguments: { file_id: 'doc1', sheet: 'Costs' } }),
    );
    expect(answer).toContain('That file is a Google Doc, so it has no tabs.');
  });

  it('says plainly that other file kinds cannot be read here', async () => {
    const { tools } = await build({ routes: [fileRoute] });
    const answer = text(await tools.callTool({ name: 'read_drive_file', arguments: { file_id: 'photo1' } }));
    expect(answer).toContain('Aman can read Google Docs and Sheets.');
  });
});
