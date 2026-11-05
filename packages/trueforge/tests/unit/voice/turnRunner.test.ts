import { HttpVoiceTurnRunner, type SessionRequest } from '../../../src/voice/turnRunner';
import { sendReplyCard } from '../../fixtures/voice/cards';

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
      input: [{ type: 'user.tool_approval', thread_id: 'main', tool_call_id: 'call-7', approval: { status: 'allow' } }],
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

  it('cancels through the chat cancel route', async () => {
    const seen: string[] = [];
    await runnerFor(path => {
      seen.push(path);
      return Promise.resolve(Response.json({}));
    }).cancel();
    expect(seen).toEqual(['/api/v1/sessions/chat%201/cancel']);
  });
});
