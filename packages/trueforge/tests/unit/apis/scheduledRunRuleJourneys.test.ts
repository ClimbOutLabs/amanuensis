/**
 * Walks the safety rules for scheduled runs through the real server with a scripted model.
 * Nobody watches a scheduled run, so each test reads what the run did, what it held, and what a later answer does.
 */
import { z } from '@hono/zod-openapi';
import { AgentSpecSchema, type Turn, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { SqliteScheduleStore } from '../../../src/db/sqlite/schedule-store/SqliteScheduleStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { ScheduleManifestSchema } from '../../../src/schemas/schedule';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { HARBOUR_ADDRESS, installRecordedTavily } from '../../fixtures/groundedFinderFixtures';
import { INERT_SERVER_NAME, INERT_WRITE_TOOL, startInertMcpServer } from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX } from '../../fixtures/scriptedModelServer';
import { StandInSandbox } from '../../fixtures/standInSandbox';

const TURN_TIMEOUT_MS = 60_000;

const AGENT_SPEC = AgentSpecSchema.parse({
  model: { name: MODEL_FQN },
  instructions: 'Do exactly what the task says.',
  mcp_servers: [
    { name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write', '@destructive', '@unclassified'] },
  ],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
});

/** The standalone owner, in the wire shape the agent and schedule stores keep. */
const OWNER_SUBJECT = {
  subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
  subject_type: 'user' as const,
  subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
};

function jsonInit(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function finishedTurn({ server, chatId }: { server: ApprovalTestServer; chatId: string }): Promise<Turn> {
  const list = ListTurnsResponseSchema.parse(await (await server.request(`/api/v1/sessions/${chatId}/turns`)).json());
  const turnId = list.data[0]?.id;
  if (turnId === undefined) {
    throw new Error('the scheduled run started no turn');
  }
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    const turn = GetTurnResponseSchema.parse(
      await (await server.request(`/api/v1/sessions/${chatId}/turns/${turnId}`)).json(),
    ).data;
    if (turn.state.status !== 'running') {
      return turn;
    }
    if (Date.now() > deadline) {
      throw new Error(`turn ${turnId} never left the running state`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Saves a schedule with this task, runs it once as the scheduler would, and returns the run's chat and turn. */
async function runScheduled({
  server,
  agent,
  name,
  task,
}: {
  server: ApprovalTestServer;
  agent: { id: string; name: string };
  name: string;
  task: string;
}): Promise<{ chatId: string; turn: Turn }> {
  const scheduled = await new SqliteScheduleStore(server.db()).createScheduleAndRun({
    tenant_id: 'default',
    agent_id: agent.id,
    agent_name: agent.name,
    persona_id: null,
    name,
    manifest: ScheduleManifestSchema.parse({ task, cron: '0 8 * * *', timezone: 'UTC', status: 'active' }),
    created_by_subject: OWNER_SUBJECT,
    runFrom: new Date(),
  });
  const run = scheduled.pendingRun;
  if (run === undefined) {
    throw new Error('the active schedule added no pending run');
  }
  const execute = await server.request('/api/internal/schedules/runs/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${configuration.TRUEFORGE_API_KEY}` },
    body: JSON.stringify({ schedule_run_id: run.id }),
  });
  expect(execute.status).toBe(204);
  const session = await new SqliteSessionStore(server.db()).getSessionByExternalId({
    tenant_id: 'default',
    external_id: run.id,
  });
  if (session === undefined) {
    throw new Error('the scheduled run created no chat');
  }
  return { chatId: session.session_id, turn: await finishedTurn({ server, chatId: session.session_id }) };
}

const HeldRefusalSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }).loose() });

const HeldCardsSchema = z.object({
  data: z.array(
    z.object({
      event: z
        .object({
          type: z.string(),
          thread_id: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z
                .object({
                  id: z.string(),
                  held: z.boolean().optional(),
                  tier3_card: z
                    .object({ plain_what: z.string(), outbound_text: z.string().nullable() })
                    .loose()
                    .nullable()
                    .optional(),
                })
                .loose(),
            )
            .optional(),
        })
        .loose(),
    }),
  ),
});

