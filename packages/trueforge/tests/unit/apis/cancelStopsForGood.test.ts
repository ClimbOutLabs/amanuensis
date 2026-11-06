/**
 * Cancel right after a denied approval, over the routes the chat uses: the owner denies a held call
 * and presses Cancel while the server is still setting up the turn that carries the denial. That turn
 * must end as cancelled, never reach the model, and nothing may start it again.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import type * as internalSources from '../../../src/runtime/turnInternalSources';
import { GetTurnResponseSchema, ListTurnsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { INERT_SERVER_NAME } from '../../fixtures/inertMcpServer';
import { RUN_DIRECTIVE_PREFIX, THINK_AFTER_WRITE_DIRECTIVE } from '../../fixtures/scriptedModelServer';

/**
 * Before a turn exists the server checks the persona's library, which can ask the chat's own model to
 * judge what it found. On a model that thinks for minutes this holds the next turn back for minutes.
 */
let admissionHold: Promise<unknown> | undefined;
let markAdmissionHeld: (() => void) | undefined;
jest.mock('../../../src/runtime/turnInternalSources', () => {
  const actual = jest.requireActual<typeof internalSources>('../../../src/runtime/turnInternalSources');
  return {
    ...actual,
    resolveTurnInternalSources: async (input: Parameters<typeof actual.resolveTurnInternalSources>[0]) => {
      const hold = admissionHold;
      admissionHold = undefined;
      if (hold !== undefined) {
        markAdmissionHeld?.();
        await hold;
      }
      return actual.resolveTurnInternalSources(input);
    },
  };
});

const CANCEL_BUDGET_MS = 5_000;
/** Longer than any timer a cancelled turn could still have pending in this fixture. */
const QUIET_PERIOD_MS = 1_500;

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

