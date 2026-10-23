/**
 * "Allow searches in this chat", driven through SessionHandle and the session store: the grant an approval adds is
 * the one the next search reads, and a turn never trusts a saved record that misses an earlier turn of the chat.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { CancellationReason } from '../../src/agent-session/schemas/turn';
import { classifyHostToolCall, createSentinelHostContext, type SentinelServices } from '../../src/core/permissions';
import {
  markPrivateDataRead,
  recordPrivateReadText,
  type WebSearchTurnState,
} from '../../src/core/permissions/webSearch';
import { drain, OWNER, searchStream, setupSearchChat, textStream } from './searchTurnHarness';
import { mintTestTurnId } from './testHelpers';

/** Words of a mail read through a connector, which no fingerprint of the chat holds. */
const OUTLOOK_QUERY = 'Joana Pires invoice 99120 riverside dental';

/** A mail read through a connector, recorded as the dispatch choke point records it. */
async function readOutlook(input: {
  services: SentinelServices;
  session_id: string;
  state: WebSearchTurnState;
}): Promise<void> {
  await classifyHostToolCall({
    sentinel: createSentinelHostContext({
      tenant_id: 't',
      created_by: OWNER.subject_id,
      conversation_id: input.session_id,
      services: input.services,
      web_search: input.state,
    }),
    repository_id: null,
    workspace_cwd: null,
    action: {
      tool_name: 'list_messages',
      canonical_params: { folder: 'INBOX' },
      tool_type: 'mcp',
      mcp_server_name: 'outlook',
      mcp_server_host: 'outlook.example',
      mcp_hints: {},
    },
  });
}

async function setup() {
  const chat = await setupSearchChat();
  const { run, create } = chat;
  /** Turn one reads a mail; the owner then allows searches in this chat on a held search. */
  const allowSearchesAfterMailRead = async (): Promise<void> => {
    const reading = chat.resolverForTurn();
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
  };
  return { ...chat, allowSearchesAfterMailRead };
}

const HELD = { status: 'done', required_actions: [{ type: EventType.TOOL_APPROVAL_REQUIRED }] };

describe('"Allow searches in this chat" given during a reply', () => {
  it('lets the next search of the same reply run without asking', async () => {
    const { session, run, resolverForTurn, create, callTool, audit } = await setup();

    // Turn one reads a mail, so the chat has read private data from then on.
    const reading = resolverForTurn();
    markPrivateDataRead(reading.webSearchTurn);
    recordPrivateReadText({ state: reading.webSearchTurn, text: 'Lunch with Ana on Monday.' });
    create.mockImplementationOnce(() => textStream('Read it.'));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Read my mail' }], resolver: reading });

    // Turn two's search is held for the private read.
    create.mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'tallest building in Lisbon' }));
    const held = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Look something up' }] });
    expect((await session.getTurn(held.id))?.state).toMatchObject(HELD);
    expect(callTool).not.toHaveBeenCalled();

    // The owner allows searches in this chat; the same reply then searches again.
    create.mockImplementationOnce(() => searchStream({ id: 'call-2', query: 'oldest cafe in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));
    const approved = await run({
      messages: [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: 'main',
          tool_call_id: 'call-1',
          approval: { status: 'allow', scope: 'chat' },
        },
      ],
    });

    expect((await session.getTurn(approved.id))?.state).toMatchObject({ status: 'done', required_actions: [] });
    expect(callTool).toHaveBeenCalledTimes(2);
    // This turn holds no mail text to check against, so only the chat grant lets the search run unasked.
    expect(audit).toContainEqual(
      expect.objectContaining({ tier: 1, outcome: 'logged', description: 'Searched: oldest cafe in Lisbon' }),
    );
  });
});

