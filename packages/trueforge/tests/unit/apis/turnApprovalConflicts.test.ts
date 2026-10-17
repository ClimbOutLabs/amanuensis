import { OpenAPIHono } from '@hono/zod-openapi';
import type { CreateTurnInput, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import {
  AgentSpecSchema,
  EventType,
  MAIN_THREAD_ID,
  PreviousTurnRunningError,
  SessionHandle,
  Sessions,
  StaleApprovalContinuationError,
  TurnAlreadyExistsError,
} from '@truefoundry/trueforge-core/agent-session';
import { AgentHarnessError, HeldActionRefusedError } from '@truefoundry/trueforge-core/core';
import { createHash } from 'node:crypto';
import { createLogger } from 'winston';
import { TENANT_ID } from '../../../src/apis/sessions';
import { createTurnsRouter } from '../../../src/apis/turns';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT, type RequestContext } from '../../../src/auth/identity';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqlitePersonaStore } from '../../../src/db/sqlite/persona-store/SqlitePersonaStore';
import { SqlitePersonalizationStore } from '../../../src/db/sqlite/personalization-store/SqlitePersonalizationStore';
import { SqliteRepositoryStore } from '../../../src/db/sqlite/repository-store/SqliteRepositoryStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteSpaceStore } from '../../../src/db/sqlite/space-store/SqliteSpaceStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import { SqliteTurnArtifactStore } from '../../../src/db/sqlite/turn-artifact-store/SqliteTurnArtifactStore';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';
import { TurnDrainRegistry } from '../../../src/runtime/turnDrains';
import { uncappedTokenFactoryBudget } from '../../fixtures/uncappedTokenFactoryBudget';

const SESSION_ID = 's1';
const TIP_TURN_ID = 'turn-tip';
const TOOL_CALL_ID = 'tc-1';

type RecordedApproval = { status: 'allow' } | { status: 'deny'; reason: string };

const FIRST_TURN_ID = 'turn-first';

const TOOL_CALL_MESSAGE = {
  role: 'assistant' as const,
  content: '',
  tool_calls: [
    {
      id: TOOL_CALL_ID,
      type: 'function' as const,
      function: { name: 'write_file', arguments: '{}' },
      tool_info: {
        type: 'mcp' as const,
        mcp_server_id: 'files',
        mcp_server_name: 'files',
        original_tool_name: 'write_file',
        is_approval_required: true,
      },
    },
  ],
};

/** A call a scheduled run held for the owner: closed with a "held" result, never dispatched. */
const HELD_CALL_MESSAGE = {
  ...TOOL_CALL_MESSAGE,
  tool_calls: TOOL_CALL_MESSAGE.tool_calls.map(call => ({
    ...call,
    tool_info: {
      ...call.tool_info,
      is_approval_required: false,
      tier: 3 as const,
      held_for_owner: { expires_at: new Date(Date.now() + 60_000).toISOString() },
    },
  })),
};
const HELD_RESULT_MESSAGE = {
  role: 'tool' as const,
  tool_call_id: TOOL_CALL_ID,
  content: JSON.stringify({ held: 'waiting for the owner' }),
};

type ContextAppend = CreateTurnInput['new_context_appends'][number];

function contextAppend(context: ContextAppend['context']): ContextAppend {
  return {
    thread_id: MAIN_THREAD_ID,
    current_context_usage: { prompt_tokens: 0, completion_tokens: 0 },
    context,
  };
}

/** A decision as the host records it: bound to the call's approval token (none here) and arguments. */
function decisionMessage(approval: RecordedApproval) {
  return {
    type: EventType.USER_TOOL_APPROVAL,
    tool_call_id: TOOL_CALL_ID,
    approval,
    approval_token_id: null,
    arguments_hash: createHash('sha256').update('{}').digest('hex'),
  };
}

/** The decided tool call the tip turn already recorded, in the shape the store persists. */
function decidedApprovalAppend(approval: RecordedApproval) {
  return contextAppend([TOOL_CALL_MESSAGE, decisionMessage(approval)]);
}

function turnInput({
  turnId,
  previousTurnId,
  appends,
}: {
  turnId: string;
  previousTurnId: string | null;
  appends: ContextAppend[];
}): CreateTurnInput {
  const now = new Date();
  return {
    turn: {
      turn_id: turnId,
      session_id: SESSION_ID,
      first_turn_id: previousTurnId === null ? turnId : FIRST_TURN_ID,
      ancestor_ids: previousTurnId === null ? [] : [previousTurnId],
      previous_turn_id: previousTurnId,
      state: { status: 'done', output: null, required_actions: [], completed_at: now.toISOString() },
      input: [],
      created_at: now,
      updated_at: now,
      custom: null,
    },
    approval_grants: [],
    require_previous_turn_is_tip: false,
    retained_previous_thread_ids: previousTurnId === null ? [] : [MAIN_THREAD_ID],
    new_threads:
      previousTurnId === null
        ? [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ]
        : [],
    new_context_appends: appends,
    capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
    tool_call_memos: [],
    task_states: [],
    sandbox_info: null,
    update_session_title_if_not_exist: null,
  };
}