/** Types one message in a chat, as the person would, and returns what the cards of that turn ask. */
async function typeInChat({
  server,
  chatId,
  text,
}: {
  server: ApprovalTestServer;
  chatId: string;
  text: string;
}): Promise<(string | undefined)[]> {
  const input: TurnInputItem[] = [{ type: 'user.message', content: text }];
  const response = await server.request(`/api/v1/sessions/${chatId}/turns`, jsonInit({ input, stream: true }));
  const turnId = /"turn_id":"([^"]+)"/.exec(await response.text())?.[1];
  if (response.status !== 200 || turnId === undefined) {
    throw new Error(`the typed turn did not start (${String(response.status)})`);
  }
  const turn = GetTurnResponseSchema.parse(
    await (await server.request(`/api/v1/sessions/${chatId}/turns/${turnId}`)).json(),
  ).data;
  if (turn.state.status !== 'done') {
    throw new Error(`the typed turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions.flatMap(action =>
    action.type === 'tool.approval_required' ? action.tool_calls.map(call => call.tier3_card?.plain_what) : [],
  );
}

/** The cards a scheduled run saved for its owner, as the chat's "Needs your OK" list reads them. */
async function heldCards({ server, chatId }: { server: ApprovalTestServer; chatId: string }) {
  const events = HeldCardsSchema.parse(await (await server.request(`/api/v1/sessions/${chatId}/events`)).json());
  return events.data.flatMap(({ event }) =>
    event.type === 'tool.approval_required'
      ? (event.tool_calls ?? [])
          .filter(call => call.held === true)
          .map(call => ({ ...call, thread_id: event.thread_id ?? 'main' }))
      : [],
  );
}

const SavedSpaceSchema = z.object({ id: z.string(), name: z.string(), body: z.string(), revision: z.number() }).loose();
const SpaceResponseSchema = z.object({ data: SavedSpaceSchema });
const ListSpacesSchema = z.object({
  data: z.object({ spaces: z.array(SavedSpaceSchema), aggregate_revision: z.number() }),
});

async function listSpaces(server: ApprovalTestServer) {
  return ListSpacesSchema.parse(await (await server.request('/api/v1/spaces')).json()).data;
}

const ActivityLogSchema = z.object({
  data: z.array(z.object({ tool_name: z.string(), description: z.string(), outcome: z.string() }).loose()),
});

/** What the activity log in Settings says about one space, oldest line first. */
async function spaceActivity({ server, name }: { server: ApprovalTestServer; name: string }): Promise<string[]> {
  const log = ActivityLogSchema.parse(await (await server.request('/api/v1/user/audit-log')).json());
  return log.data
    .filter(row => row.description.includes(`the space ${name}.`))
    .map(row => row.description)
    .reverse();
}

const RunLogSchema = z.object({
  entries: z.array(z.object({ tool_name: z.string(), description: z.string(), outcome: z.string() }).loose()),
});

/** What one chat's own log says about its maps. */
async function mapLines({ server, chatId }: { server: ApprovalTestServer; chatId: string }) {
  const log = RunLogSchema.parse(await (await server.request(`/api/v1/sessions/${chatId}/audit-log`)).json());
  return log.entries.filter(row => row.tool_name === 'render_map');
}

describe('scheduled runs', () => {
  let server: ApprovalTestServer;
  let agent: { id: string; name: string };
  let memoryDir: string;
  const original = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    MEMORY_EMBEDDINGS_ENABLED: configuration.MEMORY_EMBEDDINGS_ENABLED,
    MEMORY_SUMMARIZE: configuration.MEMORY_SUMMARIZE,
  };

  beforeAll(async () => {
    // A scheduled run saves to the memory vault, so it gets a folder of its own.
    memoryDir = await mkdtemp(join(tmpdir(), 'scheduled-run-rules-'));
    Object.assign(configuration, {
      MEMORY_MARKDOWN_DIR: memoryDir,
      MEMORY_EMBEDDINGS_ENABLED: false,
      MEMORY_SUMMARIZE: false,
    });
    server = await startApprovalTestServer();
    agent = await new SqliteAgentStore(server.db()).createAgent({
      host_managed: false,
      tenant_id: 'default',
      created_by_subject: OWNER_SUBJECT,
      name: 'weekly-tidy',
      description: 'Scheduled agent used by the scheduled-run rule tests.',
      manifest: AGENT_SPEC,
      external_id: 'weekly-tidy-external-id',
    });
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    Object.assign(configuration, original);
    await rm(memoryDir, { recursive: true, force: true });
  });

  /** A change through the connector, which a scheduled run may not make on its own. */
  async function runThatHoldsAChange(name: string) {
    const { chatId, turn } = await runScheduled({
      server,
      agent,
      name,
      task: `Tidy the notes. ${RUN_DIRECTIVE_PREFIX}${INERT_WRITE_TOOL}`,
    });
    const held = (await heldCards({ server, chatId }))[0];
    if (held === undefined) {
      throw new Error('the scheduled run held nothing');
    }
    return { chatId, turn, held };
  }

  function approve({ chatId, held }: { chatId: string; held: { thread_id: string; id: string } }): Promise<Response> {
    const input: TurnInputItem[] = [
      { type: 'user.tool_approval', thread_id: held.thread_id, tool_call_id: held.id, approval: { status: 'allow' } },
    ];
    return server.request(`/api/v1/sessions/${chatId}/turns`, jsonInit({ input, stream: true }));
  }

  it(
    'holds a change for the owner, and a later approval runs exactly what the card showed',
    async () => {
      const writesBefore = server.mcp.writeInvocations();
      const { chatId, turn, held } = await runThatHoldsAChange('tidy-notes');
      expect(turn.state.status === 'done' && turn.state.required_actions).toEqual([]);
      expect(held.tier3_card?.outbound_text).toBe('text: inert');
      expect(server.mcp.writeInvocations()).toBe(writesBefore);

      const answered = await approve({ chatId, held });
      expect(answered.status).toBe(200);
      await answered.text();
      expect(server.mcp.writeInvocations()).toBe(writesBefore + 1);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'does nothing when the action no longer matches the card, and says to ask again in chat',
    async () => {
      const writesBefore = server.mcp.writeInvocations();
      const { chatId, held } = await runThatHoldsAChange('tidy-notes-again');

      // The connector now goes somewhere else, so the place the card named is no longer where this would go.
      const elsewhere = await startInertMcpServer({ webSearch: false });
      try {
        const moved = await server.request(
          '/api/v1/settings/mcp-servers',
          jsonInit(
            {
              manifest: {
                type: 'remote',
                name: INERT_SERVER_NAME,
                url: elsewhere.url,
                description: 'Inert connector used by approval-flow tests.',
              },
            },
            'PUT',
          ),
        );
        expect(moved.status).toBe(200);

        const answered = await approve({ chatId, held });
        expect(answered.status).toBe(409);
        expect(HeldRefusalSchema.parse(await answered.json()).error).toMatchObject({
          code: 'held_action_changed',
          message: 'This no longer matches what was held, so nothing was done. Ask again in chat.',
        });
        expect(server.mcp.writeInvocations()).toBe(writesBefore);
        expect(elsewhere.writeInvocations()).toBe(0);
      } finally {
        await elsewhere.close();
      }
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'makes and changes a space without asking, shows one line per change in the activity log, and keeps the earlier version so it can be brought back',
    async () => {
      const NAME = 'Apartment listings';
      const FIRST = '- Flat on Quay Street, two rooms';
      const SECOND = '- Flat on Mill Lane, three rooms';

      server.model.next({
        toolArguments: {
          name: NAME,
          purpose: 'Flats worth a visit, kept up to date each morning.',
          status: 'active',
          body: FIRST,
        },
      });
      const made = await runScheduled({
        server,
        agent,
        name: 'listings-first-morning',
        task: `Start the list of flats. ${RUN_DIRECTIVE_PREFIX}create_space`,
      });
      expect(await heldCards({ server, chatId: made.chatId })).toEqual([]);
      const created = (await listSpaces(server)).spaces.find(space => space.name === NAME);
      expect(created).toMatchObject({ revision: 1, body: FIRST });
      expect(await spaceActivity({ server, name: NAME })).toEqual([`Created the space ${NAME}.`]);
      if (created === undefined) {
        throw new Error('the scheduled run saved no space');
      }

      server.model.next({
        toolArguments: {
          space_name: NAME,
          expected_revision: 1,
          edits: [{ type: 'append', new_content: SECOND }],
        },
      });
      const changed = await runScheduled({
        server,
        agent,
        name: 'listings-second-morning',
        task: `Add today's flats to the list. ${RUN_DIRECTIVE_PREFIX}edit_space`,
      });
      expect(await heldCards({ server, chatId: changed.chatId })).toEqual([]);
      const listed = await listSpaces(server);
      const current = listed.spaces.find(space => space.id === created.id);
      expect(current?.revision).toBe(2);
      expect(current?.body).toContain(FIRST);
      expect(current?.body).toContain(SECOND);
      expect(await spaceActivity({ server, name: NAME })).toEqual([
        `Created the space ${NAME}.`,
        `Updated the space ${NAME}.`,
      ]);

      const earlier = await server.request(`/api/v1/spaces/${created.id}?revision=1`);
      expect(SpaceResponseSchema.parse(await earlier.json()).data.body).toBe(FIRST);

      const reverted = await server.request(
        `/api/v1/spaces/${created.id}/revert`,
        jsonInit({ revision: 1, expected_revision: 2, expected_aggregate_revision: listed.aggregate_revision }),
      );
      expect(reverted.status).toBe(200);
      expect((await listSpaces(server)).spaces.find(space => space.id === created.id)).toMatchObject({
        revision: 3,
        body: FIRST,
      });
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'a space made in a chat the person is in leaves no line in the activity log',
    async () => {
      const NAME = 'Packing list';
      const chat = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
      expect(chat.status).toBe(201);
      const chatId = z.object({ data: z.object({ id: z.string() }) }).parse(await chat.json()).data.id;

      server.model.next({
        toolArguments: { name: NAME, purpose: 'What to bring on the trip.', status: 'active', body: '- Tent' },
      });
      expect(await typeInChat({ server, chatId, text: `${RUN_DIRECTIVE_PREFIX}create_space please` })).toEqual([]);
      expect((await listSpaces(server)).spaces.map(space => space.name)).toContain(NAME);
      expect(await spaceActivity({ server, name: NAME })).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  describe('a map in a scheduled run', () => {
    let recorded: ReturnType<typeof installRecordedTavily>;

    beforeAll(() => {
      recorded = installRecordedTavily();
    });

    afterAll(() => {
      recorded.restore();
    });

    async function runThatMaps({ name, place }: { name: string; place: string }) {
      server.model.next({ toolArguments: { place_name: place } });
      return runScheduled({ server, agent, name, task: `Map the meeting place. ${RUN_DIRECTIVE_PREFIX}render_map` });
    }

    it(
      'shows the map of an ordinary place without asking',
      async () => {
        const { chatId, turn } = await runThatMaps({ name: 'map-the-harbour', place: HARBOUR_ADDRESS });
        expect(turn.state.status === 'done' && turn.state.required_actions).toEqual([]);
        expect(await heldCards({ server, chatId })).toEqual([]);
        expect(await mapLines({ server, chatId })).toEqual([
          expect.objectContaining({ description: `Maps ran without asking: ${HARBOUR_ADDRESS}`, outcome: 'logged' }),
        ]);
      },
      TURN_TIMEOUT_MS,
    );

    it(
      'leaves out a map whose place text looks like a key, says so in one line, and leaves no card waiting',
      async () => {
        const { chatId, turn } = await runThatMaps({
          name: 'map-a-key',
          place: ['AKI', 'A', 'ABCDEFGH', 'IJKLMNOP'].join(''),
        });
        expect(turn.state.status === 'done' && turn.state.required_actions).toEqual([]);
        expect(await heldCards({ server, chatId })).toEqual([]);
        const lines = await mapLines({ server, chatId });
        expect(lines.map(row => row.outcome)).not.toContain('logged');
        expect(lines.filter(row => row.description.includes('One map was skipped'))).toHaveLength(1);
      },
      TURN_TIMEOUT_MS,
    );
  });
});

