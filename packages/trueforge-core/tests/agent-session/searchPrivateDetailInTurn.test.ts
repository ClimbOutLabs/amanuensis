/**
 * A search that carries a detail from the person's private data asks first, through SessionHandle and the session
 * store. The check is the host's own: it holds whatever the model's reasoning effort and whatever the owner's
 * "Web searches run without asking" setting, and a search with nothing private still runs without asking.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { holdSay } from '../../src/core/permissions/searchHoldText';
import {
  checkAttachedFilesCovered,
  markPrivateDataRead,
  recordAttachedFile,
  recordPrivateContextText,
  recordPrivateReadText,
  recordPrivateToolResult,
  type WebSearchTurnState,
} from '../../src/core/permissions/webSearch';
import { DEFAULT_ASSISTANT_NAME } from '../../src/core/personas/assistantName';
import { drain, searchStream, setupSearchChat, textStream } from './searchTurnHarness';
import { mintTestTurnId } from './testHelpers';

const HOLD_SAY = holdSay(DEFAULT_ASSISTANT_NAME);

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
  /** Why the card asks when searches run without asking: a read chat's own check, or the private-detail check. */
  say: string;
}

/** Text the host puts before the model each turn (memory, profile), or once (an attached file's text). */
const context =
  (text: string, source: 'profile' | 'memory' | 'attachment') =>
  (state: WebSearchTurnState): void => {
    recordPrivateContextText({ state, text, source });
  };
const read =
  (tool_name: string, text: string) =>
  (state: WebSearchTurnState): void => {
    recordPrivateToolResult({ state, tool_name, result: toolResultResponse({ text }).result });
  };

const SOURCES: Source[] = [
  {
    name: 'memory',
    record: context(MEMORY, 'memory'),
    query: '48 Harrowgate Rd house prices',
    message: 'What is near there?',
    say: HOLD_SAY.private_detail,
  },
  {
    name: 'profile',
    record: context(PROFILE, 'profile'),
    query: 'Teodoro Brambleworth nurse',
    message: 'Find me online',
    say: HOLD_SAY.private_detail,
  },
  {
    name: 'calendar',
    record: read('list_events', CALENDAR),
    query: 'Rafe Ollerenshaw reviews',
    message: 'Who is he?',
    say: HOLD_SAY.private_read,
  },
  {
    name: 'mail',
    record: read('read_email', MAIL),
    query: 'track order KQ-80442',
    message: 'Where is my parcel?',
    say: HOLD_SAY.private_detail,
  },
  {
    name: 'notes',
    record: read('get_space', NOTES),
    query: 'who owns 07700 900461',
    message: 'Whose number is it?',
    say: HOLD_SAY.private_read,
  },
  {
    name: 'attachment',
    record: context(ATTACHMENT, 'attachment'),
    query: 'Casimir Pendlebury lease',
    message: 'Check the tenant',
    say: HOLD_SAY.private_detail,
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
        // The card's sentence names why it asks: the setting when it is off, else the private check that caught it.
        const say = search_without_asking ? source.say : HOLD_SAY.search_setting;
        expect(JSON.stringify(state)).toContain(say);
      },
    );
  });

  it('runs a public search without asking in a chat that holds private details', async () => {
    const { run, resolverForTurn, create, callTool, audit } = await setupSearchChat({ reasoning_effort });
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: MEMORY, source: 'memory' });
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query: 'opening hours of the Lisbon Oceanarium' });
    });
    create.mockImplementation(() => textStream('Done.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'When is it open?' }], resolver });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(audit).toContainEqual(
      expect.objectContaining({ tier: 1, description: 'Searched: opening hours of the Lisbon Oceanarium' }),
    );
  });

  it('runs a second public search in the same reply without asking, after the first one was sent', async () => {
    const { run, resolverForTurn, create, callTool } = await setupSearchChat({ reasoning_effort });
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: resolver.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query: 'asyncio event loop tutorial python 3.13 advanced news' });
    });
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'weather in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Two things' }], resolver });

    expect(callTool).toHaveBeenCalledTimes(2);
  });
});

describe('a chat whose earlier turn recalled private details', () => {
  it('holds a search carrying them in a later turn, read back from the saved chat', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const recalling = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: recalling.webSearchTurn, text: MEMORY, source: 'memory' });
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
      recordPrivateContextText({ state: losing.webSearchTurn, text: MEMORY, source: 'memory' });
      losing.webSearchTurn.fingerprintsLost = true;
      return yield* searchStream({ id: 'call-1', query: 'tallest building in Lisbon' });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }], resolver: losing });

    expect((await session.getTurn(turn.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe('a chat with "Allow searches in this chat"', () => {
  it('still holds a search that carries a recalled private detail', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    // A mail read, then the owner allows searches in this chat on the held search.
    const reading = resolverForTurn();
    markPrivateDataRead(reading.webSearchTurn);
    recordPrivateReadText({ state: reading.webSearchTurn, text: 'Lunch with Ana on Monday.' });
    create.mockImplementationOnce(() => textStream('Read it.'));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Read my mail' }], resolver: reading });
    create.mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'tallest building in Lisbon' }));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look something up' }] });
    create.mockImplementationOnce(() => textStream('Allowed.'));
    await run({
      messages: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-1',
          approval: { status: 'allow', scope: 'chat' },
        },
      ],
    });
    const searchesBefore = callTool.mock.calls.length;

    const recalling = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: recalling.webSearchTurn, text: MEMORY, source: 'memory' });
      return yield* searchStream({ id: 'call-2', query: 'Ines Quillfeather' });
    });
    create.mockImplementation(() => textStream('Done.'));
    const turn = await run({
      messages: [{ type: EventType.USER_MESSAGE, content: 'Search for my sister' }],
      resolver: recalling,
    });

    expect((await session.getTurn(turn.id))?.state).toMatchObject(HELD);
    expect(callTool.mock.calls.length).toBe(searchesBefore);
  });
});

