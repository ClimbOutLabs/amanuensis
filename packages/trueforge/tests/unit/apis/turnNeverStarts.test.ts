/**
 * A reply that the server accepted but that never reaches the model, over the routes the chat
 * uses. A step before the first model call hangs and ignores the abort. The reply must end on its
 * own with plain words, Cancel must end it, and in both cases the chat must take the next message.
 */
import { z } from '@hono/zod-openapi';
import { CancellationReason, type Turn, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import configuration from '../../../src/config';
import type * as sentinelSettings from '../../../src/runtime/sentinelSettingsServices';
import type * as internalSources from '../../../src/runtime/turnInternalSources';
import { TURN_COULD_NOT_START_MESSAGE } from '../../../src/runtime/turnStartBound';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_SERVER_NAME } from '../../fixtures/inertMcpServer';

/**
 * The offline check runs inside the turn's own run, right before its model request. While a hang is
 * set the next check never answers and ignores every abort, like a stuck read.
 */
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

/** Holds the next request in setup, before its turn exists, until the gate opens. */
let admissionGate: Promise<unknown> | undefined;
jest.mock('../../../src/runtime/turnInternalSources', () => {
  const actual = jest.requireActual<typeof internalSources>('../../../src/runtime/turnInternalSources');
  return {
    ...actual,
    resolveTurnInternalSources: async (input: Parameters<typeof actual.resolveTurnInternalSources>[0]) => {
      const gate = admissionGate;
      admissionGate = undefined;
      if (gate !== undefined) {
        await gate;
      }
      return actual.resolveTurnInternalSources(input);
    },
  };
});

const SETTLE_BUDGET_MS = 15_000;

const AGENT_SPEC = {
  model: { name: MODEL_FQN },
  instructions: 'Answer briefly.',
  config: {
    sandbox: { enabled: false },
    generative_ui: { enabled: false },
    ask_user_questions: { enabled: false },
    dynamic_sub_agents: { enabled: false },
    context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
  },
};

/** The same chat with a connector that starts before the model is asked, as most real chats have. */
const AGENT_SPEC_WITH_CONNECTOR = {
  ...AGENT_SPEC,
  mcp_servers: [{ name: INERT_SERVER_NAME, preload: true }],
};

const ErrorMessageSchema = z.object({
  error: z.object({ message: z.string(), code: z.string().nullable().optional() }).loose(),
});

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function message(text: string): TurnInputItem[] {
  return [{ type: 'user.message', content: text }];
}

async function createSession(server: ApprovalTestServer, spec: object = AGENT_SPEC): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit({ agent: { spec } }));
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

