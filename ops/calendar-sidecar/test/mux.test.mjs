// The multiplexer in front of the per-account tool servers: routing by the account an id names,
// fan-out reads that say which account each answer belongs to, and refusals that change nothing.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createMux } from '../mux.mjs';

const ALICE = 'alice@example.invalid';
const BOB = 'bob@example.invalid';

function gateway({ email, calendars, events }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(message);
    let reply;
    if (message.method === 'tools/list') {
      reply = {
        result: {
          tools: [
            {
              name: 'list_calendars',
              description: 'List calendars.',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: 'create_event',
              description: 'Create an event.',
              inputSchema: {
                type: 'object',
                properties: { calendar_id: { type: 'string' } },
                required: ['calendar_id'],
              },
            },
          ],
        },
      };
    } else if (message.method === 'tools/call' && message.params.name === 'list_calendars') {
      reply = {
        result: {
          content: [{ type: 'text', text: JSON.stringify({ calendars, count: calendars.length }) }],
          structuredContent: { calendars, count: calendars.length, withheld: 0 },
        },
      };
    } else if (message.method === 'tools/call' && message.params.name === 'list_events') {
      reply = {
        result: {
          content: [{ type: 'text', text: JSON.stringify({ events, count: events.length }) }],
          structuredContent: { events, count: events.length, window: { from: 'a', to: 'b' } },
        },
      };
    } else if (message.method === 'tools/call') {
      reply = {
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, args: message.params.arguments }) }],
          structuredContent: { ok: true, args: message.params.arguments },
        },
      };
    } else {
      reply = { result: { serverInfo: { name: 'caldav-mcp' } } };
    }
    const data = JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
  });
  return { server, calls, email };
}

describe('the calendar multiplexer', () => {
  let alice;
  let bob;
  let mux;
  let muxUrl;

  async function rpc(method, params = {}) {
    const response = await fetch(muxUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    });
    return JSON.parse(await response.text());
  }

  before(async () => {
    alice = gateway({
      email: ALICE,
      calendars: [{ id: '/dav/alice/personal/', name: 'Personal' }],
      events: [{ id: 'evt-a1', calendar: '/dav/alice/personal/', summary: 'A one' }],
    });
    bob = gateway({
      email: BOB,
      calendars: [{ id: '/dav/bob/work/', name: 'Work' }],
      events: [{ id: 'evt-b1', calendar: '/dav/bob/work/', summary: 'B one' }],
    });
    await new Promise(done => alice.server.listen(0, '127.0.0.1', done));
    await new Promise(done => bob.server.listen(0, '127.0.0.1', done));
    const targets = () => [
      { email: ALICE, url: `http://127.0.0.1:${alice.server.address().port}/mcp` },
      { email: BOB, url: `http://127.0.0.1:${bob.server.address().port}/mcp` },
    ];
    mux = createMux({ targets });
    await new Promise(done => mux.listen(0, '127.0.0.1', done));
    muxUrl = `http://127.0.0.1:${mux.address().port}/mcp`;
  });

  after(() => {
    mux?.close();
    alice?.server.close();
    bob?.server.close();
  });

  it('offers the tools with an account argument added', async () => {
    const reply = await rpc('tools/list');
    const create = reply.result.tools.find(tool => tool.name === 'create_event');
    assert.equal(create.inputSchema.properties.account.type, 'string');
    assert.deepEqual(create.inputSchema.required, ['calendar_id']);
  });

  it('lists calendars from every account, each id naming its account', async () => {
    const reply = await rpc('tools/call', { name: 'list_calendars', arguments: {} });
    const calendars = reply.result.structuredContent.calendars;
    assert.deepEqual(
      calendars.map(calendar => calendar.id),
      [`${ALICE}|/dav/alice/personal/`, `${BOB}|/dav/bob/work/`],
    );
    assert.deepEqual(
      calendars.map(calendar => calendar.account),
      [ALICE, BOB],
    );
    assert.equal(reply.result.structuredContent.count, 2);
    assert.ok(reply.result.content[0].text.includes(`${BOB}|/dav/bob/work/`));
  });

  it('fans an event read out and tags each event with its account', async () => {
    const reply = await rpc('tools/call', { name: 'list_events', arguments: {} });
    const events = reply.result.structuredContent.events;
    assert.deepEqual(
      events.map(event => event.id),
      [`${ALICE}|evt-a1`, `${BOB}|evt-b1`],
    );
    assert.deepEqual(
      events.map(event => event.calendar),
      [`${ALICE}|/dav/alice/personal/`, `${BOB}|/dav/bob/work/`],
    );
  });

  it('routes a create to the account its calendar names, with the prefix stripped', async () => {
    const before = bob.calls.length;
    const reply = await rpc('tools/call', {
      name: 'create_event',
      arguments: { calendar_id: `${BOB}|/dav/bob/work/`, summary: 'New' },
    });
    assert.equal(reply.result.structuredContent.ok, true);
    assert.equal(bob.calls.length, before + 1);
    const sent = bob.calls[bob.calls.length - 1];
    assert.equal(sent.params.arguments.calendar_id, '/dav/bob/work/');
    assert.equal(sent.params.arguments.account, undefined);
  });

  it('refuses a create that names no account calendar', async () => {
    const reply = await rpc('tools/call', {
      name: 'create_event',
      arguments: { calendar_id: '/dav/bob/work/', summary: 'New' },
    });
    assert.equal(reply.result.isError, true);
    assert.ok(reply.result.content[0].text.includes('nothing was changed'));
  });

  it('refuses a call naming two accounts at once', async () => {
    const reply = await rpc('tools/call', {
      name: 'update_event',
      arguments: { id: `${ALICE}|evt-a1`, account: BOB },
    });
    assert.equal(reply.result.isError, true);
    assert.ok(reply.result.content[0].text.includes('two different accounts'));
  });

  it('scopes a spanning read to the accounts the host limits it to, and forwards no trace of the limit', async () => {
    const reply = await rpc('tools/call', {
      name: 'list_events',
      arguments: { limit_accounts: [BOB] },
    });
    const events = reply.result.structuredContent.events;
    assert.deepEqual(
      events.map(event => event.id),
      [`${BOB}|evt-b1`],
    );
    const sent = bob.calls[bob.calls.length - 1];
    assert.equal(sent.params.arguments.limit_accounts, undefined);
  });

  it('refuses an account that is not connected and names the real ones', async () => {
    const reply = await rpc('tools/call', {
      name: 'list_events',
      arguments: { account: 'ghost@example.invalid' },
    });
    assert.equal(reply.result.isError, true);
    assert.ok(reply.result.content[0].text.includes(ALICE));
  });
});