function jsonInit(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
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

/** The chat's turns as the page loads them when the owner comes back: the list, then each turn. */
async function reloadTurns(server: ApprovalTestServer, sessionId: string): Promise<Turn[]> {
  const listed: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns`)).json();
  const turns: Turn[] = [];
  for (const { id } of ListTurnsResponseSchema.parse(listed).data) {
    const body: unknown = await (await server.request(`/api/v1/sessions/${sessionId}/turns/${id}`)).json();
    turns.push(GetTurnResponseSchema.parse(body).data);
  }
  return turns;
}

function pendingApproval(turns: Turn[]): { thread_id: string; tool_call_id: string } {
  for (const turn of turns) {
    if (turn.state.status !== 'done') {
      continue;
    }
    for (const action of turn.state.required_actions) {
      if (action.type !== 'tool.approval_required') {
        continue;
      }
      const first = action.tool_calls[0];
      if (first !== undefined) {
        return { thread_id: action.thread_id, tool_call_id: first.id };
      }
    }
  }
  throw new Error(`no approval is waiting: ${JSON.stringify(turns.map(turn => turn.state))}`);
}

/**
 * Asks for the held write and answers its card with a denial, without waiting for the reply. The
 * turn that carries the denial is held in setup until `release` resolves.
 */
async function denyHeldWrite(
  server: ApprovalTestServer,
  release: Promise<unknown>,
): Promise<{ sessionId: string; held: Promise<void>; resumedStream: Promise<string> }> {
  const sessionId = await createSession(server);
  const ask: TurnInputItem[] = [
    { type: 'user.message', content: `${RUN_DIRECTIVE_PREFIX}${THINK_AFTER_WRITE_DIRECTIVE}` },
  ];
  const asked = await server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input: ask, stream: true }));
  expect(asked.status).toBe(200);
  await asked.text();
  const denial: TurnInputItem[] = [
    {
      type: 'user.tool_approval',
      ...pendingApproval(await reloadTurns(server, sessionId)),
      approval: { status: 'deny', reason: 'not now' },
    },
  ];
  const held = Promise.withResolvers<undefined>();
  admissionHold = release;
  markAdmissionHeld = () => {
    held.resolve(undefined);
  };
  const resumed = server.request(`/api/v1/sessions/${sessionId}/turns`, jsonInit({ input: denial, stream: true }));
  return { sessionId, held: held.promise, resumedStream: resumed.then(response => response.text()) };
}

async function pressCancel(server: ApprovalTestServer, sessionId: string): Promise<void> {
  const cancel = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({}));
  expect(cancel.status).toBe(200);
}

/** Comes back to the chat after every timer has had its chance: the turn stays stopped and nothing else runs. */
async function expectStoppedForGood(server: ApprovalTestServer, sessionId: string): Promise<void> {
  await waitFor({
    read: () => reloadTurns(server, sessionId),
    ready: turns => turns.length === 2 && turns.every(turn => turn.state.status !== 'running'),
    budgetMs: CANCEL_BUDGET_MS,
  });
  const requestsAtStop = server.model.requests().length;

  await new Promise(resolve => setTimeout(resolve, QUIET_PERIOD_MS));

  const turns = await reloadTurns(server, sessionId);
  expect(turns.map(turn => turn.state.status).sort()).toEqual(['cancelled', 'done']);
  expect(server.model.openThinkingStreams()).toBe(0);
  expect(server.model.requests()).toHaveLength(requestsAtStop);
}

describe('Cancel after a denied approval', () => {
  let server: ApprovalTestServer;

  beforeEach(async () => {
    server = await startApprovalTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('stops the turn for good when Cancel comes while the server is still setting it up', async () => {
    const released = Promise.withResolvers<undefined>();
    const { sessionId, held, resumedStream } = await denyHeldWrite(server, released.promise);
    await held;

    await pressCancel(server, sessionId);
    released.resolve(undefined);

    await expectStoppedForGood(server, sessionId);
    await resumedStream;
    // The model was never asked to think again: the turn ended before it reached the model.
    expect(server.model.requests().some(request => request.messages.some(message => message.role === 'tool'))).toBe(
      false,
    );
  }, 60_000);
});

describe('Cancel of one named turn', () => {
  let server: ApprovalTestServer;

  beforeEach(async () => {
    server = await startApprovalTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('stops only the turn it names, and leaves a turn it does not name running', async () => {
    const released = Promise.withResolvers<undefined>();
    const { sessionId, resumedStream } = await denyHeldWrite(server, released.promise);
    released.resolve(undefined);
    const running = await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: turns => turns.some(turn => turn.state.status === 'running'),
      budgetMs: CANCEL_BUDGET_MS,
    });
    const turnId = running.find(turn => turn.state.status === 'running')?.id;
    expect(turnId).toBeDefined();

    // A turn of another chat that is still running: naming it here must stop nothing, in this chat or its own.
    const foreignRelease = Promise.withResolvers<undefined>();
    const foreignRun = await denyHeldWrite(server, foreignRelease.promise);
    foreignRelease.resolve(undefined);
    const foreignRunning = await waitFor({
      read: () => reloadTurns(server, foreignRun.sessionId),
      ready: turns => turns.some(turn => turn.state.status === 'running'),
      budgetMs: CANCEL_BUDGET_MS,
    });
    const foreignTurnId = foreignRunning.find(turn => turn.state.status === 'running')?.id;
    expect(foreignTurnId).toBeDefined();

    const other = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({ turn_id: 'turn_other' }));
    expect(other.status).toBe(200);
    const foreign = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({ turn_id: foreignTurnId }));
    expect(foreign.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await reloadTurns(server, sessionId)).some(turn => turn.state.status === 'running')).toBe(true);
    expect((await reloadTurns(server, foreignRun.sessionId)).some(turn => turn.state.status === 'running')).toBe(true);
    // No body at all still means "cancel the last turn".
    const bare = await server.request(`/api/v1/sessions/${foreignRun.sessionId}/cancel`, { method: 'POST' });
    expect(bare.status).toBe(200);
    await foreignRun.resumedStream;
    // A body that is there but not valid is refused, never read as "cancel the last turn".
    const invalid = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({ turn_id: 5 }));
    expect(invalid.status).toBe(400);
    expect((await reloadTurns(server, sessionId)).some(turn => turn.state.status === 'running')).toBe(true);

    const named = await server.request(`/api/v1/sessions/${sessionId}/cancel`, jsonInit({ turn_id: turnId }));
    expect(named.status).toBe(200);
    await waitFor({
      read: () => reloadTurns(server, sessionId),
      ready: turns => turns.every(turn => turn.state.status !== 'running'),
      budgetMs: CANCEL_BUDGET_MS,
    });
    await resumedStream;
  }, 60_000);
});
