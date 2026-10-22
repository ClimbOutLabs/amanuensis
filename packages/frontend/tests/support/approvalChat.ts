/** A real server app behind Vite, with a chat paused on an approval card, for browser tests. */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import type { Plugin } from 'vite';

import { MODEL_FQN, type ApprovalTestServer } from '../../../trueforge/tests/fixtures/approvalTestServer.ts';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [
    { name: 'inert', preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Serves `/api/*` from the real server app in this process, as the dev proxy would. */
export function inProcessApi(api: ApprovalTestServer): Plugin {
  return {
    name: 'in-process-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (url === undefined || !url.startsWith('/api/')) {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          const method = req.method ?? 'GET';
          const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks);
          api
            .request(url, { method, headers, body })
            .then(response => {
              res.statusCode = response.status;
              response.headers.forEach((value, name) => res.setHeader(name, value));
              if (response.body === null) {
                res.end();
                return;
              }
              Readable.fromWeb(response.body).pipe(res);
            })
            .catch((error: unknown) => {
              res.statusCode = 500;
              res.end(String(error));
            });
        });
      });
    },
  };
}

/** A real paused turn: the scripted model asks to run the write tool, and the card waits. */
export async function pausedSession(api: ApprovalTestServer): Promise<{ sessionId: string; pausedTurnId: string }> {
  const session = await api.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  assert.equal(session.status, 201);
  const sessionId = ((await session.json()) as { data: { id: string } }).data.id;
  const turn = await api.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input: [{ type: 'user.message', content: 'run:inert_write please' }], stream: true }),
  );
  assert.equal(turn.status, 200);
  // Draining the stream waits for the turn to pause; its first event names the turn.
  const created =
    /"type":"turn\.created"[^}]*?"turn_id":"([^"]+)"|"turn_id":"([^"]+)"[^}]*?"type":"turn\.created"/.exec(
      await turn.text(),
    );
  const pausedTurnId = created?.[1] ?? created?.[2];
  if (pausedTurnId === undefined) throw new Error('the turn stream named no turn');
  assert.equal(await waitingCallIds({ api, sessionId, turnId: pausedTurnId }), 1);
  return { sessionId, pausedTurnId };
}

/** How many cards a turn still waits on, as the server shows it. */
export async function waitingCallIds({
  api,
  sessionId,
  turnId,
}: {
  api: ApprovalTestServer;
  sessionId: string;
  turnId: string;
}): Promise<number> {
  const response = await api.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  const body = (await response.json()) as {
    data: { state: { status: string; required_actions?: Array<{ tool_calls: unknown[] }> } };
  };
  if (body.data.state.status !== 'done') return 0;
  return (body.data.state.required_actions ?? []).reduce((total, action) => total + action.tool_calls.length, 0);
}
