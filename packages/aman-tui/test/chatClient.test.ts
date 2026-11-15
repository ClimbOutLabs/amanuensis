import type { HeldActionOutcome } from '@truefoundry/trueforge-chat';
import { describe, expect, it, vi } from 'vitest';

import type { PendingApproval } from '../src/approvals.js';
import { createChatClient } from '../src/chatClient.js';
import { ChatView, type ChatEvent } from '../src/chatEvents.js';
import { errorCodeOf, statusCodeOfError } from '../src/serverErrors.js';
import { makeFakeSdkFetch, wireSession, type RecordedSdkCall, type SseFrame } from './fakeSdkFetch.js';

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

function toolResponseFrame(id: string, toolCallId: string, disposition: string): SseFrame {
  return frame(id, {
    id: `event-${id}`,
    type: 'tool.response.v2',
    created_at: AT,
    thread_id: 'thread-1',
    tool_call_id: toolCallId,
    content: '',
    disposition,
    admission_provenance: { source: 'automatic' },
  });
}

const APPROVAL: PendingApproval = {
  toolCallId: 'call-1',
  threadId: 'thread-1',
  card: null,
  toolName: 'Send email',
  canAlwaysAllow: true,
  held: false,
  expiresAt: null,
};

async function drainOutcome(generator: AsyncGenerator<ChatEvent, HeldActionOutcome>): Promise<HeldActionOutcome> {
  let step = await generator.next();
  while (!step.done) {
    step = await generator.next();
  }
  return step.value;
}

function createTurnCalls(calls: RecordedSdkCall[]): RecordedSdkCall[] {
  return calls.filter(call => call.method === 'POST' && call.path.endsWith('/turns'));
}

