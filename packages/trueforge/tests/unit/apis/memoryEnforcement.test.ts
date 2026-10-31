/**
 * Proves the host-enforced memory feature's WIRING end to end: the real HTTP API, the real
 * session store, and a fake Hindsight HTTP server standing in for the memory provider.
 *
 * Mirrors memoryFlow.test.ts's harness style (boot the real app via `startApprovalTestServer`,
 * drive `POST /api/v1/sessions/{id}/turns` and the turn/event reads, judge outcomes by
 * persisted state plus a fixture's invocation record) but exercises the Hindsight-backed
 * capability (`runtime/memory/{hindsightClient,memoryCapability,memoryRetain,memoryEvents,
 * memoryProvider}.ts`, wired in `apis/turns.ts`) instead of the inert MCP connector's tools.
 *
 * One sequential describe block shares a single app boot and a single fake Hindsight server:
 *   1. Register the fake server as the memory provider connector.
 *   2. First turn: recall runs before the model call, the block is injected ephemerally (never
 *      persisted), and the outcome lands on the turn's own event stream.
 *   3. The completed turn's exchange is retained asynchronously (fire-and-forget on turn.done).
 *   4. Second turn: recall runs again, and the sweep verifies (not resubmits) turn 1's retain.
 *   5. A turn against an unreachable provider still completes with the scripted answer; recall
 *      degrades to a logged timeout/error with no injected block.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import configuration from '../../../src/config';
import { MEMORY_FRAMING_SENTENCE } from '../../../src/runtime/memory/memoryCapability';
import { MEMORY_PROBE_QUERY } from '../../../src/runtime/memory/memoryProbe';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetMcpServerResponseSchema } from '../../../src/schemas/mcpServer';
import { GetTurnResponseSchema, ListTurnEventsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { FINAL_TEXT } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const RETAIN_POLL_TIMEOUT_MS = 2_000;

const MEMORY_PROVIDER_NAME = 'hindsight-test';
const MEMORY_BANK = 'test-bank';
const MEMORY_TOKEN = 'test-token';

const RECALL_PATH = `/v1/default/banks/${MEMORY_BANK}/memories/recall`;
const RETAIN_PATH = `/v1/default/banks/${MEMORY_BANK}/memories`;
const OPERATIONS_PREFIX = `/v1/default/banks/${MEMORY_BANK}/operations/`;

const CANNED_ITEM_TEXT = 'The user prefers oat milk and is allergic to shellfish.';
const CANNED_SECOND_ITEM_TEXT = 'The user lives in Portland, Oregon.';
const CANNED_ENTITY_NAME = 'Portland Roasters';
const CANNED_ENTITY_OBSERVATION = 'A local coffee shop the user visits weekly.';

const USER_MESSAGE_1 = 'What do you remember about my dietary restrictions?';
const USER_MESSAGE_2 = 'Any updates on what we discussed before?';
const USER_MESSAGE_3 = 'Just checking in, no tools needed here.';

function cannedRecallResponse() {
  return {
    results: [
      { id: 'mem-1', text: CANNED_ITEM_TEXT, occurred_start: '2026-01-05T00:00:00.000Z' },
      { id: 'mem-2', text: CANNED_SECOND_ITEM_TEXT, occurred_start: '2026-02-10T00:00:00.000Z' },
    ],
    entities: {
      [CANNED_ENTITY_NAME]: {
        canonical_name: CANNED_ENTITY_NAME,
        observations: [{ text: CANNED_ENTITY_OBSERVATION, mentioned_at: '2026-02-10T00:00:00.000Z' }],
      },
    },
  };
}

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

interface FakeHindsightServer {
  /** Manifest `url`: `{apiBase}/mcp/{bank}/`, matching `parseMemoryProviderUrl`'s contract. */
  url: string;
  requests: () => readonly RecordedRequest[];
  /** Recalls made for a turn: the save-time connection check's own recall is excluded. */
  recallRequests: () => readonly RecordedRequest[];
  /** Recalls made by the memory-provider connection check on save. */
  checkRecallRequests: () => readonly RecordedRequest[];
  retainRequests: () => readonly RecordedRequest[];
  operationRequests: () => readonly RecordedRequest[];
  lastAuthorizationHeader: () => string | undefined;
  /** Closes the listening socket, simulating the provider going down. Idempotent. */
  stop: () => Promise<void>;
  close: () => Promise<void>;
}

function readFakeHindsightRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', error => {
      reject(new Error('fake Hindsight fixture could not read the request body', { cause: error }));
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('fake Hindsight fixture received a non-JSON body', { cause: error }));
      }
    });
  });
}

async function startFakeHindsightServer(): Promise<FakeHindsightServer> {
  const requests: RecordedRequest[] = [];
  let lastAuthorizationHeader: string | undefined;
  let running = true;

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization;
    lastAuthorizationHeader = typeof authHeader === 'string' ? authHeader : undefined;

    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = await readFakeHindsightRequestBody(req);
    requests.push({ method, path: pathname, body, authorization: lastAuthorizationHeader });

    if (method === 'POST' && pathname === RECALL_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(cannedRecallResponse()));
      return;
    }
    if (method === 'POST' && pathname === RETAIN_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
    if (method === 'GET' && pathname.startsWith(OPERATIONS_PREFIX)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `fake Hindsight fixture has no route for ${method} ${pathname}` }));
  }

  const httpServer: Server = createServer((req, res) => {
    void dispatch(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'fake Hindsight fixture failed' }));
    });
  });

  await new Promise<void>(resolve => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake Hindsight fixture did not bind a TCP port');
  }
  const url = `http://127.0.0.1:${String(address.port)}/mcp/${MEMORY_BANK}/`;

  async function stopServer(): Promise<void> {
    if (!running) {
      return;
    }
    running = false;
    await new Promise<void>((resolve, reject) => {
      httpServer.closeAllConnections();
      httpServer.close(error => {
        if (error) {
          reject(new Error('fake Hindsight fixture failed to close', { cause: error }));
          return;
        }
        resolve();
      });
    });
  }

  function isCheckRecall(request: RecordedRequest): boolean {
    if (request.path !== RECALL_PATH) {
      return false;
    }
    const body = request.body;
    return body !== null && typeof body === 'object' && (body as { query?: unknown }).query === MEMORY_PROBE_QUERY;
  }

  return {
    url,
    requests: () => requests,
    recallRequests: () => requests.filter(request => request.path === RECALL_PATH && !isCheckRecall(request)),
    checkRecallRequests: () => requests.filter(isCheckRecall),
    retainRequests: () => requests.filter(request => request.method === 'POST' && request.path === RETAIN_PATH),
    operationRequests: () => requests.filter(request => request.path.startsWith(OPERATIONS_PREFIX)),
    lastAuthorizationHeader: () => lastAuthorizationHeader,
    stop: stopServer,
    close: stopServer,
  };
}

function memoryProviderManifest(hindsightUrl: string) {
  return {
    type: 'remote' as const,
    name: MEMORY_PROVIDER_NAME,
    url: hindsightUrl,
    description: 'Fake Hindsight memory provider used by memoryEnforcement tests.',
    memory_provider: true,
    auth: { type: 'header' as const, headers: { Authorization: `Bearer ${MEMORY_TOKEN}` } },
  };
}

const RecallRequestBodySchema = z.object({
  query: z.string(),
  max_tokens: z.number(),
  query_timestamp: z.string(),
  types: z.array(z.string()),
  prefer_observations: z.boolean(),
  include: z.object({ entities: z.object({ max_tokens: z.number() }) }),
});

