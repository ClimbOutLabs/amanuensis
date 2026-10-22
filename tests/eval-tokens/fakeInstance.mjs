// Minimal stand-in for the chat API the token eval calls. Invented data only.
// A prompt containing NEEDS_APPROVAL pauses once for one tool approval; NO_METRICS drops the metrics.
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'eval-tokens');

export async function loadFakeMetrics() {
  return JSON.parse(await readFile(path.join(fixtureDir, 'fake-metrics.json'), 'utf8'));
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isApprovalOnly(input) {
  return Array.isArray(input) && input.length > 0 && input.every(item => item?.type === 'user.tool_approval');
}

/**
 * @param {{ token: string, metrics: Record<string, Record<string, unknown>> }} options
 */
export async function startFakeInstance({ token, metrics, evalMode = true }) {
  const requests = [];
  const sessions = new Map();
  const turns = new Map();
  let counter = 0;
  const nextId = prefix => `${prefix}_fake_${String(++counter)}`;

  function publicTurn(turn) {
    return {
      id: turn.id,
      session_id: turn.session_id,
      previous_turn_id: turn.previous_turn_id,
      state: { status: 'running' },
      created_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function finalState(turn) {
    const completed_at = '2026-01-01T00:00:01.000Z';
    if (turn.pausesForApproval) {
      turn.pendingCallId ??= nextId('call');
      return {
        status: 'done',
        output: null,
        required_actions: [
          {
            type: 'tool.approval_required',
            id: nextId('evt'),
            created_at: completed_at,
            thread_id: 'main',
            tool_calls: [{ id: turn.pendingCallId, source_event_id: nextId('evt') }],
          },
        ],
        completed_at,
        metrics: metrics.paused,
      };
    }
    const decision = turn.approvalDecision;
    const text = decision === undefined ? 'FAKE REPLY' : `FAKE REPLY (${decision})`;
    const state = {
      status: 'done',
      output: {
        type: 'model.message',
        id: nextId('msg'),
        thread_id: 'main',
        content: `${text}: ${turn.prompt.slice(0, 40)}`,
      },
      required_actions: [],
      completed_at,
    };
    if (turn.noMetrics !== true) {
      state.metrics = decision === undefined ? metrics.plain : metrics.resumed;
    }
    return state;
  }

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      body = undefined;
    }
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });

    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { status: 'ok', version: 'fake', eval_mode: evalMode });
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: { message: 'Sign in again.' } });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const turnMatch = /^\/api\/v1\/sessions\/([^/]+)\/turns(?:\/([^/]+))?$/.exec(url.pathname);

    if (req.method === 'POST' && url.pathname === '/api/v1/sessions') {
      const model = body?.agent?.spec?.model?.name;
      const temperature = body?.agent?.spec?.model?.params?.temperature;
      if (typeof model !== 'string' || typeof temperature !== 'number') {
        send(res, 400, { error: { message: 'agent.spec.model needs a name and a temperature.' } });
        return;
      }
      const id = nextId('sess');
      sessions.set(id, { id });
      send(res, 201, { data: { id, agent: { type: 'inline', spec: body.agent.spec } } });
      return;
    }

    const isTurnsCollection = turnMatch !== null && turnMatch[2] === undefined;
    const isTurnItem = turnMatch !== null && turnMatch[2] !== undefined;

    if (req.method === 'POST' && isTurnsCollection) {
      const sessionId = turnMatch[1];
      if (!sessions.has(sessionId)) {
        send(res, 404, { error: { message: 'Session not found.' } });
        return;
      }
      if (body?.stream !== false || !Array.isArray(body.input)) {
        send(res, 400, { error: { message: 'Expected stream false and an input array.' } });
        return;
      }
      const id = nextId('turn');
      if (isApprovalOnly(body.input)) {
        const previous = turns.get(body.previous_turn_id);
        const decisions = body.input;
        const matches =
          previous !== undefined &&
          previous.session_id === sessionId &&
          previous.pendingCallId !== undefined &&
          decisions.every(item => item.tool_call_id === previous.pendingCallId && item.thread_id === 'main');
        if (!matches) {
          send(res, 409, { error: { message: 'No pending approval matches this input.' } });
          return;
        }
        const decision = decisions[0].approval.status;
        const turn = {
          id,
          session_id: sessionId,
          previous_turn_id: previous.id,
          prompt: previous.prompt,
          pausesForApproval: false,
          approvalDecision: decision === 'allow' ? 'approved' : 'declined',
          polls: 1,
        };
        turns.set(id, turn);
        send(res, 200, { data: publicTurn(turn) });
        return;
      }
      const message = body.input[0];
      if (body.input.length !== 1 || message?.type !== 'user.message' || typeof message.content !== 'string') {
        send(res, 400, { error: { message: 'Expected one user message.' } });
        return;
      }
      const turn = {
        id,
        session_id: sessionId,
        previous_turn_id: null,
        prompt: message.content,
        pausesForApproval: message.content.includes('NEEDS_APPROVAL'),
        noMetrics: message.content.includes('NO_METRICS'),
        polls: 1,
      };
      turns.set(id, turn);
      send(res, 200, { data: publicTurn(turn) });
      return;
    }

    if (req.method === 'GET' && isTurnItem) {
      const turn = turns.get(turnMatch[2]);
      if (turn === undefined || turn.session_id !== turnMatch[1]) {
        send(res, 404, { error: { message: 'Turn not found.' } });
        return;
      }
      if (turn.polls > 0) {
        turn.polls -= 1;
        send(res, 200, { data: publicTurn(turn) });
        return;
      }
      send(res, 200, { data: { ...publicTurn(turn), state: finalState(turn) } });
      return;
    }

    send(res, 404, { error: { message: 'Not found.' } });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fake instance did not bind to a port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
