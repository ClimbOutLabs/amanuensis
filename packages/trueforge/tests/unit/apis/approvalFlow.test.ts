/**
 * Walks the approval gate over the HTTP surface with an inert MCP connector.
 *
 * Every scenario drives `POST /api/v1/sessions/{session_id}/turns` and the turn /
 * event reads, and judges the outcome by state transitions plus the connector's
 * invocation counter — the counter is the only evidence that says whether a tool
 * ran, independent of what the UI would render.
 */
import { z } from '@hono/zod-openapi';
import { TurnSchema, type Turn, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { RequestErrorResponseSchema } from '../../../src/schemas/errors';
import { ListSessionEventsResponseSchema, TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import {
  INERT_MEMORY_SERVER_NAME,
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../fixtures/approvalTestServer';
import {
  INERT_ASK_MEMORY_TOOL,
  INERT_ECHO_TOOL,
  INERT_READ_TOOL,
  INERT_SERVER_NAME,
  INERT_UNANNOTATED_TOOL,
  INERT_WRITE_TOOL,
  startInertMcpServer,
} from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX, THREE_AT_ONCE_DIRECTIVE } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;

/** Contract the tests hold the API to; the shipped `Session` schema may not carry it yet. */
const SessionWithGrantsSchema = z
  .object({
    data: z.object({ id: z.string(), approval_grants: z.array(z.string()) }).loose(),
  })
  .loose();

/** Machine-readable failure envelope required of conflicting or stale submissions. */
const MachineReadableErrorSchema = z
  .object({
    error: z.object({ code: z.string().min(1), message: z.string() }).loose(),
  })
  .loose();

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [
    {
      name: INERT_SERVER_NAME,
      preload: true,
      // Defaults (`@write`, `@destructive`, `@unclassified`) plus a literal name that
      // force-gates the otherwise-exempt read-only `inert_read` tool, so the chat-scope
      // grant tests below have a real pending approval to grant against.
      require_approval_for_tools: ['@write', '@destructive', '@unclassified', INERT_READ_TOOL],
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

/** AGENT_SPEC without the literal that force-gates `inert_read`, so an Always allow grant can take effect. */
const UNFORCED_AGENT_SPEC = {
  ...AGENT_SPEC,
  mcp_servers: [
    { name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
};

/**
 * Mounts the memory-provider connector, which the server marked first-party when it was set up.
 * Same default gating as UNFORCED_AGENT_SPEC.
 */
function firstPartyAgentSpec(requireApprovalForTools: string[] = ['@write', '@destructive', '@unclassified']) {
  return {
    ...AGENT_SPEC,
    mcp_servers: [
      { name: INERT_MEMORY_SERVER_NAME, preload: true, require_approval_for_tools: requireApprovalForTools },
    ],
  };
}

const ToolGrantsResponseSchema = z.object({ data: z.array(z.object({ tool_name: z.string() }).loose()) });

const AuditLogResponseSchema = z.object({
  entries: z.array(z.object({ tier: z.number(), tool_name: z.string(), outcome: z.string() }).loose()),
});

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function userMessage(tool: string): TurnInputItem[] {
  return [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${tool} please` }];
}

function approvalInput({
  thread_id,
  tool_call_id,
  approval,
}: {
  thread_id: string;
  tool_call_id: string;
  approval: { status: 'allow'; scope?: 'once' | 'chat' | 'always' } | { status: 'deny'; reason?: string };
}): TurnInputItem[] {
  return [{ type: 'user.tool_approval', thread_id, tool_call_id, approval }];
}

async function createSession(server: ApprovalTestServer, spec: object = AGENT_SPEC): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

/** Runs one turn to completion by draining its SSE stream, then returns the persisted turn. */
async function runTurn({
  server,
  sessionId,
  input,
  previousTurnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
  previousTurnId?: string;
}): Promise<Turn> {
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input, stream: true, ...(previousTurnId === undefined ? {} : { previous_turn_id: previousTurnId }) }),
  );
  if (response.status !== 200) {
    const body: unknown = await response.json();
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  const turnId = turnIdFromStream(await response.text());
  return getTurn({ server, sessionId, turnId });
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

async function listTurns(server: ApprovalTestServer, sessionId: string): Promise<Turn[]> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list turns failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return ListTurnsResponseSchema.parse(body).data;
}

async function listTurnEvents({
  server,
  sessionId,
  turnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  turnId: string;
}): Promise<z.infer<typeof ListTurnEventsDataSchema>['data']> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}/events`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list turn events failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return ListTurnEventsDataSchema.parse(body).data;
}

/** Turn events are read structurally here; only `type` and the approval/result fields matter. */
const ListTurnEventsDataSchema = z.object({
  data: z.array(z.object({ type: z.string() }).loose()),
});

async function listSessionEvents(server: ApprovalTestServer, sessionId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/events`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list session events failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return ListSessionEventsResponseSchema.parse(body).data;
}

interface PendingApproval {
  thread_id: string;
  tool_call_id: string;
}

/** The turn's single pending approval, or undefined when the turn paused for nothing. */
/** Every tool call ref the turn is waiting on for approval, across all approval events. */
function approvalCallRefs(turn: Turn) {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions.flatMap(action =>
    action.type === 'tool.approval_required' ? action.tool_calls : [],
  );
}

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

function requiredActions(turn: Turn): unknown[] {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions;
}

/** Every approval decision recorded on this session's turn inputs. */
function decisionRecords(turns: Turn[]): { tool_call_id: string; status: string }[] {
  const decisions: { tool_call_id: string; status: string }[] = [];
  const InputSchema = z.object({
    type: z.literal('user.tool_approval'),
    tool_call_id: z.string(),
    approval: z.object({ status: z.string() }).loose(),
  });
  for (const turn of turns) {
    for (const item of turn.input ?? []) {
      const parsed = InputSchema.safeParse(item);
      if (parsed.success) {
        decisions.push({ tool_call_id: parsed.data.tool_call_id, status: parsed.data.approval.status });
      }
    }
  }
  return decisions;
}

const ToolResponseSchema = z.object({
  type: z.enum(['tool.response', 'tool.response.v2']),
  tool_call_id: z.string(),
  content: z.string(),
});

async function toolResponses(server: ApprovalTestServer, sessionId: string) {
  const items = await listSessionEvents(server, sessionId);
  const responses: { tool_call_id: string; content: string }[] = [];
  for (const item of items) {
    const parsed = ToolResponseSchema.safeParse(item.event);
    if (parsed.success) {
      responses.push({ tool_call_id: parsed.data.tool_call_id, content: parsed.data.content });
    }
  }
  return responses;
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

/** Drives a session to its first pending write approval. */
async function pauseOnWrite(server: ApprovalTestServer): Promise<{ sessionId: string; turn: Turn }> {
  const sessionId = await createSession(server);
  const turn = await runTurn({ server, sessionId, input: userMessage(INERT_WRITE_TOOL) });
  return { sessionId, turn };
}

/**
 * Drives a session to its first pending approval on `inert_read` — read-only and
 * non-open-world, but force-gated by AGENT_SPEC's `require_approval_for_tools`, so
 * a chat-scope grant is both offered and has a real pending approval to exercise.
 */
async function pauseOnRead(server: ApprovalTestServer): Promise<{ sessionId: string; turn: Turn }> {
  const sessionId = await createSession(server);
  const turn = await runTurn({ server, sessionId, input: userMessage(INERT_READ_TOOL) });
  return { sessionId, turn };
}

async function auditEntries({ server, sessionId }: { server: ApprovalTestServer; sessionId: string }) {
  const audit = await server.request(`/api/v1/sessions/${sessionId}/audit-log`);
  expect(audit.status).toBe(200);
  return AuditLogResponseSchema.parse(await audit.json()).entries;
}

/** Saves the memory connector the way the settings page does, so the server re-decides its trust. */
async function saveMemoryConnector({
  server,
  url,
  memoryProvider,
}: {
  server: ApprovalTestServer;
  url: string;
  memoryProvider: boolean;
}) {
  const response = await server.request('/api/v1/settings/mcp-servers', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      manifest: {
        type: 'remote',
        name: INERT_MEMORY_SERVER_NAME,
        url,
        description: 'Inert connector registered as the memory provider.',
        ...(memoryProvider ? { memory_provider: true } : {}),
      },
    }),
  });
  expect(response.status).toBe(200);
}

describe('approval gate over an inert connector', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ memoryProvider: true });
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.mcp.resetInvocations();
  });

  it(
    'asks before a read-only tool on a user-added connector runs, whatever its hints claim',
    async () => {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const echo = await runTurn({ server, sessionId, input: userMessage(INERT_ECHO_TOOL) });
      expect(pendingApproval(echo)).toBeDefined();
      expect(server.mcp.echoInvocations()).toBe(0);

      const otherSessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const read = await runTurn({ server, sessionId: otherSessionId, input: userMessage(INERT_READ_TOOL) });
      expect(pendingApproval(read)).toBeDefined();
      expect(server.mcp.readInvocations()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );

  describe('first-party connector (the memory provider)', () => {
    it(
      'autoruns a read-only annotated tool and records the run in the audit log',
      async () => {
        const sessionId = await createSession(server, firstPartyAgentSpec());
        const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

        expect(requiredActions(turn)).toEqual([]);
        expect(server.mcp.askMemoryInvocations()).toBe(1);
        expect(await auditEntries({ server, sessionId })).toEqual([
          expect.objectContaining({
            tier: 1,
            tool_name: INERT_ASK_MEMORY_TOOL,
            outcome: 'logged',
            description: expect.stringContaining('First-party'),
          }),
        ]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'asks for the same tool on a user-added connector with identical hints',
      async () => {
        const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

        expect(pendingApproval(turn)).toBeDefined();
        expect(server.mcp.askMemoryInvocations()).toBe(0);
      },
      TURN_TIMEOUT_MS,
    );

    it.each([
      ['a read-only tool that does not declare itself closed-world', INERT_ECHO_TOOL, 'echoInvocations'],
      ['a write tool', INERT_WRITE_TOOL, 'writeInvocations'],
      ['an unannotated tool', INERT_UNANNOTATED_TOOL, 'unannotatedInvocations'],
    ] as const)(
      'still asks for %s',
      async (_label, tool, invocations) => {
        const sessionId = await createSession(server, firstPartyAgentSpec());
        const turn = await runTurn({ server, sessionId, input: userMessage(tool) });

        expect(pendingApproval(turn)).toBeDefined();
        expect(server.mcp[invocations]()).toBe(0);
        expect(await auditEntries({ server, sessionId })).toEqual([]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'still asks when an explicit require-approval selector names the tool, and audits no autorun',
      async () => {
        const spec = firstPartyAgentSpec(['@write', '@destructive', '@unclassified', INERT_ASK_MEMORY_TOOL]);
        const sessionId = await createSession(server, spec);
        const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

        expect(pendingApproval(turn)).toBeDefined();
        expect(server.mcp.askMemoryInvocations()).toBe(0);
        expect(await auditEntries({ server, sessionId })).toEqual([]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'refuses a listed origin that answers with a redirect to another host, so the tool never runs there',
      async () => {
        // An origin the operator never listed, which would serve the same routes if it were followed.
        const elsewhere = await startInertMcpServer();
        try {
          server.mcp.redirectAllTo({ to: elsewhere.origin, status: 302 });
          const sessionId = await createSession(server, firstPartyAgentSpec());
          const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

          expect(turn.state).toMatchObject({
            status: 'error',
            message: `Failed to connect to remote MCP server '${INERT_MEMORY_SERVER_NAME}': server answered HTTP 302 with a redirect to ${elsewhere.origin}, and this connection does not follow redirects`,
          });
          expect(server.mcp.askMemoryInvocations()).toBe(0);
          expect(elsewhere.requestsSeen()).toBe(0);
          expect(elsewhere.askMemoryInvocations()).toBe(0);
        } finally {
          await elsewhere.close();
        }
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'refuses the same redirect when the connector page tests the connection',
      async () => {
        const elsewhere = await startInertMcpServer();
        try {
          // A 307 keeps the request, so following it would have reached a server that answers.
          server.mcp.redirectAllTo({ to: elsewhere.origin, status: 307 });
          const response = await server.request(`/api/v1/mcp-servers/${INERT_MEMORY_SERVER_NAME}/tools`);

          expect(response.status).toBe(502);
          expect(await response.json()).toEqual({
            error: {
              message: `Failed to connect to remote MCP server '${INERT_MEMORY_SERVER_NAME}': server answered HTTP 307 with a redirect to ${elsewhere.origin}, and this connection does not follow redirects`,
            },
          });
          expect(elsewhere.requestsSeen()).toBe(0);
        } finally {
          await elsewhere.close();
        }
      },
      TURN_TIMEOUT_MS,
    );

    // Last in this block: it repoints the shared connector, then restores it through setup.
    it(
      'keeps trust on another bank of the same origin, and asks once the connector moves to an origin the operator did not list',
      async () => {
        // Answers the memory provider check like any server, but the operator never listed its origin.
        const elsewhere = await startInertMcpServer();
        try {
          await saveMemoryConnector({ server, url: `${server.mcp.url}/other`, memoryProvider: true });
          const sameOrigin = await createSession(server, firstPartyAgentSpec());
          const ran = await runTurn({ server, sessionId: sameOrigin, input: userMessage(INERT_ASK_MEMORY_TOOL) });
          expect(requiredActions(ran)).toEqual([]);
          expect(server.mcp.askMemoryInvocations()).toBe(1);

          await saveMemoryConnector({ server, url: elsewhere.memoryProviderUrl, memoryProvider: true });
          const moved = await createSession(server, firstPartyAgentSpec());
          const asked = await runTurn({ server, sessionId: moved, input: userMessage(INERT_ASK_MEMORY_TOOL) });
          expect(pendingApproval(asked)).toBeDefined();
          expect(elsewhere.askMemoryInvocations()).toBe(0);
        } finally {
          await saveMemoryConnector({ server, url: server.mcp.memoryProviderUrl, memoryProvider: true });
          await elsewhere.close();
        }

        const restored = await createSession(server, firstPartyAgentSpec());
        const again = await runTurn({ server, sessionId: restored, input: userMessage(INERT_ASK_MEMORY_TOOL) });
        expect(requiredActions(again)).toEqual([]);
        expect(server.mcp.askMemoryInvocations()).toBe(2);
      },
      TURN_TIMEOUT_MS,
    );
  });

  it(
    'pauses the write tool before it executes',
    async () => {
      const { turn } = await pauseOnWrite(server);

      expect(requiredActions(turn)).not.toEqual([]);
      expect(pendingApproval(turn)).toBeDefined();
      expect(server.mcp.writeInvocations()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'carries the Tier 3 tier and plain-language card on the pending approval',
    async () => {
      // The approval UI renders its Tier 3 card from these fields; the wire tool_info omits them.
      const { turn } = await pauseOnWrite(server);
      if (turn.state.status !== 'done') {
        throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
      }
      const action = turn.state.required_actions.find(entry => entry.type === 'tool.approval_required');
      const ref = action?.type === 'tool.approval_required' ? action.tool_calls[0] : undefined;

      expect(ref?.tier).toBe(3);
      expect(ref?.tier3_card?.plain_what).toEqual(expect.any(String));
      expect(ref?.tier3_card?.plain_what).not.toBe('');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'allow once executes exactly once and prompts again for an equivalent later call',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }

      const resumed = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'once' } }),
      });
      expect(requiredActions(resumed)).toEqual([]);
      expect(server.mcp.writeInvocations()).toBe(1);

      const again = await runTurn({ server, sessionId, input: userMessage(INERT_WRITE_TOOL) });
      expect(pendingApproval(again)).toBeDefined();
      expect(server.mcp.writeInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'allow in this chat executes, autoruns the next equivalent call, and records the grant',
    async () => {
      const { sessionId, turn } = await pauseOnRead(server);
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
      expect(server.mcp.readInvocations()).toBe(1);

      const again = await runTurn({ server, sessionId, input: userMessage(INERT_READ_TOOL) });
      expect(pendingApproval(again)).toBeUndefined();
      expect(requiredActions(again)).toEqual([]);
      expect(server.mcp.readInvocations()).toBe(2);

      const sessionResponse = await server.request(`/api/v1/sessions/${sessionId}`);
      const sessionBody: unknown = await sessionResponse.json();
      const parsed = SessionWithGrantsSchema.safeParse(sessionBody);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.data.approval_grants.length).toBe(1);
        expect(parsed.data.data.approval_grants.join(' ')).toContain(INERT_READ_TOOL);
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'does not leak a chat grant into a second session',
    async () => {
      const granted = await pauseOnRead(server);
      const pending = pendingApproval(granted.turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }
      await runTurn({
        server,
        sessionId: granted.sessionId,
        input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'chat' } }),
      });
      expect(server.mcp.readInvocations()).toBe(1);

      const otherSessionId = await createSession(server);
      const otherTurn = await runTurn({ server, sessionId: otherSessionId, input: userMessage(INERT_READ_TOOL) });

      expect(pendingApproval(otherTurn)).toBeDefined();
      expect(server.mcp.readInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'refuses a chat-scope grant for a write tool and leaves the pending approval intact',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }

      const response = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({
          input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'chat' } }),
          stream: false,
        }),
      );
      const body: unknown = await response.json();
      expect(response.status).toBe(422);
      const parsed = RequestErrorResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.error.message).toContain('chat-scoped approval is not available');
        expect(parsed.data.error.message).toContain(pending.tool_call_id);
      }
      expect(server.mcp.writeInvocations()).toBe(0);

      // Refused submissions must not disturb the pending approval it was submitted against.
      const reread = await getTurn({ server, sessionId, turnId: turn.id });
      expect(pendingApproval(reread)).toEqual(pending);
    },
    TURN_TIMEOUT_MS,
  );

  describe('Always allow this tool', () => {
    async function listToolGrants(): Promise<string[]> {
      const response = await server.request(`/api/v1/mcp-servers/${INERT_SERVER_NAME}/tool-grants`);
      expect(response.status).toBe(200);
      return ToolGrantsResponseSchema.parse(await response.json()).data.map(grant => grant.tool_name);
    }

    async function revokeToolGrant(toolName: string): Promise<void> {
      const response = await server.request(`/api/v1/mcp-servers/${INERT_SERVER_NAME}/tool-grants/${toolName}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
    }

    async function alwaysAllow(toolName: string): Promise<void> {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const paused = await runTurn({ server, sessionId, input: userMessage(toolName) });
      const pending = pendingApproval(paused);
      if (!pending) {
        throw new Error(`expected ${toolName} to ask before its first run`);
      }
      const resumed = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'always' } }),
      });
      expect(requiredActions(resumed)).toEqual([]);
    }

    afterEach(async () => {
      for (const toolName of await listToolGrants()) {
        await revokeToolGrant(toolName);
      }
    });

    it(
      'runs the approved call, skips the card in a later chat, and records the auto-run in the audit log',
      async () => {
        await alwaysAllow(INERT_READ_TOOL);
        expect(server.mcp.readInvocations()).toBe(1);
        expect(await listToolGrants()).toEqual([INERT_READ_TOOL]);

        const laterSessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const later = await runTurn({ server, sessionId: laterSessionId, input: userMessage(INERT_READ_TOOL) });
        expect(requiredActions(later)).toEqual([]);
        expect(server.mcp.readInvocations()).toBe(2);

        const audit = await server.request(`/api/v1/sessions/${laterSessionId}/audit-log`);
        expect(audit.status).toBe(200);
        expect(AuditLogResponseSchema.parse(await audit.json()).entries).toEqual([
          expect.objectContaining({ tier: 1, tool_name: INERT_READ_TOOL, outcome: 'logged' }),
        ]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'still shows a card when a selector gates a call the standing grant let through',
      async () => {
        await alwaysAllow(INERT_READ_TOOL);

        // AGENT_SPEC force-gates inert_read by name, so the grant makes it Tier 1 but the selector still asks.
        const sessionId = await createSession(server);
        const gated = await runTurn({ server, sessionId, input: userMessage(INERT_READ_TOOL) });
        if (gated.state.status !== 'done') {
          throw new Error(`turn is not done: ${JSON.stringify(gated.state)}`);
        }
        const ref = gated.state.required_actions.flatMap(action =>
          action.type === 'tool.approval_required' ? action.tool_calls : [],
        )[0];

        expect(ref?.tier).toBe(3);
        expect(ref?.tier3_card?.plain_what).toContain(INERT_READ_TOOL);
        expect(ref?.tier3_card?.outbound_text).toContain('text: inert');
        expect(server.mcp.readInvocations()).toBe(1);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'tells the live card that Always allow is offered for a read, and not for a call that writes',
      async () => {
        const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const read = await runTurn({ server, sessionId, input: userMessage(INERT_READ_TOOL) });
        expect(approvalCallRefs(read)).toEqual([
          expect.objectContaining({ tier3_card: expect.any(Object), can_always_allow: true }),
        ]);

        const writeSessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const write = await runTurn({ server, sessionId: writeSessionId, input: userMessage(INERT_WRITE_TOOL) });
        expect(approvalCallRefs(write)).toEqual([expect.objectContaining({ can_always_allow: false })]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'covers only the approved tool on that connector',
      async () => {
        await alwaysAllow(INERT_READ_TOOL);

        const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const other = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });
        expect(pendingApproval(other)).toBeDefined();
        expect(server.mcp.askMemoryInvocations()).toBe(0);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'asks again once the grant is revoked from settings',
      async () => {
        await alwaysAllow(INERT_READ_TOOL);
        await revokeToolGrant(INERT_READ_TOOL);
        expect(await listToolGrants()).toEqual([]);

        const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const again = await runTurn({ server, sessionId, input: userMessage(INERT_READ_TOOL) });
        expect(pendingApproval(again)).toBeDefined();
        expect(server.mcp.readInvocations()).toBe(1);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'still asks when an explicit require-approval selector names the always-allowed tool',
      async () => {
        await alwaysAllow(INERT_READ_TOOL);

        const sessionId = await createSession(server);
        const gated = await runTurn({ server, sessionId, input: userMessage(INERT_READ_TOOL) });
        expect(pendingApproval(gated)).toBeDefined();
        expect(server.mcp.readInvocations()).toBe(1);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'refuses Always allow for a read-only tool that does not declare itself closed-world',
      async () => {
        const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
        const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ECHO_TOOL) });
        const pending = pendingApproval(turn);
        expect(pending).toBeDefined();
        if (!pending) {
          return;
        }

        const response = await server.request(
          `/api/v1/sessions/${sessionId}/turns`,
          jsonInit({
            input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'always' } }),
            stream: false,
          }),
        );
        expect(response.status).toBe(422);
        const parsed = RequestErrorResponseSchema.safeParse(await response.json());
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data.error.message).toContain('always-allow approval is not available');
        }
        expect(server.mcp.echoInvocations()).toBe(0);
        expect(await listToolGrants()).toEqual([]);
        expect(pendingApproval(await getTurn({ server, sessionId, turnId: turn.id }))).toEqual(pending);
      },
      TURN_TIMEOUT_MS,
    );
  });

  it(
    'denies with a reason, runs nothing, and lets the model continue to a terminal state',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }

      const denied = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'deny', reason: 'not this time' } }),
      });

      expect(server.mcp.writeInvocations()).toBe(0);
      expect(denied.state.status).toBe('done');
      expect(requiredActions(denied)).toEqual([]);

      const results = await toolResponses(server, sessionId);
      const denialResult = results.find(result => result.tool_call_id === pending.tool_call_id);
      expect(denialResult).toBeDefined();
      expect(denialResult?.content ?? '').toContain('not this time');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'treats a duplicate decision submission as idempotent',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }
      const input = approvalInput({ ...pending, approval: { status: 'allow', scope: 'once' } });

      const first = await runTurn({ server, sessionId, input });
      expect(server.mcp.writeInvocations()).toBe(1);

      const duplicate = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: false }));
      const duplicateBody: unknown = await duplicate.json();

      if (duplicate.status === 200) {
        // Replay: the tip turn is handed back rather than a second execution.
        expect(GetTurnResponseSchema.parse(duplicateBody).data.id).toBe(first.id);
      } else {
        expect(duplicate.status).toBe(409);
        expect(MachineReadableErrorSchema.safeParse(duplicateBody).success).toBe(true);
      }
      expect(server.mcp.writeInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'keeps a failed submission retryable with the pending approval unchanged',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }
      const input = approvalInput({ ...pending, approval: { status: 'allow', scope: 'once' } });

      // Chaining off a turn that is not the tip is a conflict, not a decision.
      const conflicting = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({ input, stream: false, previous_turn_id: 'turn-that-never-existed' }),
      );
      const conflictBody: unknown = await conflicting.json();
      expect(conflicting.status).toBeGreaterThanOrEqual(400);
      expect(RequestErrorResponseSchema.safeParse(conflictBody).success).toBe(true);
      expect(server.mcp.writeInvocations()).toBe(0);

      // Identity of the pending approval survives the failure.
      const reread = await getTurn({ server, sessionId, turnId: turn.id });
      expect(pendingApproval(reread)).toEqual(pending);

      const retried = await runTurn({ server, sessionId, input });
      expect(requiredActions(retried)).toEqual([]);
      expect(server.mcp.writeInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'reproduces the pending approval after a restart and drops it once resolved',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }

      await server.restart();

      const turnsAfterRestart = await listTurns(server, sessionId);
      const tip = turnsAfterRestart.find(candidate => candidate.id === turn.id);
      expect(tip).toBeDefined();
      expect(tip && pendingApproval(tip)).toEqual(pending);

      const eventsAfterRestart = await listTurnEvents({ server, sessionId, turnId: turn.id });
      expect(eventsAfterRestart.some(event => event.type === 'tool.approval_required')).toBe(true);

      const resolved = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'once' } }),
      });
      expect(server.mcp.writeInvocations()).toBe(1);

      await server.restart();

      const finalTurn = await getTurn({ server, sessionId, turnId: resolved.id });
      expect(requiredActions(finalTurn)).toEqual([]);
      const finalEvents = await listTurnEvents({ server, sessionId, turnId: resolved.id });
      expect(finalEvents.some(event => event.type === 'tool.approval_required')).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'keeps the chat usable after an approved call is cancelled mid-execution',
    async () => {
      const { sessionId, turn } = await pauseOnWrite(server);
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      if (!pending) {
        return;
      }

      const hold = server.mcp.holdNextWrite();
      const started = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({
          input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'once' } }),
          stream: false,
        }),
      );
      expect(started.status).toBe(200);
      const runningTurn = GetTurnResponseSchema.parse(await started.json()).data;

      await hold.entered;
      const cancelled = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({}));
      expect(cancelled.status).toBe(200);
      hold.release();

      const terminal = await waitForTerminalTurn({ server, sessionId, turnId: runningTurn.id });
      expect(terminal.state.status).not.toBe('running');

      const followUp = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({ input: userMessage(INERT_ECHO_TOOL), stream: false }),
      );
      const followUpBody: unknown = await followUp.json();
      expect(JSON.stringify(followUpBody)).not.toContain('user message cannot be sent while approvals');
      expect(followUp.status).toBe(200);
      await waitForTerminalTurn({
        server,
        sessionId,
        turnId: TurnSchema.parse(z.object({ data: z.unknown() }).parse(followUpBody).data).id,
      });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'records exactly one decision and one tool result per terminal outcome',
    async () => {
      const sessionId = await createSession(server);
      const outcomes: { status: 'allow' | 'deny'; scope?: 'once' | 'chat'; reason?: string }[] = [
        { status: 'deny', reason: 'first refusal' },
        { status: 'allow', scope: 'once' },
      ];
      const decidedCallIds: string[] = [];

      for (const outcome of outcomes) {
        const paused = await runTurn({ server, sessionId, input: userMessage(INERT_WRITE_TOOL) });
        const pending = pendingApproval(paused);
        expect(pending).toBeDefined();
        if (!pending) {
          return;
        }
        decidedCallIds.push(pending.tool_call_id);
        await runTurn({
          server,
          sessionId,
          input: approvalInput({
            ...pending,
            approval:
              outcome.status === 'allow'
                ? { status: 'allow', ...(outcome.scope ? { scope: outcome.scope } : {}) }
                : { status: 'deny', ...(outcome.reason ? { reason: outcome.reason } : {}) },
          }),
        });
      }

      const decisions = decisionRecords(await listTurns(server, sessionId));
      const results = await toolResponses(server, sessionId);
      for (const callId of decidedCallIds) {
        expect(decisions.filter(decision => decision.tool_call_id === callId)).toHaveLength(1);
        expect(results.filter(result => result.tool_call_id === callId)).toHaveLength(1);
      }
      expect(server.mcp.writeInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('memory provider on an origin the operator did not list', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    // No origin is listed, as on any server that never set FIRST_PARTY_MCP_ORIGINS.
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.mcp.resetInvocations();
  });

  it(
    'keeps a hostile memory provider user-added, so its read-only closed-world tool still asks',
    async () => {
      // The server answers the setup check and declares ask_memory read-only and closed-world,
      // which is everything a hostile server needs to say.
      await saveMemoryConnector({ server, url: server.mcp.memoryProviderUrl, memoryProvider: true });
      const sessionId = await createSession(server, firstPartyAgentSpec());
      const turn = await runTurn({ server, sessionId, input: userMessage(INERT_ASK_MEMORY_TOOL) });

      expect(pendingApproval(turn)).toBeDefined();
      expect(server.mcp.askMemoryInvocations()).toBe(0);
      expect(await auditEntries({ server, sessionId })).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'trusts it only once the operator lists the origin and the provider is saved again, and stops when the origin is removed',
    async () => {
      await saveMemoryConnector({ server, url: server.mcp.memoryProviderUrl, memoryProvider: true });

      // Listing the origin changes nothing for a provider that was saved before.
      server.setFirstPartyOrigins([server.mcp.origin]);
      const beforeSave = await createSession(server, firstPartyAgentSpec());
      const asked = await runTurn({ server, sessionId: beforeSave, input: userMessage(INERT_ASK_MEMORY_TOOL) });
      expect(pendingApproval(asked)).toBeDefined();
      expect(server.mcp.askMemoryInvocations()).toBe(0);

      // Saving it again re-runs the setup check and marks it.
      await saveMemoryConnector({ server, url: server.mcp.memoryProviderUrl, memoryProvider: true });
      const afterSave = await createSession(server, firstPartyAgentSpec());
      const ran = await runTurn({ server, sessionId: afterSave, input: userMessage(INERT_ASK_MEMORY_TOOL) });
      expect(requiredActions(ran)).toEqual([]);
      expect(server.mcp.askMemoryInvocations()).toBe(1);

      // Removing the origin takes effect on the next turn, with no save.
      server.setFirstPartyOrigins([]);
      const afterRemoval = await createSession(server, firstPartyAgentSpec());
      const askedAgain = await runTurn({ server, sessionId: afterRemoval, input: userMessage(INERT_ASK_MEMORY_TOOL) });
      expect(pendingApproval(askedAgain)).toBeDefined();
      expect(server.mcp.askMemoryInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('web search provider over an inert connector', () => {
  let server: ApprovalTestServer;

  /** Assembled at run time so no literal here looks like a credential to a scanner. */
  const syntheticAwsKeyId = ['AKI', 'A', 'ABCDEFGH', 'IJKLMNOP'].join('');

  /** The user's own switch, set through the same route the settings page uses. */
  async function setSearchWithoutAsking(value: boolean) {
    const response = await server.request('/api/v1/user/settings/sentinel', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ search_without_asking: value }),
    });
    expect(response.status).toBe(200);
  }

  /** Designates the inert connector (or clears the role) the way the settings page does. */
  async function designateSearchProvider(designated: boolean) {
    const response = await server.request('/api/v1/settings/mcp-servers', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'remote',
          name: INERT_SERVER_NAME,
          url: server.mcp.url,
          description: 'Inert connector used by approval-flow tests.',
          ...(designated ? { search_provider: true } : {}),
        },
      }),
    });
    expect(response.status).toBe(200);
  }

  function searchMessage(text: string): TurnInputItem[] {
    return [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${INERT_ECHO_TOOL} text:${text}` }];
  }

  /** The `silent_search_query` the server stamped on any tool call of the session, as the chat would draw its chip. */
  async function stampedQueries(sessionId: string): Promise<string[]> {
    const ToolCallsSchema = z.object({
      type: z.literal('model.message'),
      tool_calls: z
        .array(z.object({ tool_info: z.object({ silent_search_query: z.string().optional() }).loose() }).loose())
        .optional(),
    });
    const queries: string[] = [];
    for (const item of await listSessionEvents(server, sessionId)) {
      const parsed = ToolCallsSchema.safeParse(item.event);
      for (const call of parsed.success ? (parsed.data.tool_calls ?? []) : []) {
        if (call.tool_info.silent_search_query !== undefined) {
          queries.push(call.tool_info.silent_search_query);
        }
      }
    }
    return queries;
  }

  beforeAll(async () => {
    server = await startApprovalTestServer();
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    server.mcp.resetInvocations();
    await setSearchWithoutAsking(true);
    await designateSearchProvider(true);
  });

  it(
    'runs the designated provider’s tool without asking, stamps the chip text on the call, and audits the run',
    async () => {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const turn = await runTurn({ server, sessionId, input: searchMessage('tallest-building-in-Lisbon') });

      expect(requiredActions(turn)).toEqual([]);
      expect(server.mcp.echoInvocations()).toBe(1);
      expect(await stampedQueries(sessionId)).toEqual(['tallest-building-in-Lisbon']);
      expect(await auditEntries({ server, sessionId })).toEqual([
        expect.objectContaining({
          tier: 1,
          tool_name: INERT_ECHO_TOOL,
          outcome: 'logged',
          description: 'Searched with inert: tallest-building-in-Lisbon',
        }),
      ]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'still asks for the same tool once the connector is no longer the designated provider',
    async () => {
      await designateSearchProvider(false);
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const turn = await runTurn({ server, sessionId, input: searchMessage('tallest-building-in-Lisbon') });

      expect(pendingApproval(turn)).toBeDefined();
      expect(server.mcp.echoInvocations()).toBe(0);
      expect(await stampedQueries(sessionId)).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it.each([
    ['an unannotated tool', INERT_UNANNOTATED_TOOL, 'unannotatedInvocations'],
    ['a write tool', INERT_WRITE_TOOL, 'writeInvocations'],
  ] as const)(
    'still asks for %s on the designated connector, because the role does not make a connector’s other tools silent',
    async (_label, tool, counter) => {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const turn = await runTurn({ server, sessionId, input: userMessage(tool) });

      expect(pendingApproval(turn)).toBeDefined();
      expect(server.mcp[counter]()).toBe(0);
      expect(await stampedQueries(sessionId)).toEqual([]);
      expect(await auditEntries({ server, sessionId })).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks when the user switched searches to Ask, and runs again once they switch back',
    async () => {
      await setSearchWithoutAsking(false);
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const asked = await runTurn({ server, sessionId, input: searchMessage('tallest-building-in-Lisbon') });
      expect(pendingApproval(asked)).toBeDefined();
      expect(server.mcp.echoInvocations()).toBe(0);

      await setSearchWithoutAsking(true);
      const otherSessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const ran = await runTurn({
        server,
        sessionId: otherSessionId,
        input: searchMessage('tallest-building-in-Lisbon'),
      });
      expect(requiredActions(ran)).toEqual([]);
      expect(server.mcp.echoInvocations()).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'holds a query that carries a key for approval instead of running it, with the exact query on the card',
    async () => {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const turn = await runTurn({ server, sessionId, input: searchMessage(syntheticAwsKeyId) });

      expect(pendingApproval(turn)).toBeDefined();
      expect(server.mcp.echoInvocations()).toBe(0);
      expect(await stampedQueries(sessionId)).toEqual([]);
      const events = await listSessionEvents(server, sessionId);
      expect(JSON.stringify(events)).toContain(syntheticAwsKeyId);
      expect(await auditEntries({ server, sessionId })).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'runs the held query only after the user approves it, once',
    async () => {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const held = await runTurn({ server, sessionId, input: searchMessage(syntheticAwsKeyId) });
      const pending = pendingApproval(held);
      if (pending === undefined) {
        throw new Error('expected the query to wait for approval');
      }

      const approved = await runTurn({
        server,
        sessionId,
        previousTurnId: held.id,
        input: approvalInput({ ...pending, approval: { status: 'allow' } }),
      });
      expect(requiredActions(approved)).toEqual([]);
      expect(server.mcp.echoInvocations()).toBe(1);
      const entries = await auditEntries({ server, sessionId });
      expect(entries).not.toEqual([]);
      expect(JSON.stringify(entries)).not.toContain(syntheticAwsKeyId);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'keeps the held query out of the audit log when the user turns it down',
    async () => {
      const sessionId = await createSession(server, UNFORCED_AGENT_SPEC);
      const held = await runTurn({ server, sessionId, input: searchMessage(syntheticAwsKeyId) });
      const pending = pendingApproval(held);
      if (pending === undefined) {
        throw new Error('expected the query to wait for approval');
      }
      await runTurn({
        server,
        sessionId,
        previousTurnId: held.id,
        input: approvalInput({ ...pending, approval: { status: 'deny' } }),
      });
      const entries = await auditEntries({ server, sessionId });
      expect(entries).not.toEqual([]);
      expect(JSON.stringify(entries)).not.toContain(syntheticAwsKeyId);
    },
    TURN_TIMEOUT_MS,
  );
});

describe('three connector calls pending in one turn', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ memoryProvider: true });
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.mcp.resetInvocations();
  });

  /** Every pending approval of a paused turn, in the order the model asked for them. */
  function pendingApprovals(turn: Turn): PendingApproval[] {
    if (turn.state.status !== 'done') {
      throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
    }
    return turn.state.required_actions.flatMap(action =>
      action.type === 'tool.approval_required'
        ? action.tool_calls.map(call => ({ thread_id: action.thread_id, tool_call_id: call.id }))
        : [],
    );
  }

  async function pauseOnThree(): Promise<{ sessionId: string; turn: Turn; pending: PendingApproval[] }> {
    const sessionId = await createSession(server);
    const turn = await runTurn({ server, sessionId, input: userMessage(THREE_AT_ONCE_DIRECTIVE) });
    return { sessionId, turn, pending: pendingApprovals(turn) };
  }

  it(
    'asks once per call, each with its own card, and runs nothing until answered',
    async () => {
      const { turn, pending } = await pauseOnThree();

      expect(pending).toHaveLength(3);
      expect(new Set(pending.map(call => call.tool_call_id)).size).toBe(3);
      expect(server.mcp.unannotatedInvocations()).toBe(0);
      if (turn.state.status !== 'done') {
        throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
      }
      const refs = turn.state.required_actions.flatMap(action =>
        action.type === 'tool.approval_required' ? action.tool_calls : [],
      );
      expect(refs.map(ref => ref.tier)).toEqual([3, 3, 3]);
      for (const ref of refs) {
        expect(ref.tier3_card?.outbound_text).toContain('text: ');
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'approves two and denies one in one answer: the turn continues, and each call runs or is refused as decided',
    async () => {
      const { sessionId, turn, pending } = await pauseOnThree();
      const [first, second, third] = pending;
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error('expected three pending approvals');
      }

      const resumed = await runTurn({
        server,
        sessionId,
        previousTurnId: turn.id,
        input: [
          ...approvalInput({ ...first, approval: { status: 'allow', scope: 'once' } }),
          ...approvalInput({ ...second, approval: { status: 'deny', reason: 'not this one' } }),
          ...approvalInput({ ...third, approval: { status: 'allow', scope: 'once' } }),
        ],
      });

      expect(resumed.state.status).toBe('done');
      expect(requiredActions(resumed)).toEqual([]);
      expect(server.mcp.unannotatedInvocations()).toBe(2);
      const responses = await toolResponses(server, sessionId);
      const byCall = new Map(responses.map(response => [response.tool_call_id, response.content]));
      expect(byCall.get(second.tool_call_id)).toMatch(/denied/i);
      expect(byCall.get(first.tool_call_id)).not.toMatch(/denied/i);
      expect(byCall.get(third.tool_call_id)).not.toMatch(/denied/i);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'refuses a partial answer by name, runs nothing, and still accepts the full answer afterwards',
    async () => {
      const { sessionId, turn, pending } = await pauseOnThree();
      const [first, second, third] = pending;
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error('expected three pending approvals');
      }

      // The client collects every decision before sending, so a lone answer is a client bug:
      // the server says exactly which calls are missing instead of resuming half a batch.
      const partial = await server.request(
        `/api/v1/sessions/${sessionId}/turns`,
        jsonInit({
          input: approvalInput({ ...first, approval: { status: 'allow', scope: 'once' } }),
          stream: true,
          previous_turn_id: turn.id,
        }),
      );
      expect(partial.status).toBe(422);
      const partialBody = z.object({ error: z.object({ message: z.string() }) }).parse(await partial.json());
      expect(partialBody.error.message).toContain(second.tool_call_id);
      expect(partialBody.error.message).toContain(third.tool_call_id);
      expect(server.mcp.unannotatedInvocations()).toBe(0);

      const done = await runTurn({
        server,
        sessionId,
        previousTurnId: turn.id,
        input: [
          ...approvalInput({ ...first, approval: { status: 'allow', scope: 'once' } }),
          ...approvalInput({ ...second, approval: { status: 'deny' } }),
          ...approvalInput({ ...third, approval: { status: 'allow', scope: 'once' } }),
        ],
      });
      expect(requiredActions(done)).toEqual([]);
      expect(server.mcp.unannotatedInvocations()).toBe(2);
    },
    TURN_TIMEOUT_MS,
  );
});
