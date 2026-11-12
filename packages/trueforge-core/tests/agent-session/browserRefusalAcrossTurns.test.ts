/**
 * A "no" to a browser open lasts the rest of the chat: the session keeps the refusal, the next
 * turn refuses another page on that site with no new card, a different site still asks, and a
 * new chat asks again. Invented people and hosts only.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { browserTextStream, setupBrowserChat, toolStream } from './browserTurnHarness';

const say = (text: string) => [{ type: EventType.USER_MESSAGE, content: text }];

const deny = (tool_call_id: string) => [
  {
    type: EventType.USER_TOOL_APPROVAL,
    thread_id: 'main',
    tool_call_id,
    approval: { status: 'deny' as const, reason: 'Not now' },
  },
];

type Chat = Awaited<ReturnType<typeof setupBrowserChat>>;

async function approvalCallIds(chat: Chat, turnId: string): Promise<string[]> {
  const turn = await chat.session.getTurn(turnId);
  const actions = turn?.state.status === 'done' ? turn.state.required_actions : [];
  return actions.flatMap(action =>
    action.type === EventType.TOOL_APPROVAL_REQUIRED ? action.tool_calls.map(call => call.id) : [],
  );
}

function openedUrls(chat: Chat): string[] {
  return chat.callTool.mock.calls
    .filter(([params]) => params.name === 'browser_open')
    .map(([params]) => String(params.arguments?.['url'] ?? ''));
}

/** Turn 1: read a newsletter, then an open on news.example that the person turns down. */
async function refuseFirstOpen(chat: Chat): Promise<void> {
  chat.create
    .mockImplementationOnce(() => toolStream({ id: 'call-read', name: 'browser_read', args: {} }))
    .mockImplementationOnce(() =>
      toolStream({ id: 'call-open-1', name: 'browser_open', args: { url: 'https://news.example/first-story' } }),
    );
  const turn = await chat.run({ messages: say('Read the newsletter, then open the top story') });
  expect(await approvalCallIds(chat, turn.id)).toEqual(['call-open-1']);

  chat.create.mockImplementationOnce(() => browserTextStream('Understood, I will leave it closed.'));
  const answered = await chat.run({ messages: deny('call-open-1') });
  expect(await approvalCallIds(chat, answered.id)).toEqual([]);
  expect(openedUrls(chat)).toEqual([]);
}

describe('a "no" to a browser open', () => {
  it('is kept on the session, keyed to the site', async () => {
    const chat = await setupBrowserChat();
    await refuseFirstOpen(chat);

    const record = await chat.store.getSession({ tenant_id: 't', session_id: chat.session_id });
    expect(record?.approval_refusals).toHaveLength(1);
    expect(record?.approval_refusals[0]).toContain('news.example');
    expect(record?.approval_refusals[0]).toContain('browser_open_unvouched');
  });

  it('refuses another page on that site in the next turn with no new card, and still asks on a new site', async () => {
    const chat = await setupBrowserChat();
    await refuseFirstOpen(chat);

    // The new site asks first: a repeat of a "no" ends a turn, so the refused site is tried
    // in the continuation after this card is answered.
    chat.create
      .mockImplementationOnce(() => toolStream({ id: 'call-read-2', name: 'browser_read', args: {} }))
      .mockImplementationOnce(() =>
        toolStream({ id: 'call-open-3', name: 'browser_open', args: { url: 'https://other.example/story' } }),
      )
      .mockImplementation(() => browserTextStream('Done.'));
    const turn = await chat.run({ messages: say('Open that other piece, then the follow-up story') });
    expect(await approvalCallIds(chat, turn.id)).toEqual(['call-open-3']);
    expect(openedUrls(chat)).toEqual([]);

    // The answer refuses the new site too. The model then tries the follow-up on the site
    // refused in turn 1: no card is made for it, and it never reaches the browser.
    chat.create
      .mockImplementationOnce(() =>
        toolStream({ id: 'call-open-2', name: 'browser_open', args: { url: 'https://news.example/second-story' } }),
      )
      .mockImplementation(() => browserTextStream('Done.'));
    const answered = await chat.run({ messages: deny('call-open-3') });
    expect(await approvalCallIds(chat, answered.id)).toEqual([]);
    expect(openedUrls(chat)).toEqual([]);

    const record = await chat.store.getSession({ tenant_id: 't', session_id: chat.session_id });
    expect(record?.approval_refusals).toHaveLength(2);
  });

  it('asks again in a new chat', async () => {
    const chat = await setupBrowserChat();
    await refuseFirstOpen(chat);

    const fresh = await setupBrowserChat();
    fresh.create
      .mockImplementationOnce(() => toolStream({ id: 'call-read', name: 'browser_read', args: {} }))
      .mockImplementationOnce(() =>
        toolStream({ id: 'call-open-9', name: 'browser_open', args: { url: 'https://news.example/first-story' } }),
      );
    const turn = await fresh.run({ messages: say('Read the newsletter, then open the top story') });
    expect(await approvalCallIds(fresh, turn.id)).toEqual(['call-open-9']);
  });
});