async function reloadTurns(server: ApprovalTestServer, sessionId: string): Promise<Turn[]> {
  const listed: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json();
  const turns: Turn[] = [];
  for (const { id } of ListTurnsResponseSchema.parse(listed).data) {
    const body: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns/${id}`)).json();
    turns.push(GetTurnResponseSchema.parse(body).data);
  }
  return turns;
}

/** Sends a message whose run hangs before the model, and waits until its turn exists. */
async function sendStuckReply(server: ApprovalTestServer, sessionId: string): Promise<void> {
  offlineCheckHang = new Promise(() => undefined);
  void server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input: message('Hello there.'), stream: false }),
  );
  await waitFor({
    read: () => reloadTurns(server, sessionId),
    ready: turns => turns.length === 1,
    budgetMs: SETTLE_BUDGET_MS,
  });
}

/** The chat is free again: the next message is accepted and answered by the model. */
async function expectNextMessageAnswered(server: ApprovalTestServer, sessionId: string): Promise<void> {
  const requestsBefore = server.model.requests().length;
  const next = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit({ input: message('Are you there?'), stream: true }),
  );
  expect(next.status).toBe(200);
  await next.text();
  const turns = await reloadTurns(server, sessionId);
  expect(turns.filter(turn => turn.state.status === 'done')).toHaveLength(1);
  expect(server.model.requests().length).toBeGreaterThan(requestsBefore);
}

describe('a reply that never reaches the model', () => {
  let server: ApprovalTestServer;
  const original = {
    startTimeoutMs: configuration.TURN_START_TIMEOUT_MS,
    executionTimeoutSeconds: configuration.SERVER_EXECUTION_TIMEOUT_SECONDS,
  };

  beforeEach(async () => {
    server = await startApprovalTestServer();
  });

  afterEach(async () => {
    offlineCheckHang = undefined;
    admissionGate = undefined;
    configuration.TURN_START_TIMEOUT_MS = original.startTimeoutMs;
    configuration.SERVER_EXECUTION_TIMEOUT_SECONDS = original.executionTimeoutSeconds;
    await server.close();
  });

  it('ends with plain words once its start limit passes, and the chat takes the next message', async () => {
    configuration.TURN_START_TIMEOUT_MS = 1_000;
    const sessionId = await createSession(server);
    await sendStuckReply(server, sessionId);

    const [ended] = await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: turns => turns.every(turn => turn.state.status !== 'running'),
      budgetMs: SETTLE_BUDGET_MS,
    });
    expect(ended?.state).toMatchObject({ status: 'error', message: TURN_COULD_NOT_START_MESSAGE });
    expect(server.model.requests()).toHaveLength(0);

    configuration.TURN_START_TIMEOUT_MS = original.startTimeoutMs;
    await expectNextMessageAnswered(server, sessionId);
  }, 60_000);

  it('is not released by its connector starting: it still ends once its start limit passes', async () => {
    configuration.TURN_START_TIMEOUT_MS = 1_000;
    const sessionId = await createSession(server, AGENT_SPEC_WITH_CONNECTOR);
    await sendStuckReply(server, sessionId);

    const [ended] = await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: turns => turns.every(turn => turn.state.status !== 'running'),
      budgetMs: SETTLE_BUDGET_MS,
    });
    expect(ended?.state).toMatchObject({ status: 'error', message: TURN_COULD_NOT_START_MESSAGE });
    expect(server.model.requests()).toHaveLength(0);

    configuration.TURN_START_TIMEOUT_MS = original.startTimeoutMs;
    await expectNextMessageAnswered(server, sessionId);
  }, 60_000);

  it('answers "could not start" when a setup step never returns, and the chat takes the next message', async () => {
    configuration.TURN_START_TIMEOUT_MS = 1_000;
    const sessionId = await createSession(server);
    // A setup step before the turn exists that never answers and ignores the abort.
    admissionGate = new Promise(() => undefined);
    const sentAt = Date.now();
    const response = await server.request(
      `/api/v1/sessions/${sessionId}/turns`,
      jsonInit({ input: message('Hello there.'), stream: true }),
    );
    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(response.status).toBe(409);
    expect(ErrorMessageSchema.parse(await response.json()).error).toMatchObject({
      message: TURN_COULD_NOT_START_MESSAGE,
      code: 'turn_could_not_start',
    });
    expect(await reloadTurns(server, sessionId)).toEqual([]);

    configuration.TURN_START_TIMEOUT_MS = original.startTimeoutMs;
    await expectNextMessageAnswered(server, sessionId);
  }, 60_000);

  it('ends on Cancel, and the chat takes the next message', async () => {
    const sessionId = await createSession(server);
    await sendStuckReply(server, sessionId);

    const cancel = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({}));
    expect(cancel.status).toBe(200);
    const [ended] = await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: turns => turns.every(turn => turn.state.status !== 'running'),
      budgetMs: SETTLE_BUDGET_MS,
    });
    expect(ended?.state).toMatchObject({ status: 'cancelled', reason: CancellationReason.ClientCancelled });

    await expectNextMessageAnswered(server, sessionId);
  }, 60_000);

  it('is covered by its deadline from the moment it is accepted', async () => {
    configuration.SERVER_EXECUTION_TIMEOUT_SECONDS = 1;
    const sessionId = await createSession(server);
    const gate = Promise.withResolvers<undefined>();
    admissionGate = gate.promise;
    const pending = server.request(
      `/api/v1/sessions/${sessionId}/turns`,
      jsonInit({ input: message('Hello there.'), stream: false }),
    );
    // Setup outlasts the whole deadline before the turn exists.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    gate.resolve(undefined);

    const response = await pending;
    expect(response.status).toBe(409);
    expect(ErrorMessageSchema.parse(await response.json()).error).toMatchObject({
      message: TURN_COULD_NOT_START_MESSAGE,
      code: 'turn_could_not_start',
    });
    expect(await reloadTurns(server, sessionId)).toEqual([]);
    expect(server.model.requests()).toHaveLength(0);

    configuration.SERVER_EXECUTION_TIMEOUT_SECONDS = original.executionTimeoutSeconds;
    await expectNextMessageAnswered(server, sessionId);
  }, 60_000);
});