const SANDBOX_AGENT_SPEC = AgentSpecSchema.parse({
  ...AGENT_SPEC,
  config: { ...AGENT_SPEC.config, sandbox: { enabled: true } },
});
const RUN_CODE_CARD = 'Run this Python code the assistant wrote?';

describe('a scheduled run that wants to run code', () => {
  let server: ApprovalTestServer;
  let memoryDir: string;
  const original = {
    MEMORY_MARKDOWN_DIR: configuration.MEMORY_MARKDOWN_DIR,
    MEMORY_EMBEDDINGS_ENABLED: configuration.MEMORY_EMBEDDINGS_ENABLED,
    MEMORY_SUMMARIZE: configuration.MEMORY_SUMMARIZE,
  };

  beforeAll(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'scheduled-run-code-'));
    Object.assign(configuration, {
      MEMORY_MARKDOWN_DIR: memoryDir,
      MEMORY_EMBEDDINGS_ENABLED: false,
      MEMORY_SUMMARIZE: false,
    });
    // The sandbox has no network, where a chat with the switch on runs code without asking.
    server = await startApprovalTestServer({ sandboxProvider: new StandInSandbox('none') });
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    await server.close();
    Object.assign(configuration, original);
    await rm(memoryDir, { recursive: true, force: true });
  });

  it(
    'holds the code for the owner even with "run without asking" on',
    async () => {
      const saved = await server.request(
        '/api/v1/user/settings/sentinel',
        jsonInit({ sandbox_without_asking: true }, 'PATCH'),
      );
      expect(saved.status).toBe(200);
      const agent = await new SqliteAgentStore(server.db()).createAgent({
        host_managed: false,
        tenant_id: 'default',
        created_by_subject: OWNER_SUBJECT,
        name: 'weekly-sums',
        description: 'Scheduled agent with a sandbox, used by the scheduled-run rule tests.',
        manifest: SANDBOX_AGENT_SPEC,
        external_id: 'weekly-sums-external-id',
      });

      server.model.next({ toolArguments: { code: 'print(1)', language: 'python' } });
      const { chatId, turn } = await runScheduled({
        server,
        agent,
        name: 'add-up-the-week',
        task: `Add up the week. ${RUN_DIRECTIVE_PREFIX}run_code`,
      });

      expect(turn.state.status === 'done' && turn.state.required_actions).toEqual([]);
      const held = await heldCards({ server, chatId });
      expect(held.map(card => card.tier3_card?.plain_what)).toEqual([RUN_CODE_CARD]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "asks before code when the person types in the run's chat, and an ordinary chat still runs it without a card",
    async () => {
      const agent = await new SqliteAgentStore(server.db()).createAgent({
        host_managed: false,
        tenant_id: 'default',
        created_by_subject: OWNER_SUBJECT,
        name: 'weekly-notes',
        description: 'Scheduled agent with a sandbox, used by the scheduled-run rule tests.',
        manifest: SANDBOX_AGENT_SPEC,
        external_id: 'weekly-notes-external-id',
      });
      const { chatId } = await runScheduled({ server, agent, name: 'write-the-week-up', task: 'Write the week up.' });

      server.model.next({ toolArguments: { code: 'print(1)', language: 'python' } });
      expect(await typeInChat({ server, chatId, text: `${RUN_DIRECTIVE_PREFIX}run_code please` })).toEqual([
        RUN_CODE_CARD,
      ]);

      const created = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: SANDBOX_AGENT_SPEC } }));
      expect(created.status).toBe(201);
      const ordinary = z.object({ data: z.object({ id: z.string() }) }).parse(await created.json()).data.id;
      server.model.next({ toolArguments: { code: 'print(1)', language: 'python' } });
      expect(await typeInChat({ server, chatId: ordinary, text: `${RUN_DIRECTIVE_PREFIX}run_code please` })).toEqual(
        [],
      );
    },
    TURN_TIMEOUT_MS,
  );
});
