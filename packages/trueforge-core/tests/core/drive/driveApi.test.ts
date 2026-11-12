import { DriveApi } from '../../../src/core/drive/driveApi';
import { GoogleAccessTokens } from '../../../src/core/google/GoogleAccessTokens';
import { connectedRecord, FakeConnections, OWNER } from '../google/fakes';
import { API_OFF_BODY, INSUFFICIENT_SCOPE_BODY, json, scriptedGoogle, type Route } from './harness';

async function buildApi(routes: Route[]) {
  const connections = new FakeConnections();
  await connections.save(
    connectedRecord({
      granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/drive.file'],
    }),
  );
  const google = scriptedGoogle(routes);
  const api = new DriveApi({
    tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl: google.fetchImpl }),
    fetchImpl: google.fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return { api, google };
}

describe('listFiles', () => {
  it('escapes a search word with an apostrophe inside the Drive query', async () => {
    const { api, google } = await buildApi([() => json({ files: [] })]);
    await api.listFiles({ query: "o'brien", maxResults: 25, pageToken: undefined });
    const call = google.urls.find(url => url.includes('/drive/v3/files'));
    const query = new URLSearchParams((call ?? '').split('?')[1] ?? '');
    expect(query.get('q')).toBe("trashed = false and name contains 'o\\'brien'");
    expect(query.get('orderBy')).toBe('modifiedTime desc');
    expect(query.get('pageSize')).toBe('25');
  });

  it('lists without a name clause when no search words are given', async () => {
    const { api, google } = await buildApi([() => json({ files: [] })]);
    await api.listFiles({ query: undefined, maxResults: 10, pageToken: undefined });
    const call = google.urls.find(url => url.includes('/drive/v3/files'));
    const query = new URLSearchParams((call ?? '').split('?')[1] ?? '');
    expect(query.get('q')).toBe('trashed = false');
  });
});

describe('create and insert', () => {
  it('creates an empty Doc through Drive, then inserts its text through Docs', async () => {
    const { api, google } = await buildApi([
      (url, init) =>
        init?.method === 'POST' && url.pathname === '/drive/v3/files'
          ? json({ id: 'doc9', name: 'Notes', mimeType: 'application/vnd.google-apps.document' })
          : undefined,
      (url, init) =>
        init?.method === 'POST' && url.pathname === '/v1/documents/doc9:batchUpdate'
          ? json({ documentId: 'doc9' })
          : undefined,
    ]);
    const created = await api.createDocument({ title: 'Notes' });
    expect(created.id).toBe('doc9');
    await api.insertText({ documentId: 'doc9', text: 'Hello.' });
    expect(google.bodies).toEqual([
      { name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
      { requests: [{ insertText: { location: { index: 1 }, text: 'Hello.' } }] },
    ]);
  });
});

describe('appendRows', () => {
  it('appends with values read as typed, in a new row', async () => {
    const { api, google } = await buildApi([
      (url, init) =>
        init?.method === 'POST' && decodeURIComponent(url.pathname) === "/v4/spreadsheets/s1/values/'Costs':append"
          ? json({ spreadsheetId: 's1', updates: { updatedRange: "'Costs'!A2:B2", updatedRows: 1 } })
          : undefined,
    ]);
    const outcome = await api.appendRows({ spreadsheetId: 's1', range: "'Costs'", rows: [['Coffee', '4']] });
    expect(outcome).toEqual({ updatedRange: "'Costs'!A2:B2", updatedRows: 1 });
    const call = google.urls.find(url => url.includes(':append'));
    const query = new URLSearchParams((call ?? '').split('?')[1] ?? '');
    expect(query.get('valueInputOption')).toBe('USER_ENTERED');
    expect(query.get('insertDataOption')).toBe('INSERT_ROWS');
    expect(google.bodies).toEqual([{ range: "'Costs'", majorDimension: 'ROWS', values: [['Coffee', '4']] }]);
  });
});

describe('error words', () => {
  it('points at the Drive API link when the Drive API is off', async () => {
    const { api } = await buildApi([() => json(API_OFF_BODY, 403)]);
    await expect(api.listFiles({ query: undefined, maxResults: 5, pageToken: undefined })).rejects.toThrow(
      "The Google Drive API isn't turned on",
    );
  });

  it('points at the Sheets API link when the Sheets API is off', async () => {
    const { api } = await buildApi([() => json(API_OFF_BODY, 403)]);
    await expect(api.getSpreadsheet('s1')).rejects.toThrow("The Google Sheets API isn't turned on");
  });

  it('says to connect Google Drive when the scope is missing', async () => {
    const { api } = await buildApi([() => json(INSUFFICIENT_SCOPE_BODY, 403)]);
    await expect(api.listFiles({ query: undefined, maxResults: 5, pageToken: undefined })).rejects.toThrow(
      'connect Google Drive',
    );
  });

  it('says a missing file is one Aman cannot see', async () => {
    const { api } = await buildApi([() => json({ error: { code: 404, message: 'File not found.' } }, 404)]);
    await expect(api.getFile('nope')).rejects.toThrow('Aman sees only files it created or that you opened with it.');
  });
});