function failingGateway() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const reply = {
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'The calendar server could not be reached.' }], isError: true },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  return { server };
}

describe('the calendar multiplexer when an account does not answer', () => {
  const CAROL = 'carol@example.invalid';
  const DAVE = 'dave@example.invalid';
  let alice;
  let carol;
  let dave;
  let partialMux;
  let failingMux;
  let partialUrl;
  let failingUrl;

  async function call(url, name) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } }),
    });
    return JSON.parse(await response.text());
  }

  before(async () => {
    alice = gateway({
      email: ALICE,
      calendars: [{ id: '/dav/alice/personal/', name: 'Personal' }],
      events: [{ id: 'evt-a1', calendar: '/dav/alice/personal/', summary: 'A one' }],
    });
    carol = failingGateway();
    dave = failingGateway();
    await new Promise(done => alice.server.listen(0, '127.0.0.1', done));
    await new Promise(done => carol.server.listen(0, '127.0.0.1', done));
    await new Promise(done => dave.server.listen(0, '127.0.0.1', done));
    partialMux = createMux({
      targets: () => [
        { email: ALICE, url: `http://127.0.0.1:${alice.server.address().port}/mcp` },
        { email: CAROL, url: `http://127.0.0.1:${carol.server.address().port}/mcp` },
      ],
    });
    failingMux = createMux({
      targets: () => [
        { email: CAROL, url: `http://127.0.0.1:${carol.server.address().port}/mcp` },
        { email: DAVE, url: `http://127.0.0.1:${dave.server.address().port}/mcp` },
      ],
    });
    await new Promise(done => partialMux.listen(0, '127.0.0.1', done));
    await new Promise(done => failingMux.listen(0, '127.0.0.1', done));
    partialUrl = `http://127.0.0.1:${partialMux.address().port}/mcp`;
    failingUrl = `http://127.0.0.1:${failingMux.address().port}/mcp`;
  });

  after(() => {
    partialMux?.close();
    failingMux?.close();
    alice?.server.close();
    carol?.server.close();
    dave?.server.close();
  });

  it('answers with what it has and notes that one account did not answer', async () => {
    const reply = await call(partialUrl, 'list_events');
    assert.notEqual(reply.result.isError, true);
    assert.deepEqual(
      reply.result.structuredContent.events.map(event => event.id),
      [`${ALICE}|evt-a1`],
    );
    const notes = reply.result.structuredContent.notes ?? [];
    assert.ok(
      notes.some(note => note.includes('did not answer')),
      `expected a note about the account that did not answer, got: ${JSON.stringify(notes)}`,
    );
  });

  it('keeps the error when every account fails to answer', async () => {
    const reply = await call(failingUrl, 'list_events');
    assert.equal(reply.result.isError, true);
  });
});
