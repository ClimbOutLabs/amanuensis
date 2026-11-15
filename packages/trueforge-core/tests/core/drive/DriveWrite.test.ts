import { DOC_MIME_TYPE, SHEET_MIME_TYPE } from '../../../src/core/drive/driveWire';
import { approvalProblem, approvedContext, build, json, route, text, type Route } from './harness';

const CREATE = { title: 'Trip plan', text: 'Fly out Friday.\nPack light.' };
const ROWS = {
  file_id: 'sheet1',
  rows: [
    ['Coffee', '4'],
    ['Taxi', '12'],
  ],
};

const createFileRoute: Route = (url, init) =>
  init?.method === 'POST' && url.pathname === '/drive/v3/files'
    ? json({ id: 'doc-new', name: 'Trip plan', mimeType: DOC_MIME_TYPE })
    : undefined;

const insertRoute: Route = (url, init) =>
  init?.method === 'POST' && url.pathname === '/v1/documents/doc-new:batchUpdate'
    ? json({ documentId: 'doc-new' })
    : undefined;

const sheetFileRoute: Route = url => {
  if (url.pathname === '/drive/v3/files/sheet1') {
    return json({ id: 'sheet1', name: 'Expenses', mimeType: SHEET_MIME_TYPE });
  }
  if (url.pathname === '/drive/v3/files/doc1') {
    return json({ id: 'doc1', name: 'Trip notes', mimeType: DOC_MIME_TYPE });
  }
  return undefined;
};

const sharedSheetFileRoute: Route = url => {
  if (url.pathname === '/drive/v3/files/sheet1') {
    return json({
      id: 'sheet1',
      name: 'Expenses',
      mimeType: SHEET_MIME_TYPE,
      shared: true,
      permissions: [
        { id: 'p-owner', type: 'user', role: 'owner' },
        { id: 'p-1', type: 'user', role: 'writer' },
        { id: 'p-2', type: 'user', role: 'reader' },
        { id: 'p-3', type: 'group', role: 'reader' },
      ],
    });
  }
  return undefined;
};

function spreadsheetRoute(titles: string[]): Route {
  return route('/v4/spreadsheets/sheet1', {
    spreadsheetId: 'sheet1',
    properties: { title: 'Expenses' },
    sheets: titles.map((title, index) => ({ properties: { title, index } })),
  });
}

const appendRoute: Route = (url, init) => {
  const path = decodeURIComponent(url.pathname);
  return init?.method === 'POST' && path === "/v4/spreadsheets/sheet1/values/'Costs':append"
    ? json({ spreadsheetId: 'sheet1', updates: { updatedRange: "'Costs'!A3:B4", updatedRows: 2, updatedCells: 4 } })
    : undefined;
};

/** Write calls Google received, leaving out the sign-in token refresh every call starts with. */
const posts = (urls: string[]): string[] =>
  urls.filter(url => url.startsWith('POST') && !url.startsWith('POST /token'));

