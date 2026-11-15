/**
 * Walks a connector's retrieval tools over the HTTP surface with the inert MCP connector's
 * `ask_memory` / `search_memory` tools.
 *
 * Mirrors approvalFlow.test.ts's harness style: drive `POST /api/v1/sessions/{id}/turns`
 * and the turn/event reads, and judge outcomes by state transitions plus the connector's
 * invocation counters — the counters are the only evidence that a call actually reached
 * the mock server, independent of what the UI would render.
 *
 * The connector under test is one a person added, so each retrieval tool asks before it runs.
 *
 * Five axes:
 *   1. SUCCESS       — an approved retrieval tool runs and its result reaches the turn events.
 *   2. ABSTENTION    — an empty result arrives as an honest, non-error empty.
 *   3. PAUSE         — a fully-deferred (preload:false) connector contributes nothing and
 *      is never dialed at turn init; a later call against it while down never reaches the
 *      mock server, raises no approval card, never fails the turn and never corrupts the
 *      session: it lands as a never_ran tool.response.v2 that tells the model the connector
 *      is unreachable.
 *   4. RESUME        — the connector coming back needs no re-registration.
 *   5. RESTART/ROTATION — a header reference persists verbatim; resolving it into the
 *      live request is pinned only once the resolver (owned by a concurrent change to
 *      schemas/mcpServer.ts, runtime/sessionResources.ts, and utils/secretRedaction.ts)
 *      has actually landed.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_ID } from '../../../src/apis/sessions';
import { ListSessionEventsResponseSchema, TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetMcpServerResponseSchema } from '../../../src/schemas/mcpServer';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  EMPTY_MEMORY_RESULT,
  INERT_ASK_MEMORY_TOOL,
  INERT_SEARCH_MEMORY_TOOL,
  INERT_SERVER_NAME,
  populatedMemoryResult,
} from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX, SERVER_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;

/**
 * Best-effort, import-free capability probe for the header-reference resolver described in
 * ops/memory/DESIGN.md (`^\$\{(env|file):.+\}$`). This reads source text under `src/` — it
 * never imports the module under active concurrent edit, so it cannot break typecheck while
 * that change is mid-flight, and it cannot go stale in a way that breaks the build either. A
 * false negative (staying "not wired" a little longer than true) is the safe failure
 * direction, since it only delays exercising the axis-5 resolution test, never falsely
 * greenlights it.
 */
function referenceResolutionIsWired(): boolean {
  const marker = '(env|file)';
  const root = join(__dirname, '../../../src');
  const seen = new Set<string>();

  function scanDir(dir: string): boolean {
    if (seen.has(dir)) {
      return false;
    }
    seen.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scanDir(full)) {
          return true;
        }
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        try {
          if (readFileSync(full, 'utf8').includes(marker)) {
            return true;
          }
        } catch {
          // Unreadable file: not a signal either way.
        }
      }
    }
    return false;
  }

  try {
    return scanDir(root);
  } catch {
    return false;
  }
}

const REFERENCE_RESOLUTION_LIVE = referenceResolutionIsWired();

function jsonInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function agentSpec({
  preload,
  forceApprovalTools = [],
  server = INERT_SERVER_NAME,
}: {
  preload: boolean;
  forceApprovalTools?: string[];
  server?: string;
}) {
  return {
    model: { name: MODEL_FQN },
    instructions: 'Use the memory tools exactly as instructed.',
    mcp_servers: [
      {
        name: server,
        preload,
        // A tool on a connector a person added asks whatever its hints say. `forceApprovalTools`
        // names one explicitly as well, the same way approvalFlow.test.ts does for its chat-grant test.
        require_approval_for_tools: ['@write', '@destructive', '@unclassified', ...forceApprovalTools],
      },
    ],
    config: {
      sandbox: { enabled: false },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  };
}

/** `server` only matters for `call_tool`, which reaches a deferred connector's tool by name. */
function userMessage(tool: string, { server = INERT_SERVER_NAME }: { server?: string } = {}): TurnInputItem[] {
  return [
    { type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${tool} ${SERVER_DIRECTIVE_PREFIX}${server} please` },
  ];
}

function plainMessage(text: string): TurnInputItem[] {
  return [{ type: 'user.message', content: text }];
}

function approvalInput({
  thread_id,
  tool_call_id,
  approval,
}: {
  thread_id: string;
  tool_call_id: string;
  approval: { status: 'allow'; scope?: 'once' | 'chat' } | { status: 'deny'; reason?: string };
}): TurnInputItem[] {
  return [{ type: 'user.tool_approval', thread_id, tool_call_id, approval }];
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

async function waitForTerminalTurn({
  server,
  sessionId,
  turnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  turnId: string;
}): Promise<Turn> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const turn = await getTurn({ server, sessionId, turnId });
    if (turn.state.status !== 'running') {
      return turn;
    }
    if (Date.now() > deadline) {
      throw new Error(`turn ${turnId} never left the running state`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function requiredActions(turn: Turn): unknown[] {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions;
}

interface PendingApproval {
  thread_id: string;
  tool_call_id: string;
}

/** The turn's single pending approval, or undefined when the turn paused for nothing. */
function pendingApproval(turn: Turn): PendingApproval | undefined {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  for (const action of turn.state.required_actions) {
    if (action.type === 'tool.approval_required') {
      const first = action.tool_calls[0];
      if (first === undefined) {
        continue;
      }
      return { thread_id: action.thread_id, tool_call_id: first.id };
    }
  }
  return undefined;
}

async function listSessionEvents(server: ApprovalTestServer, sessionId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/events`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list session events failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return ListSessionEventsResponseSchema.parse(body).data;
}

const ToolResponseSchema = z.object({
  type: z.literal('tool.response.v2'),
  tool_call_id: z.string(),
  content: z.string(),
  disposition: z.enum(['denied', 'policy_blocked', 'executed_ok', 'executed_nonzero', 'never_ran', 'outcome_unknown']),
});

const ToolResponseContentSchema = z.object({
  schema_version: z.literal('tool.response.v2'),
  result: z.unknown(),
});

/** Every canonical tool result on the session, oldest first. */
async function toolResponses(server: ApprovalTestServer, sessionId: string) {
  const items = await listSessionEvents(server, sessionId);
  const responses: {
    tool_call_id: string;
    disposition: z.infer<typeof ToolResponseSchema>['disposition'];
    result: unknown;
  }[] = [];
  for (const item of items) {
    const parsed = ToolResponseSchema.safeParse(item.event);
    if (parsed.success) {
      const content = ToolResponseContentSchema.parse(JSON.parse(parsed.data.content));
      responses.push({
        tool_call_id: parsed.data.tool_call_id,
        disposition: parsed.data.disposition,
        result: content.result,
      });
    }
  }
  return responses;
}

describe('retrieval tools over the inert connector', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    server.mcp.resetInvocations();
    server.mcp.restore();
    // A prior PAUSE test always restarts the connector itself, but guard here too so a
    // thrown assertion mid-test can never leave the connector down for the next one.
    await server.mcp.start();
  });

  /** Runs a turn that asks for one tool, approves its card, and returns the resumed turn. */
  async function runApproved({ sessionId, input }: { sessionId: string; input: TurnInputItem[] }): Promise<Turn> {
    const asked = await runTurn({ server, sessionId, input });
    const pending = pendingApproval(asked);
    if (!pending) {
      throw new Error(`expected the tool to ask first: ${JSON.stringify(asked.state)}`);
    }
    return runTurn({ server, sessionId, input: approvalInput({ ...pending, approval: { status: 'allow' } }) });
  }

  it(
    'SUCCESS: an approved retrieval tool runs, and its result reaches the turn events verbatim',
    async () => {
      const sessionId = await createSession(server, agentSpec({ preload: true }));
      const turn = await runApproved({ sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

      expect(requiredActions(turn)).toEqual([]);
      expect(server.mcp.askMemoryInvocations()).toBe(1);

      const responses = await toolResponses(server, sessionId);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.disposition).toBe('executed_ok');
      expect(responses[0]?.result).toEqual(populatedMemoryResult('inert'));
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'ABSTENTION SUBSTRATE: an empty result arrives as an honest tool.response.v2, not an error and not filler',
    async () => {
      server.mcp.setAskMemoryMode('empty');
      const sessionId = await createSession(server, agentSpec({ preload: true }));
      const turn = await runApproved({ sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

      // No turn-level failure: the harness treated this as a normal, successful tool call, never
      // a synthesized error.
      expect(requiredActions(turn)).toEqual([]);

      const responses = await toolResponses(server, sessionId);
      expect(responses).toHaveLength(1);
      const parsed: unknown = responses[0]?.result;
      // executeToolCalls.ts wraps an isError:true result as `{ error: result.content }`; an
      // exact match against the bare empty structure is proof both that isError stayed false
      // and that no retry/"not executed" text was injected on top of it.
      expect(parsed).toEqual(EMPTY_MEMORY_RESULT);
      expect(parsed).not.toHaveProperty('error');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'PAUSE: a mid-session call against a stopped connector raises no approval card, never runs, and tells the model the connector is unreachable',
    async () => {
      // Classifying a tool call connects to the server live, every turn. When that connect
      // fails at the transport (the server is down), the call is marked never_ran with a
      // connector_unreachable remediation: a server that cannot be reached cannot run
      // anything, so there is nothing for the person to approve.
      const sessionId = await createSession(server, agentSpec({ preload: false }));
      await runTurn({ server, sessionId, input: plainMessage('opening the session, no tools yet') });
      expect(server.mcp.askMemoryInvocations()).toBe(0);

      await server.mcp.stop();
      const down = await runTurn({ server, sessionId, input: userMessage('call_tool') });
      await server.mcp.start();

      // The call never reached the fixture's handler, and the turn finished without a card.
      expect(server.mcp.askMemoryInvocations()).toBe(0);
      expect(down.state.status).toBe('done');
      expect(requiredActions(down)).toEqual([]);

      const responses = await toolResponses(server, sessionId);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.disposition).toBe('never_ran');
      const failedContent = JSON.stringify(responses[0]?.result);
      expect(failedContent).toContain(INERT_SERVER_NAME);
      expect(failedContent).toMatch(/not reachable/i);

      const sessionEvents = await listSessionEvents(server, sessionId);
      const remediation = sessionEvents.flatMap(item =>
        item.event.type === 'tool.response.v2' && item.event.remediation !== undefined ? [item.event.remediation] : [],
      );
      expect(remediation).toEqual([expect.objectContaining({ reason_code: 'connector_unreachable' })]);

      // The session survives: a fresh turn succeeds once reachable again.
      const recovered = await runApproved({ sessionId, input: userMessage('call_tool') });
      expect(requiredActions(recovered)).toEqual([]);
      expect(server.mcp.askMemoryInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'PAUSE: an unreachable connector with preload off is skipped at init, and the turn proceeds',
    async () => {
      await server.mcp.stop();
      const sessionId = await createSession(server, agentSpec({ preload: false }));
      const response = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit('POST', { input: plainMessage('no tools needed for this one'), stream: false }),
      );
      expect(response.status).toBe(200);
      const created = GetTurnResponseSchema.parse(await response.json()).data;
      const turn = await waitForTerminalTurn({ server, sessionId, turnId: created.id });
      await server.mcp.start();

      expect(turn.state.status).toBe('done');
      expect(requiredActions(turn)).toEqual([]);
      expect(server.mcp.askMemoryInvocations()).toBe(0);
      expect(server.mcp.searchMemoryInvocations()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'RESUME: restarting the connector on the same port needs no re-registration before the next call succeeds',
    async () => {
      const sessionId = await createSession(server, agentSpec({ preload: true }));

      await server.mcp.stop();
      await server.mcp.start();

      // No settings-API call in between: same manifest, same session, same running app.
      const turn = await runApproved({ sessionId, input: userMessage(INERT_SEARCH_MEMORY_TOOL) });
      expect(requiredActions(turn)).toEqual([]);
      expect(server.mcp.searchMemoryInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'chat-grant eligibility: a force-gated retrieval tool offers scope "chat" and honors it',
    async () => {
      const sessionId = await createSession(
        server,
        agentSpec({ preload: true, forceApprovalTools: [INERT_ASK_MEMORY_TOOL] }),
      );
      const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }

      const resumed = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'chat' } }),
      });
      expect(requiredActions(resumed)).toEqual([]);
      expect(server.mcp.askMemoryInvocations()).toBe(1);

      const again = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });
      expect(pendingApproval(again)).toBeUndefined();
      expect(requiredActions(again)).toEqual([]);
      expect(server.mcp.askMemoryInvocations()).toBe(2);
    },
    TURN_TIMEOUT_MS,
  );

  /**
   * Registers the connector's manifest with a header reference instead of a literal secret.
   * Runs last in this file: unlike every axis above, it mutates the shared server's stored
   * MCP-server manifest (adding `auth`), and later tests should not have to account for that.
   */
  describe('RESTART/ROTATION substrate: header references', () => {
    const REFERENCE_HEADER_VALUE = '${env:LKOS_MEMORY_TEST_TOKEN}';

    function referenceManifest(headerValue: string) {
      return {
        type: 'remote' as const,
        name: INERT_SERVER_NAME,
        url: server.mcp.url,
        description: 'Inert connector, re-registered with a header reference for the rotation axis.',
        auth: { type: 'header' as const, headers: { Authorization: headerValue } },
      };
    }

    it('persists an ${env:...}/${file:...} header reference verbatim in the stored manifest', async () => {
      const putResponse = await server.request(
        '/api/v1/settings/mcp-servers',
        jsonInit('PUT', { manifest: referenceManifest(REFERENCE_HEADER_VALUE) }),
      );
      expect(putResponse.status).toBe(200);

      // Raw store: the manifest jsonb persists whatever string was written, verbatim — no
      // store-layer change is part of this feature (ops/memory/DESIGN.md: "No store changes").
      const stored = await server.mcpServerStore().getServer({ tenant_id: TENANT_ID, name: INERT_SERVER_NAME });
      expect(stored?.manifest.auth?.type).toBe('header');
      const storedHeaders = stored?.manifest.auth?.type === 'header' ? stored.manifest.auth.headers : undefined;
      expect(storedHeaders?.['Authorization']).toBe(REFERENCE_HEADER_VALUE);

      // Settings GET: only what is true unconditionally today — the header key survives the
      // round trip. Whether the *value* comes back unredacted is the live-wiring assertion
      // below, gated on the resolver actually being present.
      const getResponse = await server.request(`/api/v1/settings/mcp-servers/${INERT_SERVER_NAME}`);
      expect(getResponse.status).toBe(200);
      const got = GetMcpServerResponseSchema.parse(await getResponse.json()).data;
      expect(got.manifest.auth?.type).toBe('header');
      expect(got.manifest.auth?.type === 'header' ? Object.keys(got.manifest.auth.headers) : []).toContain(
        'Authorization',
      );
    });

    // Un-skip this once schemas/mcpServer.ts, src/runtime/sessionResources.ts, and
    // src/utils/secretRedaction.ts land header-reference resolution end to end (the concurrent
    // change this suite was written alongside). Until then `REFERENCE_RESOLUTION_LIVE` reports
    // false and Jest reports this test as skipped rather than failed, so the other agent's
    // landing timeline never breaks this suite. The integration suite (against a real LKOS
    // registration, per ops/memory/RUNBOOK.md) is the place that must exercise this for real,
    // not just this static probe.
    (REFERENCE_RESOLUTION_LIVE ? it : it.skip)(
      'resolves the header reference into the live request Authorization header once wired',
      async () => {
        const TOKEN_ENV_VAR = 'LKOS_MEMORY_TEST_TOKEN';
        const RESOLVED_TOKEN = 'resolved-lkos-test-token';
        process.env[TOKEN_ENV_VAR] = RESOLVED_TOKEN;
        try {
          const putResponse = await server.request(
            '/api/v1/settings/mcp-servers',
            jsonInit('PUT', { manifest: referenceManifest(`\${env:${TOKEN_ENV_VAR}}`) }),
          );
          expect(putResponse.status).toBe(200);

          const getResponse = await server.request(`/api/v1/settings/mcp-servers/${INERT_SERVER_NAME}`);
          const got = GetMcpServerResponseSchema.parse(await getResponse.json()).data;
          const gotAuthorization =
            got.manifest.auth?.type === 'header' ? got.manifest.auth.headers['Authorization'] : undefined;
          expect(gotAuthorization).toBe(`\${env:${TOKEN_ENV_VAR}}`);

          const sessionId = await createSession(server, agentSpec({ preload: true }));
          await runTurn({
            server,
            sessionId,
            input: userMessage(INERT_ASK_MEMORY_TOOL),
          });

          expect(server.mcp.lastAuthorizationHeader()).toBe(RESOLVED_TOKEN);
        } finally {
          delete process.env[TOKEN_ENV_VAR];
        }
      },
      TURN_TIMEOUT_MS,
    );
  });
});
