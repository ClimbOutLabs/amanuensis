/**
 * A search that carries a detail from the person's private data asks first, through SessionHandle and the session
 * store. The check is the host's own: it holds whatever the model's reasoning effort and whatever the owner's
 * "Web searches run without asking" setting, and a search with nothing private still runs without asking.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import {
  recordPrivateContextText,
  recordPrivateToolResult,
  type WebSearchTurnState,
} from '../../src/core/permissions/webSearch';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

/** Invented details only. */
const MEMORY =
  '<aman-memory>\n- [2026-09-02] Your sister Inês Quillfeather is moving to 48 Harrowgate Road.\n</aman-memory>';
const PROFILE =
  '<user-name>Teodoro Brambleworth</user-name>\n\n<user-profile>Born on 1984-07-19. Works as a nurse.</user-profile>';
const CALENDAR = JSON.stringify({
  items: [{ summary: 'Check-up', attendees: [{ displayName: 'Doutor Rafe Ollerenshaw', email: 'rafe@clinic.test' }] }],
});
const MAIL = JSON.stringify({
  from: 'Mirela Vantongeren <mirela@example.test>',
  body: 'Your order KQ-80442 is on its way.',
});
const NOTES = JSON.stringify({ title: 'Plans', body: 'Call Ottoline Fairweather about the boat on 07700 900461.' });
const ATTACHMENT = 'Lease agreement. Tenant: Casimir Pendlebury. Deposit reference 55120983.';

interface Source {
  name: string;
  /** Puts the source's text before the model, as the host does during the turn. */
  record: (state: WebSearchTurnState) => void;
  /** A search that carries one of the source's details. */
  query: string;
  /** The person's own message. */
  message: string;
}

const context =
  (text: string) =>
  (state: WebSearchTurnState): void => {
    recordPrivateContextText({ state, text });
  };
const read =
  (tool_name: string, text: string) =>
  (state: WebSearchTurnState): void => {
    recordPrivateToolResult({ state, tool_name, result: toolResultResponse({ text }).result });
  };

const SOURCES: Source[] = [
  { name: 'memory', record: context(MEMORY), query: '48 Harrowgate Rd house prices', message: 'What is near there?' },
  { name: 'profile', record: context(PROFILE), query: 'Teodoro Brambleworth nurse', message: 'Find me online' },
  { name: 'calendar', record: read('list_events', CALENDAR), query: 'Rafe Ollerenshaw reviews', message: 'Who is he?' },
  { name: 'mail', record: read('read_email', MAIL), query: 'track order KQ-80442', message: 'Where is my parcel?' },
  { name: 'notes', record: read('get_space', NOTES), query: 'who owns 07700 900461', message: 'Whose number is it?' },
  { name: 'attachment', record: context(ATTACHMENT), query: 'Casimir Pendlebury lease', message: 'Check the tenant' },
  {
    name: 'a name from the message that memory holds',
    record: context(MEMORY),
    query: 'Ines Quillfeather new job',
    message: 'Look up Inês Quillfeather for me',
  },
];

const HELD = { status: 'done', required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }] };
const EFFORTS = ['none', 'medium'];

describe.each(EFFORTS)('with reasoning effort %s', reasoning_effort => {
  describe.each([true, false])('and "Web searches run without asking" %s', search_without_asking => {
    it.each(SOURCES.map(source => [source.name, source] as const))(
      'holds a search carrying a detail from %s and shows its exact query',
      async (_name, source) => {
        const { session, run, resolverForTurn, create, callTool } = await setupSearchChat({
          search_without_asking,
          reasoning_effort,
        });
        const resolver = resolverForTurn();
        create.mockImplementationOnce(async function* () {
          source.record(resolver.webSearchTurn);
          return yield* searchStream({ id: 'call-1', query: source.query });
        });
        create.mockImplementation(() => textStream('Done.'));

        const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: source.message }], resolver });

        const state = (await session.getTurn(turn.id))?.state;
        expect(state).toMatchObject(HELD);
        expect(JSON.stringify(state)).toContain(source.query);
        expect(callTool).not.toHaveBeenCalled();
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort }));
      },
    );
  });

  it('runs a public search without asking in a chat that holds private details', async () => {
    const { run, resolverForTurn, create, callTool, audit } = await setupSearchChat({ reasoning_effort });
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: MEMORY });
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE });
      return yield* searchStream({ id: 'call-1', query: 'opening hours of the Lisbon Oceanarium' });
    });
    create.mockImplementation(() => textStream('Done.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'When is it open?' }], resolver });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(audit).toContainEqual(
      expect.objectContaining({ tier: 1, description: 'Searched: opening hours of the Lisbon Oceanarium' }),
    );
  });
});

describe('a chat whose earlier turn recalled private details', () => {
  it('holds a search carrying them in a later turn, read back from the saved chat', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const recalling = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: recalling.webSearchTurn, text: MEMORY });
      return yield* textStream('Noted.');
    });
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Hello' }], resolver: recalling });

    // A fresh resolver and a chat loaded afresh from the store, as after a restart: nothing is recalled this turn.
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'Ines Quillfeather' }));
    create.mockImplementation(() => textStream('Done.'));
    const later = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Search for my sister' }] });

    expect((await session.getTurn(later.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();

    // Skipped on its card; the next message's public search runs without asking.
    create.mockImplementationOnce(() => textStream('Skipped.'));
    await run({
      messages: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-2',
          approval: { status: 'deny', reason: 'Not now' },
        },
      ],
    });
    create.mockImplementationOnce(() => searchStream({ id: 'call-3', query: 'tallest building in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Something else then' }] });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('asks before every search once a private detail could not be kept', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const losing = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: losing.webSearchTurn, text: MEMORY });
      losing.webSearchTurn.fingerprintsLost = true;
      return yield* searchStream({ id: 'call-1', query: 'tallest building in Lisbon' });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }], resolver: losing });

    expect((await session.getTurn(turn.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();
  });
});