describe('create_doc', () => {
  it('asks first, with the title and the whole text on the card', async () => {
    const { tools, sentinel } = await build({ routes: [] });
    const call = { name: 'create_doc', arguments: CREATE };
    const info = await tools.toolCallInfo(call);
    expect(info).toMatchObject({ tier: 3, tier_reason: 'google_drive_write', is_approval_required: true });
    expect(info.tier3_card?.plain_what).toContain('Create a Google Doc named');
    expect(info.tier3_card?.plain_what).toContain('Trip plan');
    expect(info.tier3_card?.outbound_text).toBe(CREATE.text);
    expect(await approvalProblem({ tools, sentinel, info, call })).toBeUndefined();
  });

  it('creates the Doc and adds its text once approved', async () => {
    const { tools, google } = await build({ routes: [createFileRoute, insertRoute] });
    const info = await tools.toolCallInfo({ name: 'create_doc', arguments: CREATE });
    const response = await tools.callTool(
      { name: 'create_doc', arguments: CREATE },
      { status: 'allow' },
      approvedContext(info),
    );
    const result = JSON.parse(text(response));
    expect(result).toMatchObject({ status: 'created', file_id: 'doc-new', kind: 'Google Doc' });
    expect(google.bodies).toEqual([
      { name: 'Trip plan', mimeType: DOC_MIME_TYPE },
      { requests: [{ insertText: { location: { index: 1 }, text: CREATE.text } }] },
    ]);
  });

  it('creates an empty Doc with no second call when the text is empty', async () => {
    const { tools, google } = await build({ routes: [createFileRoute, insertRoute] });
    const args = { title: 'Blank', text: '' };
    const info = await tools.toolCallInfo({ name: 'create_doc', arguments: args });
    expect(info.tier3_card?.plain_what).toContain('It starts empty.');
    expect(info.tier3_card?.outbound_text).toBeNull();
    const response = await tools.callTool(
      { name: 'create_doc', arguments: args },
      { status: 'allow' },
      approvedContext(info),
    );
    expect(JSON.parse(text(response)).status).toBe('created');
    expect(posts(google.urls)).toHaveLength(1);
  });

  it('creates nothing without an approval', async () => {
    const { tools, google } = await build({ routes: [createFileRoute, insertRoute] });
    const response = await tools.callTool({ name: 'create_doc', arguments: CREATE });
    expect(text(response)).toContain('not approved');
    expect(posts(google.urls)).toEqual([]);
  });

  it('creates nothing when the text changed after approval', async () => {
    const { tools, google } = await build({ routes: [createFileRoute, insertRoute] });
    const info = await tools.toolCallInfo({ name: 'create_doc', arguments: CREATE });
    const response = await tools.callTool(
      { name: 'create_doc', arguments: { ...CREATE, text: 'Different text.' } },
      { status: 'allow' },
      approvedContext(info),
    );
    expect(text(response)).toContain('changed after you approved them');
    expect(posts(google.urls)).toEqual([]);
  });

  it('says the Doc was created when only its text could not be added', async () => {
    const docsOff: Route = (url, init) =>
      init?.method === 'POST' && url.pathname === '/v1/documents/doc-new:batchUpdate'
        ? json(
            {
              error: {
                code: 403,
                message: 'Google Docs API has not been used in project 123456789 before or it is disabled.',
                status: 'PERMISSION_DENIED',
                errors: [{ message: 'disabled', domain: 'usageLimits', reason: 'accessNotConfigured' }],
              },
            },
            403,
          )
        : undefined;
    const { tools } = await build({ routes: [createFileRoute, docsOff] });
    const info = await tools.toolCallInfo({ name: 'create_doc', arguments: CREATE });
    const response = await tools.callTool(
      { name: 'create_doc', arguments: CREATE },
      { status: 'allow' },
      approvedContext(info),
    );
    const error = JSON.parse(text(response)).error;
    expect(error).toContain('The Doc "Trip plan" was created, but its text was not added.');
    expect(error).toContain("The Google Docs API isn't turned on");
  });

  it('runs under a standing grant with no answer to the call', async () => {
    const built = await build({ routes: [createFileRoute, insertRoute] });
    await built.sentinel.services.tool_grants.recordToolGrant({
      tenant_id: built.sentinel.tenant_id,
      created_by: built.sentinel.created_by,
      mcp_server_name: 'google_drive',
      tool_name: 'create_doc',
      connector_binding: null,
    });
    const info = await built.tools.toolCallInfo({ name: 'create_doc', arguments: CREATE });
    expect(info).toMatchObject({ tier: 1, tier_reason: 'mcp_tool_grant' });
    const response = await built.tools.callTool({ name: 'create_doc', arguments: CREATE }, undefined, {
      admission_provenance: { source: 'automatic' },
      approved_params: info.mint_canonical_params,
    });
    expect(JSON.parse(text(response)).status).toBe('created');
  });

  it('never writes in a scheduled run, even with an approval-shaped call', async () => {
    const { tools, google } = await build({ routes: [createFileRoute, insertRoute], unattended: true });
    const info = await tools.toolCallInfo({ name: 'create_doc', arguments: CREATE });
    const response = await tools.callTool({ name: 'create_doc', arguments: CREATE }, undefined, approvedContext(info));
    expect(text(response)).toContain('Scheduled runs never change your Google Drive files.');
    expect(posts(google.urls)).toEqual([]);
  });
});