describe('a turn that follows a profile-only turn', () => {
  it('waits for that turn, then keeps the chat record whole, so a later public search runs without asking', async () => {
    const { session_id, store, loadChat, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const first = resolverForTurn();
    let recorded: () => void = () => undefined;
    const profileKept = new Promise<void>(resolve => {
      recorded = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: first.webSearchTurn, text: PROFILE, source: 'profile' });
      recorded();
      await gate;
      return yield* textStream('Hello.');
    });
    const running = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Hi' }],
      signal: new AbortController().signal,
      resolver: first,
    });
    const runningDrained = drain(running).catch(() => undefined);
    await profileKept;

    // A chat answers one message at a time, so a second turn is refused until the first ends.
    await expect(
      (await loadChat()).createTurn({
        turn_id: mintTestTurnId(),
        input: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }],
        signal: new AbortController().signal,
        resolver: resolverForTurn(),
      }),
    ).rejects.toThrow('is still running');
    release();
    await runningDrained;

    const second = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordPrivateContextText({ state: second.webSearchTurn, text: PROFILE, source: 'profile' });
      return yield* searchStream({ id: 'call-1', query: 'tallest building in Lisbon' });
    });
    create.mockImplementation(() => textStream('Done.'));
    const next = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }],
      signal: new AbortController().signal,
      resolver: second,
    });
    await drain(next);

    expect(callTool).toHaveBeenCalledTimes(1);
    const saved = await store.getSession({ tenant_id: 't', session_id });
    expect(saved?.private_fingerprints).toMatchObject({ complete: true, has_text: true });

    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'oldest cafe in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'And another' }] });
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});

describe('a chat with an attached file', () => {
  const CONTACTS = 'name,email,phone\nJane Example-Smith,jane.smith@example.test,+44 20 7946 0958\n';

  it.each([
    ['a name', 'Jane Example-Smith'],
    ['an email address', 'jane.smith@example.test'],
  ])('holds a search for %s from an attached CSV after a sandbox command printed it', async (_label, query) => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      // The upload step keeps the file's text; then the model prints it with an ordinary command.
      recordAttachedFile({ state: resolver.webSearchTurn, content: { kind: 'text', text: CONTACTS } });
      recordPrivateToolResult({
        state: resolver.webSearchTurn,
        tool_name: 'run_command',
        result: toolResultResponse({ text: CONTACTS }).result,
      });
      return yield* searchStream({ id: 'call-1', query });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Who is this?' }], resolver });

    const state = (await session.getTurn(turn.id))?.state;
    expect(state).toMatchObject(HELD);
    expect(JSON.stringify(state)).toContain(HOLD_SAY.private_detail);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('asks before every search once a file it cannot read was attached, and keeps asking in later turns', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordAttachedFile({ state: resolver.webSearchTurn, content: { kind: 'unreadable' } });
      return yield* searchStream({ id: 'call-1', query: 'tallest building in Lisbon' });
    });
    create.mockImplementation(() => textStream('Done.'));
    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look at this' }], resolver });
    expect((await session.getTurn(turn.id))?.state).toMatchObject(HELD);
    expect(JSON.stringify((await session.getTurn(turn.id))?.state)).toContain(HOLD_SAY.private_unchecked);

    create.mockImplementationOnce(() => textStream('Skipped.'));
    await run({
      messages: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-1',
          approval: { status: 'deny', reason: 'Not now' },
        },
      ],
    });
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'oldest cafe in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));
    const later = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Something else' }] });
    expect((await session.getTurn(later.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('asks when the history shows a file the saved record does not cover, as in an older or imported chat', async () => {
    const { session, run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      checkAttachedFilesCovered({ state: resolver.webSearchTurn, attached_in_history: 1 });
      return yield* searchStream({ id: 'call-1', query: 'tallest building in Lisbon' });
    });
    create.mockImplementation(() => textStream('Done.'));

    const turn = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }], resolver });

    expect((await session.getTurn(turn.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs a public search without asking after a readable file was attached', async () => {
    const { run, resolverForTurn, create, callTool } = await setupSearchChat();
    const resolver = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      recordAttachedFile({ state: resolver.webSearchTurn, content: { kind: 'text', text: CONTACTS } });
      return yield* searchStream({ id: 'call-1', query: 'tallest building in Lisbon' });
    });
    create.mockImplementation(() => textStream('Done.'));

    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look it up' }], resolver });

    expect(callTool).toHaveBeenCalledTimes(1);
  });
});