function inputOf(call: RecordedSdkCall): unknown {
  if (typeof call.body !== 'object' || call.body === null || !('input' in call.body)) {
    return undefined;
  }
  return call.body.input;
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

  it('says the connection is lost while it rejoins, and a retry at once wakes the wait', async () => {
    let subscribeAttempts = 0;
    const { fetcher } = makeFakeSdkFetch({
      onCreateTurn: () => ({ frames: [turnCreatedFrame('1', 'Hello'), deltaFrame('2', 'Hel')], failAtEnd: true }),
      onSubscribe: () => {
        subscribeAttempts += 1;
        if (subscribeAttempts === 1) {
          throw new Error('The connection dropped.');
        }
        return { frames: [deltaFrame('3', 'lo'), messageFrame('4', 'Hello'), doneFrame('5')] };
      },
    });
    const neverSleep = (): Promise<void> => new Promise<void>(() => undefined);
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: neverSleep });
    const onConnectionLost = vi.fn();
    const view = new ChatView(BASE);
    let finished = false;
    const drained = (async () => {
      for await (const event of client.streamMessage('session-1', 'Hello', { onConnectionLost })) {
        view.apply(event);
      }
      finished = true;
    })();
    await vi.waitFor(() => {
      expect(onConnectionLost).toHaveBeenCalledTimes(1);
    });
    // The rejoin is parked in its wait between attempts. Asking retries at
    // once, and the ask is repeated until it lands, as a keypress would be.
    await vi.waitFor(
      () => {
        client.retryConnectionNow();
        expect(finished).toBe(true);
      },
      { timeout: 10000, interval: 50 },
    );
    await drained;
    const assistant = view.blocks.find(block => block.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.text).toBe('Hello');
  });

  it('gives up with the plain lost line after the rejoin attempts run out', async () => {
    const { fetcher } = makeFakeSdkFetch({
      onCreateTurn: () => ({ frames: [turnCreatedFrame('1', 'Hello')], failAtEnd: true }),
      onSubscribe: () => {
        throw new Error('The connection dropped.');
      },
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const drained = (async () => {
      for await (const event of client.streamMessage('session-1', 'Hello')) {
        void event;
      }
    })();
    await expect(drained).rejects.toThrow(
      'The connection to Aman was lost and the reply could not be rejoined. Send your message again.',
    );
  });

  it('answers an approval through the continuation, the way the web app sends it, and returns the outcome', async () => {
    const { fetcher, calls } = makeFakeSdkFetch({
      onCreateTurn: () => ({
        frames: [
          turnCreatedFrame('1', ''),
          toolResponseFrame('2', 'call-1', 'executed_ok'),
          messageFrame('3', 'Sent.'),
          doneFrame('4'),
        ],
      }),
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const outcome = await drainOutcome(client.answerApproval('session-1', APPROVAL, 'approve'));
    expect(outcome).toBe('done');
    const posts = createTurnCalls(calls);
    expect(posts).toHaveLength(1);
    expect(inputOf(posts[0] ?? { method: '', path: '', body: undefined })).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'thread-1',
        tool_call_id: 'call-1',
        approval: { status: 'allow', scope: 'once' },
      },
    ]);
  });

  it('answers a deny as a deny, and an always allow with the always scope', async () => {
    const { fetcher, calls } = makeFakeSdkFetch({
      onCreateTurn: () => ({
        frames: [turnCreatedFrame('1', ''), toolResponseFrame('2', 'call-1', 'denied'), doneFrame('3')],
      }),
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const denied = await drainOutcome(client.answerApproval('session-1', APPROVAL, 'deny'));
    expect(denied).toBe('not_run');
    const always = await drainOutcome(client.answerApproval('session-1', APPROVAL, 'always_allow'));
    expect(always).toBe('not_run');
    const posts = createTurnCalls(calls);
    expect(inputOf(posts[0] ?? { method: '', path: '', body: undefined })).toEqual([
      { type: 'user.tool_approval', thread_id: 'thread-1', tool_call_id: 'call-1', approval: { status: 'deny' } },
    ]);
    expect(inputOf(posts[1] ?? { method: '', path: '', body: undefined })).toEqual([
      {
        type: 'user.tool_approval',
        thread_id: 'thread-1',
        tool_call_id: 'call-1',
        approval: { status: 'allow', scope: 'always' },
      },
    ]);
  });

  it('lets a continuation refusal reach the caller with its status and code intact', async () => {
    const { fetcher } = makeFakeSdkFetch({
      onCreateTurn: () => ({
        frames: [],
        failWith: {
          status: 409,
          body: { error: { message: 'The approval is stale.', code: 'stale_approval_continuation' } },
        },
      }),
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    let caught: unknown;
    try {
      await drainOutcome(client.answerApproval('session-1', APPROVAL, 'approve'));
    } catch (error) {
      caught = error;
    }
    expect(statusCodeOfError(caught)).toBe(409);
    expect(errorCodeOf(caught)).toBe('stale_approval_continuation');
  });

  it('stops a turn through the cancel route', async () => {
    const { fetcher, calls } = makeFakeSdkFetch({});
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    await client.stopTurn('session-1');
    expect(calls.some(call => call.method === 'POST' && call.path === '/api/v1/sessions/session-1/cancel')).toBe(true);
  });

  it('reads the approvals waiting on the tip turn, with their cards', async () => {
    const { fetcher } = makeFakeSdkFetch({
      historyBySession: {
        'session-1': [
          {
            turn_id: 'turn-2',
            event: {
              id: 'event-9',
              type: 'turn.done',
              created_at: AT,
              thread_id: null,
              state: { status: 'done', completed_at: AT, output: null, required_actions: [] },
            },
          },
        ],
      },
      turnById: {
        'turn-2': {
          id: 'turn-2',
          created_at: AT,
          previous_turn_id: 'turn-1',
          session_id: 'session-1',
          state: {
            status: 'done',
            completed_at: AT,
            output: null,
            required_actions: [
              {
                id: 'event-8',
                type: 'tool.approval_required',
                created_at: AT,
                thread_id: 'thread-1',
                tool_calls: [
                  {
                    id: 'call-9',
                    source_event_id: 'event-8',
                    can_always_allow: true,
                    tier3_card: {
                      plain_what: 'Send an email to Pippa.',
                      plain_why: null,
                      why_asked_again: null,
                      copy: { headline: 'Send this email to Pippa?', consequence: null, reason: null },
                      cannot_be_undone: null,
                      destination: null,
                      destination_host: null,
                      recipient: null,
                      amount: null,
                      parsed_command: null,
                      outbound_text: null,
                      outbound_truncated: false,
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    });
    const client = createChatClient({ baseUrl: BASE, token: 'aman_tk_test', fetch: fetcher, sleep: noSleep });
    const pending = await client.pendingApprovals('session-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolCallId).toBe('call-9');
    expect(pending[0]?.threadId).toBe('thread-1');
    expect(pending[0]?.canAlwaysAllow).toBe(true);
    expect(pending[0]?.card?.copy?.headline).toBe('Send this email to Pippa?');
  });
});
