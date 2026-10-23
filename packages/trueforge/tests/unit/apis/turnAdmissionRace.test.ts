/**
 * Two create-turn requests for one chat that the server accepts at the same time, over the routes
 * the chat uses: the owner presses Send or an approval button twice while the server is still
 * setting the reply up. At most one of them may run, the other is refused or answered from what
 * is on record, and the chat must not end up stuck.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type * as sentinelSettings from '../../../src/runtime/sentinelSettingsServices';
import type * as internalSources from '../../../src/runtime/turnInternalSources';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_SERVER_NAME } from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX, WRITE_THEN_SEARCH_DIRECTIVE } from '../../fixtures/scriptedModelServer';

/**
 * Before a turn exists the server looks up the persona's library, which on a slow model takes
 * seconds. Each request that reaches it here waits for its own gate, so a test decides the order
 * in which the waiting requests go on.
 */
const admissionGates: Promise<unknown>[] = [];
let onAdmissionHeld: (() => void) | undefined;
jest.mock('../../../src/runtime/turnInternalSources', () => {
  const actual = jest.requireActual<typeof internalSources>('../../../src/runtime/turnInternalSources');
  return {
    ...actual,
    resolveTurnInternalSources: async (input: Parameters<typeof actual.resolveTurnInternalSources>[0]) => {
      const gate = admissionGates.shift();
      if (gate !== undefined) {
        onAdmissionHeld?.();
        await gate;
      }
      return actual.resolveTurnInternalSources(input);
    },
  };
});

/** While set, the next offline check (inside a turn's run, before its model call) waits for it. */
let offlineCheckHang: Promise<unknown> | undefined;
jest.mock('../../../src/runtime/sentinelSettingsServices', () => {
  const actual = jest.requireActual<typeof sentinelSettings>('../../../src/runtime/sentinelSettingsServices');
  return {
    ...actual,
    sentinelSettingsServices: (store: Parameters<typeof actual.sentinelSettingsServices>[0]) => {
      const services = actual.sentinelSettingsServices(store);
      return {
        ...services,
        isOffline: async (input: Parameters<typeof services.isOffline>[0]) => {
          const hang = offlineCheckHang;
          offlineCheckHang = undefined;
          if (hang !== undefined) {
            await hang;
          }
          return services.isOffline(input);
        },
      };
    },
  };
});

const SETTLE_BUDGET_MS = 15_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Use the inert connector exactly as instructed.',
  mcp_servers: [{ name: INERT_SERVER_NAME, preload: true, require_approval_for_tools: ['@write'] }],
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

const ErrorCodeSchema = z.object({ error: z.object({ code: z.string().nullable().optional() }).loose() });
const TurnIdSchema = z.object({ data: z.object({ id: z.string() }).loose() });

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function createSession(server: ApprovalTestServer): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec: AGENT_SPEC } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return TurnIdSchema.parse(body).data.id;
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

async function reloadTurns(server: ApprovalTestServer, sessionId: string): Promise<Turn[]> {
  const listed: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json();
  const turns: Turn[] = [];
  for (const { id } of ListTurnsResponseSchema.parse(listed).data) {
    const body: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns/${id}`)).json();
    turns.push(GetTurnResponseSchema.parse(body).data);
  }
  return turns;
}

/** Resolves once a second turn exists: the first reply to go on was created. */
async function secondTurnCreated(server: ApprovalTestServer, sessionId: string): Promise<void> {
  await waitFor({
    read: () => reloadTurns(server, sessionId),
    ready: turns => turns.length === 2,
    budgetMs: SETTLE_BUDGET_MS,
  });
}

/** Asks for the gated write and returns the paused turn with its approval card. */
async function askForWrite(
  server: ApprovalTestServer,
  sessionId: string,
): Promise<{ turnId: string; approval: TurnInputItem[] }> {
  const ask: TurnInputItem[] = [
    { type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${WRITE_THEN_SEARCH_DIRECTIVE}` },
  ];
  const asked = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input: ask, stream: true }));
  expect(asked.status).toBe(200);
  await asked.text();
  const [paused] = await reloadTurns(server, sessionId);
  if (paused?.state.status !== 'done') {
    throw new Error(`the first turn did not pause: ${JSON.stringify(paused?.state)}`);
  }
  const card = paused.state.required_actions.find(action => action.type === 'tool.approval_required');
  const call = card?.tool_calls[0];
  if (card === undefined || call === undefined) {
    throw new Error('no approval is waiting');
  }
  return {
    turnId: paused.id,
    approval: [
      { type: 'user.tool_approval', thread_id: card.thread_id, tool_call_id: call.id, approval: { status: 'allow' } },
    ],
  };
}

