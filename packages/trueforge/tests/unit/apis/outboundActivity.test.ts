/**
 * What left this computer, end to end: a real server over a real database, with the scripted model
 * and an inert connector standing in for outside services. The recorder treats them as outside
 * (the fixture's `isLocalHost`), so each kind of request can be checked as recorded, and nothing
 * else: no prompt text, no query, no key.
 */
import { z } from '@hono/zod-openapi';
import { ListDataLocationsResponseSchema, ListOutboundEventsResponseSchema } from '../../../src/schemas/privacy';
import {
  INERT_MEMORY_SERVER_NAME,
  MODEL_FQN,
  startApprovalTestServer,
  type ApprovalTestServer,
} from '../../fixtures/approvalTestServer';
import {
  INERT_ASK_MEMORY_TOOL,
  INERT_ECHO_TOOL,
  INERT_SERVER_NAME,
  INERT_WRITE_TOOL,
} from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const PROMPT_MARKER = 'PRIVATE-PROMPT-MARKER-4471';
const QUERY_MARKER = 'tallest-building-in-Lisbon';

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function agentSpec(mcpServerName: string | undefined) {
  return {
    model: { name: MODEL_FQN },
    instructions: 'Use the connector exactly as instructed.',
    ...(mcpServerName === undefined
      ? {}
      : {
          mcp_servers: [
            {
              name: mcpServerName,
              preload: true,
              require_approval_for_tools: ['@write', '@destructive', '@unclassified'],
            },
          ],
        }),
    config: {
      sandbox: { enabled: false },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  };
}

describe('what left this computer, over HTTP', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer({ memoryProvider: true });
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
  });

  async function runMessage({ mcpServerName, content }: { mcpServerName: string | undefined; content: string }) {
    const created = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: agentSpec(mcpServerName) } }));
    expect(created.status).toBe(201);
    const sessionId = z.object({ data: z.object({ id: z.string() }).loose() }).parse(await created.json()).data.id;
    const turn = await server.request(
      `/api/v1/sessions/${sessionId}/turns`,
      jsonInit({ input: [{ type: 'user.message', content }], stream: true }),
    );
    expect(turn.status).toBe(200);
    await turn.text();
    return sessionId;
  }

  async function outbound() {
    const response = await server.request('/api/v1/settings/outbound-events');
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    return { body, ...ListOutboundEventsResponseSchema.parse(body) };
  }

  it(
    'says nothing has left before anything is sent, and records a model request with only host, model and size',
    async () => {
      const before = await outbound();
      expect(before.data).toEqual([]);
      expect(before.truncated).toBe(false);
      expect(Date.now() - new Date(before.window_start).getTime()).toBeGreaterThan(24 * 60 * 60 * 1000 - 5_000);
      expect(Date.now() - new Date(before.window_start).getTime()).toBeLessThan(24 * 60 * 60 * 1000 + 5_000);

      const sessionId = await runMessage({ mcpServerName: undefined, content: `Hello ${PROMPT_MARKER}` });

      const after = await outbound();
      const modelRequests = after.data.filter(event => event.kind === 'model_request');
      expect(modelRequests.length).toBeGreaterThan(0);
      const sentToModel = server.model.requests();
      expect(modelRequests).toHaveLength(sentToModel.length);
      for (const event of modelRequests) {
        expect(event).toMatchObject({
          host: new URL(server.model.baseUrl).host,
          model: 'scripted-model',
          conversation_id: sessionId,
          tool_name: null,
          recipient_count: null,
          subject: null,
        });
        expect(event.request_bytes).toBeGreaterThan(0);
      }
      expect(JSON.stringify(sentToModel)).toContain(PROMPT_MARKER);
      expect(JSON.stringify(after.body)).not.toContain(PROMPT_MARKER);
      expect(JSON.stringify(after.body)).not.toContain('scripted-key');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'records an allowed connector call, but nothing for one that is still waiting for approval',
    async () => {
      const mark = (await outbound()).data.length;

      await runMessage({
        mcpServerName: INERT_SERVER_NAME,
        content: `${RUN_DIRECTIVE_PREFIX}${INERT_WRITE_TOOL} please`,
      });
      const waiting = (await outbound()).data.filter(event => event.kind === 'connector_call');
      expect(waiting).toEqual([]);
      expect(server.mcp.writeInvocations()).toBe(0);

      server.mcp.resetInvocations();
      await runMessage({
        mcpServerName: INERT_MEMORY_SERVER_NAME,
        content: `${RUN_DIRECTIVE_PREFIX}${INERT_ASK_MEMORY_TOOL} ${PROMPT_MARKER}`,
      });
      expect(server.mcp.askMemoryInvocations()).toBe(1);

      const calls = (await outbound()).data.filter(event => event.kind === 'connector_call');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        host: new URL(server.mcp.memoryProviderUrl).host,
        tool_name: INERT_ASK_MEMORY_TOOL,
        model: null,
      });
      expect((await outbound()).data.length).toBeGreaterThan(mark);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'records a designated search provider call as a web search without the query',
    async () => {
      const designate = await server.request(
        '/api/v1/settings/mcp-servers',
        jsonInit(
          {
            manifest: {
              type: 'remote',
              name: INERT_SERVER_NAME,
              url: server.mcp.url,
              description: 'Inert connector used by approval-flow tests.',
              search_provider: true,
            },
          },
          'PUT',
        ),
      );
      expect(designate.status).toBe(200);

      await runMessage({
        mcpServerName: INERT_SERVER_NAME,
        content: `${RUN_DIRECTIVE_PREFIX}${INERT_ECHO_TOOL} text:${QUERY_MARKER}`,
      });
      expect(server.mcp.echoInvocations()).toBe(1);

      const result = await outbound();
      const searches = result.data.filter(event => event.kind === 'web_search');
      expect(searches).toHaveLength(1);
      expect(searches[0]).toMatchObject({ host: new URL(server.mcp.url).host, tool_name: INERT_ECHO_TOOL });
      expect(JSON.stringify(result.body)).not.toContain(QUERY_MARKER);
    },
    TURN_TIMEOUT_MS,
  );

  it('lists newest first', async () => {
    const times = (await outbound()).data.map(event => Date.parse(event.created_at));
    expect(times.length).toBeGreaterThan(2);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('lists where each kind of data lives for the owner', async () => {
    const response = await server.request('/api/v1/settings/data-locations');
    expect(response.status).toBe(200);
    const locations = ListDataLocationsResponseSchema.parse(await response.json()).data;
    expect(locations.map(location => location.id)).toEqual([
      'chats',
      'memory',
      'personas',
      'files_from_runs',
      'settings',
      'backups',
    ]);
  });
});
