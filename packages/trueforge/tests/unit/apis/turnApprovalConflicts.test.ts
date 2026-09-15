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
import { AgentHarnessError } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';
import { TENANT_ID } from '../../../src/apis/sessions';
import { createTurnsRouter } from '../../../src/apis/turns';
import { TrueForgeAuthorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT } from '../../../src/auth/identity';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
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

const SESSION_ID = 's1';
const TIP_TURN_ID = 'turn-tip';
const TOOL_CALL_ID = 'tc-1';

/** The decided tool call the tip turn already recorded, in the shape the store persists. */
function decidedApprovalAppend(approval: { status: 'allow' } | { status: 'deny'; reason: string }) {
  return {
    thread_id: MAIN_THREAD_ID,
    current_context_usage: { prompt_tokens: 0, completion_tokens: 0 },
    context: [
      {
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
      },
      { type: EventType.USER_TOOL_APPROVAL, tool_call_id: TOOL_CALL_ID, approval },
    ],
  };
}

function tipTurnInput(approval: { status: 'allow' } | { status: 'deny'; reason: string }): CreateTurnInput {
  const now = new Date();
  return {
    turn: {
      turn_id: TIP_TURN_ID,
      session_id: SESSION_ID,
      first_turn_id: TIP_TURN_ID,
      ancestor_ids: [],
      previous_turn_id: null,
      state: { status: 'done', output: null, required_actions: [], completed_at: now.toISOString() },
      input: [],
      created_at: now,
      updated_at: now,
      custom: null,
    },
    approval_grants: [],
    require_previous_turn_is_tip: false,
    retained_previous_thread_ids: [],
    new_threads: [{ thread_id: MAIN_THREAD_ID, parent: null, agent_info: null, tool_call_memo: undefined }],
    new_context_appends: [decidedApprovalAppend(approval)],
    capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
    tool_call_memos: [],
    sandbox_info: null,
    update_session_title_if_not_exist: null,
  };
}

async function buildApp(recordedApproval: { status: 'allow' } | { status: 'deny'; reason: string }) {
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
  await sessionStore.createTurn(tipTurnInput(recordedApproval));

  const tokenStore = new SqliteOAuthTokenStore(db);
  const app = new OpenAPIHono();
  app.onError((_error, c) => c.json({ error: { message: 'Internal server error' } }, 500));
  app.route(
    '/',
    createTurnsRouter({
      sessions,
      sessionStore,
      activeTurns: new ActiveTurnRegistry(),
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
      resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
      authorizer: new TrueForgeAuthorizer(),
    }),
  );
  return app;
}

async function postTurn(app: OpenAPIHono, input: TurnInputItem[]): Promise<Response> {
  return app.request(`/${SESSION_ID}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, stream: false }),
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
    [new StaleApprovalContinuationError('turn-old', TIP_TURN_ID), 'stale_approval_continuation'],
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