describe('append_rows', () => {
  it('asks first, naming the file, the tab and every row', async () => {
    const { tools, sentinel } = await build({ routes: [sheetFileRoute, spreadsheetRoute(['Costs', 'Trips'])] });
    const call = { name: 'append_rows', arguments: ROWS };
    const info = await tools.toolCallInfo(call);
    expect(info).toMatchObject({ tier: 3, tier_reason: 'google_drive_write' });
    expect(info.tier3_card?.plain_what).toContain('Add 2 rows to the tab "Costs" of the Google Sheet');
    expect(info.tier3_card?.plain_what).toContain('Expenses');
    expect(info.tier3_card?.outbound_text).toBe('Coffee, 4\nTaxi, 12');
    expect(await approvalProblem({ tools, sentinel, info, call })).toBeUndefined();
  });

  it('says on the card how many people the Sheet is shared with, not counting its owner', async () => {
    const { tools } = await build({ routes: [sharedSheetFileRoute, spreadsheetRoute(['Costs', 'Trips'])] });
    const info = await tools.toolCallInfo({ name: 'append_rows', arguments: ROWS });
    expect(info).toMatchObject({ tier: 3, tier_reason: 'google_drive_write' });
    expect(info.tier3_card?.plain_what).toContain('This file is shared with 3 people.');
  });

  it('adds the rows after the existing ones once approved', async () => {
    const { tools, google } = await build({
      routes: [sheetFileRoute, spreadsheetRoute(['Costs', 'Trips']), appendRoute],
    });
    const info = await tools.toolCallInfo({ name: 'append_rows', arguments: ROWS });
    const response = await tools.callTool(
      { name: 'append_rows', arguments: ROWS },
      { status: 'allow' },
      approvedContext(info),
    );
    const result = JSON.parse(text(response));
    expect(result).toMatchObject({ status: 'appended', sheet: 'Costs', rows_added: 2 });
    const appendCall = google.urls.find(url => url.includes(':append'));
    expect(appendCall).toBeDefined();
    const query = new URLSearchParams((appendCall ?? '').split('?')[1] ?? '');
    expect(query.get('valueInputOption')).toBe('USER_ENTERED');
    expect(query.get('insertDataOption')).toBe('INSERT_ROWS');
    expect(google.bodies).toContainEqual({ range: "'Costs'", majorDimension: 'ROWS', values: ROWS.rows });
  });

  it('adds nothing without an approval', async () => {
    const { tools, google } = await build({
      routes: [sheetFileRoute, spreadsheetRoute(['Costs']), appendRoute],
    });
    const response = await tools.callTool({ name: 'append_rows', arguments: ROWS });
    expect(text(response)).toContain('not approved');
    expect(posts(google.urls)).toEqual([]);
  });

  it('is not offered when the file is not a Sheet', async () => {
    const { tools } = await build({ routes: [sheetFileRoute, spreadsheetRoute(['Costs'])] });
    const info = await tools.toolCallInfo({ name: 'append_rows', arguments: { file_id: 'doc1', rows: [['a']] } });
    expect(info.pre_dispatch_failure?.message).toContain('not a Google Sheet, so rows cannot be added to it.');
    expect(info.tier3_card).toBeFalsy();
  });

  it('is not offered when the named tab does not exist, and names the real tabs', async () => {
    const { tools } = await build({ routes: [sheetFileRoute, spreadsheetRoute(['Costs', 'Trips'])] });
    const info = await tools.toolCallInfo({
      name: 'append_rows',
      arguments: { file_id: 'sheet1', sheet: 'Nope', rows: [['a']] },
    });
    expect(info.pre_dispatch_failure?.message).toContain(
      'That Sheet has no tab named "Nope". Its tabs are: Costs, Trips.',
    );
  });

  it('adds nothing when the Sheet gained a tab arrangement change after approval', async () => {
    let titles = ['Costs'];
    const changing: Route = url =>
      url.pathname === '/v4/spreadsheets/sheet1'
        ? json({
            spreadsheetId: 'sheet1',
            properties: { title: 'Expenses' },
            sheets: titles.map((title, index) => ({ properties: { title, index } })),
          })
        : undefined;
    const { tools, google } = await build({ routes: [sheetFileRoute, changing, appendRoute] });
    const info = await tools.toolCallInfo({ name: 'append_rows', arguments: ROWS });
    titles = ['Costs v2'];
    const response = await tools.callTool(
      { name: 'append_rows', arguments: ROWS },
      { status: 'allow' },
      approvedContext(info),
    );
    expect(text(response)).toContain('The Sheet changed after you approved this, so nothing was added.');
    expect(posts(google.urls)).toEqual([]);
  });
});
