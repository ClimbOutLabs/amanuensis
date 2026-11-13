/**
 * Walks notes kept in the real Obsidian app through the real server: Obsidian's Local REST API
 * plugin is added as a connector by its address, the way Settings adds one. Needs Obsidian running
 * with the plugin on, so it has its own script and is not part of the unit run.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';

const OBSIDIAN = 'obsidian';
const SEARCH_TOOL = 'search_simple';
const READ_TOOL = 'vault_read';
/** The note the workflow's made-up vault holds, and a word only that note has. */
const NOTE = 'Garden plan.md';
const NOTE_WORD = 'tomatoes';

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Do exactly what is asked.',
  mcp_servers: [
    { name: OBSIDIAN, preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. Start Obsidian with "pnpm nightly:obsidian-notes:start" first.`);
  }
  return value;
}

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createChat(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

/** Runs one turn to its end and returns the saved turn. */
async function runTurn({
  server,
  chatId,
  input,
}: {
  server: ApprovalTestServer;
  chatId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await server.request(
    `/api/v1/sessions/${chatId}/turns`,
    jsonInit({ input, stream: true, client_timezone: 'Europe/London' }),
  );
  if (response.status !== 200) {
    throw new Error(`create turn failed (${String(response.status)}): ${await response.text()}`);
  }
  const created = (await response.text())
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length))))
    .find(event => event.type === 'turn.created');
  if (created === undefined) {
    throw new Error('the turn stream carried no turn.created event');
  }
  const saved = await server.request(`/api/v1/sessions/${chatId}/turns/${created.turn_id}`);
  return GetTurnResponseSchema.parse(await saved.json()).data;
}

/** The cards a finished turn is waiting on. */
function cards(turn: Turn) {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions.flatMap(action =>
    action.type === 'tool.approval_required'
      ? action.tool_calls.map(call => ({ ...call, thread_id: action.thread_id }))
      : [],
  );
}

describe('notes in Obsidian, reached through a connector the person adds by its address', () => {
  let server: ApprovalTestServer;

  /** Asks for one Obsidian tool in a new chat and returns the chat with the turn that came back. */
  async function useObsidian({ tool, toolArguments }: { tool: string; toolArguments: object }) {
    const chatId = await createChat(server);
    server.model.next({ toolArguments });
    const input: TurnInputItem[] = [{ type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${tool} please` }];
    return { chatId, turn: await runTurn({ server, chatId, input }) };
  }

  /** Everything the chat holds so far, tool results included. */
  async function chatLog(chatId: string): Promise<string> {
    const response = await server.request(`/api/v1/sessions/${chatId}/events`);
    expect(response.status).toBe(200);
    return response.text();
  }

  beforeAll(async () => {
    server = await startApprovalTestServer();
    const added = await server.request(
      '/api/v1/settings/mcp-servers',
      jsonInit({
        manifest: {
          type: 'remote',
          name: OBSIDIAN,
          url: requiredEnv('OBSIDIAN_MCP_URL'),
          description: 'My notes in Obsidian.',
          auth: { type: 'header', headers: { Authorization: `Bearer ${requiredEnv('OBSIDIAN_API_KEY')}` } },
        },
      }),
    );
    if (added.status !== 201) {
      throw new Error(`adding Obsidian failed (${String(added.status)}): ${await added.text()}`);
    }
  });

  afterAll(async () => {
    await server.close();
  });

  it('lists the tools Obsidian offers once it is added', async () => {
    const response = await server.request(`/api/v1/mcp-servers/${OBSIDIAN}/tools`);
    const listed = await response.text();
    expect(response.status).toBe(200);
    expect(listed).toContain(SEARCH_TOOL);
    expect(listed).toContain(READ_TOOL);
  });

  it('asks before the first search, and "Always allow everywhere" lets later searches find the note in any chat', async () => {
    const first = await useObsidian({ tool: SEARCH_TOOL, toolArguments: { query: NOTE_WORD } });
    const [card, ...others] = cards(first.turn);
    expect(others).toEqual([]);
    expect(card).toMatchObject({ can_always_allow: true });
    if (card === undefined) {
      throw new Error('the first search of the notes did not ask');
    }
    expect(await chatLog(first.chatId)).not.toContain(NOTE);

    await runTurn({
      server,
      chatId: first.chatId,
      input: [
        {
          type: 'user.tool_approval',
          thread_id: card.thread_id,
          tool_call_id: card.id,
          approval: { status: 'allow', scope: 'always' },
        },
      ],
    });
    expect(await chatLog(first.chatId)).toContain(NOTE);

    const later = await useObsidian({ tool: SEARCH_TOOL, toolArguments: { query: NOTE_WORD } });
    expect(cards(later.turn)).toEqual([]);
    expect(await chatLog(later.chatId)).toContain(NOTE);
  });
});
