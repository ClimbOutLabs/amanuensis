/**
 * What the private-detail check lets through and what it still holds, through SessionHandle and the session store.
 * Words the person typed in this turn's message and the town their profile names are theirs to search for. Contact
 * details and names copied from mail or memory still ask. Invented details only.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { holdSay } from '../../src/core/permissions/searchHoldText';
import {
  markPrivateDataRead,
  recordPrivateContextText,
  recordPrivateReadText,
} from '../../src/core/permissions/webSearch';
import { DEFAULT_ASSISTANT_NAME } from '../../src/core/personas/assistantName';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

const HOLD_SAY = holdSay(DEFAULT_ASSISTANT_NAME);
const HELD = { status: 'done', required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }] };

/** A profile that names the person's town, as the profile the host puts before the model renders it. */
const PROFILE =
  '<user-name>Wren Oakhollow</user-name>\n\n' +
  '<user-profile>I live in Fernhollow Bay, Calderra. Works as a ceramicist. Home is 9 Larkspur Street, Fernhollow Bay.' +
  ' Home pin 41.158312, -8.629105.</user-profile>\n\n' +
  '<learned-profile>\n- City: Fernhollow Bay\n</learned-profile>';
const MEMORY =
  '<aman-memory>\n- [2026-09-02] Your accountant Odile Fenwright, odile.fenwright@ledger.example, ' +
  '+44 20 7946 0321, works at 14 Quarry Lane.\n</aman-memory>';
const WEATHER_QUERY = 'Current weather conditions and forecast in Fernhollow Bay, Calderra right now';
const FORECAST_PAGE = 'https://forecast.example/MapClick.php?lat=41.1583&amp;lon=-8.6291';

describe('a search for the town the profile names', () => {
  it('runs the weather search without asking', async () => {
    const { run, resolverForTurn, create, callTool, audit } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query: WEATHER_QUERY });
    });
    create.mockImplementation(() => textStream('Sunny.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'What is the weather in FB' }], resolver });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(audit).toContainEqual(expect.objectContaining({ tier: 1, description: `Searched: ${WEATHER_QUERY}` }));
  });

  it('then opens the forecast page the search returned, whose link carries the town centre', async () => {
    const { run, resolverForTurn, create, callTool } = await setupSearchChat();
    callTool.mockImplementation(() =>
      Promise.resolve(toolResultResponse({ text: JSON.stringify({ results: [{ url: FORECAST_PAGE }] }) })),
    );
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query: WEATHER_QUERY });
    });
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', args: { url: FORECAST_PAGE } }));
    create.mockImplementation(() => textStream('Sunny.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'What is the weather in FB' }], resolver });

    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the home street address', '9 Larkspur Street Fernhollow Bay'],
    ['the precise home pin', 'what is at 41.158312, -8.629105'],
    ['the person’s own name', 'Wren Oakhollow ceramics'],
  ])('still holds a search carrying %s from the profile', async (_label, query) => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look this up' }], resolver });

    const state = (await session.getTurn(turn.id))?.state;
    expect(state).toMatchObject(HELD);
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_detail);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('contact details recalled from memory', () => {
  it.each([
    ['an email address', 'odile.fenwright@ledger.example'],
    ['a phone number', 'who calls from +44 20 7946 0321'],
    ['a street address', '14 Quarry Lane opening hours'],
    ['a person’s name', 'Odile Fenwright accountant reviews'],
  ])('holds a search carrying %s, even with the profile’s town in it', async (_label, query) => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      recordPrivateContextText({ state: resolver.webSearchTurn, text: MEMORY, source: 'memory' });
      return yield* searchStream({ id: 'call-1', query: `${query} Fernhollow Bay` });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Check on them' }], resolver });

    const state = (await session.getTurn(turn.id))?.state;
    expect(state).toMatchObject(HELD);
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_detail);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs a search for a name the person typed in this message', async () => {
    const { run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: MEMORY, source: 'memory' });
      return yield* searchStream({ id: 'call-1', query: 'odile fenwright accountant reviews' });
    });
    create.mockImplementation(() => textStream('Done.'));

    await run({
      messages: [{ type: EventType.USER_MESSAGE, content: 'Is Odile Fenwright a good accountant?' }],
      resolver,
    });

    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('still holds an email address the person did not type, next to a name they did', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: MEMORY, source: 'memory' });
      return yield* searchStream({ id: 'call-1', query: 'Odile Fenwright odile.fenwright@ledger.example' });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({
      messages: [{ type: EventType.USER_MESSAGE, content: 'Is Odile Fenwright a good accountant?' }],
      resolver,
    });

    expect((await session.getTurn(turn.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('a name from a mail the model read in an earlier turn', () => {
  const MAIL = JSON.stringify({ from: 'Bertil Ashcombe <bertil@harbour.example>', body: 'See you at the yard.' });

  /** A chat whose earlier turn read the mail, so the chat's saved record holds the sender's name. */
  const readMail = async () => {
    const chat = await setupSearchChat();
    const reading = chat.resolverForTurn();
    chat.create.mockImplementationOnce(async function* () {
      markPrivateDataRead(reading.webSearchTurn);
      recordPrivateReadText({ state: reading.webSearchTurn, text: MAIL });
      return yield* textStream('Read it.');
    });
    await chat.run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Read my mail' }], resolver: reading });
    return chat;
  };

  it('holds a search that copies the sender’s name from the mail', async () => {
    const { session, run, create, callTool } = await readMail();
    const before = callTool.mock.calls.length;
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'Bertil Ashcombe boatyard' }));
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Who wrote to me?' }] });

    const state = (await session.getTurn(turn.id))?.state;
    expect(state).toMatchObject(HELD);
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_detail);
    expect(callTool.mock.calls.length).toBe(before);
  });

  it('runs the same search when the person typed the name in this message', async () => {
    const { run, create, callTool } = await readMail();
    const before = callTool.mock.calls.length;
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'Bertil Ashcombe boatyard' }));
    create.mockImplementation(() => textStream('Done.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Find the boatyard Bertil Ashcombe runs' }] });

    expect(callTool.mock.calls.length).toBe(before + 1);
  });
});

describe('the sentence on a held card', () => {
  it('names the assistant by the name the person gave it', async () => {
    const { session, run, resolverForTurn, create } = await setupSearchChat({ assistant_name: 'Juniper' });
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: MEMORY, source: 'memory' });
      return yield* searchStream({ id: 'call-1', query: 'odile.fenwright@ledger.example' });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Check this' }], resolver });

    const state = JSON.stringify((await session.getTurn(turn.id))?.state);
    expect(state).toContain(holdSay('Juniper').private_detail);
    expect(state).not.toContain(DEFAULT_ASSISTANT_NAME);
  });
});

describe('a held page read', () => {
  it('is named as opening a page, not as a search', async () => {
    const page = 'https://forecast.example/MapClick.php?lat=41.158312&lon=-8.629105';
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    callTool.mockImplementation(() =>
      Promise.resolve(toolResultResponse({ text: JSON.stringify({ results: [{ url: page }] }) })),
    );
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query: WEATHER_QUERY });
    });
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', args: { url: page } }));
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Forecast for home' }], resolver });

    const state = JSON.stringify((await session.getTurn(turn.id))?.state);
    expect(state).toContain(`Open a web page: ${page}.`);
    expect(state).toContain(HOLD_SAY.private_detail);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
