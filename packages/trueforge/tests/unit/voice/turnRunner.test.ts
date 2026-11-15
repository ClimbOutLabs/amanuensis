import type { OpenAPIHono } from '@hono/zod-openapi';
import { SessionHandle } from '@truefoundry/trueforge-core/agent-session';
import { HeldActionRefusedError } from '@truefoundry/trueforge-core/core';

import { APPROVAL_LINES } from '../../../src/voice/approvalVoice';
import { VoiceSession } from '../../../src/voice/session';
import type { PendingApproval, VoiceTurnRunner } from '../../../src/voice/transport';
import { HttpVoiceTurnRunner, type SessionRequest } from '../../../src/voice/turnRunner';
import { SESSION_ID, TOOL_CALL_ID, buildApp } from '../../fixtures/turnApprovalApp';
import { sendReplyCard } from '../../fixtures/voice/cards';
import {
  FakeStt,
  FakeTransport,
  FakeTts,
  LoudnessVad,
  ManualClock,
  feed,
  hum,
  quiet,
} from '../../fixtures/voice/fakes';

const never = new AbortController().signal;

function sse(...events: object[]): Response {
  return new Response(events.map(event => `id: 1\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const created = {
  type: 'turn.created',
  id: 'e1',
  turn_id: 'turn-9',
  previous_turn_id: null,
  state: { status: 'running' },
  created_at: 'x',
  thread_id: null,
};
const delta = (content: string) => ({ type: 'model.message.delta', id: 'e2', thread_id: 'main', content });
const done = (requiredActions: object[]) => ({
  type: 'turn.done',
  id: 'e3',
  thread_id: null,
  created_at: 'x',
  state: { status: 'done', output: null, required_actions: requiredActions, completed_at: 'x' },
});

function runnerFor(request: SessionRequest) {
  return new HttpVoiceTurnRunner({ request, sessionId: 'chat 1', clientTimezone: 'Europe/Paris' });
}

describe('HttpVoiceTurnRunner', () => {
  it('sends the words as a normal user message, marked as spoken, and streams the reply text', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const runner = runnerFor((path, init) => {
      seen.push({ path, body: JSON.parse(String(init.body)) });
      return Promise.resolve(sse(created, delta('Hello'), delta(' there.'), done([])));
    });
    const text: string[] = [];
    const outcome = await runner.sendMessage({ text: 'hi', signal: never, onText: piece => text.push(piece) });
    expect(outcome).toEqual({ kind: 'done', turnId: 'turn-9', approvals: [] });
    expect(text.join('')).toBe('Hello there.');
    expect(seen[0]).toEqual({
      path: '/api/v1/sessions/chat%201/turns',
      body: {
        input: [{ type: 'user.message', content: 'hi' }],
        stream: true,
        spoken_reply: true,
        client_timezone: 'Europe/Paris',
      },
    });
  });

  it('reports the cards that are waiting, as the chat shows them', async () => {
    const card = sendReplyCard();
    const runner = runnerFor(() =>
      Promise.resolve(
        sse(
          created,
          done([
            {
              type: 'tool.approval_required',
              id: 'a',
              created_at: 'x',
              thread_id: 'main',
              tool_calls: [{ id: 'call-7', source_event_id: 's', tier: 3, tier3_card: card }],
            },
          ]),
        ),
      ),
    );
    const outcome = await runner.sendMessage({ text: 'go', signal: never, onText: () => undefined });
    expect(
      outcome.kind === 'done'
        ? outcome.approvals.map(({ threadId, toolCallId, tier }) => ({ threadId, toolCallId, tier }))
        : outcome,
    ).toEqual([{ threadId: 'main', toolCallId: 'call-7', tier: 3 }]);
  });

  it('knows whether a card is still waiting, and that it is not once a newer turn exists or it was cleared', async () => {
    const turn = (calls: string[]) => ({
      data: {
        id: 'turn-9',
        session_id: 'chat 1',
        previous_turn_id: null,
        state: {
          status: 'done',
          output: null,
          completed_at: 'x',
          required_actions:
            calls.length === 0
              ? []
              : [
                  {
                    type: 'tool.approval_required',
                    id: 'a1',
                    thread_id: 'main',
                    tool_calls: calls.map(id => ({ id })),
                  },
                ],
        },
        created_at: 'x',
      },
    });
    const events = (newestTurnId: string) => ({
      data: [{ turn_id: newestTurnId, event: { type: 'turn.created' } }],
      pagination: { next_page_token: null },
    });
    const paths: string[] = [];
    let calls: string[] = ['call-7'];
    let newest = 'turn-9';
    const runner = runnerFor(path => {
      paths.push(path);
      return Promise.resolve(Response.json(path.includes('/events') ? events(newest) : turn(calls)));
    });
    const approval = { threadId: 'main', toolCallId: 'call-7', card: null, tier: 3 } as const;
    expect(await runner.stillWaiting({ turnId: 'turn-9', approval })).toBe(true);
    expect(paths).toEqual(['/api/v1/sessions/chat%201/events?limit=1', '/api/v1/sessions/chat%201/turns/turn-9']);
    newest = 'turn-10';
    expect(await runner.stillWaiting({ turnId: 'turn-9', approval })).toBe(false);
    newest = 'turn-9';
    calls = [];
    expect(await runner.stillWaiting({ turnId: 'turn-9', approval })).toBe(false);
    const broken = runnerFor(() => Promise.reject(new Error('offline')));
    // When it cannot be checked the answer is still validated by the server, so the card is treated as waiting.
    expect(await broken.stillWaiting({ turnId: 'turn-9', approval })).toBe(true);
  });

  it('answers a card with the same approval item the chat sends, and no spoken_reply flag', async () => {
    let body: unknown;
    const runner = runnerFor((_path, init) => {
      body = JSON.parse(String(init.body));
      return Promise.resolve(sse(created, done([])));
    });
    await runner.answerApproval({
      approval: { threadId: 'main', toolCallId: 'call-7', card: null, tier: 3 },
      decision: 'allow',
      signal: never,
      onText: () => undefined,
    });
    expect(body).toEqual({
      input: [
        {
          type: 'user.tool_approval',
          thread_id: 'main',
          tool_call_id: 'call-7',
          approval: { status: 'allow', scope: 'once' },
        },
      ],
      stream: true,
      client_timezone: 'Europe/Paris',
    });
  });

  it.each(['expired', 'changed', 'not_allowed', 'tool_gone', 'sign_in'] as const)(
    'reports a refused answer (%s) as refused, never as done',
    async reason => {
      const runner = runnerFor(() =>
        Promise.resolve(
          Response.json({ error: { message: 'x', type: 'conflict', code: `held_action_${reason}` } }, { status: 409 }),
        ),
      );
      const outcome = await runner.answerApproval({
        approval: { threadId: 'main', toolCallId: 'call-7', card: null, tier: 3 },
        decision: 'allow',
        signal: never,
        onText: () => undefined,
      });
      expect(outcome).toEqual({ kind: 'refused', reason });
    },
  );

  it('fails, without throwing, when the server cannot be reached or says no', async () => {
    const down = runnerFor(() => Promise.reject(new Error('offline')));
    expect(await down.sendMessage({ text: 'x', signal: never, onText: () => undefined })).toEqual({ kind: 'failed' });
    const busy = runnerFor(() =>
      Promise.resolve(Response.json({ error: { code: 'previous_turn_running' } }, { status: 409 })),
    );
    expect(await busy.sendMessage({ text: 'x', signal: never, onText: () => undefined })).toEqual({ kind: 'failed' });
  });

  it('still cancels a turn that was abandoned before the server named it, as soon as it is named', async () => {
    const cancelBodies: unknown[] = [];
    let open: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const runner = runnerFor((path, init) => {
      if (path.endsWith('/cancel')) {
        cancelBodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              open = controller;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });
    const abort = new AbortController();
    const sending = runner.sendMessage({ text: 'x', signal: abort.signal, onText: () => undefined });
    await new Promise(resolve => setTimeout(resolve, 10));
    abort.abort();
    // The caller is released at once, before the turn has a name.
    expect(await sending).toEqual({ kind: 'failed' });
    expect(cancelBodies).toEqual([]);
    open?.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify(created)}\n\n`));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(cancelBodies).toEqual([{ turn_id: 'turn-9' }]);
  });

  it('cancels the turn now running, not an abandoned one that was named late', async () => {
    const cancelBodies: unknown[] = [];
    const opens: ReadableStreamDefaultController<Uint8Array>[] = [];
    const encoder = new TextEncoder();
    const named = (id: string) => `id: 1\ndata: ${JSON.stringify({ ...created, turn_id: id })}\n\n`;
    const runner = runnerFor((path, init) => {
      if (path.endsWith('/cancel')) {
        cancelBodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              opens.push(controller);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });
    const first = new AbortController();
    const abandoned = runner.sendMessage({ text: 'one', signal: first.signal, onText: () => undefined });
    await new Promise(resolve => setTimeout(resolve, 10));
    first.abort();
    await abandoned;
    void runner.sendMessage({ text: 'two', signal: never, onText: () => undefined });
    await new Promise(resolve => setTimeout(resolve, 10));
    opens[1]?.enqueue(encoder.encode(named('turn-2')));
    await new Promise(resolve => setTimeout(resolve, 10));
    opens[0]?.enqueue(encoder.encode(named('turn-1')));
    await new Promise(resolve => setTimeout(resolve, 10));
    cancelBodies.length = 0;
    await runner.cancel();
    expect(cancelBodies).toEqual([{ turn_id: 'turn-2' }]);
  });

  it('cancels through the chat cancel route only while a turn it started is running', async () => {
    const seen: string[] = [];
    const cancelBodies: unknown[] = [];
    let open: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const runner = runnerFor((path, init) => {
      if (path.endsWith('/cancel')) {
        seen.push(path);
        cancelBodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              open = controller;
              controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify(created)}\n\n`));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    });
    await runner.cancel();
    expect(seen).toEqual([]);

    const sending = runner.sendMessage({ text: 'x', signal: never, onText: () => undefined });
    await new Promise(resolve => setTimeout(resolve, 20));
    await runner.cancel();
    expect(seen).toEqual(['/api/v1/sessions/chat%201/cancel']);
    // Only its own turn is named, so a message typed meanwhile in the same chat is left alone.
    expect(cancelBodies).toEqual([{ turn_id: 'turn-9' }]);

    open?.enqueue(encoder.encode(`id: 2\ndata: ${JSON.stringify(done([]))}\n\n`));
    await sending;
    await runner.cancel();
    expect(seen).toHaveLength(1);
  });
});

/** A spoken answer goes through the chat's own turns route; its refusals are told to the person, never reported as done. */
const says = (): Int16Array => Int16Array.from([...hum(900), ...quiet(900)]);

/** The first message is scripted to leave one card waiting; the answer goes to the real route. */
function cardThenRealRoute({ app, card }: { app: OpenAPIHono; card: PendingApproval }): VoiceTurnRunner {
  const real = new HttpVoiceTurnRunner({
    request: (path, init) => Promise.resolve(app.request(path.replace('/api/v1/sessions', ''), init)),
    sessionId: SESSION_ID,
  });
  return {
    sendMessage: ({ onText }) => {
      onText('I have a draft.');
      return Promise.resolve({ kind: 'done', turnId: 't1', approvals: [card] });
    },
    answerApproval: args => real.answerApproval(args),
    stillWaiting: args => real.stillWaiting(args),
    cancel: () => real.cancel(),
  };
}

async function answerAloud({
  words,
  error,
  toolCallId = TOOL_CALL_ID,
}: {
  words: string[];
  error?: Error;
  toolCallId?: string;
}) {
  if (error !== undefined) {
    jest.spyOn(SessionHandle.prototype, 'createTurn').mockRejectedValue(error);
  }
  const app = await buildApp(undefined, { heldAction: true });
  const clock = new ManualClock();
  const transport = new FakeTransport({ clock, voiceApprovals: true });
  const tts = new FakeTts();
  const session = new VoiceSession({
    transport,
    vad: new LoudnessVad(),
    stt: new FakeStt(...words),
    tts,
    turns: cardThenRealRoute({
      app,
      card: { threadId: 'main', toolCallId, card: sendReplyCard(), tier: 3 },
    }),
    clock,
  });
  session.start();
  await feed({ session, clock, samples: says() });
  await session.settled();
  await feed({ session, clock, samples: quiet(9000) });
  await feed({ session, clock, samples: says() });
  await session.settled();
  return tts.sentences.join(' ');
}

describe('a spoken answer through the real turns route', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['changed', APPROVAL_LINES.changed],
    ['expired', APPROVAL_LINES.expired],
    ['not_allowed', APPROVAL_LINES.notAllowed],
    // A card that belongs to another chat is not found in this one.
    ['tool_gone', APPROVAL_LINES.notAllowed],
  ] as const)('tells the person when the route says the card is %s, and never says done', async (reason, line) => {
    const spoken = await answerAloud({
      words: ['send the reply', 'yes send it'],
      error: new HeldActionRefusedError(reason),
    });
    expect(spoken).toContain(line);
    expect(spoken).not.toContain(APPROVAL_LINES.done('send'));
  });
});