/**
 * `pausedFirstTurn` seeds the real sequence: turn one asks for the approval, and turn two, created by
 * the user's answer, records the decision. Otherwise the single tip turn carries both.
 */
async function buildApp(
  recordedApproval: RecordedApproval | undefined,
  options: { pausedFirstTurn?: boolean; heldAction?: boolean; requester?: RequestContext } = {},
) {
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const sessionStore = new SqliteSessionStore(db);
  const sessions = new Sessions({ sessionStore });
  await sessions.create({
    tenant_id: TENANT_ID,
    session_id: SESSION_ID,
    created_by_subject: {
      subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
      subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
      subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
    },
    external_id: null,
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({
        model: { name: 'test-provider/test-model' },
        instructions: 'You are a test agent.',
      }),
    },
  });
  if (options.heldAction === true) {
    // The scheduled run ended with the call held; the answer, if any, was recorded on the tip.
    await sessionStore.createTurn(
      turnInput({
        turnId: TIP_TURN_ID,
        previousTurnId: null,
        appends: [
          contextAppend([
            HELD_CALL_MESSAGE,
            HELD_RESULT_MESSAGE,
            ...(recordedApproval === undefined ? [] : [decisionMessage(recordedApproval)]),
          ]),
        ],
      }),
    );
  } else if (recordedApproval === undefined) {
    throw new Error('a recorded approval is required unless the call is held');
  } else if (options.pausedFirstTurn === true) {
    await sessionStore.createTurn(
      turnInput({ turnId: FIRST_TURN_ID, previousTurnId: null, appends: [contextAppend([TOOL_CALL_MESSAGE])] }),
    );
    await sessionStore.createTurn(
      turnInput({
        turnId: TIP_TURN_ID,
        previousTurnId: FIRST_TURN_ID,
        appends: [contextAppend([decisionMessage(recordedApproval)])],
      }),
    );
  } else {
    await sessionStore.createTurn(
      turnInput({ turnId: TIP_TURN_ID, previousTurnId: null, appends: [decidedApprovalAppend(recordedApproval)] }),
    );
  }

  const tokenStore = new SqliteOAuthTokenStore(db);
  const app = new OpenAPIHono();
  app.onError((_error, c) => c.json({ error: { message: 'Internal server error' } }, 500));
  app.route(
    '/',
    createTurnsRouter({
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      tokenFactoryBudget: uncappedTokenFactoryBudget,
      sessions,
      sessionStore,
      activeTurns: new ActiveTurnRegistry(),
      turnDrains: new TurnDrainRegistry(),
      tokenStore,
      resolveModelProviderStore: () => new SqliteModelProviderStore(db),
      resolveMcpServerStore: () =>
        new McpServerWithAuthStore({ store: new SqliteMcpServerStore(db), tokenStore, clientName: 'test-client' }),
      resolveSkillStore: () => new SqliteSkillStore(db),
      resolveAgentStore: () => new SqliteAgentStore(db),
      personalizationStore: new SqlitePersonalizationStore(db),
      personaStore: new SqlitePersonaStore(db),
      spaceStore: new SqliteSpaceStore(db),
      repositoryStore: new SqliteRepositoryStore(db),
      turnArtifactStore: new SqliteTurnArtifactStore(db),
      eventSubscriptions: new EventSubscriptionRegistry(undefined),
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
      logger: createLogger({ silent: true }),
      resolveRequestContext: () => options.requester ?? STANDALONE_REQUEST_CONTEXT,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  return app;
}

async function postTurn(app: OpenAPIHono, input: TurnInputItem[], previousTurnId?: string): Promise<Response> {
  return app.request(`/${SESSION_ID}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input,
      stream: false,
      ...(previousTurnId === undefined ? {} : { previous_turn_id: previousTurnId }),
    }),
  });
}

function approvalInput(approval: { status: 'allow' } | { status: 'deny'; reason: string }): TurnInputItem[] {
  return [
    {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: MAIN_THREAD_ID,
      tool_call_id: TOOL_CALL_ID,
      approval,
    },
  ];
}

/** Every rejection under test comes from createTurn, so the test drives it directly. */
function rejectCreateTurnWith(error: Error): void {
  jest.spyOn(SessionHandle.prototype, 'createTurn').mockRejectedValue(error);
}

describe('POST /{session_id}/turns approval conflicts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [new PreviousTurnRunningError(TIP_TURN_ID), 'previous_turn_running'],
    [new TurnAlreadyExistsError(TIP_TURN_ID), 'turn_already_exists'],
  ])('maps a store conflict to 409 with code %#', async (error, code) => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(error);

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: error.message, type: 'conflict', code },
    });
  });

  describe('when the session tip moved after the request read it', () => {
    const stale = () => new StaleApprovalContinuationError('turn-old', TIP_TURN_ID);

    it('replays a decision the tip already recorded, as a double submit would send it', async () => {
      const app = await buildApp({ status: 'allow' });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'allow' }));

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ data: { id: TIP_TURN_ID, session_id: SESSION_ID } });
    });

    it('replays the answer for a resend anchored on the turn that asked, after the answer created the next turn', async () => {
      const app = await buildApp({ status: 'allow' }, { pausedFirstTurn: true });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'allow' }), FIRST_TURN_ID);

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ data: { id: TIP_TURN_ID, session_id: SESSION_ID } });
    });

    it('refuses a different answer anchored on the turn that asked once the first answer is recorded', async () => {
      const app = await buildApp({ status: 'allow' }, { pausedFirstTurn: true });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'too late' }), FIRST_TURN_ID);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'approval_conflict' } });
    });

    it('refuses a decision that contradicts the recorded one instead of replaying it', async () => {
      const app = await buildApp({ status: 'allow' });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'approval_conflict' } });
    });

    it('keeps the stale 409 for a decision the session never recorded', async () => {
      const app = await buildApp({ status: 'allow' });
      const error = stale();
      rejectCreateTurnWith(error);

      const response = await postTurn(app, [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'tc-from-an-older-turn',
          approval: { status: 'allow' },
        },
      ]);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { message: error.message, type: 'conflict', code: 'stale_approval_continuation' },
      });
    });
  });

  it('replays the tip turn for a decision it already recorded', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(
      new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
    );

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ data: { id: TIP_TURN_ID, session_id: SESSION_ID } });
  });

  it('rejects a resubmission that contradicts the recorded decision', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(
      new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
    );

    const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        message: `Tool call ${TOOL_CALL_ID} already has a different decision on record`,
        type: 'conflict',
        code: 'approval_conflict',
      },
    });
  });

  it('replays a recorded denial regardless of the reason text resent with it', async () => {
    const app = await buildApp({ status: 'deny', reason: 'not this repo' });
    rejectCreateTurnWith(
      new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
    );

    const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'still no' }));

    expect(response.status).toBe(200);
  });

  it('keeps 422 for a decision the session never recorded', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(new AgentHarnessError('invalid_send_input', 'thread main: no pending approval'));

    const response = await postTurn(app, [
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'tc-never-seen',
        approval: { status: 'allow' },
      },
    ]);

    expect(response.status).toBe(422);
  });

  it('keeps 422 for a rejected user message, which is no resubmission', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(
      new AgentHarnessError(
        'invalid_send_input',
        'user message cannot be sent while approvals or questions are pending',
      ),
    );

    const response = await postTurn(app, [{ type: EventType.USER_MESSAGE, content: 'hello' }]);

    expect(response.status).toBe(422);
  });
});

describe('POST /{session_id}/turns answering an action a scheduled run held', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** createTurn is stubbed to stop the request after it was handed its options. */
  function captureCreateTurnOptions() {
    return jest
      .spyOn(SessionHandle.prototype, 'createTurn')
      .mockRejectedValue(new PreviousTurnRunningError(TIP_TURN_ID));
  }

  it('ends the turn after the tool step, so approving runs just that call and asks the model nothing', async () => {
    const app = await buildApp(undefined, { heldAction: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'allow' }));

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: true }));
  });

  it('does not end the turn early for an approval that is not about a held action', async () => {
    const app = await buildApp({ status: 'allow' }, { pausedFirstTurn: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'allow' }), FIRST_TURN_ID);

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: false }));
  });

  it('does not end the turn early once the held action was answered, so a repeat is only replayed', async () => {
    const app = await buildApp({ status: 'allow' }, { heldAction: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'allow' }));

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: false }));
  });

  it('replays the recorded turn for a second approval instead of running the call again', async () => {
    const app = await buildApp({ status: 'allow' }, { heldAction: true });
    jest
      .spyOn(SessionHandle.prototype, 'createTurn')
      .mockRejectedValue(
        new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
      );

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: TIP_TURN_ID } });
  });

  it('refuses a deny that contradicts an approval already recorded', async () => {
    const app = await buildApp({ status: 'allow' }, { heldAction: true });
    jest
      .spyOn(SessionHandle.prototype, 'createTurn')
      .mockRejectedValue(
        new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
      );

    const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'approval_conflict' } });
  });

  it('refuses anyone but the chat owner, before reading the held call', async () => {
    const someoneElse: RequestContext = {
      ...STANDALONE_REQUEST_CONTEXT,
      subject: { id: 'someone-else', type: 'user', display_name: 'someone-else' },
    };
    const app = await buildApp(undefined, { heldAction: true, requester: someoneElse });
    const createTurn = captureCreateTurnOptions();

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(403);
    expect(createTurn).not.toHaveBeenCalled();
  });

  it('answers an action that cannot run now with a conflict whose code says why', async () => {
    const app = await buildApp(undefined, { heldAction: true });
    jest.spyOn(SessionHandle.prototype, 'createTurn').mockRejectedValue(new HeldActionRefusedError('expired'));

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        message: 'Expired, nothing was done. Ask again in chat.',
        type: 'conflict',
        code: 'held_action_expired',
      },
    });
  });
});