/** Holds the next request in setup until `release` is called; resolves once it is held. */
function holdNextAdmission(): { held: Promise<void>; release: () => void } {
  const gate = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<undefined>();
  admissionGates.push(gate.promise);
  const previous = onAdmissionHeld;
  onAdmissionHeld = () => {
    onAdmissionHeld = previous;
    held.resolve(undefined);
  };
  return {
    held: held.promise,
    release: () => {
      gate.resolve(undefined);
    },
  };
}

async function sendHeld({
  server,
  sessionId,
  input,
  previousTurnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
  previousTurnId: string;
}): Promise<{ release: () => void; response: Promise<Response> }> {
  const { held, release } = holdNextAdmission();
  const response = server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input, stream: false, previous_turn_id: previousTurnId }),
  );
  await held;
  return { release, response };
}

async function outcome(response: Response): Promise<{ status: number; code: string | null | undefined }> {
  const body: unknown = await response.json();
  return { status: response.status, code: response.status === 409 ? ErrorCodeSchema.parse(body).error.code : null };
}

describe('two replies for one chat accepted at the same time', () => {
  let server: ApprovalTestServer;

  beforeEach(async () => {
    server = await startApprovalTestServer();
  });

  afterEach(async () => {
    admissionGates.length = 0;
    onAdmissionHeld = undefined;
    offlineCheckHang = undefined;
    await server.close();
  });

  it('runs only one reply when Send is pressed twice during setup', async () => {
    const sessionId = await createSession(server);
    const first = await server.request(
      `/api/v1/sessions/${sessionId}/turns`,
      jsonInit({ input: [{ type: 'user.message', content: 'Hello.' }], stream: true }),
    );
    expect(first.status).toBe(200);
    await first.text();
    const [answered] = await reloadTurns(server, sessionId);
    const previousTurnId = answered?.id ?? 'missing';

    // Both presses carry the same message and name the same finished turn.
    const press: TurnInputItem[] = [{ type: 'user.message', content: 'And one more thing.' }];
    const pressed = await sendHeld({ server, sessionId, input: press, previousTurnId });
    const pressedAgain = await sendHeld({ server, sessionId, input: press, previousTurnId });

    // The first press is created and still running, held before its model call, when the second goes on.
    const runHold = Promise.withResolvers<undefined>();
    offlineCheckHang = runHold.promise;
    pressed.release();
    expect((await pressed.response).status).toBe(200);
    pressedAgain.release();

    expect(await outcome(await pressedAgain.response)).toEqual({ status: 409, code: 'previous_turn_running' });
    runHold.resolve(undefined);

    const turns = await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: listed => listed.every(turn => turn.state.status !== 'running'),
      budgetMs: SETTLE_BUDGET_MS,
    });
    expect(turns.map(turn => turn.state.status)).toEqual(['done', 'done']);
  }, 60_000);

  it('answers a second press of the same approval from the record instead of running it twice', async () => {
    const sessionId = await createSession(server);
    const { turnId, approval } = await askForWrite(server, sessionId);

    const first = await sendHeld({ server, sessionId, input: approval, previousTurnId: turnId });
    const second = await sendHeld({ server, sessionId, input: approval, previousTurnId: turnId });
    first.release();
    await secondTurnCreated(server, sessionId);
    second.release();

    expect((await first.response).status).toBe(200);
    const again = await second.response;
    expect([200, 409]).toContain(again.status);

    const turns = await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: listed => listed.every(turn => turn.state.status !== 'running'),
      budgetMs: SETTLE_BUDGET_MS,
    });
    expect(turns).toHaveLength(2);
  }, 60_000);
});
