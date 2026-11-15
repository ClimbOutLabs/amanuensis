import { describe, expect, it } from 'vitest';

import { createChatClient } from '../src/chatClient.js';
import { ChatView } from '../src/chatEvents.js';
import { makeFakeSdkFetch, wireSession, type SseFrame } from './fakeSdkFetch.js';

const BASE = 'https://nora.example:8443';
const AT = '2026-11-15T12:00:00.000Z';

function frame(id: string, data: Record<string, unknown>): SseFrame {
  return { id, data };
}

function turnCreatedFrame(id: string, text: string): SseFrame {
  return frame(id, {
    id: `event-${id}`,
    type: 'turn.created',
    created_at: AT,
    thread_id: null,
    turn_id: 'turn-1',
    previous_turn_id: null,
    state: { status: 'running' },
    input: [{ type: 'user.message', content: text }],
  });
}

function deltaFrame(id: string, content: string): SseFrame {
  return frame(id, { id: `event-${id}`, type: 'model.message.delta', thread_id: 'thread-1', content });
}

function messageFrame(id: string, content: string): SseFrame {
  return frame(id, { id: `event-${id}`, type: 'model.message', created_at: AT, thread_id: 'thread-1', content });
}

function doneFrame(id: string): SseFrame {
  return frame(id, {
    id: `event-${id}`,
    type: 'turn.done',
    created_at: AT,
    thread_id: null,
    state: { status: 'done', completed_at: AT, output: null, required_actions: [] },
  });
}

const noSleep = async (): Promise<void> => undefined;

describe('the chat client over a fake SDK fetch', () => {
  it('lists chats with titles, personas, and last activity, newest first', async () => {
    const { fetcher } = makeFakeSdkFetch({
      sessions: [
        wireSession({ id: 'session-1', title: 'Weekend plans', updated_at: '2026-11-15T11:45:00.000Z' }),
        wireSession({ id: 'session-2', title: null, updated_at: '2026-11-15T10:00:00.000Z' }),
      ],
      personaBySession: { 'session-1': 'Mannie', 'session-2': null },
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    await expect(client.listChats()).resolves.toEqual([
      { id: 'session-1', title: 'Weekend plans', personaName: 'Mannie', updatedAt: '2026-11-15T11:45:00.000Z' },
      { id: 'session-2', title: 'New chat', personaName: 'mannie', updatedAt: '2026-11-15T10:00:00.000Z' },
    ]);
  });

  it('refuses a route outside the terminal key scope, as the real server does', async () => {
    const { fetcher } = makeFakeSdkFetch({});
    const response = await fetcher(`${BASE}/api/v1/agents`);
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: { message: 'A paired terminal can only reach chats. Open Aman on the web to use this part of Aman.' },
    });
  });

  it('answers a new chat on an instance with no chats with the plain line, not the scope refusal', async () => {
    const { fetcher, calls } = makeFakeSdkFetch({ sessions: [] });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    await expect(client.createChat()).rejects.toThrow(
      'No agent is set up on this Aman yet. Start your first chat in the web app.',
    );
    // The agents list was tried and refused as out of scope, and no chat was created.
    expect(calls.some(call => call.path === '/api/v1/agents')).toBe(true);
    expect(calls.some(call => call.method === 'POST' && call.path === '/api/v1/sessions')).toBe(false);
  });

  it('starts a new chat on the agent of the newest chat', async () => {
    const { fetcher, calls } = makeFakeSdkFetch({
      sessions: [wireSession({ id: 'session-1' })],
      createdSession: wireSession({ id: 'session-new', title: null }),
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const created = await client.createChat();
    expect(created.id).toBe('session-new');
    expect(created.title).toBe('New chat');
    const post = calls.find(call => call.method === 'POST' && call.path === '/api/v1/sessions');
    expect(post?.body).toEqual({ agent: { name: 'mannie' } });
  });

  it('loads saved history oldest first', async () => {
    const { fetcher } = makeFakeSdkFetch({
      historyBySession: {
        'session-1': [
          {
            turn_id: 'turn-1',
            event: {
              id: 'event-3',
              type: 'turn.done',
              created_at: AT,
              thread_id: null,
              state: { status: 'done', completed_at: AT, output: null, required_actions: [] },
            },
          },
          {
            turn_id: 'turn-1',
            event: {
              id: 'event-2',
              type: 'model.message',
              created_at: AT,
              thread_id: 'thread-1',
              content: 'Hello Nora',
            },
          },
          {
            turn_id: 'turn-1',
            event: {
              id: 'event-1',
              type: 'turn.created',
              created_at: AT,
              thread_id: null,
              turn_id: 'turn-1',
              previous_turn_id: null,
              state: { status: 'running' },
              input: [{ type: 'user.message', content: 'Hello' }],
            },
          },
        ],
      },
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const events = await client.loadHistory('session-1');
    expect(events.map(event => event.id)).toEqual(['event-1', 'event-2', 'event-3']);
    const view = new ChatView(BASE);
    for (const event of events) {
      view.apply(event);
    }
    expect(view.blocks.map(block => block.kind)).toEqual(['user', 'assistant']);
  });

  it('streams a reply in order', async () => {
    const { fetcher } = makeFakeSdkFetch({
      onCreateTurn: () => ({
        frames: [
          turnCreatedFrame('1', 'Hello'),
          deltaFrame('2', 'Hello '),
          deltaFrame('3', 'Nora'),
          messageFrame('4', 'Hello Nora'),
          doneFrame('5'),
        ],
      }),
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const view = new ChatView(BASE);
    for await (const event of client.streamMessage('session-1', 'Hello')) {
      view.apply(event);
    }
    const assistant = view.blocks.find(block => block.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('Hello Nora');
    expect(assistant?.kind === 'assistant' && assistant.streaming).toBe(false);
  });

  it('rejoins through the subscribe route when the connection drops mid-turn', async () => {
    const { fetcher, calls } = makeFakeSdkFetch({
      onCreateTurn: () => ({ frames: [turnCreatedFrame('1', 'Hello'), deltaFrame('2', 'Hel')], failAtEnd: true }),
      onSubscribe: () => ({ frames: [deltaFrame('3', 'lo'), messageFrame('4', 'Hello'), doneFrame('5')] }),
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const view = new ChatView(BASE);
    for await (const event of client.streamMessage('session-1', 'Hello')) {
      view.apply(event);
    }
    expect(calls.some(call => call.path === '/api/v1/sessions/session-1/turns/turn-1/subscribe')).toBe(true);
    const assistant = view.blocks.find(block => block.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('Hello');
  });
});