const RetainRequestBodySchema = z.object({
  items: z.array(
    z.object({
      content: z.string(),
      timestamp: z.string(),
      document_id: z.string(),
      context: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  ),
  async: z.boolean(),
  operation_id: z.string(),
});

function jsonInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function agentSpec() {
  return {
    model: { name: MODEL_FQN },
    instructions: 'Answer plainly; no tools are needed for these tests.',
    config: {
      sandbox: { enabled: false },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  };
}

function plainMessage(text: string): TurnInputItem[] {
  return [{ type: 'user.message', content: text }];
}

async function createSession(server: ApprovalTestServer, spec: ReturnType<typeof agentSpec>): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit('POST', { agent: { spec } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

function turnIdFromStream(streamBody: string): string {
  for (const line of streamBody.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
    if (event.type === 'turn.created') {
      return event.turn_id;
    }
  }
  throw new Error(`turn stream carried no turn.created event: ${streamBody.slice(0, 400)}`);
}

async function getTurn({
  server,
  sessionId,
  turnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  turnId: string;
}): Promise<Turn> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`get turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return GetTurnResponseSchema.parse(body).data;
}

/** Runs one turn to completion by draining its SSE stream, then returns the persisted turn. */
async function runTurn({
  server,
  sessionId,
  input,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit('POST', { input, stream: true }),
  );
  if (response.status !== 200) {
    const body: unknown = await response.json();
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  const turnId = turnIdFromStream(await response.text());
  return getTurn({ server, sessionId, turnId });
}

async function listTurnEvents(server: ApprovalTestServer, sessionId: string, turnId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}/events`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list turn events failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return ListTurnEventsResponseSchema.parse(body).data;
}

function requiredActions(turn: Turn): unknown[] {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions;
}

/** Flattened text of the final `model.message` output, or '' when the turn paused without one. */
function outputText(turn: Turn): string {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  const content = turn.state.output?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(part =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met before timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Flattens a scripted-model chat message's `content` (string or content-part array) to text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(part =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join(' ');
  }
  return '';
}

/** The line that opens a recalled-memory block; the static instruction only names the tag. */
const MEMORY_BLOCK_OPENING = '<aman-memory>\n';

function memoryBlockMessages(messages: readonly { role: string; content?: unknown }[]) {
  return messages.filter(message => contentText(message.content).includes(MEMORY_BLOCK_OPENING));
}

describe('Host-enforced memory: wiring through the real HTTP API and session store', () => {
  let server: ApprovalTestServer;
  let hindsight: FakeHindsightServer;
  let sessionId: string;
  let turn1: Turn;
  let turn1OperationId: string;

  const originalBackend = configuration.MEMORY_BACKEND;

  beforeAll(async () => {
    // The Hindsight capability is only wired when this backend is selected; the default is markdown.
    configuration.MEMORY_BACKEND = 'hindsight';
    server = await startApprovalTestServer();
    hindsight = await startFakeHindsightServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    configuration.MEMORY_BACKEND = originalBackend;
    await server.close();
    await hindsight.close();
  });

  it('registers the fake Hindsight connector as the memory provider, checking its REST API first', async () => {
    const putResponse = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit('PUT', { manifest: memoryProviderManifest(hindsight.url) }),
    );
    expect(putResponse.status).toBe(200);
    const put = GetMcpServerResponseSchema.parse(await putResponse.json());
    expect(put.data.manifest.type === 'remote' ? put.data.manifest.memory_provider : undefined).toBe(true);
    expect(put.data.manifest.url).toBe(hindsight.url);

    // The save verified the REST recall path itself, carrying the connector's resolved header.
    const checkRecalls = hindsight.checkRecallRequests();
    expect(checkRecalls).toHaveLength(1);
    expect(checkRecalls[0]?.authorization).toBe(`Bearer ${MEMORY_TOKEN}`);

    const getResponse = await server.request(`/api/v1/settings/mcp-servers/${MEMORY_PROVIDER_NAME}`);
    expect(getResponse.status).toBe(200);
    const got = GetMcpServerResponseSchema.parse(await getResponse.json());
    expect(got.data.manifest.type === 'remote' ? got.data.manifest.memory_provider : undefined).toBe(true);
  });

  it(
    'first turn: recalls before the model call, injects the block ephemerally, and records the outcome',
    async () => {
      sessionId = await createSession(server, agentSpec());
      turn1 = await runTurn({ server, sessionId, input: plainMessage(USER_MESSAGE_1) });

      expect(requiredActions(turn1)).toEqual([]);
      expect(outputText(turn1)).toContain(FINAL_TEXT);

      // (a) exactly one recall call, carrying the user message as `query` and the resolved
      // `Authorization` header.
      const recallRequests = hindsight.recallRequests();
      expect(recallRequests).toHaveLength(1);
      const recallRequest = recallRequests[0];
      if (!recallRequest) {
        throw new Error('expected a recorded recall request');
      }
      expect(recallRequest.authorization).toBe(`Bearer ${MEMORY_TOKEN}`);
      const recallBody = RecallRequestBodySchema.parse(recallRequest.body);
      expect(recallBody.query).toBe(USER_MESSAGE_1);

      // (b) the scripted model saw the `<aman-memory>` block, carrying the canned memory text, in
      // a host-context message of its own. The person's words are the last message, alone and unchanged.
      const modelRequests = server.model.requests();
      const turn1ModelRequest = modelRequests[modelRequests.length - 1];
      if (!turn1ModelRequest) {
        throw new Error('expected the scripted model server to have received a request for turn 1');
      }
      const lastMessage = turn1ModelRequest.messages[turn1ModelRequest.messages.length - 1];
      expect(lastMessage?.role).toBe('user');
      expect(contentText(lastMessage?.content)).toBe(USER_MESSAGE_1);
      const contextMessage = turn1ModelRequest.messages[turn1ModelRequest.messages.length - 2];
      expect(contextMessage?.role).toBe('user');
      // The block is never in a system message, since recalled text is data, not instructions.
      expect(memoryBlockMessages(turn1ModelRequest.messages)).toEqual([contextMessage]);
      const contextText = contentText(contextMessage?.content);
      expect(contextText.indexOf("Today's date")).toBeGreaterThan(-1);
      expect(contextText.indexOf("Today's date")).toBeLessThan(contextText.indexOf(MEMORY_BLOCK_OPENING));
      expect(contextText).toContain(CANNED_ITEM_TEXT);
      expect(contextText).not.toContain(USER_MESSAGE_1);
      // The framing that marks recalled text as data stays inside the block the model reads.
      expect(contextText).toContain(MEMORY_FRAMING_SENTENCE);
      // The label says the notes are not the person's message and to answer the one that follows.
      expect(contextText).toContain("Answer the person's own message");

      // (c) the turn's own persisted events carry the recall outcome, injected_block included
      // verbatim.
      const events = await listTurnEvents(server, sessionId, turn1.id);
      const recallEvent = events.find(event => event.type === 'aman.memory.recall');
      if (!recallEvent) {
        throw new Error('expected an aman.memory.recall event on turn 1');
      }
      expect(recallEvent.injected_block).toContain(CANNED_ITEM_TEXT);
      expect(recallEvent.stats.outcome).toBe('ok');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'retains the completed turn asynchronously, without blocking the response',
    async () => {
      await waitFor(() => hindsight.retainRequests().length >= 1, RETAIN_POLL_TIMEOUT_MS);
      const retainRequest = hindsight.retainRequests()[0];
      if (!retainRequest) {
        throw new Error('expected the fake Hindsight server to have received a retain POST for turn 1');
      }
      const retainBody = RetainRequestBodySchema.parse(retainRequest.body);
      expect(retainBody.async).toBe(true);
      expect(retainBody.operation_id.length).toBeGreaterThan(0);
      const item = retainBody.items[0];
      if (!item) {
        throw new Error('expected the retain request to carry one item');
      }
      expect(item.content).toContain(USER_MESSAGE_1);
      expect(item.content).toContain(FINAL_TEXT);
      expect(item.document_id).toContain(sessionId);
      expect(item.document_id).toContain(turn1.id);

      turn1OperationId = retainBody.operation_id;
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "second turn: recalls again, and the sweep verifies (never resubmits) turn 1's retain",
    async () => {
      const turn2 = await runTurn({ server, sessionId, input: plainMessage(USER_MESSAGE_2) });

      expect(requiredActions(turn2)).toEqual([]);
      expect(hindsight.recallRequests()).toHaveLength(2);

      // The sweep polled turn 1's operation id and saw it completed.
      const operationRequests = hindsight.operationRequests();
      expect(operationRequests.some(request => request.path === `${OPERATIONS_PREFIX}${turn1OperationId}`)).toBe(true);

      // Turn 1's retain was submitted exactly once: the sweep verified it rather than
      // resubmitting it. (Turn 2's own completion fires its own, differently-keyed retain
      // submission independently, so this checks the operation id rather than the raw count.)
      const turn1RetainSubmissions = hindsight
        .retainRequests()
        .filter(request => RetainRequestBodySchema.parse(request.body).operation_id === turn1OperationId);
      expect(turn1RetainSubmissions).toHaveLength(1);

      // (d) the stored thread context never carries the `<aman-memory>` block turn 1 got: the
      // history for turn 1's own message stays clean, and exactly one message in this whole
      // request — the one freshly spliced in for turn 2 — carries the tag.
      const modelRequests = server.model.requests();
      const turn2ModelRequest = modelRequests[modelRequests.length - 1];
      if (!turn2ModelRequest) {
        throw new Error('expected the scripted model server to have received a request for turn 2');
      }
      // The system prompt's own memory instructions mention the `<aman-memory>` tag by name, so
      // this counts only messages that carry the block's opening line.
      expect(memoryBlockMessages(turn2ModelRequest.messages)).toHaveLength(1);

      const turn1HistoryMessages = turn2ModelRequest.messages.filter(
        message => message.role === 'user' && contentText(message.content).includes(USER_MESSAGE_1),
      );
      expect(turn1HistoryMessages).toHaveLength(1);
      expect(contentText(turn1HistoryMessages[0]?.content)).not.toContain('<aman-memory>');

      const turn2Last = turn2ModelRequest.messages[turn2ModelRequest.messages.length - 1];
      expect(turn2Last?.role).toBe('user');
      expect(contentText(turn2Last?.content)).toBe(USER_MESSAGE_2);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'the person-level memory switch turns recall off for a chat on a saved agent',
    async () => {
      const created = await server.request(
        '/api/v1/agents',
        jsonInit('POST', { name: 'saved-assistant', description: 'Saved test agent.', manifest: agentSpec() }),
      );
      expect(created.status).toBe(201);
      const savedSession = async (): Promise<string> => {
        const response = await server.request(
          '/api/v1/sessions',
          jsonInit('POST', { agent: { name: 'saved-assistant' } }),
        );
        expect(response.status).toBe(201);
        return z.object({ data: z.object({ id: z.string() }).loose() }).parse(await response.json()).data.id;
      };

      // With the switch unset, the saved agent's own setting (on) applies and recall runs.
      const recallsBefore = hindsight.recallRequests().length;
      const onSession = await savedSession();
      const onTurn = await runTurn({ server, sessionId: onSession, input: plainMessage(USER_MESSAGE_1) });
      expect(hindsight.recallRequests()).toHaveLength(recallsBefore + 1);
      const onEvent = (await listTurnEvents(server, onSession, onTurn.id)).find(
        event => event.type === 'aman.memory.recall',
      );
      expect(onEvent?.injected_block).toContain(CANNED_ITEM_TEXT);

      const off = await server.request('/api/v1/settings/memory-recalls', jsonInit('PUT', { enabled: false }));
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ data: { enabled: false } });

      // A new chat with the same saved agent recalls nothing and sends no block to the model.
      const offSession = await savedSession();
      const offTurn = await runTurn({ server, sessionId: offSession, input: plainMessage(USER_MESSAGE_1) });
      expect(requiredActions(offTurn)).toEqual([]);
      expect(hindsight.recallRequests()).toHaveLength(recallsBefore + 1);
      const offEvent = (await listTurnEvents(server, offSession, offTurn.id)).find(
        event => event.type === 'aman.memory.recall',
      );
      expect(offEvent?.injected_block).toBeNull();
      const modelRequests = server.model.requests();
      const lastRequest = modelRequests[modelRequests.length - 1];
      expect(lastRequest ? memoryBlockMessages(lastRequest.messages) : undefined).toEqual([]);

      // Clearing the switch hands the choice back to the agent.
      const cleared = await server.request('/api/v1/settings/memory-recalls', jsonInit('PUT', { enabled: null }));
      expect(await cleared.json()).toEqual({ data: { enabled: null } });
      const backSession = await savedSession();
      await runTurn({ server, sessionId: backSession, input: plainMessage(USER_MESSAGE_1) });
      expect(hindsight.recallRequests()).toHaveLength(recallsBefore + 2);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'failure path: an unreachable provider degrades to no memory, and the turn still completes',
    async () => {
      await hindsight.stop();

      const otherSessionId = await createSession(server, agentSpec());
      const turn3 = await runTurn({ server, sessionId: otherSessionId, input: plainMessage(USER_MESSAGE_3) });

      expect(requiredActions(turn3)).toEqual([]);
      expect(outputText(turn3)).toContain(FINAL_TEXT);

      const events = await listTurnEvents(server, otherSessionId, turn3.id);
      const recallEvent = events.find(event => event.type === 'aman.memory.recall');
      if (!recallEvent) {
        throw new Error('expected an aman.memory.recall event on turn 3');
      }
      expect(['timeout', 'error']).toContain(recallEvent.stats.outcome);
      expect(recallEvent.injected_block).toBeNull();
    },
    TURN_TIMEOUT_MS,
  );
});
