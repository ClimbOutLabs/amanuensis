/**
 * The Home Assistant demo world over the HTTP surface, against the SSE stub: a read runs, a
 * lamp change raises a card naming the lamp, the lock is refused outright, a standing grant on
 * lights lets the second lamp change run, clearing the grant makes the next change ask again,
 * and the heating line reaches the conversation only when the connector is mounted.
 */
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { z } from 'zod';
import { ListSessionEventsResponseSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import {
  HA_LAMP,
  HA_LOCK,
  startHomeAssistantStub,
  type HomeAssistantStub,
} from '../../fixtures/homeAssistantMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const CANARY_TOKEN = 'ha-flow-token-51c2';

const HA_AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the Home Assistant connector exactly as instructed.',
  mcp_servers: [
    {
      name: 'home-assistant',
      preload: true,
      require_approval_for_tools: ['@write', '@destructive', '@unclassified'],
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

const NO_HA_AGENT_SPEC = { ...HA_AGENT_SPEC, mcp_servers: [] };

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function userMessage(text: string): TurnInputItem[] {
  return [{ type: 'user.message', content: text }];
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

async function createSession(server: ApprovalTestServer, spec: object): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

async function runTurn({
  server,
  sessionId,
  input,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: true }));
  if (response.status !== 200) {
    const body: unknown = await response.json();
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  const streamBody = await response.text();
  let turnId: string | undefined;
  for (const line of streamBody.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const event: unknown = JSON.parse(line.slice('data: '.length));
    if (typeof event === 'object' && event !== null && 'type' in event && event.type === 'turn.created') {
      turnId = z.object({ turn_id: z.string() }).parse(event).turn_id;
    }
  }
  if (turnId === undefined) {
    throw new Error(`turn stream carried no turn.created event: ${streamBody.slice(0, 400)}`);
  }
  const turnResponse = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  const turnBody: unknown = await turnResponse.json();
  if (turnResponse.status !== 200) {
    throw new Error(`get turn failed (${String(turnResponse.status)}): ${JSON.stringify(turnBody)}`);
  }
  return GetTurnResponseSchema.parse(turnBody).data;
}

interface PendingApproval {
  thread_id: string;
  tool_call_id: string;
  plain_what: string | null;
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
      return {
        thread_id: action.thread_id,
        tool_call_id: first.id,
        plain_what: first.tier3_card?.plain_what ?? null,
      };
    }
  }
  return undefined;
}

const ToolResponseSchema = z.object({
  type: z.enum(['tool.response', 'tool.response.v2']),
  tool_call_id: z.string(),
  content: z.string(),
});

async function toolResponses(server: ApprovalTestServer, sessionId: string): Promise<string[]> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/events`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list session events failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  const items = ListSessionEventsResponseSchema.parse(body).data;
  const contents: string[] = [];
  for (const item of items) {
    const parsed = ToolResponseSchema.safeParse(item.event);
    if (parsed.success) {
      contents.push(parsed.data.content);
    }
  }
  return contents;
}

describe('Home Assistant demo world', () => {
  let server: ApprovalTestServer;
  let stub: HomeAssistantStub;
  let sessionId: string;
  let liveContextAfterSetup = 0;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    stub = await startHomeAssistantStub({ token: CANARY_TOKEN });
    const created = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit({
        manifest: {
          type: 'remote',
          name: 'home-assistant',
          url: stub.url,
          description: 'See and control the Home Assistant devices you expose to voice assistants.',
          auth: { type: 'header', headers: { Authorization: `Bearer ${CANARY_TOKEN}` } },
        },
      }),
    );
    if (created.status !== 201) {
      throw new Error(`connector create failed (${String(created.status)}): ${JSON.stringify(await created.json())}`);
    }
    // Setting the connector up runs its connection check, as the connector page does: the
    // check is the moment the server's own change declarations are captured onto the record,
    // and standing grants read them from there. The check also reads the live context once,
    // so the turn tests count from this baseline.
    const checked = await server.request('/api/v1/mcp-servers/home-assistant/home-assistant-check', {
      method: 'POST',
    });
    if (checked.status !== 200) {
      throw new Error(`connector check failed (${String(checked.status)}): ${JSON.stringify(await checked.json())}`);
    }
    liveContextAfterSetup = stub.liveContextInvocations();
    sessionId = await createSession(server, HA_AGENT_SPEC);
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await stub.stop();
    await server.close();
  });

  it(
    'runs a read without asking, and the heating line reaches the conversation',
    async () => {
      const turn = await runTurn({
        server,
        sessionId,
        input: userMessage(`${RUN_DIRECTIVE_PREFIX}GetLiveContext please`),
      });
      expect(pendingApproval(turn)).toBeUndefined();
      expect(stub.liveContextInvocations()).toBe(liveContextAfterSetup + 1);
      const responses = await toolResponses(server, sessionId);
      expect(responses.some(content => content.includes('Hallway thermostat: heating, set to 22 degrees'))).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'cards a lamp change naming the lamp, then runs it on Allow always and covers the next one',
    async () => {
      const turn = await runTurn({
        server,
        sessionId,
        input: userMessage(`${RUN_DIRECTIVE_PREFIX}HassTurnOff text:${HA_LAMP} please`),
      });
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      expect(pending?.plain_what).toBe('Turn off Living room lamp');
      expect(stub.invocations('HassTurnOff')).toBe(0);
      if (pending === undefined) {
        return;
      }
      const resumed = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'allow', scope: 'always' } }),
      });
      expect(pendingApproval(resumed)).toBeUndefined();
      expect(stub.invocations('HassTurnOff')).toBe(1);
      expect(stub.entityState(HA_LAMP)).toBe('off');

      // The standing grant is stored under the lights scope, where Settings lists it.
      const grants = await server.request('/api/v1/mcp-servers/home-assistant/tool-grants');
      expect(grants.status).toBe(200);
      const grantBody = (await grants.json()) as { data: { tool_name: string }[] };
      expect(grantBody.data.map(grant => grant.tool_name)).toContain('ha:domain:light');

      const second = await runTurn({
        server,
        sessionId,
        input: userMessage(`${RUN_DIRECTIVE_PREFIX}HassTurnOn text:${HA_LAMP} please`),
      });
      expect(pendingApproval(second)).toBeUndefined();
      expect(stub.invocations('HassTurnOn')).toBe(1);
      expect(stub.entityState(HA_LAMP)).toBe('on');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'refuses the front door lock outright, with no card and no run',
    async () => {
      const turn = await runTurn({
        server,
        sessionId,
        input: userMessage(`${RUN_DIRECTIVE_PREFIX}HassTurnOn text:${HA_LOCK} please`),
      });
      expect(pendingApproval(turn)).toBeUndefined();
      expect(stub.invocations('HassTurnOn')).toBe(1);
      const responses = await toolResponses(server, sessionId);
      expect(responses.some(content => content.includes('does not control locks, alarms or garage doors'))).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'asks again once the standing grant is cleared in Settings',
    async () => {
      const cleared = await server.request(
        `/api/v1/mcp-servers/home-assistant/tool-grants/${encodeURIComponent('ha:domain:light')}`,
        { method: 'DELETE' },
      );
      expect(cleared.status).toBe(200);
      const turn = await runTurn({
        server,
        sessionId,
        input: userMessage(`${RUN_DIRECTIVE_PREFIX}HassTurnOff text:${HA_LAMP} please`),
      });
      const pending = pendingApproval(turn);
      expect(pending).toBeDefined();
      expect(stub.invocations('HassTurnOff')).toBe(1);
      if (pending === undefined) {
        return;
      }
      const denied = await runTurn({
        server,
        sessionId,
        input: approvalInput({ ...pending, approval: { status: 'deny' } }),
      });
      expect(pendingApproval(denied)).toBeUndefined();
      expect(stub.invocations('HassTurnOff')).toBe(1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'has no heating line to mention when the connector is not mounted',
    async () => {
      const bareSessionId = await createSession(server, NO_HA_AGENT_SPEC);
      await runTurn({
        server,
        sessionId: bareSessionId,
        input: userMessage(`${RUN_DIRECTIVE_PREFIX}GetLiveContext please`),
      });
      const responses = await toolResponses(server, bareSessionId);
      expect(responses.some(content => content.includes('Hallway thermostat'))).toBe(false);
    },
    TURN_TIMEOUT_MS,
  );

  it('never lets the token reach a turn event', async () => {
    const responses = await toolResponses(server, sessionId);
    expect(responses.join('\n')).not.toContain(CANARY_TOKEN);
  });
});
