/**
 * An eval instance over the real turn route: a card answered without naming the turn it follows, as the app
 * answers it, still reaches the invented inbox and calendar, and any other tool is still declined.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_SERVER_NAME, INERT_WRITE_TOOL } from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX, SCRIPTED_EVENT } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the tools exactly as instructed.',
  mcp_servers: [{ name: INERT_SERVER_NAME, preload: true }],
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

describe('approval cards on an eval instance', () => {
  let server: ApprovalTestServer;

  beforeAll(async () => {
    server = await startApprovalTestServer();
    server.setEvalMode(true);
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  /** Sends one turn that follows the chat's last turn, as a caller that names no turn does. */
  async function runTurn({ sessionId, input }: { sessionId: string; input: TurnInputItem[] }): Promise<Turn> {
    const response = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input, stream: true }));
    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`turn failed (${String(response.status)}): ${text}`);
    }
    const created = text
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length))))
      .find(event => event.type === 'turn.created');
    if (created?.type !== 'turn.created') {
      throw new Error('the turn stream named no turn');
    }
    const turn = await server.request(`/api/v1/sessions/${sessionId}/turns/${created.turn_id}`);
    return GetTurnResponseSchema.parse(await turn.json()).data;
  }

  /** Asks for the tool, then allows the one card it raises. */
  async function askAndAllow(tool: string): Promise<void> {
    const created = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
    const sessionId = z.object({ data: z.object({ id: z.string() }) }).parse(await created.json()).data.id;
    const paused = await runTurn({
      sessionId,
      input: [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${tool} please` }],
    });
    const actions = paused.state.status === 'done' ? (paused.state.required_actions ?? []) : [];
    const action = actions.find(item => item.type === 'tool.approval_required');
    const call = action?.type === 'tool.approval_required' ? action.tool_calls[0] : undefined;
    if (action?.type !== 'tool.approval_required' || call === undefined) {
      throw new Error(`${tool} raised no card`);
    }
    await runTurn({
      sessionId,
      input: [
        {
          type: 'user.tool_approval',
          thread_id: action.thread_id,
          tool_call_id: call.id,
          approval: { status: 'allow', scope: 'once' },
        },
      ],
    });
  }

  it(
    'saves an allowed draft and an allowed event',
    async () => {
      const { gmail, calendar } = server.evalSources();
      const day = SCRIPTED_EVENT.start.slice(0, 10);
      const eventsThatDay = async () =>
        (
          await calendar.listEvents({
            timeMin: `${day}T00:00:00`,
            timeMax: `${day}T23:59:59`,
            query: SCRIPTED_EVENT.title,
            maxResults: 10,
            pageToken: undefined,
            timeZone: SCRIPTED_EVENT.time_zone,
          })
        ).events.length;
      const drafts = async () => (await gmail.listDrafts({ maxResults: 10, pageToken: undefined })).draftIds.length;
      const draftsBefore = await drafts();
      const eventsBefore = await eventsThatDay();

      await askAndAllow('draft_email');
      expect(await drafts()).toBe(draftsBefore + 1);

      await askAndAllow('create_event');
      expect(await eventsThatDay()).toBe(eventsBefore + 1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'still declines a tool that is not mail, calendar, maps or search',
    async () => {
      await askAndAllow(INERT_WRITE_TOOL);
      expect(server.mcp.writeInvocations()).toBe(0);
    },
    TURN_TIMEOUT_MS,
  );
});
