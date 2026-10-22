/**
 * A model that goes silent after a tool result, over the real server path: the scripted provider
 * answers the continuation request with a heartbeat and nothing else. Cancel must end the turn
 * within seconds and keep the steps already done.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { MODEL_STOPPED_ANSWERING_MESSAGE } from '@truefoundry/trueforge-core/core';
import configuration from '../../../src/config';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { installRecordedTavily } from '../../fixtures/groundedFinderFixtures';
import {
  RUN_DIRECTIVE_PREFIX,
  STALL_AFTER_TOOL_DIRECTIVE,
  STALL_MID_ANSWER_DIRECTIVE,
} from '../../fixtures/scriptedModelServer';

const CANCEL_BUDGET_MS = 5_000;
const TAVILY_SERVER_NAME = 'tavily';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [{ name: TAVILY_SERVER_NAME, preload: true }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function waitFor<T>({
  read,
  ready,
  budgetMs,
}: {
  read: () => Promise<T>;
  ready: (value: T) => boolean;
  budgetMs: number;
}): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(budgetMs)}ms: ${JSON.stringify(value)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function onlyTurn(server: ApprovalTestServer, sessionId: string): Promise<Turn | undefined> {
  const body: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json();
  const id = ListTurnsResponseSchema.parse(body).data[0]?.id;
  if (id === undefined) {
    return undefined;
  }
  const turn: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns/${id}`)).json();
  return GetTurnResponseSchema.parse(turn).data;
}

/** The finished turn's tool calls by tool: the steps it kept. */
function toolCallsOf(turn: Turn | undefined): Record<string, number> | undefined {
  return turn === undefined || turn.state.status === 'running' ? undefined : turn.state.metrics?.tool_calls_by_tool;
}

describe('a model that goes silent after a tool result', () => {
  let server: ApprovalTestServer;
  let tavily: ReturnType<typeof installRecordedTavily>;

  beforeEach(async () => {
    server = await startApprovalTestServer();
    tavily = installRecordedTavily();
    const saved = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit(
        {
          manifest: {
            type: 'remote',
            name: TAVILY_SERVER_NAME,
            url: 'https://mcp.tavily.com/mcp',
            description: 'Search the web, extract page content, and crawl sites.',
            search_provider: true,
            auth: { type: 'header', headers: { Authorization: 'Bearer YOUR_TAVILY_API_KEY' } },
          },
        },
        'PUT',
      ),
    );
    expect(saved.status).toBe(200);
    // Searches run without a card, as the owner's did.
    const settings = await server.request(
      '/api/v1/user/settings/sentinel',
      jsonInit({ search_without_asking: true }, 'PATCH'),
    );
    expect(settings.status).toBe(200);
  });

  afterEach(async () => {
    tavily.restore();
    await server.close();
  });

  it('stops on Cancel within seconds and keeps the tool step', async () => {
    const sessionId = await createSession(server);
    const input: TurnInputItem[] = [
      { type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${STALL_AFTER_TOOL_DIRECTIVE}` },
    ];
    const started = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: true }));
    expect(started.status).toBe(200);
    const drained = started.text();

    // The second model request is the continuation after the tool result; the provider stalls on it.
    await waitFor({
      read: () => Promise.resolve(server.model.requests().length),
      ready: count => count >= 3,
      budgetMs: 30_000,
    });

    const cancelledAt = Date.now();
    const cancel = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({}));
    expect(cancel.status).toBe(200);
    const turn = await waitFor({
      read: () => onlyTurn(server, sessionId),
      ready: value => value !== undefined && value.state.status !== 'running',
      budgetMs: CANCEL_BUDGET_MS,
    });
    expect(Date.now() - cancelledAt).toBeLessThan(CANCEL_BUDGET_MS);
    expect(turn?.state.status).toBe('cancelled');
    expect(toolCallsOf(turn)).toMatchObject({ tavily_search: 1 });
    await drained;
  }, 60_000);

  describe('with short silence bounds', () => {
    const original = {
      first: configuration.MODEL_FIRST_RESPONSE_TIMEOUT_MS,
      idle: configuration.MODEL_STREAM_IDLE_TIMEOUT_MS,
    };

    beforeEach(() => {
      configuration.MODEL_FIRST_RESPONSE_TIMEOUT_MS = 500;
      configuration.MODEL_STREAM_IDLE_TIMEOUT_MS = 500;
    });

    afterEach(() => {
      configuration.MODEL_FIRST_RESPONSE_TIMEOUT_MS = original.first;
      configuration.MODEL_STREAM_IDLE_TIMEOUT_MS = original.idle;
    });

    it.each([
      { name: 'never sends a first token after the search', directive: STALL_AFTER_TOOL_DIRECTIVE },
      { name: 'goes silent in the middle of its answer', directive: STALL_MID_ANSWER_DIRECTIVE },
    ])(
      'ends the turn with the plain message when the model $name',
      async ({ directive }) => {
        const sessionId = await createSession(server);
        const input: TurnInputItem[] = [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${directive}` }];
        const started = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: true }));
        expect(started.status).toBe(200);
        await started.text();

        const turn = await waitFor({
          read: () => onlyTurn(server, sessionId),
          ready: value => value !== undefined && value.state.status !== 'running',
          budgetMs: 10_000,
        });
        expect(turn?.state.status).toBe('error');
        expect(turn?.state.status === 'error' ? turn.state.message : '').toBe(MODEL_STOPPED_ANSWERING_MESSAGE);
        expect(toolCallsOf(turn)).toMatchObject({ tavily_search: 1 });
      },
      60_000,
    );
  });
});