describe('a turn whose fingerprints the store may not hold yet', () => {
  it('holds a search sent after Cancel stops the turn that read through a connector', async () => {
    const {
      session,
      session_id,
      store,
      services,
      loadChat,
      resolverForTurn,
      create,
      callTool,
      allowSearchesAfterMailRead,
    } = await setup();
    await allowSearchesAfterMailRead();
    const searchesBefore = callTool.mock.calls.length;
    const saves = jest.spyOn(store, 'setPrivateFingerprints');

    // The connector read happens, then the reply is still thinking when the owner stops it and sends a new message.
    const reading = resolverForTurn();
    let readDone: () => void = () => undefined;
    const read = new Promise<void>(resolve => {
      readDone = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    create.mockImplementationOnce(async function* () {
      await readOutlook({ services, session_id, state: reading.webSearchTurn });
      readDone();
      await gate;
      return yield* textStream('Read it.');
    });
    const outlookTurn = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Read my Outlook mail' }],
      signal: new AbortController().signal,
      resolver: reading,
    });
    const outlookDrained = drain(outlookTurn).catch(() => undefined);
    await read;

    // A new message waits for the reply to end, so the owner presses Cancel first.
    await (await loadChat()).freezeTurn({ turn_id: outlookTurn.id, reason: CancellationReason.ClientCancelled });
    create.mockImplementationOnce(() => searchStream({ id: 'call-9', query: OUTLOOK_QUERY }));
    create.mockImplementation(() => textStream('Done.'));
    const next = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Search for it' }],
      signal: new AbortController().signal,
      resolver: resolverForTurn(),
    });
    const nextDrained = drain(next);
    release();
    await Promise.all([outlookDrained, nextDrained]);

    expect((await session.getTurn(next.id))?.state).toMatchObject(HELD);
    expect(callTool.mock.calls.length).toBe(searchesBefore);
    // The cancelled turn saved what it read before the chat took the next message, and only it saved.
    expect((await session.getTurn(outlookTurn.id))?.state).toMatchObject({ status: 'cancelled' });
    expect(saves).toHaveBeenCalledTimes(1);
  });

  it('does not keep counting a turn that ended before it streamed', async () => {
    const { loadChat, run, resolverForTurn, create, callTool, allowSearchesAfterMailRead } = await setup();
    await allowSearchesAfterMailRead();
    const searchesBefore = callTool.mock.calls.length;

    // The server gives up on a turn before inference, for example when the chat's persona changed meanwhile.
    const unstarted = resolverForTurn();
    const abandoned = await (
      await loadChat()
    ).createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'Hello' }],
      signal: new AbortController().signal,
      resolver: unstarted,
    });
    // As if it inherited an unsaved earlier turn, so it would have something to save.
    unstarted.webSearchTurn.fingerprintsLost = true;
    abandoned.forgetUnstarted();
    await (await loadChat()).freezeTurn({ turn_id: abandoned.id, reason: CancellationReason.Abandoned });

    create.mockImplementationOnce(() => searchStream({ id: 'call-9', query: 'oldest cafe in Lisbon' }));
    create.mockImplementation(() => textStream('Done.'));
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Search for it' }] });

    expect(callTool.mock.calls.length).toBe(searchesBefore + 1);
  });

  it('holds a later search when saving the connector-read turn failed', async () => {
    const { session, session_id, store, services, run, resolverForTurn, create, callTool, allowSearchesAfterMailRead } =
      await setup();
    await allowSearchesAfterMailRead();
    const searchesBefore = callTool.mock.calls.length;

    jest.spyOn(store, 'setPrivateFingerprints').mockRejectedValueOnce(new Error('The disk is full.'));
    const reading = resolverForTurn();
    create.mockImplementationOnce(async function* () {
      await readOutlook({ services, session_id, state: reading.webSearchTurn });
      return yield* textStream('Read it.');
    });
    await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Read my Outlook mail' }], resolver: reading });

    create.mockImplementationOnce(() => searchStream({ id: 'call-9', query: OUTLOOK_QUERY }));
    create.mockImplementation(() => textStream('Done.'));
    const next = await run({ messages: [{ type: EventType.USER_MESSAGE, content: 'Search for it' }] });

    expect((await session.getTurn(next.id))?.state).toMatchObject(HELD);
    expect(callTool.mock.calls.length).toBe(searchesBefore);
  });
});
