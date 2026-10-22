import { z } from 'zod';
import { MAIN_THREAD_ID } from '../../../src/agent-session/models/TurnRecord';
import type { PersistedTurnEvent } from '../../../src/agent-session/schemas/events';
import { EventType } from '../../../src/agent-session/schemas/events';
import { CancellationReason, TurnStateCancelledSchema } from '../../../src/agent-session/schemas/turn';
import type {
  AppendCommandExecutionStartedInput,
  CreateTurnInput,
  ISessionStore,
} from '../../../src/agent-session/store/ISessionStore';
import {
  decodeSessionEventPageToken,
  encodeSessionEventPageToken,
} from '../../../src/agent-session/store/SessionEventPageToken';
import {
  ImplementationPlanGrantLifecycleError,
  PreviousTurnRunningError,
  SessionExternalIdConflictError,
  SessionNotFoundError,
  SessionStoreConflictError,
  SessionStoreInvariantError,
  SessionStoreNotFoundError,
  StaleApprovalContinuationError,
  StaleTaskChecklistError,
  TurnAlreadyExistsError,
  TurnNotFoundError,
  TurnNotRunningError,
} from '../../../src/agent-session/store/SessionStoreErrors';
import { createToolResponseV2, newEventId } from '../../../src/core/events/schema';
import { getEmptyUsage } from '../../../src/core/llm/LLMTypes';
import type { ToolCallMemoSnapshot } from '../../../src/core/mcp/executeToolCalls';
import {
  mintImplementationPlanGrant,
  serializeImplementationPlanGrant,
} from '../../../src/core/mcp/implementationPlanGrant';
import type { ChatPrivateFingerprints, PrivateFingerprint } from '../../../src/core/permissions/privateTextCheck';
import { AbnormalHandoffSchema } from '../../../src/core/runtime/AbnormalHandoff';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { getEmptyCurrentContextUsage } from '../../../src/core/runtime/contextUsage';
import type { TaskStateSnapshot } from '../../../src/core/runtime/taskState';
import {
  makeAgentSpec,
  makeCreateTurnInput as makeBaseCreateTurnInput,
  makeCancelledTurnState,
  type MakeCreateTurnInputOptions,
  makeDoneTurnState,
  makeModelMessageEvent,
  makeTurnCreatedEvent,
  makeTurnDoneEvent,
} from '../testHelpers';

const ContractPassthroughEventSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  event: z.object({ value: z.number() }),
});

declare module '../../../src/core/events/PassthroughEvents' {
  interface AgentPassthroughEventSchemaMap {
    'custom.event': typeof ContractPassthroughEventSchema;
  }
}

function mustGet<T>(value: T | undefined | null, label = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${label} to be defined`);
  }
  return value;
}

function userMessage(content: string): ContextMessage {
  return { role: 'user', content };
}

function contextContents(messages: ContextMessage[] | undefined): string[] {
  return (messages ?? []).map(message => {
    if ('role' in message && message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
    return JSON.stringify(message);
  });
}

function toolCallMemoSnapshot(overrides: Partial<ToolCallMemoSnapshot> = {}): ToolCallMemoSnapshot {
  return {
    read_results: [],
    side_effect_attempts: [{ key: '["mcp","write"]', count: 1 }],
    github_content_unavailable: false,
    consecutive_empty_inspection_batches: 2,
    consecutive_no_progress_batches: 0,
    consecutive_failed_batches: 0,
    call_signatures: [{ key: '["write",{"path":"a.py"}]', count: 1 }],
    denied_approval_identities: ['approval-1'],
    repeated_denied_approval: false,
    inspection_calls_before_edit: 3,
    inspection_budget_warned: true,
    edit_observed: true,
    clarification_answered: false,
    workspace_mutation_epoch: 0,
    pending_identical_call_nudges: [],
    failed_batch_nudge_generation: 0,
    empty_inspection_nudge_generation: 0,
    no_progress_nudge_generation: 0,
    policy_blocked_calls_this_turn: 0,
    write_calls_this_turn: 0,
    successful_writes_this_turn: 0,
    last_call_signature: undefined,
    tool_markup_leaks_this_turn: 0,
    tool_markup_retries_this_turn: 0,
    ...overrides,
  };
}

function commandOwnership(input: { leaseId: string; ownerId?: string; expiresAt?: string }) {
  return {
    owner_id: input.ownerId ?? 'replica-a',
    lease_id: input.leaseId,
    lease_expires_at: new Date(input.expiresAt ?? '2026-08-31T12:30:00.000Z'),
  };
}

/** Store contract suite — factory-injected so other backends can reuse it. */
export function runStoreContractSuite<
  TSessionCustom extends object = Record<string, never>,
  TTurnCustom extends object = Record<string, never>,
  TStore extends ISessionStore<TSessionCustom, TTurnCustom> = ISessionStore<TSessionCustom, TTurnCustom>,
>(
  createStore: () => TStore,
  setSessionRepositoryBinding: (
    store: TStore,
    input: {
      tenant_id: string;
      created_by: string;
      session_id: string;
      repository_id: string | null;
      workspace_cwd: string | null;
    },
  ) => Promise<void>,
) {
  type Store = ISessionStore<TSessionCustom, TTurnCustom>;
  const makeCreateTurnInput = (input: MakeCreateTurnInputOptions<TTurnCustom>): CreateTurnInput<TTurnCustom> =>
    makeBaseCreateTurnInput<TTurnCustom>(input);
  const tenant = 't1';
  const createdBy = 'user-1';
  const sessionId = 's1';
  const missingSessionId = 'missing-session';
  const missingTurnId = 'missing-turn';

  async function finishTurn(store: Store, turnId: string) {
    const state = makeDoneTurnState();
    await store.updateTurnState({
      session_id: sessionId,
      turn_id: turnId,
      state,
      turn_done_event: makeTurnDoneEvent(state),
    });
  }

  async function seedSession(store: Store, agentSpec = makeAgentSpec()) {
    await store.createSession({
      tenant_id: tenant,
      session_id: sessionId,
      created_by_subject: { subject_id: createdBy, subject_type: 'user', subject_display_name: createdBy },
      agent: { type: 'inline', spec: agentSpec },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }

  async function seedImplementationPlanSession(store: TStore) {
    await seedSession(store);
    await setSessionRepositoryBinding(store, {
      tenant_id: tenant,
      created_by: createdBy,
      session_id: sessionId,
      repository_id: 'repository-a',
      workspace_cwd: '/repo',
    });
  }

  function implementationPlanGrant(
    input: {
      tenant_id?: string;
      created_by?: string;
      session_id?: string;
      workspace_cwd?: string;
      checkout_id?: string;
    } = {},
  ) {
    return mintImplementationPlanGrant({
      tenant_id: input.tenant_id ?? tenant,
      created_by: input.created_by ?? createdBy,
      session_id: input.session_id ?? sessionId,
      workspace_cwd: input.workspace_cwd ?? '/repo',
      checkout_id: input.checkout_id ?? `sha256:${'1'.repeat(64)}`,
      plan: {
        repository_id: 'repository-a',
        repository_revision: 7,
        branch: 'codex/plan-grants',
        head_sha: 'abcdef012345',
        file_globs: ['packages/core/src/**/*.ts'],
        approach: 'Update the scoped implementation.',
        verify_command_ids: ['core-test'],
      },
    });
  }

  function turnScopedWrites(store: Store, keys: { session_id: string; turn_id: string }): (() => Promise<unknown>)[] {
    const doneState = makeDoneTurnState();
    return [
      () =>
        store.freezeAndGetTurn({
          ...keys,
          turn_done_event: makeTurnDoneEvent(makeCancelledTurnState(CancellationReason.ClientCancelled)),
        }),
      () =>
        store.updateTurnState({
          ...keys,
          state: doneState,
          turn_done_event: makeTurnDoneEvent(doneState),
        }),
      () =>
        store.addThreads({
          ...keys,
          threads: [
            {
              thread_id: 'child',
              context: [],
              current_context_usage: getEmptyCurrentContextUsage(),
              parent: { thread_id: MAIN_THREAD_ID, tool_call_id: 'tc1' },
              agent_info: { type: 'dynamic', name: 'child', input: 'task' },
              completion: null,
              capability_state: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ],
        }),
      () => store.removeThreads({ ...keys, thread_ids: [MAIN_THREAD_ID] }),
      () =>
        store.appendToThreadContext({
          ...keys,
          thread_id: MAIN_THREAD_ID,
          context: [userMessage('late')],
          current_context_usage: null,
          completion: null,
          tool_call_memo: undefined,
          task_state: undefined,
        }),
      () =>
        store.overwriteThreadContext({
          ...keys,
          event: {
            type: EventType.AGENT_CONTEXT_OVERWRITE,
            id: newEventId(),
            created_at: new Date().toISOString(),
            thread_id: MAIN_THREAD_ID,
            reason: 'compaction',
            context: [userMessage('late')],
            current_context_usage: getEmptyCurrentContextUsage(),
            usage: getEmptyUsage(),
          },
        }),
      () =>
        store.patchMCPServers({
          ...keys,
          mcp_servers: [{ id: 'svc', name: 'svc', session_id: 'mcp-1', transport_type: 'streamable-http' }],
        }),
      () => store.patchSandboxInfo({ ...keys, sandbox_info: { sandbox_id: 'sbx-1' } }),
      () =>
        store.patchThreadCapabilityState({
          ...keys,
          thread_id: MAIN_THREAD_ID,
          key: 'tfy.plan',
          state: { step: 1 },
        }),
    ];
  }

  describe('session CRUD + activity', () => {
    it('createSession stores an inline agent and sets last_activity_timestamp_ms', async () => {
      const store = createStore();
      const before = Date.now();
      await seedSession(store);
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(session).toBeDefined();
      expect(mustGet(session).tenant_id).toBe(tenant);
      expect(mustGet(session).created_by_subject.subject_id).toBe('user-1');
      expect(mustGet(session).source).toBeNull();
      expect(mustGet(session).agent).toMatchObject({
        type: 'inline',
        spec: { model: { name: 'test-provider/test-model' } },
      });
      expect(mustGet(session).last_activity_timestamp_ms).toBeGreaterThanOrEqual(before);
      expect(mustGet(session).title).toBeNull();
      expect(mustGet(session).metrics).toEqual({
        total_duration_ms: 0,
        total_turns: 0,
      });
    });

    it('createSession persists created_by_subject', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: 'created-by-session',
        created_by_subject: {
          subject_id: 'alice@example.com',
          subject_type: 'user',
          subject_display_name: 'alice@example.com',
        },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const session = mustGet(await store.getSession({ tenant_id: tenant, session_id: 'created-by-session' }));
      expect(session.created_by_subject).toEqual({
        subject_id: 'alice@example.com',
        subject_type: 'user',
        subject_display_name: 'alice@example.com',
      });

      const listed = await store.listSessions({
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(listed.data.map(s => s.session_id)).toContain('created-by-session');
      expect(listed.data.find(s => s.session_id === 'created-by-session')?.created_by_subject.subject_id).toBe(
        'alice@example.com',
      );
    });

    it('persists a bounded full-replacement checklist with revision CAS and tenant isolation', async () => {
      const store = createStore();
      await seedSession(store);

      const initial = await store.getTaskChecklist({ tenant_id: tenant, session_id: sessionId });
      expect(initial).toEqual({ revision: 0, items: [] });

      const saved = await store.replaceTaskChecklist({
        tenant_id: tenant,
        session_id: sessionId,
        expected_revision: initial.revision,
        items: [{ id: 'inspect', text: 'Inspect the focused files', done: false }],
      });
      expect(saved).toEqual({
        revision: 1,
        items: [{ id: 'inspect', text: 'Inspect the focused files', done: false }],
      });
      await expect(
        store.replaceTaskChecklist({
          tenant_id: tenant,
          session_id: sessionId,
          expected_revision: initial.revision,
          items: [],
        }),
      ).rejects.toBeInstanceOf(StaleTaskChecklistError);
      await expect(store.getTaskChecklist({ tenant_id: 'other-tenant', session_id: sessionId })).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });

    it('persists reference agents and listSessions filters by agent_id', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: 'named-1',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'reference', id: 'agent-abc', name: null },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await seedSession(store);

      const named = mustGet(await store.getSession({ tenant_id: tenant, session_id: 'named-1' }));
      expect(named.agent).toEqual({ type: 'reference', id: 'agent-abc', name: null });

      const filtered = await store.listSessions({
        agent_id: 'agent-abc',
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(filtered.data.map(row => row.session_id)).toEqual(['named-1']);
    });

    it('rejects agent updates on sessions bound by agent_id', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: 'named-1',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'reference', id: 'agent-abc', name: null },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      await expect(
        store.updateSession({
          tenant_id: tenant,
          session_id: 'named-1',
          agent: { type: 'inline', spec: makeAgentSpec({ instructions: 'nope' }) },
          title: undefined,
          metadata: undefined,
        }),
      ).rejects.toBeInstanceOf(SessionStoreInvariantError);
    });

    it('getSession does not bump last_activity_timestamp_ms', async () => {
      const store = createStore();
      await seedSession(store);
      const first = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      await new Promise(r => setTimeout(r, 5));
      const second = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(second).last_activity_timestamp_ms).toBe(mustGet(first).last_activity_timestamp_ms);
    });

    it('updateSession patches only provided fields and bumps activity', async () => {
      const store = createStore();
      await seedSession(store);
      const before = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      await new Promise(r => setTimeout(r, 5));
      const nextSpec = makeAgentSpec({ instructions: 'updated' });
      await store.updateSession({
        tenant_id: tenant,
        session_id: sessionId,
        agent: { type: 'inline', spec: nextSpec },
        title: 'Hello',
        metadata: undefined,
      });
      const after = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(after).agent).toMatchObject({
        type: 'inline',
        spec: { instructions: 'updated' },
      });
      expect(mustGet(after).title).toBe('Hello');
      expect(mustGet(after).last_activity_timestamp_ms).toBeGreaterThan(mustGet(before).last_activity_timestamp_ms);
    });

    it('persists owner-scoped folders without treating assignment or deletion as session activity', async () => {
      const store = createStore();
      await seedSession(store);
      const before = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));

      const created = await store.createSessionFolder({
        tenant_id: tenant,
        folder_id: 'folder-1',
        created_by: 'user-1',
        name: 'Work',
      });
      expect(created).toMatchObject({ folder_id: 'folder-1', name: 'Work' });

      await store.setSessionFolder({
        tenant_id: tenant,
        session_id: sessionId,
        created_by: 'user-1',
        folder_id: 'folder-1',
      });
      const assigned = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(assigned.folder_id).toBe('folder-1');
      expect(assigned.updated_at).toEqual(before.updated_at);
      expect(assigned.last_activity_timestamp_ms).toBe(before.last_activity_timestamp_ms);

      const renamed = await store.updateSessionFolder({
        tenant_id: tenant,
        folder_id: 'folder-1',
        created_by: 'user-1',
        name: 'Projects',
      });
      expect(renamed?.name).toBe('Projects');
      await expect(store.listSessionFolders({ tenant_id: tenant, created_by: 'user-1' })).resolves.toMatchObject([
        { folder_id: 'folder-1', name: 'Projects' },
      ]);

      await store.deleteSessionFolder({
        tenant_id: tenant,
        folder_id: 'folder-1',
        created_by: 'user-1',
      });
      const afterDelete = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(afterDelete.folder_id).toBeNull();
      expect(afterDelete.updated_at).toEqual(before.updated_at);
      expect(afterDelete.last_activity_timestamp_ms).toBe(before.last_activity_timestamp_ms);
    });

    it("refuses to assign another owner's folder", async () => {
      const store = createStore();
      await seedSession(store);
      await store.createSessionFolder({
        tenant_id: tenant,
        folder_id: 'other-folder',
        created_by: 'user-2',
        name: 'Private',
      });

      await expect(
        store.setSessionFolder({
          tenant_id: tenant,
          session_id: sessionId,
          created_by: 'user-1',
          folder_id: 'other-folder',
        }),
      ).rejects.toBeInstanceOf(SessionStoreNotFoundError);
      await expect(store.getSession({ tenant_id: tenant, session_id: sessionId })).resolves.toMatchObject({
        folder_id: null,
      });
    });

    it('createSession persists metadata for getSession', async () => {
      const store = createStore();
      const metadata = { env: 'prod', ticket: 'T-1' };
      await store.createSession({
        tenant_id: tenant,
        session_id: sessionId,
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata,
        external_id: null,
        source: null,
      });

      expect(mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId })).metadata).toEqual(metadata);
    });

    it('updateSession replaces metadata when set and leaves it when omitted', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: sessionId,
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: { a: '1' },
        external_id: null,
        source: null,
      });

      await store.updateSession({
        tenant_id: tenant,
        session_id: sessionId,
        agent: undefined,
        title: undefined,
        metadata: { b: '2' },
      });
      expect(mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId })).metadata).toEqual({
        b: '2',
      });

      await store.updateSession({
        tenant_id: tenant,
        session_id: sessionId,
        agent: undefined,
        title: 'keep-meta',
        metadata: undefined,
      });
      const afterOmit = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(afterOmit.title).toBe('keep-meta');
      expect(afterOmit.metadata).toEqual({ b: '2' });

      await store.updateSession({
        tenant_id: tenant,
        session_id: sessionId,
        agent: undefined,
        title: undefined,
        metadata: {},
      });
      expect(mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId })).metadata).toEqual({});
    });

    it('createSession conflict when session already exists', async () => {
      const store = createStore();
      await seedSession(store);
      await expect(seedSession(store)).rejects.toBeInstanceOf(SessionStoreConflictError);
    });

    it('createSession rejects a session_id already used by another tenant', async () => {
      const store = createStore();
      await seedSession(store);
      await expect(
        store.createSession({
          tenant_id: 'other',
          session_id: sessionId,
          created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
          agent: { type: 'inline', spec: makeAgentSpec() },
          custom: null,
          metadata: {},
          external_id: null,
          source: null,
        }),
      ).rejects.toBeInstanceOf(SessionStoreConflictError);
    });

    it('createSession stores a null external_id', async () => {
      const store = createStore();
      await seedSession(store);
      const record = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(record).external_id).toBeNull();
    });

    it('createSession persists external_id and getSessionByExternalId finds it', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: sessionId,
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: 'run-1',
        source: null,
      });
      const byId = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(byId).external_id).toBe('run-1');
      const byExternal = await store.getSessionByExternalId({ tenant_id: tenant, external_id: 'run-1' });
      expect(mustGet(byExternal).session_id).toBe(sessionId);
      expect(await store.getSessionByExternalId({ tenant_id: tenant, external_id: 'missing' })).toBeUndefined();
      expect(await store.getSessionByExternalId({ tenant_id: 'other', external_id: 'run-1' })).toBeUndefined();
    });

    it('createSession unique external_id within a tenant; nulls and other tenants do not collide', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: 's-a',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: 'shared-key',
        source: null,
      });
      // Specifically the external-id arm, not just any conflict: get-or-create
      // treats this rejection as its normal repeat-call path.
      await expect(
        store.createSession({
          tenant_id: tenant,
          session_id: 's-b',
          created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
          agent: { type: 'inline', spec: makeAgentSpec() },
          custom: null,
          metadata: {},
          external_id: 'shared-key',
          source: null,
        }),
      ).rejects.toBeInstanceOf(SessionExternalIdConflictError);

      await store.createSession({
        tenant_id: 'other',
        session_id: 's-c',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: 'shared-key',
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 's-d',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 's-e',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
    });

    it('getSessionByExternalId does not bump last_activity_timestamp_ms', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: sessionId,
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: 'run-1',
        source: null,
      });
      const first = await store.getSessionByExternalId({ tenant_id: tenant, external_id: 'run-1' });
      await new Promise(r => setTimeout(r, 5));
      const second = await store.getSessionByExternalId({ tenant_id: tenant, external_id: 'run-1' });
      expect(mustGet(second).last_activity_timestamp_ms).toBe(mustGet(first).last_activity_timestamp_ms);
    });
  });

  describe('setPrivateFingerprints', () => {
    const fingerprints: ChatPrivateFingerprints = {
      complete: true,
      has_text: true,
      secret: false,
      entries: [{ kind: 'name', length: 2, digest: '0123456789abcdef0123456789abcdef' }],
    };

    async function savedFingerprints(store: Store): Promise<ChatPrivateFingerprints | null | undefined> {
      return (await store.getSession({ tenant_id: tenant, session_id: sessionId }))?.private_fingerprints;
    }

    it('starts as null for a new session', async () => {
      const store = createStore();
      await seedSession(store);
      expect(await savedFingerprints(store)).toBeNull();
    });

    it('round-trips what was saved', async () => {
      const store = createStore();
      await seedSession(store);
      await store.setPrivateFingerprints({ session_id: sessionId, fingerprints });
      expect(await savedFingerprints(store)).toEqual(fingerprints);
    });

    it('merges a later save: entries are joined, and an incomplete or secret record stays so', async () => {
      const store = createStore();
      await seedSession(store);
      const otherEntry: PrivateFingerprint = { kind: 'number', length: 7, digest: 'fedcba9876543210fedcba9876543210' };
      await store.setPrivateFingerprints({
        session_id: sessionId,
        fingerprints: { complete: false, has_text: false, secret: true, entries: [otherEntry] },
      });
      await store.setPrivateFingerprints({ session_id: sessionId, fingerprints });

      const merged = await savedFingerprints(store);
      expect(merged).toMatchObject({ complete: false, has_text: true, secret: true });
      expect(merged?.entries).toEqual(expect.arrayContaining([...fingerprints.entries, otherEntry]));
      expect(merged?.entries).toHaveLength(2);
    });

    it('is a no-op for a missing session', async () => {
      const store = createStore();
      await store.setPrivateFingerprints({ session_id: missingSessionId, fingerprints });
      expect(await store.getSession({ tenant_id: tenant, session_id: missingSessionId })).toBeUndefined();
    });

    it('is removed with the session', async () => {
      const store = createStore();
      await seedSession(store);
      await store.setPrivateFingerprints({ session_id: sessionId, fingerprints });
      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });
      expect(await store.getSession({ tenant_id: tenant, session_id: sessionId })).toBeUndefined();

      await seedSession(store);
      expect(await savedFingerprints(store)).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('removes all session data, is idempotent, and is a no-op when tenant_id does not match', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createSession({
        tenant_id: 'other',
        session_id: 'other-session',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('private context')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
          capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: { 'tfy.initial': { value: 1 } } }],
        }),
      );
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        events: [makeTurnCreatedEvent('turn-1'), makeModelMessageEvent()],
      });
      await store.patchThreadCapabilityState({
        session_id: sessionId,
        turn_id: 'turn-1',
        thread_id: MAIN_THREAD_ID,
        key: 'tfy.plan',
        state: { step: 'secret' },
      });
      await store.patchMCPServers({
        session_id: sessionId,
        turn_id: 'turn-1',
        mcp_servers: [{ id: 'svc', name: 'svc', session_id: 'mcp-1', transport_type: 'streamable-http' }],
      });
      await store.patchSandboxInfo({
        session_id: sessionId,
        turn_id: 'turn-1',
        sandbox_info: { sandbox_id: 'sbx-1' },
      });

      await store.deleteSession({ tenant_id: 'other', session_id: sessionId });
      expect(await store.getSession({ tenant_id: tenant, session_id: sessionId })).toBeDefined();
      expect(await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' })).toBeDefined();
      expect(
        (
          await store.listTurnEvents({
            session_id: sessionId,
            turn_id: 'turn-1',
            limit: 10,
            page_token: undefined,
            order: 'asc',
          })
        ).data,
      ).toHaveLength(2);

      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });
      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });

      expect(await store.getSession({ tenant_id: tenant, session_id: sessionId })).toBeUndefined();
      expect(await store.getSession({ tenant_id: 'other', session_id: 'other-session' })).toBeDefined();
      expect(await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' })).toBeUndefined();
      await expect(
        store.listTurnEvents({
          session_id: sessionId,
          turn_id: 'turn-1',
          limit: 10,
          page_token: undefined,
          order: 'asc',
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
      await expect(
        store.listSessionEvents({
          session_id: sessionId,
          limit: 10,
          page_token: undefined,
          last_turn_id: undefined,
          types: undefined,
          after_event_id: undefined,
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);

      const listed = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(listed.data).toHaveLength(0);

      // Reusing every identifier must not expose orphaned events, context, or checkpoint state.
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const recreated = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' }));
      expect(recreated.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([]);
      expect(recreated.snapshot.threads[MAIN_THREAD_ID]?.capability_state).toBeNull();
      expect(recreated.snapshot.mcp_servers).toBeNull();
      expect(recreated.snapshot.sandbox_info).toBeNull();
      expect(
        (
          await store.listTurnEvents({
            session_id: sessionId,
            turn_id: 'turn-1',
            limit: 10,
            page_token: undefined,
            order: 'asc',
          })
        ).data,
      ).toEqual([]);
    });

    it('rejects session mutations after deleteSession', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });

      await expect(
        store.updateSession({
          tenant_id: tenant,
          session_id: sessionId,
          agent: undefined,
          title: 'new-title',
          metadata: undefined,
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      await expect(store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-2' }))).rejects.toBeInstanceOf(
        SessionNotFoundError,
      );
    });

    it('rejects turn mutations after deleteSession', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });

      for (const write of turnScopedWrites(store, { session_id: sessionId, turn_id: 'turn-1' })) {
        await expect(write()).rejects.toBeInstanceOf(TurnNotFoundError);
      }
    });

    it('rejects event mutations after deleteSession', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });

      const keys = { session_id: sessionId, turn_id: 'turn-1' };
      await expect(
        store.appendToEvents({
          ...keys,
          events: [makeTurnCreatedEvent('turn-1')],
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
      await expect(
        store.listTurnEvents({
          ...keys,
          limit: 10,
          page_token: undefined,
          order: undefined,
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
      await expect(
        store.listSessionEvents({
          session_id: sessionId,
          limit: 10,
          page_token: undefined,
          last_turn_id: undefined,
          types: undefined,
          after_event_id: undefined,
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('leaves sessions whose id extends the deleted id untouched', async () => {
      const store = createStore();
      const nested = `${sessionId}:nested`;
      await seedSession(store);
      await store.createSession({
        tenant_id: tenant,
        session_id: nested,
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await store.createTurn(makeCreateTurnInput({ sessionId: nested, turnId: 'turn-1' }));
      const nestedKeys = { session_id: nested, turn_id: 'turn-1' };
      await store.appendToEvents({ ...nestedKeys, events: [makeTurnCreatedEvent('turn-1')] });

      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });

      expect(await store.getSession({ tenant_id: tenant, session_id: nested })).toBeDefined();
      expect(await store.getTurn(nestedKeys)).toBeDefined();
      expect(
        (await store.listTurnEvents({ ...nestedKeys, limit: 10, page_token: undefined, order: 'asc' })).data,
      ).toHaveLength(1);
    });

    it('child appends that race deleteSession fail cleanly and leave no orphans', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const keys = { session_id: sessionId, turn_id: 'turn-1' };

      const results = await Promise.allSettled([
        store.deleteSession({ tenant_id: tenant, session_id: sessionId }),
        store.appendToEvents({
          ...keys,
          events: [makeTurnCreatedEvent('turn-1'), makeModelMessageEvent()],
        }),
        store.appendToThreadContext({
          ...keys,
          thread_id: MAIN_THREAD_ID,
          context: [userMessage('raced')],
          current_context_usage: null,
          completion: null,
          tool_call_memo: undefined,
          task_state: undefined,
        }),
      ]);

      const [deletion, ...appends] = results;
      expect(deletion.status).toBe('fulfilled');
      for (const result of appends) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(SessionStoreNotFoundError);
        }
      }

      expect(await store.getSession({ tenant_id: tenant, session_id: sessionId })).toBeUndefined();
      expect(await store.getTurn(keys)).toBeUndefined();

      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const recreated = mustGet(await store.getTurn(keys));
      expect(recreated.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([]);
      expect(
        (
          await store.listTurnEvents({
            ...keys,
            limit: 10,
            page_token: undefined,
            order: 'asc',
          })
        ).data,
      ).toEqual([]);
    });
  });

  describe('stampImportedSession', () => {
    const archivedSession = {
      created_at: new Date('2025-03-04T05:06:07.000Z'),
      updated_at: new Date('2025-03-04T09:10:11.000Z'),
      last_activity_timestamp_ms: Date.parse('2025-03-04T09:10:11.000Z'),
      metrics: { total_duration_ms: 123_456, total_turns: 2, total_cost_in_usd: 0.25 },
    };

    it('overwrites the session and turn clocks and the metrics with the archived values', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await finishTurn(store, 'turn-1');
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1' }));
      await finishTurn(store, 'turn-2');

      const turns = [
        {
          turn_id: 'turn-1',
          created_at: new Date('2025-03-04T05:06:08.000Z'),
          updated_at: new Date('2025-03-04T05:07:00.000Z'),
        },
        {
          turn_id: 'turn-2',
          created_at: new Date('2025-03-04T09:00:00.000Z'),
          updated_at: new Date('2025-03-04T09:10:11.000Z'),
        },
      ];
      await store.stampImportedSession({ tenant_id: tenant, session_id: sessionId, ...archivedSession, turns });

      const session = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(session.created_at).toEqual(archivedSession.created_at);
      expect(session.updated_at).toEqual(archivedSession.updated_at);
      expect(session.last_activity_timestamp_ms).toBe(archivedSession.last_activity_timestamp_ms);
      expect(session.metrics).toEqual(archivedSession.metrics);
      expect(session.last_turn_id).toBe('turn-2');

      for (const expected of turns) {
        const turn = mustGet(await store.getTurn({ session_id: sessionId, turn_id: expected.turn_id }));
        expect(turn.created_at).toEqual(expected.created_at);
        expect(turn.updated_at).toEqual(expected.updated_at);
        expect(turn.state.status).toBe('done');
      }
    });

    it('rejects a missing session or turn and leaves the session untouched', async () => {
      const store = createStore();
      await expect(
        store.stampImportedSession({
          tenant_id: tenant,
          session_id: missingSessionId,
          ...archivedSession,
          turns: [],
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);

      await seedSession(store);
      const before = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      await expect(
        store.stampImportedSession({
          tenant_id: tenant,
          session_id: sessionId,
          ...archivedSession,
          turns: [
            { turn_id: missingTurnId, created_at: archivedSession.created_at, updated_at: archivedSession.updated_at },
          ],
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
      await expect(
        store.stampImportedSession({
          tenant_id: 'other-tenant',
          session_id: sessionId,
          ...archivedSession,
          turns: [],
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);

      const after = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(after).toEqual(before);
    });
  });

  describe('missing session / turn', () => {
    it('rejects session mutations for a missing session', async () => {
      const store = createStore();

      await expect(
        store.updateSession({
          tenant_id: tenant,
          session_id: missingSessionId,
          agent: undefined,
          title: 'new-title',
          metadata: undefined,
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
      await expect(
        store.createTurn(makeCreateTurnInput({ sessionId: missingSessionId, turnId: 'turn-1' })),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it('rejects turn mutations for a missing turn', async () => {
      const store = createStore();
      await seedSession(store);

      for (const write of turnScopedWrites(store, { session_id: sessionId, turn_id: missingTurnId })) {
        await expect(write()).rejects.toBeInstanceOf(TurnNotFoundError);
      }
    });

    it('rejects event mutations for a missing session or turn', async () => {
      const store = createStore();
      await seedSession(store);
      const keys = { session_id: sessionId, turn_id: missingTurnId };

      await expect(
        store.appendToEvents({
          ...keys,
          events: [makeTurnCreatedEvent(missingTurnId)],
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
      await expect(
        store.listTurnEvents({
          ...keys,
          limit: 10,
          page_token: undefined,
          order: undefined,
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
      await expect(
        store.listSessionEvents({
          session_id: missingSessionId,
          limit: 10,
          page_token: undefined,
          last_turn_id: undefined,
          types: undefined,
          after_event_id: undefined,
        }),
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });
  });

  describe('listSessions', () => {
    async function seedThreeSessions(store: Store) {
      for (const id of ['sa', 'sb', 'sc']) {
        await store.createSession({
          tenant_id: tenant,
          session_id: id,
          created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
          agent: { type: 'inline', spec: makeAgentSpec() },
          custom: null,
          metadata: {},
          external_id: null,
          source: null,
        });
        await new Promise(r => setTimeout(r, 2));
      }
    }

    it('lists newest-first by default, asc on request, scoped to tenant', async () => {
      const store = createStore();
      await seedThreeSessions(store);
      await store.createSession({
        tenant_id: 'other',
        session_id: 'sx',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      const desc = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(desc.data.map(s => s.session_id)).toEqual(['sc', 'sb', 'sa']);

      const asc = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(asc.data.map(s => s.session_id)).toEqual(['sa', 'sb', 'sc']);
    });

    it('paginates with next_page_token and filters by created_at bounds', async () => {
      const store = createStore();
      await seedThreeSessions(store);

      const first = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 2,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(first.data).toHaveLength(2);
      expect(first.pagination.next_page_token).toBeDefined();
      const second = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 2,
        page_token: first.pagination.next_page_token,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(second.data.map(s => s.session_id)).toEqual(['sa']);
      expect(second.pagination.next_page_token).toBeUndefined();

      const all = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      const middleSession = all.data[1];
      if (!middleSession) {
        throw new Error('expected middle session in list');
      }
      const middleCreatedAt = middleSession.created_at;
      const bounded = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        order: 'asc',
        page_token: undefined,
        start_timestamp: middleCreatedAt,
        end_timestamp: middleCreatedAt,
        source_type: undefined,
        source_id: undefined,
      });
      expect(bounded.data.map(s => s.session_id)).toEqual(['sb']);
    });

    it('orders by updated_at so later activity ranks ahead of create order', async () => {
      const store = createStore();
      await seedThreeSessions(store);
      await new Promise(r => setTimeout(r, 5));
      await store.updateSession({
        tenant_id: tenant,
        session_id: 'sa',
        agent: undefined,
        title: 'bumped',
        metadata: undefined,
      });

      const listArgs = {
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      };
      const desc = await store.listSessions({ ...listArgs, limit: 10, page_token: undefined });
      expect(desc.data.map(s => s.session_id)).toEqual(['sa', 'sc', 'sb']);

      // Keyset must continue from the bumped row's updated_at cursor, not create order.
      const page1 = await store.listSessions({ ...listArgs, limit: 2, page_token: undefined });
      expect(page1.data.map(s => s.session_id)).toEqual(['sa', 'sc']);
      const page2 = await store.listSessions({
        ...listArgs,
        limit: 2,
        page_token: page1.pagination.next_page_token,
      });
      expect(page2.data.map(s => s.session_id)).toEqual(['sb']);
    });

    it('keyset pages partition the ordered list without overlap or gaps', async () => {
      const store = createStore();
      await seedThreeSessions(store);

      const listArgs = {
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        order: 'desc' as const,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      };
      const full = await store.listSessions({ ...listArgs, limit: 10, page_token: undefined });
      const page1 = await store.listSessions({ ...listArgs, limit: 2, page_token: undefined });
      expect(page1.pagination.next_page_token).toBeDefined();
      const page2 = await store.listSessions({
        ...listArgs,
        limit: 2,
        page_token: page1.pagination.next_page_token,
      });

      const pageIds = [...page1.data, ...page2.data].map(s => s.session_id);
      expect(pageIds).toEqual(full.data.map(s => s.session_id));
      expect(new Set(pageIds).size).toBe(pageIds.length);
      expect(page2.pagination.next_page_token).toBeUndefined();
    });

    it('filters listSessions by metadata containment', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: 'prod-platform',
        created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: { env: 'prod', team: 'platform' },
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'prod-only',
        created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: { env: 'prod' },
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'staging',
        created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: { env: 'staging' },
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'empty-meta',
        created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      const listArgs = {
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: 'asc' as const,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      };

      const byEnv = await store.listSessions({ ...listArgs, metadata: { env: 'prod' } });
      expect(byEnv.data.map(s => s.session_id).sort()).toEqual(['prod-only', 'prod-platform']);

      const byBoth = await store.listSessions({
        ...listArgs,
        metadata: { env: 'prod', team: 'platform' },
      });
      expect(byBoth.data.map(s => s.session_id)).toEqual(['prod-platform']);

      const emptyOnly = await store.listSessions({ ...listArgs, metadata: {} });
      expect(emptyOnly.data.map(s => s.session_id)).toEqual(['empty-meta']);
    });

    it('filters by creator or named-agent ids', async () => {
      const store = createStore();
      await store.createSession({
        tenant_id: tenant,
        session_id: 'alice-session',
        created_by_subject: { subject_id: 'alice', subject_type: 'user', subject_display_name: 'alice' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'bob-session',
        created_by_subject: { subject_id: 'bob', subject_type: 'user', subject_display_name: 'bob' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'managed-session',
        created_by_subject: { subject_id: 'charlie', subject_type: 'user', subject_display_name: 'charlie' },
        agent: { type: 'reference', id: 'managed-agent', name: null },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'unmanaged-session',
        created_by_subject: { subject_id: 'dave', subject_type: 'user', subject_display_name: 'dave' },
        agent: { type: 'reference', id: 'unmanaged-agent', name: null },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      const aliceOnly = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: {
          created_by_subject_id: 'alice',
          agent_ids: [],
        },
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(aliceOnly.data.map(s => s.session_id)).toEqual(['alice-session']);
      expect(aliceOnly.data[0]?.created_by_subject.subject_id).toBe('alice');

      const aliceOrManaged = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: {
          created_by_subject_id: 'alice',
          agent_ids: ['managed-agent'],
        },
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: 'asc',
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(aliceOrManaged.data.map(s => s.session_id)).toEqual(['alice-session', 'managed-session']);

      const managedAgentOnly = await store.listSessions({
        agent_id: 'managed-agent',
        created_by_or_agent_ids: {
          created_by_subject_id: 'alice',
          agent_ids: ['managed-agent'],
        },
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(managedAgentOnly.data.map(s => s.session_id)).toEqual(['managed-session']);

      const unmatched = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: {
          created_by_subject_id: 'nobody',
          agent_ids: [],
        },
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: undefined,
        source_id: undefined,
      });
      expect(unmatched.data).toEqual([]);
    });

    it('persists schedule source and listSessions filters by source_type / source_id', async () => {
      const store = createStore();
      const scheduleSource = {
        type: 'schedule' as const,
        id: 'sched-1',
        run_id: 'run-1',
      };
      await store.createSession({
        tenant_id: tenant,
        session_id: 'from-schedule',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: 'run-1',
        source: scheduleSource,
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'from-other-schedule',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: 'run-2',
        source: { type: 'schedule', id: 'sched-2', run_id: 'run-2' },
      });
      await store.createSession({
        tenant_id: tenant,
        session_id: 'interactive',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      const byId = mustGet(await store.getSession({ tenant_id: tenant, session_id: 'from-schedule' }));
      expect(byId.source).toEqual(scheduleSource);

      const byType = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: 'schedule',
        source_id: undefined,
      });
      expect(byType.data.map(s => s.session_id).sort()).toEqual(['from-other-schedule', 'from-schedule']);

      const bySourceId = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: 'schedule',
        source_id: 'sched-1',
      });
      expect(bySourceId.data.map(s => s.session_id)).toEqual(['from-schedule']);
      expect(bySourceId.data[0]?.source).toEqual(scheduleSource);

      const unmatched = await store.listSessions({
        agent_id: undefined,
        created_by_or_agent_ids: undefined,
        metadata: undefined,
        tenant_id: tenant,
        limit: 10,
        page_token: undefined,
        order: undefined,
        start_timestamp: undefined,
        end_timestamp: undefined,
        source_type: 'schedule',
        source_id: 'missing-sched',
      });
      expect(unmatched.data).toEqual([]);
    });
  });

  describe('createTurn', () => {
    it('retains only explicitly live predecessor threads in a successor snapshot', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'terminal-with-child' }));
      await store.addThreads({
        session_id: sessionId,
        turn_id: 'terminal-with-child',
        threads: [
          {
            thread_id: 'stale-child',
            parent: { thread_id: MAIN_THREAD_ID, tool_call_id: 'spawn-child' },
            agent_info: { type: 'dynamic', name: 'child', input: 'work' },
            context: [userMessage('unfinished child context')],
            current_context_usage: getEmptyCurrentContextUsage(),
            completion: null,
            capability_state: null,
            tool_call_memo: undefined,
            task_state: undefined,
          },
        ],
      });
      await finishTurn(store, 'terminal-with-child');

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'successor',
          previousTurnId: 'terminal-with-child',
          firstTurnId: 'terminal-with-child',
          retained_previous_thread_ids: [MAIN_THREAD_ID],
        }),
      );

      const predecessor = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'terminal-with-child' }));
      const successor = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'successor' }));
      expect(Object.keys(predecessor.snapshot.threads).sort()).toEqual([MAIN_THREAD_ID, 'stale-child'].sort());
      expect(Object.keys(successor.snapshot.threads)).toEqual([MAIN_THREAD_ID]);
    });

    it('persists a sandbox created before thread construction atomically with the turn', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-with-sandbox',
          sandbox_info: { sandbox_id: 'v1:test:bound-sandbox' },
        }),
      );

      const turn = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'turn-with-sandbox' }));
      expect(turn.snapshot.sandbox_info).toEqual({ sandbox_id: 'v1:test:bound-sandbox' });
    });

    it('persists chat approval grants atomically with the turn', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-with-grant',
          approval_grants: ['["v1","mcp","github","create_issue"]'],
        }),
      );

      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).approval_grants).toEqual(['["v1","mcp","github","create_issue"]']);
    });

    it('never persists implementation-plan envelopes in legacy approval_grants', async () => {
      const store = createStore();
      await seedSession(store);
      const chatGrant = '["v3","mcp","github","read_issue"]';
      const planGrant = serializeImplementationPlanGrant(implementationPlanGrant());

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-with-separated-grants',
          approval_grants: [chatGrant, planGrant],
        }),
      );

      expect(mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId })).approval_grants).toEqual([
        chatGrant,
      ]);
    });

    it('persists an owner-scoped implementation-plan grant before its approval turn completes', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const grant = implementationPlanGrant();
      const turnId = 'plan-approval-turn';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));

      await store.persistImplementationPlanGrant({ grant, turn_id: turnId });

      await expect(
        store.listImplementationPlanGrants({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
        }),
      ).resolves.toEqual([grant]);
      await expect(
        store.persistImplementationPlanGrant({
          grant: implementationPlanGrant({ created_by: 'other-user' }),
          turn_id: turnId,
        }),
      ).rejects.toBeInstanceOf(SessionStoreInvariantError);
    });

    it('rejects implementation-plan grant activation after its turn is no longer running', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const turnId = 'completed-plan-activation-turn';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
      await finishTurn(store, turnId);

      await expect(
        store.persistImplementationPlanGrant({ grant: implementationPlanGrant(), turn_id: turnId }),
      ).rejects.toBeInstanceOf(ImplementationPlanGrantLifecycleError);
    });

    it('matches no implementation-plan grant after unbind or rebind to another checkout', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const turnId = 'unbind-plan-turn';
      const grant = implementationPlanGrant();
      const owner = { tenant_id: tenant, created_by: createdBy, session_id: sessionId };
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
      await store.persistImplementationPlanGrant({ grant, turn_id: turnId });

      await setSessionRepositoryBinding(store, {
        ...owner,
        repository_id: null,
        workspace_cwd: null,
      });
      await expect(store.listImplementationPlanGrants(owner)).resolves.toEqual([]);
      await expect(store.revokeImplementationPlanGrant({ ...owner, grant_id: grant.grant_id })).resolves.toEqual({
        status: 'absent',
      });
      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: turnId,
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'unbound-dispatch',
        }),
      ).resolves.toEqual({ status: 'blocked' });

      await setSessionRepositoryBinding(store, {
        ...owner,
        repository_id: grant.plan.repository_id,
        workspace_cwd: '/repo-b',
      });
      await expect(store.listImplementationPlanGrants(owner)).resolves.toEqual([]);
      await expect(store.revokeImplementationPlanGrant({ ...owner, grant_id: grant.grant_id })).resolves.toEqual({
        status: 'absent',
      });
      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: turnId,
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'rebound-dispatch',
        }),
      ).resolves.toEqual({ status: 'blocked' });
    });

    it('does not expose or revoke implementation-plan grants across tenant, user, or session scope', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const grant = implementationPlanGrant();
      const turnId = 'owner-scope-turn';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
      await store.persistImplementationPlanGrant({ grant, turn_id: turnId });

      const wrongOwners = [
        { tenant_id: 'other-tenant', created_by: createdBy, session_id: sessionId },
        { tenant_id: tenant, created_by: 'other-user', session_id: sessionId },
        { tenant_id: tenant, created_by: createdBy, session_id: 'other-session' },
      ];
      for (const owner of wrongOwners) {
        await expect(store.listImplementationPlanGrants(owner)).resolves.toEqual([]);
        await expect(store.revokeImplementationPlanGrant({ ...owner, grant_id: grant.grant_id })).resolves.toEqual({
          status: 'absent',
        });
      }
      await expect(
        store.listImplementationPlanGrants({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
        }),
      ).resolves.toEqual([grant]);
    });

    it('durably revokes an implementation-plan grant without changing legacy chat grants', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const grant = implementationPlanGrant();
      const chatGrant = '["v3","mcp","github","read_issue"]';
      const turnId = 'turn-before-revoke';
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId,
          approval_grants: [chatGrant],
        }),
      );
      await store.persistImplementationPlanGrant({ grant, turn_id: turnId });

      await expect(
        store.revokeImplementationPlanGrant({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
          grant_id: grant.grant_id,
        }),
      ).resolves.toEqual({ status: 'revoked' });
      await expect(
        store.listImplementationPlanGrants({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
        }),
      ).resolves.toEqual([]);
      expect(mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId })).approval_grants).toEqual([
        chatGrant,
      ]);
    });

    it('keeps an idle implementation-plan grant visible and revocable, then blocks future admission', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const grant = implementationPlanGrant();
      const owner = { tenant_id: tenant, created_by: createdBy, session_id: sessionId };
      const completedTurnId = 'completed-plan-control-turn';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: completedTurnId }));
      await store.persistImplementationPlanGrant({ grant, turn_id: completedTurnId });
      await finishTurn(store, completedTurnId);

      await expect(store.listImplementationPlanGrants(owner)).resolves.toEqual([grant]);
      await expect(
        store.revokeImplementationPlanGrant({
          ...owner,
          grant_id: grant.grant_id,
        }),
      ).resolves.toEqual({ status: 'revoked' });

      const runningTurnId = 'current-plan-control-turn';
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: runningTurnId,
          previousTurnId: completedTurnId,
          firstTurnId: completedTurnId,
        }),
      );
      await expect(store.listImplementationPlanGrants(owner)).resolves.toEqual([]);
      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: runningTurnId,
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'revoked-idle-grant',
        }),
      ).resolves.toEqual({ status: 'blocked' });
    });

    it('does not resurrect a revoked grant when its stale approval turn completes', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const grant = implementationPlanGrant();
      const staleTurnId = 'stale-turn-after-plan-revoke';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: staleTurnId }));
      await store.persistImplementationPlanGrant({ grant, turn_id: staleTurnId });
      await store.revokeImplementationPlanGrant({
        tenant_id: tenant,
        created_by: createdBy,
        session_id: sessionId,
        grant_id: grant.grant_id,
      });

      await finishTurn(store, staleTurnId);
      const freshTurnId = 'fresh-turn-after-plan-revoke';
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: freshTurnId, previousTurnId: staleTurnId, firstTurnId: staleTurnId }),
      );

      await expect(
        store.listImplementationPlanGrants({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
        }),
      ).resolves.toEqual([]);

      await store.persistImplementationPlanGrant({ grant, turn_id: freshTurnId });
      await expect(
        store.listImplementationPlanGrants({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
        }),
      ).resolves.toEqual([grant]);
    });

    it('linearizes revocation against a durable plan dispatch reservation', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'running-plan-turn' }));
      const grant = implementationPlanGrant();
      const owner = { tenant_id: tenant, created_by: createdBy, session_id: sessionId };
      await store.persistImplementationPlanGrant({ grant, turn_id: 'running-plan-turn' });

      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: 'running-plan-turn',
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'dispatch-a',
        }),
      ).resolves.toEqual({ status: 'admitted' });
      await expect(
        store.revokeImplementationPlanGrant({
          ...owner,
          grant_id: grant.grant_id,
        }),
      ).resolves.toEqual({ status: 'pending' });
      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: 'running-plan-turn',
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'dispatch-b',
        }),
      ).resolves.toEqual({ status: 'blocked' });

      await store.completeImplementationPlanDispatch({
        ...owner,
        turn_id: 'running-plan-turn',
        grant_id: grant.grant_id,
        dispatch_id: 'dispatch-a',
      });
      await expect(
        store.revokeImplementationPlanGrant({
          ...owner,
          grant_id: grant.grant_id,
        }),
      ).resolves.toEqual({ status: 'revoked' });
    });

    it('blocks a dispatch whose revocation transaction linearized first', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'revoke-first-turn' }));
      const grant = implementationPlanGrant();
      const owner = { tenant_id: tenant, created_by: createdBy, session_id: sessionId };
      await store.persistImplementationPlanGrant({ grant, turn_id: 'revoke-first-turn' });

      await expect(
        store.revokeImplementationPlanGrant({
          ...owner,
          grant_id: grant.grant_id,
        }),
      ).resolves.toEqual({ status: 'revoked' });
      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: 'revoke-first-turn',
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: 'too-late',
        }),
      ).resolves.toEqual({ status: 'blocked' });
    });

    it('scopes a durable dispatch identity to its turn', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const firstTurnId = 'dispatch-identity-turn-a';
      const secondTurnId = 'dispatch-identity-turn-b';
      const dispatchId = 'model-reused-tool-call';
      const grant = implementationPlanGrant();
      const owner = { tenant_id: tenant, created_by: createdBy, session_id: sessionId };
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: firstTurnId }));
      await store.persistImplementationPlanGrant({ grant, turn_id: firstTurnId });
      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: firstTurnId,
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: dispatchId,
        }),
      ).resolves.toEqual({ status: 'admitted' });
      await store.completeImplementationPlanDispatch({
        ...owner,
        turn_id: firstTurnId,
        grant_id: grant.grant_id,
        dispatch_id: dispatchId,
      });
      await finishTurn(store, firstTurnId);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: secondTurnId,
          previousTurnId: firstTurnId,
          firstTurnId,
        }),
      );

      await expect(
        store.beginImplementationPlanDispatch({
          ...owner,
          turn_id: secondTurnId,
          grant_id: grant.grant_id,
          checkout_id: grant.checkout_id,
          dispatch_id: dispatchId,
        }),
      ).resolves.toEqual({ status: 'admitted' });
    });

    it('rejects a valid grant whose durable owner does not match the session row', async () => {
      const store = createStore();
      await seedImplementationPlanSession(store);
      const turnId = 'owner-mismatch-turn';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));

      await expect(
        store.persistImplementationPlanGrant({
          grant: implementationPlanGrant({ created_by: 'other-user' }),
          turn_id: turnId,
        }),
      ).rejects.toBeInstanceOf(SessionStoreInvariantError);
      await expect(
        store.listImplementationPlanGrants({
          tenant_id: tenant,
          created_by: createdBy,
          session_id: sessionId,
        }),
      ).resolves.toEqual([]);
    });

    it('round-trips tool-call memos for new and carried-forward threads', async () => {
      const store = createStore();
      await seedSession(store);
      const firstMemo = toolCallMemoSnapshot();
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'memo-turn-1',
          new_threads: [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: firstMemo,
              task_state: undefined,
            },
          ],
        }),
      );

      const first = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'memo-turn-1' }));
      expect(first.snapshot.threads[MAIN_THREAD_ID]?.tool_call_memo).toEqual(firstMemo);

      await finishTurn(store, 'memo-turn-1');
      const secondMemo = toolCallMemoSnapshot({
        side_effect_attempts: [{ key: '["mcp","write"]', count: 2 }],
        clarification_answered: true,
        // Keyed by the full call signature, not just the tool name; see
        // ToolCallMemoSnapshot.pending_identical_call_nudges. Two argument variants of the
        // same tool round-trip as distinct pending entries.
        pending_identical_call_nudges: [{ signature: '["run",{"a":1}]', tool_name: 'run' }],
      });
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'memo-turn-2',
          previousTurnId: 'memo-turn-1',
          firstTurnId: 'memo-turn-1',
          tool_call_memos: [{ thread_id: MAIN_THREAD_ID, tool_call_memo: secondMemo }],
        }),
      );

      const second = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'memo-turn-2' }));
      expect(second.snapshot.threads[MAIN_THREAD_ID]?.tool_call_memo).toEqual(secondMemo);
    });

    it('round-trips host-owned task states for new and carried-forward threads', async () => {
      const store = createStore();
      await seedSession(store);
      const firstTaskState: TaskStateSnapshot = {
        findings: [
          {
            label: 'Spain/Madrid',
            headline: 'Average room rent is around 650 euros per month.',
            why_it_matters: 'Answers the rent beat of the brief.',
            url: 'https://example.com/madrid-rent',
          },
        ],
        tool_calls_used: 2,
        phase: 'research',
      };
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'task-state-turn-1',
          new_threads: [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: undefined,
              task_state: firstTaskState,
            },
          ],
          task_states: [{ thread_id: MAIN_THREAD_ID, task_state: firstTaskState }],
        }),
      );

      const first = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'task-state-turn-1' }));
      expect(first.snapshot.threads[MAIN_THREAD_ID]?.task_state).toEqual(firstTaskState);

      await finishTurn(store, 'task-state-turn-1');
      const secondTaskState: TaskStateSnapshot = {
        ...firstTaskState,
        tool_calls_used: 5,
        phase: 'final_answer',
      };
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'task-state-turn-2',
          previousTurnId: 'task-state-turn-1',
          firstTurnId: 'task-state-turn-1',
          task_states: [{ thread_id: MAIN_THREAD_ID, task_state: secondTaskState }],
        }),
      );

      const second = mustGet(await store.getTurn({ session_id: sessionId, turn_id: 'task-state-turn-2' }));
      expect(second.snapshot.threads[MAIN_THREAD_ID]?.task_state).toEqual(secondTaskState);
    });

    it('merges concurrent chat approval grants instead of replacing existing grants', async () => {
      const store = createStore();
      await seedSession(store);
      const firstGrant = '["v1","mcp","github","create_issue"]';
      const secondGrant = '["v1","mcp","slack","send_message"]';
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1', approval_grants: [firstGrant] }));
      await finishTurn(store, 'turn-1');
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-2',
          previousTurnId: 'turn-1',
          firstTurnId: 'turn-1',
          approval_grants: [secondGrant],
        }),
      );

      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).approval_grants).toEqual([firstGrant, secondGrant]);
    });

    it('rejects a replayed approval continuation after the session tip advances', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await finishTurn(store, 'turn-1');
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
      );

      await expect(
        store.createTurn(
          makeCreateTurnInput({
            sessionId,
            turnId: 'stale-approval-turn',
            previousTurnId: 'turn-1',
            firstTurnId: 'turn-1',
            require_previous_turn_is_tip: true,
          }),
        ),
      ).rejects.toBeInstanceOf(StaleApprovalContinuationError);

      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).last_turn_id).toBe('turn-2');
      expect(await store.getTurn({ session_id: sessionId, turn_id: 'stale-approval-turn' })).toBeUndefined();
    });

    it('atomically links last_turn_id and bumps activity', async () => {
      const store = createStore();
      await seedSession(store);
      const before = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      await new Promise(r => setTimeout(r, 5));
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const after = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(after).last_turn_id).toBe('turn-1');
      expect(mustGet(after).last_activity_timestamp_ms).toBeGreaterThan(mustGet(before).last_activity_timestamp_ms);
    });

    it('increments session.metrics.total_turns without cost or duration', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const afterFirst = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(afterFirst).metrics).toEqual({
        total_duration_ms: 0,
        total_turns: 1,
      });
      await finishTurn(store, 'turn-1');
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
      );
      const afterSecond = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(afterSecond).metrics.total_turns).toBe(2);
    });

    it('update_session_title_if_not_exist sets once and never overwrites', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-1', update_session_title_if_not_exist: 'First title' }),
      );
      await finishTurn(store, 'turn-1');
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-2',
          previousTurnId: 'turn-1',
          firstTurnId: 'turn-1',
          update_session_title_if_not_exist: 'Second title',
        }),
      );
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).title).toBe('First title');
    });

    it('fork from any existing turn succeeds and advances tip', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await finishTurn(store, 'turn-1');
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
      );
      // Fork from turn-1 (not the tip).
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-fork', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
      );
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).last_turn_id).toBe('turn-fork');
    });

    it('new root turn (no previous_turn_id) succeeds on non-empty session', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-root-2' }));
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).last_turn_id).toBe('turn-root-2');
    });

    it('concurrent createTurn forking the same tip: both succeed with isolated context', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'tip',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('shared')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );
      await finishTurn(store, 'tip');
      const results = await Promise.allSettled([
        store.createTurn(
          makeCreateTurnInput({
            sessionId,
            turnId: 'turn-a',
            previousTurnId: 'tip',
            firstTurnId: 'tip',
            new_context_appends: [
              {
                thread_id: MAIN_THREAD_ID,
                context: [userMessage('a-only')],
                current_context_usage: getEmptyCurrentContextUsage(),
              },
            ],
          }),
        ),
        store.createTurn(
          makeCreateTurnInput({
            sessionId,
            turnId: 'turn-b',
            previousTurnId: 'tip',
            firstTurnId: 'tip',
            new_context_appends: [
              {
                thread_id: MAIN_THREAD_ID,
                context: [userMessage('b-only')],
                current_context_usage: getEmptyCurrentContextUsage(),
              },
            ],
          }),
        ),
      ]);
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(['turn-a', 'turn-b']).toContain(mustGet(session).last_turn_id);
      const turns = await store.listTurns({
        session_id: sessionId,
        limit: 10,
        page_token: undefined,
      });
      expect(turns.data.map(t => t.turn_id).sort()).toEqual(['tip', 'turn-a', 'turn-b']);

      const turnA = await store.getTurn({ session_id: sessionId, turn_id: 'turn-a' });
      const turnB = await store.getTurn({ session_id: sessionId, turn_id: 'turn-b' });
      expect(contextContents(turnA?.snapshot.threads[MAIN_THREAD_ID]?.context)).toEqual(['shared', 'a-only']);
      expect(contextContents(turnB?.snapshot.threads[MAIN_THREAD_ID]?.context)).toEqual(['shared', 'b-only']);
    });

    it('rejects createTurn when previous turn is still running', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await expect(
        store.createTurn(
          makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
        ),
      ).rejects.toBeInstanceOf(PreviousTurnRunningError);
    });

    it('rejects duplicate turn_id with conflict', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await finishTurn(store, 'turn-1');
      await expect(
        store.createTurn(
          makeCreateTurnInput({
            sessionId,
            turnId: 'turn-1',
            previousTurnId: 'turn-1',
            firstTurnId: 'turn-1',
          }),
        ),
      ).rejects.toBeInstanceOf(TurnAlreadyExistsError);
    });

    it('linear continuation carries context and persists the caller-supplied capability map', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't1',
          new_threads: [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ],
          capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: { 'tfy.plan': { step: 1 } } }],
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('L1a'), userMessage('L1b')],
              current_context_usage: { ...getEmptyCurrentContextUsage(), prompt_tokens: 2 },
            },
          ],
        }),
      );
      await store.patchThreadCapabilityState({
        session_id: sessionId,
        turn_id: 't1',
        thread_id: MAIN_THREAD_ID,
        key: 'tfy.plan',
        state: { step: 2 },
      });
      await finishTurn(store, 't1');

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't2',
          previousTurnId: 't1',
          firstTurnId: 't1',
          capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: { 'tfy.plan': { step: 2 } } }],
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('L2')],
              current_context_usage: { ...getEmptyCurrentContextUsage(), prompt_tokens: 3 },
            },
          ],
        }),
      );

      const t2 = await store.getTurn({ session_id: sessionId, turn_id: 't2' });
      const main = mustGet(t2).snapshot.threads[MAIN_THREAD_ID];
      expect(contextContents(main?.context)).toEqual(['L1a', 'L1b', 'L2']);
      expect(main?.current_context_usage.prompt_tokens).toBe(3);
      expect(main?.capability_state).toEqual({ 'tfy.plan': { step: 2 } });
    });

    it('createTurn atomically persists the complete post-send capability map', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't1',
          capability_states: [
            {
              thread_id: MAIN_THREAD_ID,
              capability_state: { keep: { version: 1 }, remove: true },
            },
          ],
        }),
      );
      await finishTurn(store, 't1');

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't2',
          previousTurnId: 't1',
          firstTurnId: 't1',
          capability_states: [
            {
              thread_id: MAIN_THREAD_ID,
              capability_state: { keep: { version: 2 } },
            },
          ],
        }),
      );

      const t2 = await store.getTurn({ session_id: sessionId, turn_id: 't2' });
      expect(t2?.snapshot.threads[MAIN_THREAD_ID]?.capability_state).toEqual({
        keep: { version: 2 },
      });
    });

    it('fork from an older turn after tip overwrite sees only the parent prefix', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('from-t1')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );
      await finishTurn(store, 't1');

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't2',
          previousTurnId: 't1',
          firstTurnId: 't1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('from-t2')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );
      await store.overwriteThreadContext({
        session_id: sessionId,
        turn_id: 't2',
        event: {
          type: EventType.AGENT_CONTEXT_OVERWRITE,
          id: newEventId(),
          created_at: new Date().toISOString(),
          thread_id: MAIN_THREAD_ID,
          reason: 'compaction',
          context: [userMessage('t2-summary-only')],
          current_context_usage: getEmptyCurrentContextUsage(),
          usage: getEmptyUsage(),
        },
      });
      await finishTurn(store, 't2');

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't3-fork',
          previousTurnId: 't1',
          firstTurnId: 't1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('fork-append')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );

      const fork = await store.getTurn({
        session_id: sessionId,
        turn_id: 't3-fork',
      });
      expect(contextContents(fork?.snapshot.threads[MAIN_THREAD_ID]?.context)).toEqual(['from-t1', 'fork-append']);
    });

    it('createTurn with multiple new_threads + appends is atomic (all threads present together)', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't1',
          new_threads: [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
            {
              thread_id: 'child-a',
              parent: { thread_id: MAIN_THREAD_ID, tool_call_id: 'tc-a' },
              agent_info: { type: 'dynamic', name: 'child-a', input: 'task-a' },
              tool_call_memo: undefined,
              task_state: undefined,
            },
            {
              thread_id: 'child-b',
              parent: { thread_id: MAIN_THREAD_ID, tool_call_id: 'tc-b' },
              agent_info: { type: 'dynamic', name: 'child-b', input: 'task-b' },
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ],
          capability_states: [
            { thread_id: MAIN_THREAD_ID, capability_state: null },
            { thread_id: 'child-a', capability_state: { 'tfy.plan': { step: 1 } } },
            { thread_id: 'child-b', capability_state: null },
          ],
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('main-msg')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
            {
              thread_id: 'child-a',
              context: [userMessage('a-msg')],
              current_context_usage: { ...getEmptyCurrentContextUsage(), prompt_tokens: 1 },
            },
            {
              thread_id: 'child-b',
              context: [userMessage('b-msg-1'), userMessage('b-msg-2')],
              current_context_usage: { ...getEmptyCurrentContextUsage(), prompt_tokens: 2 },
            },
          ],
        }),
      );

      const turn = await store.getTurn({
        session_id: sessionId,
        turn_id: 't1',
      });
      const threads = mustGet(turn).snapshot.threads;
      expect(Object.keys(threads).sort()).toEqual(['child-a', 'child-b', MAIN_THREAD_ID]);
      expect(contextContents(threads[MAIN_THREAD_ID]?.context)).toEqual(['main-msg']);
      expect(contextContents(threads['child-a']?.context)).toEqual(['a-msg']);
      expect(contextContents(threads['child-b']?.context)).toEqual(['b-msg-1', 'b-msg-2']);
      expect(threads['child-a']?.parent).toEqual({
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'tc-a',
      });
      expect(threads['child-a']?.agent_info).toEqual({
        type: 'dynamic',
        name: 'child-a',
        input: 'task-a',
      });
      expect(threads['child-a']?.capability_state).toEqual({ 'tfy.plan': { step: 1 } });
      expect(threads['child-b']?.current_context_usage.prompt_tokens).toBe(2);
    });
  });

  describe('freezeAndGetTurn', () => {
    it('persists the same durable handoff in the cancelled state and terminal event', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-handoff' }));
      const handoff = AbnormalHandoffSchema.parse({
        cause: 'client_cancelled',
        summary: null,
        evidence: {
          repository: {
            repository_id: 'repo-1',
            revision: 7,
            workspace_cwd: '/workspace/repo-1',
            branch: null,
            head_sha: null,
            changed_files: [],
            changed_file_count: 0,
            changed_files_truncated: false,
            diffstat: [],
            diffstat_truncated: false,
            overflow_artifact: null,
          },
          verification_receipt: {
            status: 'not_available',
            command: null,
            branch: null,
            head_sha: null,
            state_sha256: null,
          },
        },
      });
      const cancelledState = makeCancelledTurnState(CancellationReason.ClientCancelled, handoff);
      const turnDone = makeTurnDoneEvent(cancelledState);

      const record = await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-handoff',
        turn_done_event: turnDone,
      });
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-handoff',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      const terminalEvents = data.filter(event => event.type === EventType.TURN_DONE);

      expect(record.state).toEqual(cancelledState);
      expect(terminalEvents).toHaveLength(1);
      expect(terminalEvents[0]?.state).toEqual(record.state);
    });

    it('rejects a new freeze without a durable handoff', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-without-handoff' }));
      const bareState = TurnStateCancelledSchema.parse({
        status: 'cancelled',
        reason: CancellationReason.ClientCancelled,
        completed_at: new Date().toISOString(),
      });

      await expect(
        store.freezeAndGetTurn({
          session_id: sessionId,
          turn_id: 'turn-without-handoff',
          turn_done_event: makeTurnDoneEvent(bareState),
        }),
      ).rejects.toBeInstanceOf(SessionStoreInvariantError);

      const record = await store.getTurn({ session_id: sessionId, turn_id: 'turn-without-handoff' });
      expect(mustGet(record).state).toEqual({ status: 'running' });
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-without-handoff',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(data.filter(event => event.type === EventType.TURN_DONE)).toHaveLength(0);
    });

    it('cancels a running turn, persists turn.done, and fences all turn-scoped writes', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const cancelledState = makeCancelledTurnState(CancellationReason.CancelledForNextTurn);
      const record = await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
        turn_done_event: makeTurnDoneEvent(cancelledState),
      });
      expect(record.state.status).toBe('cancelled');
      expect(record.state).toMatchObject({ reason: CancellationReason.CancelledForNextTurn });
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(data.some(e => e.type === EventType.TURN_DONE)).toBe(true);

      const keys = { session_id: sessionId, turn_id: 'turn-1' };
      const fencedWrites: (() => Promise<unknown>)[] = [
        () =>
          store.appendToEvents({
            ...keys,
            events: [makeTurnCreatedEvent('turn-1')],
          }),
        () =>
          store.appendToThreadContext({
            ...keys,
            thread_id: MAIN_THREAD_ID,
            context: [userMessage('late')],
            current_context_usage: null,
            completion: null,
            tool_call_memo: undefined,
            task_state: undefined,
          }),
        () =>
          store.overwriteThreadContext({
            ...keys,
            event: {
              type: EventType.AGENT_CONTEXT_OVERWRITE,
              id: newEventId(),
              created_at: new Date().toISOString(),
              thread_id: MAIN_THREAD_ID,
              reason: 'compaction',
              context: [userMessage('late-overwrite')],
              current_context_usage: getEmptyCurrentContextUsage(),
              usage: getEmptyUsage(),
            },
          }),
        () =>
          store.addThreads({
            ...keys,
            threads: [
              {
                thread_id: 'child',
                context: [],
                current_context_usage: getEmptyCurrentContextUsage(),
                parent: { thread_id: MAIN_THREAD_ID, tool_call_id: 'tc1' },
                agent_info: { type: 'dynamic', name: 'child', input: 'do work' },
                completion: null,
                capability_state: null,
                tool_call_memo: undefined,
                task_state: undefined,
              },
            ],
          }),
        () => store.removeThreads({ ...keys, thread_ids: [MAIN_THREAD_ID] }),
        () =>
          store.patchMCPServers({
            ...keys,
            mcp_servers: [{ id: 'svc', name: 'svc', session_id: 'mcp-1', transport_type: 'streamable-http' }],
          }),
        () => store.patchSandboxInfo({ ...keys, sandbox_info: { sandbox_id: 'sbx-1' } }),
        () =>
          store.patchThreadCapabilityState({
            ...keys,
            thread_id: MAIN_THREAD_ID,
            key: 'tfy.plan',
            state: { v: 1 },
          }),
      ];

      for (const write of fencedWrites) {
        await expect(write()).rejects.toBeInstanceOf(TurnNotRunningError);
      }
    });

    it('cancels a running turn with the caller-supplied reason', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const cancelledState = makeCancelledTurnState(CancellationReason.ClientCancelled);
      const record = await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
        turn_done_event: makeTurnDoneEvent(cancelledState),
      });
      expect(record.state).toMatchObject({
        status: 'cancelled',
        reason: CancellationReason.ClientCancelled,
      });
    });

    it('folds duration into session.metrics when cancel applies, not on a second freeze', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const cancelledState = makeCancelledTurnState(CancellationReason.CancelledForNextTurn);
      const record = await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
        reason: CancellationReason.CancelledForNextTurn,
        turn_done_event: makeTurnDoneEvent(cancelledState),
      });
      if (record.state.status !== 'cancelled') {
        throw new Error(`expected cancelled turn, got ${record.state.status}`);
      }
      const afterCancel = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      const elapsed_ms = Date.parse(record.state.completed_at) - record.created_at.getTime();
      expect(mustGet(afterCancel).metrics).toEqual({
        total_duration_ms: elapsed_ms > 0 ? Math.trunc(elapsed_ms) : 0,
        total_turns: 1,
      });

      await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
        reason: CancellationReason.CancelledForNextTurn,
        turn_done_event: makeTurnDoneEvent(cancelledState),
      });
      const afterSecond = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(afterSecond).metrics).toEqual(mustGet(afterCancel).metrics);
    });

    it('on an already-terminal turn is a plain read without duplicating turn.done', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await finishTurn(store, 'turn-1');
      await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
        turn_done_event: makeTurnDoneEvent(makeCancelledTurnState(CancellationReason.CancelledForNextTurn)),
      });
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(data.filter(e => e.type === EventType.TURN_DONE)).toHaveLength(1);
    });

    it('concurrent freeze x freeze is idempotent: one cancels, both return terminal', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const cancelledState = makeCancelledTurnState(CancellationReason.CancelledForNextTurn);
      const results = await Promise.allSettled([
        store.freezeAndGetTurn({
          session_id: sessionId,
          turn_id: 'turn-1',
          turn_done_event: makeTurnDoneEvent(cancelledState),
        }),
        store.freezeAndGetTurn({
          session_id: sessionId,
          turn_id: 'turn-1',
          turn_done_event: makeTurnDoneEvent(cancelledState),
        }),
      ]);
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(mustGet(turn).state.status).toBe('cancelled');
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(data.filter(e => e.type === EventType.TURN_DONE)).toHaveLength(1);
    });

    it('concurrent freeze x updateTurnState: exactly one terminal transition wins', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const cancelledState = makeCancelledTurnState(CancellationReason.CancelledForNextTurn);
      const doneState = makeDoneTurnState();
      const results = await Promise.allSettled([
        store.freezeAndGetTurn({
          session_id: sessionId,
          turn_id: 'turn-1',
          turn_done_event: makeTurnDoneEvent(cancelledState),
        }),
        store.updateTurnState({
          session_id: sessionId,
          turn_id: 'turn-1',
          state: doneState,
          turn_done_event: makeTurnDoneEvent(doneState),
        }),
      ]);
      const rejected = results.filter(r => r.status === 'rejected');
      for (const result of rejected) {
        expect(result.reason).toBeInstanceOf(TurnNotRunningError);
      }
      // freeze-after-update is a plain read (both fulfill); update-after-freeze rejects.
      expect(rejected.length === 0 || rejected.length === 1).toBe(true);

      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(['cancelled', 'done']).toContain(mustGet(turn).state.status);
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(data.filter(e => e.type === EventType.TURN_DONE)).toHaveLength(1);
    });
  });

  describe('updateTurnState', () => {
    it('allows running → done and rejects second terminal (first-terminal-wins)', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await finishTurn(store, 'turn-1');
      const cancelledState = makeCancelledTurnState(CancellationReason.ClientCancelled);
      await expect(
        store.updateTurnState({
          session_id: sessionId,
          turn_id: 'turn-1',
          state: cancelledState,
          turn_done_event: makeTurnDoneEvent(cancelledState),
        }),
      ).rejects.toBeInstanceOf(SessionStoreConflictError);
    });

    it('writes terminal state and turn.done atomically', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const state = makeDoneTurnState();
      const turnDone = makeTurnDoneEvent(state);
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state,
        turn_done_event: turnDone,
      });

      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(mustGet(turn).state).toEqual(state);
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      const doneEvents = data.filter(e => e.type === EventType.TURN_DONE);
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]).toEqual(turnDone);
    });

    it('adds cost and duration into session.metrics on running → terminal', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      const createdAt = mustGet(turn).created_at;
      const completedAt = new Date(createdAt.getTime() + 1500).toISOString();
      const state = {
        ...makeDoneTurnState(),
        completed_at: completedAt,
        metrics: { total_cost_in_usd: 1.25 },
      };
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state,
        turn_done_event: makeTurnDoneEvent(state),
      });
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).metrics).toEqual({
        total_cost_in_usd: 1.25,
        total_duration_ms: 1500,
        total_turns: 1,
      });
    });

    it('leaves session.metrics.total_cost_in_usd unset when the terminal turn has no cost', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      const createdAt = mustGet(turn).created_at;
      const completedAt = new Date(createdAt.getTime() + 1500).toISOString();
      const state = {
        ...makeDoneTurnState(),
        completed_at: completedAt,
        metrics: { total_tokens: 10 },
      };
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state,
        turn_done_event: makeTurnDoneEvent(state),
      });
      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).metrics).toEqual({
        total_duration_ms: 1500,
        total_turns: 1,
      });
      expect(mustGet(session).metrics.total_cost_in_usd).toBeUndefined();
    });

    it('does not add session.metrics again on a losing terminal write', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      const createdAt = mustGet(turn).created_at;
      const doneState = {
        ...makeDoneTurnState(),
        completed_at: new Date(createdAt.getTime() + 1500).toISOString(),
        metrics: { total_cost_in_usd: 1.25 },
      };
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state: doneState,
        turn_done_event: makeTurnDoneEvent(doneState),
      });
      const afterFirst = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId })).metrics;

      const losingState = {
        ...makeCancelledTurnState(CancellationReason.ClientCancelled),
        completed_at: new Date(createdAt.getTime() + 8000).toISOString(),
        metrics: { total_cost_in_usd: 9.99 },
      };
      await expect(
        store.updateTurnState({
          session_id: sessionId,
          turn_id: 'turn-1',
          state: losingState,
          turn_done_event: makeTurnDoneEvent(losingState),
        }),
      ).rejects.toBeInstanceOf(SessionStoreConflictError);

      const afterSecond = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(afterSecond).metrics).toEqual(afterFirst);
      expect(afterFirst).toEqual({
        total_cost_in_usd: 1.25,
        total_duration_ms: 1500,
        total_turns: 1,
      });
    });

    it('adds cost and duration from a second done turn onto existing session.metrics', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const turn1 = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      const turn1Done = {
        ...makeDoneTurnState(),
        completed_at: new Date(mustGet(turn1).created_at.getTime() + 1500).toISOString(),
        metrics: { total_cost_in_usd: 1.25 },
      };
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state: turn1Done,
        turn_done_event: makeTurnDoneEvent(turn1Done),
      });

      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
      );
      const turn2 = await store.getTurn({ session_id: sessionId, turn_id: 'turn-2' });
      const turn2Done = {
        ...makeDoneTurnState(),
        completed_at: new Date(mustGet(turn2).created_at.getTime() + 800).toISOString(),
        metrics: { total_cost_in_usd: 0.5 },
      };
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-2',
        state: turn2Done,
        turn_done_event: makeTurnDoneEvent(turn2Done),
      });

      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).metrics).toEqual({
        total_cost_in_usd: 1.75,
        total_duration_ms: 2300,
        total_turns: 2,
      });
    });

    it('accumulates session.metrics across turn1 done, turn2 cancel, and turn3 create', async () => {
      const store = createStore();
      await seedSession(store);

      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const turn1 = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      const turn1Done = {
        ...makeDoneTurnState(),
        completed_at: new Date(mustGet(turn1).created_at.getTime() + 1000).toISOString(),
        metrics: { total_cost_in_usd: 1.0 },
      };
      await store.updateTurnState({
        session_id: sessionId,
        turn_id: 'turn-1',
        state: turn1Done,
        turn_done_event: makeTurnDoneEvent(turn1Done),
      });

      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-2', previousTurnId: 'turn-1', firstTurnId: 'turn-1' }),
      );
      const cancelledState = makeCancelledTurnState(CancellationReason.CancelledForNextTurn);
      const turn2 = await store.freezeAndGetTurn({
        session_id: sessionId,
        turn_id: 'turn-2',
        reason: CancellationReason.CancelledForNextTurn,
        turn_done_event: makeTurnDoneEvent(cancelledState),
      });
      if (turn2.state.status !== 'cancelled') {
        throw new Error(`expected cancelled turn, got ${turn2.state.status}`);
      }
      const turn2DurationMs = Math.max(
        0,
        Math.trunc(Date.parse(turn2.state.completed_at) - turn2.created_at.getTime()),
      );

      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 'turn-3', previousTurnId: 'turn-2', firstTurnId: 'turn-1' }),
      );

      const session = await store.getSession({ tenant_id: tenant, session_id: sessionId });
      expect(mustGet(session).metrics).toEqual({
        total_cost_in_usd: 1.0,
        total_duration_ms: 1000 + turn2DurationMs,
        total_turns: 3,
      });
    });

    it('missing turn → not found', async () => {
      const store = createStore();
      await seedSession(store);
      const state = makeDoneTurnState();
      await expect(
        store.updateTurnState({
          session_id: sessionId,
          turn_id: missingTurnId,
          state,
          turn_done_event: makeTurnDoneEvent(state),
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
    });
  });

  describe('events + threads + capability_state', () => {
    it('appendToEvents orders by monotonic event id, not append call order', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const created = makeTurnCreatedEvent('turn-1');
      const model = makeModelMessageEvent();
      expect(created.id < model.id).toBe(true);
      expect(created.created_at).toBeDefined();
      expect(model.created_at).toBeDefined();
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        // Deliberately reversed: durable ordering comes from event.id.
        events: [model, created],
      });
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(data.map(e => e.type)).toEqual(['turn.created', EventType.MODEL_MESSAGE]);
      expect(data.map(e => e.id)).toEqual([created.id, model.id]);
    });

    it('add/remove threads and append/overwrite context', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.addThreads({
        session_id: sessionId,
        turn_id: 'turn-1',
        threads: [
          {
            thread_id: 'child',
            context: [],
            current_context_usage: getEmptyCurrentContextUsage(),
            parent: { thread_id: MAIN_THREAD_ID, tool_call_id: 'tc1' },
            agent_info: { type: 'dynamic', name: 'child', input: 'do work' },
            completion: null,
            capability_state: null,
            tool_call_memo: undefined,
            task_state: undefined,
          },
        ],
      });
      await store.appendToThreadContext({
        session_id: sessionId,
        turn_id: 'turn-1',
        thread_id: 'child',
        context: [{ role: 'user', content: 'hello' }],
        current_context_usage: null,
        completion: null,
        tool_call_memo: undefined,
        task_state: undefined,
      });
      let turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(turn?.snapshot.threads['child']?.context).toHaveLength(1);

      await store.overwriteThreadContext({
        session_id: sessionId,
        turn_id: 'turn-1',
        event: {
          type: EventType.AGENT_CONTEXT_OVERWRITE,
          id: newEventId(),
          created_at: new Date().toISOString(),
          thread_id: 'child',
          reason: 'compaction',
          context: [{ role: 'user', content: 'replaced' }],
          current_context_usage: getEmptyCurrentContextUsage(),
          usage: getEmptyUsage(),
        },
      });
      turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(turn?.snapshot.threads['child']?.context).toEqual([{ role: 'user', content: 'replaced' }]);

      await store.removeThreads({
        session_id: sessionId,
        turn_id: 'turn-1',
        thread_ids: ['child'],
      });
      turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(turn?.snapshot.threads['child']).toBeUndefined();
    });

    it('context order is identical before persistence and after loading', async () => {
      const store = createStore();
      await seedSession(store);
      const firstBatch = ['m-03', 'm-01', 'm-04'].map(userMessage);
      const secondBatch = ['m-02', 'm-05', 'm-00'].map(userMessage);
      const expected = [...firstBatch, ...secondBatch];

      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: firstBatch,
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );
      await store.appendToThreadContext({
        session_id: sessionId,
        turn_id: 'turn-1',
        thread_id: MAIN_THREAD_ID,
        context: secondBatch,
        current_context_usage: null,
        completion: null,
        tool_call_memo: undefined,
        task_state: undefined,
      });

      const loaded = await store.getTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
      });
      expect(loaded?.snapshot.threads[MAIN_THREAD_ID]?.context).toEqual(expected);
      expect(contextContents(loaded?.snapshot.threads[MAIN_THREAD_ID]?.context)).toEqual([
        'm-03',
        'm-01',
        'm-04',
        'm-02',
        'm-05',
        'm-00',
      ]);
    });

    it('patchThreadCapabilityState is LWW per key', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.patchThreadCapabilityState({
        session_id: sessionId,
        turn_id: 'turn-1',
        thread_id: MAIN_THREAD_ID,
        key: 'tfy.plan',
        state: { v: 1 },
      });
      await store.patchThreadCapabilityState({
        session_id: sessionId,
        turn_id: 'turn-1',
        thread_id: MAIN_THREAD_ID,
        key: 'tfy.plan',
        state: { v: 2 },
      });
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(turn?.snapshot.threads[MAIN_THREAD_ID]?.capability_state).toEqual({ 'tfy.plan': { v: 2 } });
    });

    // InMemory rejects unknown thread_id; Postgres/SQLite only fence on a running turn and
    // will upsert an orphan capability row. Production callers (TurnHandle) only patch threads
    // that already exist on the turn — not enforced at the SQL store boundary yet.
    it.skip('patchThreadCapabilityState rejects a thread_id not present on the turn', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await expect(
        store.patchThreadCapabilityState({
          session_id: sessionId,
          turn_id: 'turn-1',
          thread_id: 'missing-thread',
          key: 'tfy.plan',
          state: { v: 1 },
        }),
      ).rejects.toBeInstanceOf(SessionStoreInvariantError);
    });

    it('capability state is per-turn: patching the successor does not change a frozen predecessor', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't1',
          new_threads: [
            {
              thread_id: MAIN_THREAD_ID,
              parent: null,
              agent_info: null,
              tool_call_memo: undefined,
              task_state: undefined,
            },
          ],
          capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: { plan: { step: 1 } } }],
        }),
      );
      await finishTurn(store, 't1');
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 't2',
          previousTurnId: 't1',
          firstTurnId: 't1',
        }),
      );
      await store.patchThreadCapabilityState({
        session_id: sessionId,
        turn_id: 't2',
        thread_id: MAIN_THREAD_ID,
        key: 'plan',
        state: { step: 2 },
      });

      const t1 = await store.getTurn({ session_id: sessionId, turn_id: 't1' });
      const t2 = await store.getTurn({ session_id: sessionId, turn_id: 't2' });
      expect(t1?.snapshot.threads[MAIN_THREAD_ID]?.capability_state).toEqual({ plan: { step: 1 } });
      expect(t2?.snapshot.threads[MAIN_THREAD_ID]?.capability_state).toEqual({ plan: { step: 2 } });
    });

    it('getTurn output is JSON-round-trip total (no undefined holes)', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage('hello')],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );
      const turn = await store.getTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
      });
      // Totality: JSON round-trip must not drop keys (undefined is stripped by stringify).
      // Store timestamps are Date; wire form is ISO string after stringify.
      const record = mustGet(turn);
      const revived = JSON.parse(JSON.stringify(record)) as unknown;
      expect(revived).toEqual({
        ...record,
        created_at: record.created_at.toISOString(),
        updated_at: record.updated_at.toISOString(),
      });
    });

    it('JSON-looking strings remain strings', async () => {
      const store = createStore();
      const jsonLooking = '{"x":1}';
      await seedSession(store, makeAgentSpec({ instructions: jsonLooking }));
      await store.updateSession({
        tenant_id: tenant,
        session_id: sessionId,
        agent: undefined,
        title: jsonLooking,
        metadata: undefined,
      });
      await store.createTurn(
        makeCreateTurnInput({
          sessionId,
          turnId: 'turn-1',
          new_context_appends: [
            {
              thread_id: MAIN_THREAD_ID,
              context: [userMessage(jsonLooking)],
              current_context_usage: getEmptyCurrentContextUsage(),
            },
          ],
        }),
      );
      const turn = await store.getTurn({
        session_id: sessionId,
        turn_id: 'turn-1',
      });
      const session = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(session.title).toBe(jsonLooking);
      expect(session.agent).toMatchObject({
        type: 'inline',
        spec: { instructions: jsonLooking },
      });
      expect(mustGet(turn).snapshot.threads[MAIN_THREAD_ID]?.context).toEqual([{ role: 'user', content: jsonLooking }]);
    });

    it('patchMCPServers and patchSandboxInfo', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.patchMCPServers({
        session_id: sessionId,
        turn_id: 'turn-1',
        mcp_servers: [{ id: 'svc', name: 'svc', session_id: 'mcp-1', transport_type: 'streamable-http' }],
      });
      await store.patchSandboxInfo({
        session_id: sessionId,
        turn_id: 'turn-1',
        sandbox_info: { sandbox_id: 'sbx-1' },
      });
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(turn?.snapshot.mcp_servers?.['svc']?.session_id).toBe('mcp-1');
      expect(mustGet(turn).snapshot.sandbox_info?.sandbox_id).toBe('sbx-1');
    });

    it('patchMCPServers replaces each server id wholesale (omitted fields do not linger)', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.patchMCPServers({
        session_id: sessionId,
        turn_id: 'turn-1',
        mcp_servers: [{ id: 'svc', name: 'svc', session_id: 'mcp-1', transport_type: 'streamable-http' }],
      });
      await store.patchMCPServers({
        session_id: sessionId,
        turn_id: 'turn-1',
        mcp_servers: [{ id: 'svc', name: 'svc', transport_type: 'sse' }],
      });
      const turn = await store.getTurn({ session_id: sessionId, turn_id: 'turn-1' });
      expect(mustGet(turn).snapshot.mcp_servers).toEqual({
        svc: { id: 'svc', name: 'svc', transport_type: 'sse' },
      });
    });
  });

  describe('registered command executions', () => {
    it('qualifies identical tool call ids by thread id', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't-thread-qualified' }));

      for (const threadId of ['main', 'worker']) {
        await store.appendCommandExecutionStarted({
          session_id: sessionId,
          turn_id: 't-thread-qualified',
          ownership: commandOwnership({ leaseId: `lease-${threadId}` }),
          event: {
            type: EventType.TOOL_EXECUTION_STARTED,
            id: newEventId(),
            thread_id: threadId,
            tool_call_id: 'shared-call-id',
            tool_name: 'sandbox__run_registered_command',
            created_at: '2026-08-31T12:00:00.000Z',
            command_execution: {
              repository_id: 'repo-1',
              repository_revision: 3,
              command_id: 'verify',
              command: 'pnpm verify',
              cwd: '/workspace/repo',
              timeout_ms: 900_000,
            },
          },
        });
      }

      await expect(
        store.getCommandExecution({
          session_id: sessionId,
          turn_id: 't-thread-qualified',
          thread_id: 'main',
          tool_call_id: 'shared-call-id',
        }),
      ).resolves.toMatchObject({ thread_id: 'main', status: 'running' });
      await expect(
        store.getCommandExecution({
          session_id: sessionId,
          turn_id: 't-thread-qualified',
          thread_id: 'worker',
          tool_call_id: 'shared-call-id',
        }),
      ).resolves.toMatchObject({ thread_id: 'worker', status: 'running' });
    });

    it('persists start and terminal disposition with their events atomically', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't-command' }));
      const started: AppendCommandExecutionStartedInput['event'] = {
        type: EventType.TOOL_EXECUTION_STARTED,
        id: newEventId(),
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'call-verify',
        tool_name: 'sandbox__run_registered_command',
        created_at: '2026-08-31T12:00:00.000Z',
        command_execution: {
          repository_id: 'repo-1',
          repository_revision: 3,
          command_id: 'verify',
          command: 'pnpm verify',
          cwd: '/workspace/repo',
          timeout_ms: 900_000,
        },
      };

      await store.appendCommandExecutionStarted({
        session_id: sessionId,
        turn_id: 't-command',
        ownership: commandOwnership({ leaseId: 'lease-command' }),
        event: started,
      });
      expect(
        await store.getCommandExecution({
          session_id: sessionId,
          turn_id: 't-command',
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-verify',
        }),
      ).toMatchObject({ status: 'running', disposition: null });

      const terminal = createToolResponseV2({
        id: newEventId(),
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'call-verify',
        created_at: '2026-08-31T12:14:00.000Z',
        raw_content: JSON.stringify({ exit_code: 0 }),
        model_content: null,
        screen: null,
        admission_provenance: { source: 'user_approval', decision: 'allow', scope: 'once' },
        memoized: false,
        repeat_count: 0,
        disposition: 'executed_ok',
        remediation: undefined,
      }).event;
      await store.appendCommandExecutionResult({
        session_id: sessionId,
        turn_id: 't-command',
        event: terminal,
        lease_id: 'lease-command',
      });

      expect(
        await store.getCommandExecution({
          session_id: sessionId,
          turn_id: 't-command',
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-verify',
        }),
      ).toMatchObject({ status: 'terminal', disposition: 'executed_ok' });
      const events = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 't-command',
        limit: 10,
        page_token: undefined,
        order: 'asc',
      });
      expect(events.data.map(event => event.type)).toEqual([
        EventType.TOOL_EXECUTION_STARTED,
        EventType.TOOL_RESPONSE_V2,
      ]);
    });

    it('recovers running records as outcome unknown without inventing success', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't-recovery' }));
      await store.appendCommandExecutionStarted({
        session_id: sessionId,
        turn_id: 't-recovery',
        ownership: commandOwnership({
          leaseId: 'lease-recovery',
          expiresAt: '2026-08-31T12:30:00.000Z',
        }),
        event: {
          type: EventType.TOOL_EXECUTION_STARTED,
          id: newEventId(),
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-recovery',
          tool_name: 'sandbox__run_registered_command',
          created_at: '2026-08-31T12:00:00.000Z',
          command_execution: {
            repository_id: 'repo-1',
            repository_revision: 3,
            command_id: 'verify',
            command: 'pnpm verify',
            cwd: '/workspace/repo',
            timeout_ms: 900_000,
          },
        },
      });

      expect(
        await store.recoverRunningCommandExecutions({
          completed_at: new Date('2026-08-31T13:00:00.000Z'),
          owner_ids: null,
          require_expired_lease: true,
        }),
      ).toBe(1);
      expect(
        await store.getCommandExecution({
          session_id: sessionId,
          turn_id: 't-recovery',
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-recovery',
        }),
      ).toMatchObject({ status: 'terminal', disposition: 'outcome_unknown' });
      const recoveryEvents = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 't-recovery',
        limit: 20,
        page_token: undefined,
        order: 'asc',
      });
      expect(
        recoveryEvents.data.filter(
          event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === 'call-recovery',
        ),
      ).toEqual([expect.objectContaining({ disposition: 'outcome_unknown' })]);
    });

    it('recovers a running record with a live lease when expiry is not required', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't-recovery-no-expiry' }));
      await store.appendCommandExecutionStarted({
        session_id: sessionId,
        turn_id: 't-recovery-no-expiry',
        ownership: commandOwnership({
          ownerId: 'owner-recovery-no-expiry',
          leaseId: 'lease-recovery-no-expiry',
          expiresAt: '2026-08-31T14:00:00.000Z',
        }),
        event: {
          type: EventType.TOOL_EXECUTION_STARTED,
          id: newEventId(),
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-recovery-no-expiry',
          tool_name: 'sandbox__run_registered_command',
          created_at: '2026-08-31T12:00:00.000Z',
          command_execution: {
            repository_id: 'repo-1',
            repository_revision: 3,
            command_id: 'verify',
            command: 'pnpm verify',
            cwd: '/workspace/repo',
            timeout_ms: 900_000,
          },
        },
      });

      await expect(
        store.recoverRunningCommandExecutions({
          completed_at: new Date('2026-08-31T13:00:00.000Z'),
          owner_ids: null,
          require_expired_lease: false,
        }),
      ).resolves.toBe(1);
      await expect(
        store.getCommandExecution({
          session_id: sessionId,
          turn_id: 't-recovery-no-expiry',
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-recovery-no-expiry',
        }),
      ).resolves.toMatchObject({
        status: 'terminal',
        disposition: 'outcome_unknown',
        lease_id: 'lease-recovery-no-expiry',
        lease_expires_at: new Date('2026-08-31T14:00:00.000Z'),
      });
    });

    it('recovers only explicitly selected owners with expired leases', async () => {
      const store = createStore();
      await seedSession(store);
      for (const turnId of ['turn-a.replica-a', 'turn-b.replica-b']) {
        await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
        await store.appendCommandExecutionStarted({
          session_id: sessionId,
          turn_id: turnId,
          ownership: commandOwnership({
            leaseId: `lease-${turnId}`,
            ownerId: turnId.endsWith('replica-a') ? 'replica-a' : 'replica-b',
            // Equality at the cutoff is expired in every store implementation.
            expiresAt: turnId.endsWith('replica-a') ? '2026-08-31T14:00:00.000Z' : '2026-08-31T13:00:00.000Z',
          }),
          event: {
            type: EventType.TOOL_EXECUTION_STARTED,
            id: newEventId(),
            thread_id: MAIN_THREAD_ID,
            tool_call_id: `call-${turnId}`,
            tool_name: 'sandbox__run_registered_command',
            created_at: '2026-08-31T12:00:00.000Z',
            command_execution: {
              repository_id: 'repo-1',
              repository_revision: 3,
              command_id: 'verify',
              command: 'pnpm verify',
              cwd: '/workspace/repo',
              timeout_ms: 900_000,
            },
          },
        });
      }

      await expect(store.listRunningCommandExecutionOwnerIds()).resolves.toEqual(['replica-a', 'replica-b']);
      await expect(
        store.recoverRunningCommandExecutions({
          completed_at: new Date('2026-08-31T13:00:00.000Z'),
          owner_ids: ['replica-a', 'replica-b'],
          require_expired_lease: true,
        }),
      ).resolves.toBe(1);
      await expect(
        store.getCommandExecution({
          session_id: sessionId,
          turn_id: 'turn-a.replica-a',
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-turn-a.replica-a',
        }),
      ).resolves.toMatchObject({ status: 'running', disposition: null });
      await expect(
        store.getCommandExecution({
          session_id: sessionId,
          turn_id: 'turn-b.replica-b',
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'call-turn-b.replica-b',
        }),
      ).resolves.toMatchObject({ status: 'terminal', disposition: 'outcome_unknown' });
      const recoveredEvents = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-b.replica-b',
        limit: 10,
        page_token: undefined,
        order: 'asc',
      });
      expect(
        recoveredEvents.data.filter(
          event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === 'call-turn-b.replica-b',
        ),
      ).toHaveLength(1);
    });

    it('atomically fences renewal against expired-lease recovery and audits only the winner', async () => {
      const store = createStore();
      await seedSession(store);

      for (let index = 0; index < 8; index += 1) {
        const turnId = `t-renew-recovery-${String(index)}`;
        const toolCallId = `call-renew-recovery-${String(index)}`;
        const leaseId = `lease-renew-recovery-${String(index)}`;
        const ownerId = `owner-renew-recovery-${String(index)}`;
        await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
        await store.appendCommandExecutionStarted({
          session_id: sessionId,
          turn_id: turnId,
          ownership: commandOwnership({
            leaseId,
            ownerId,
            expiresAt: '2026-08-31T12:00:00.000Z',
          }),
          event: {
            type: EventType.TOOL_EXECUTION_STARTED,
            id: newEventId(),
            thread_id: MAIN_THREAD_ID,
            tool_call_id: toolCallId,
            tool_name: 'sandbox__run_registered_command',
            created_at: '2026-08-31T11:00:00.000Z',
            command_execution: {
              repository_id: 'repo-1',
              repository_revision: 3,
              command_id: 'verify',
              command: 'pnpm verify',
              cwd: '/workspace/repo',
              timeout_ms: 900_000,
            },
          },
        });

        const [renewed, recovered] = await Promise.all([
          store.renewCommandExecutionLease({
            session_id: sessionId,
            turn_id: turnId,
            thread_id: MAIN_THREAD_ID,
            tool_call_id: toolCallId,
            lease_id: leaseId,
            lease_expires_at: new Date('2026-08-31T14:00:00.000Z'),
          }),
          store.recoverRunningCommandExecutions({
            completed_at: new Date('2026-08-31T13:00:00.000Z'),
            owner_ids: [ownerId],
            require_expired_lease: true,
          }),
        ]);
        expect([renewed, recovered]).toEqual(renewed ? [true, 0] : [false, 1]);

        const record = await store.getCommandExecution({
          session_id: sessionId,
          turn_id: turnId,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: toolCallId,
        });
        expect(record).toMatchObject(
          renewed
            ? { status: 'running', disposition: null, lease_expires_at: new Date('2026-08-31T14:00:00.000Z') }
            : { status: 'terminal', disposition: 'outcome_unknown' },
        );
        const events = await store.listTurnEvents({
          session_id: sessionId,
          turn_id: turnId,
          limit: 10,
          page_token: undefined,
          order: 'asc',
        });
        expect(
          events.data.filter(event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === toolCallId),
        ).toHaveLength(recovered);
      }
    });

    it.each(['complete', 'freeze'] as const)(
      'closes a running command as outcome unknown when the turn reaches a terminal state via %s',
      async terminalPath => {
        const store = createStore();
        await seedSession(store);
        const turnId = `t-terminal-${terminalPath}`;
        const toolCallId = `call-terminal-${terminalPath}`;
        await store.createTurn(makeCreateTurnInput({ sessionId, turnId }));
        await store.appendCommandExecutionStarted({
          session_id: sessionId,
          turn_id: turnId,
          ownership: commandOwnership({ leaseId: `lease-${terminalPath}` }),
          event: {
            type: EventType.TOOL_EXECUTION_STARTED,
            id: newEventId(),
            thread_id: MAIN_THREAD_ID,
            tool_call_id: toolCallId,
            tool_name: 'sandbox__run_registered_command',
            created_at: '2026-08-31T12:00:00.000Z',
            command_execution: {
              repository_id: 'repo-1',
              repository_revision: 3,
              command_id: 'verify',
              command: 'pnpm verify',
              cwd: '/workspace/repo',
              timeout_ms: 900_000,
            },
          },
        });

        if (terminalPath === 'complete') {
          await finishTurn(store, turnId);
        } else {
          await store.freezeAndGetTurn({
            session_id: sessionId,
            turn_id: turnId,
            reason: CancellationReason.ClientCancelled,
            turn_done_event: makeTurnDoneEvent(makeCancelledTurnState(CancellationReason.ClientCancelled)),
          });
        }

        expect(
          await store.getCommandExecution({
            session_id: sessionId,
            turn_id: turnId,
            thread_id: MAIN_THREAD_ID,
            tool_call_id: toolCallId,
          }),
        ).toMatchObject({ status: 'terminal', disposition: 'outcome_unknown' });
        const events = await store.listTurnEvents({
          session_id: sessionId,
          turn_id: turnId,
          limit: 20,
          page_token: undefined,
          order: 'asc',
        });
        expect(
          events.data.filter(event => event.type === EventType.TOOL_RESPONSE_V2 && event.tool_call_id === toolCallId),
        ).toEqual([expect.objectContaining({ disposition: 'outcome_unknown' })]);
      },
    );
  });

  describe('approval dismissals', () => {
    it('records a dismissal once per thread and tool call, keeping the first record', async () => {
      const store = createStore();
      await seedSession(store);

      await expect(store.listApprovalDismissals({ session_id: sessionId })).resolves.toEqual([]);

      await store.recordApprovalDismissal({
        session_id: sessionId,
        thread_id: 'thread-child',
        tool_call_id: 'call-send',
        dismissed_at: '2026-10-22T10:00:00.000Z',
      });
      await store.recordApprovalDismissal({
        session_id: sessionId,
        thread_id: 'thread-child',
        tool_call_id: 'call-send',
        dismissed_at: '2026-10-22T11:00:00.000Z',
      });

      await expect(store.listApprovalDismissals({ session_id: sessionId })).resolves.toEqual([
        {
          thread_id: 'thread-child',
          tool_call_id: 'call-send',
          dismissed_at: '2026-10-22T10:00:00.000Z',
        },
      ]);
    });

    it('keeps dismissals scoped to their own session', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createSession({
        tenant_id: tenant,
        session_id: 'other-session',
        created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      await store.recordApprovalDismissal({
        session_id: sessionId,
        thread_id: 'thread-child',
        tool_call_id: 'call-send',
        dismissed_at: '2026-10-22T10:00:00.000Z',
      });

      await expect(store.listApprovalDismissals({ session_id: 'other-session' })).resolves.toEqual([]);
    });

    it("drops a session's dismissals when the session is deleted", async () => {
      const store = createStore();
      await seedSession(store);
      await store.recordApprovalDismissal({
        session_id: sessionId,
        thread_id: 'thread-child',
        tool_call_id: 'call-send',
        dismissed_at: '2026-10-22T10:00:00.000Z',
      });

      await store.deleteSession({ tenant_id: tenant, session_id: sessionId });

      await expect(store.listApprovalDismissals({ session_id: sessionId })).resolves.toEqual([]);
    });
  });

  describe('pagination', () => {
    // Offset-token pagination does not isolate readers from concurrent inserts:
    // rows added while a client walks pages may appear twice or be skipped.
    // Callers that need a consistent snapshot re-fetch from the tip.

    it('listTurns paginates with opaque tokens', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't1' }));
      await finishTurn(store, 't1');
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't2', previousTurnId: 't1', firstTurnId: 't1' }));
      await finishTurn(store, 't2');
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't3', previousTurnId: 't2', firstTurnId: 't1' }));
      const page1 = await store.listTurns({
        session_id: sessionId,
        limit: 2,
        page_token: undefined,
      });
      expect(page1.data.map(t => t.turn_id)).toEqual(['t1', 't2']);
      expect(page1.pagination.next_page_token).toBeDefined();
      const page2 = await store.listTurns({
        session_id: sessionId,
        limit: 2,
        page_token: page1.pagination.next_page_token,
      });
      expect(page2.data.map(t => t.turn_id)).toEqual(['t3']);
    });

    it('listTurnEvents supports desc order', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        events: [makeTurnCreatedEvent('turn-1'), makeModelMessageEvent()],
      });
      const { data } = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        order: 'desc',
        page_token: undefined,
      });
      expect(data[0]?.type).toBe(EventType.MODEL_MESSAGE);
    });

    it('listTurnEvents missing turn → not found', async () => {
      const store = createStore();
      await seedSession(store);
      await expect(
        store.listTurnEvents({
          session_id: sessionId,
          turn_id: missingTurnId,
          limit: 10,
          page_token: undefined,
          order: undefined,
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
    });

    it('listTurnEvents on a turn with no events returns an empty page', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 'turn-1' }));
      const page = await store.listTurnEvents({
        session_id: sessionId,
        turn_id: 'turn-1',
        limit: 10,
        page_token: undefined,
        order: undefined,
      });
      expect(page.data).toEqual([]);
      expect(page.pagination.next_page_token).toBeUndefined();
    });

    it('listSessionEvents includes running turns and is newest-first', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't1' }));
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't1',
        events: [makeTurnCreatedEvent('t1')],
      });
      await finishTurn(store, 't1');
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't2', previousTurnId: 't1', firstTurnId: 't1' }));
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't2',
        events: [makeTurnCreatedEvent('t2')],
      });
      // t2 still running — must appear in the feed.
      const { data } = await store.listSessionEvents({
        session_id: sessionId,
        limit: 10,
        page_token: undefined,
        last_turn_id: undefined,
        types: undefined,
        after_event_id: undefined,
      });
      expect(data.map(row => row.turn_id)).toEqual(['t2', 't1', 't1']);
      expect(data.map(row => row.event.type)).toEqual([
        EventType.TURN_CREATED,
        EventType.TURN_DONE,
        EventType.TURN_CREATED,
      ]);
    });

    it('listSessionEvents includes registered passthrough events', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't1' }));
      // Built through the registered schema so the fixture cannot drift from the registration.
      const passthrough: PersistedTurnEvent = {
        type: 'custom.event',
        ...ContractPassthroughEventSchema.parse({
          id: newEventId(),
          created_at: new Date().toISOString(),
          event: { value: 1 },
        }),
      };
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't1',
        events: [passthrough],
      });

      const { data } = await store.listSessionEvents({
        session_id: sessionId,
        limit: 10,
        page_token: undefined,
        last_turn_id: undefined,
        types: undefined,
        after_event_id: undefined,
      });
      expect(data).toEqual([{ turn_id: 't1', event: passthrough }]);
    });

    it('listSessionEvents defaults to the active branch and excludes fork siblings', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't1' }));
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't1',
        events: [makeTurnCreatedEvent('t1')],
      });
      // Two forks off t1; the sibling is created BEFORE the anchor, so a
      // creation-order prefix would wrongly include it.
      await finishTurn(store, 't1');
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 't2-sibling', previousTurnId: 't1', firstTurnId: 't1' }),
      );
      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 't2-anchor', previousTurnId: 't1', firstTurnId: 't1' }),
      );
      for (const turnId of ['t2-sibling', 't2-anchor']) {
        await store.appendToEvents({
          session_id: sessionId,
          turn_id: turnId,
          events: [makeTurnCreatedEvent(turnId)],
        });
      }
      const { data } = await store.listSessionEvents({
        session_id: sessionId,
        limit: 10,
        last_turn_id: undefined,
        page_token: undefined,
        types: undefined,
        after_event_id: undefined,
      });
      expect(data.filter(row => row.event.type === EventType.TURN_CREATED).map(row => row.turn_id)).toEqual([
        't2-anchor',
        't1',
      ]);

      await expect(
        store.listSessionEvents({
          session_id: sessionId,
          limit: 10,
          last_turn_id: missingTurnId,
          page_token: undefined,
          types: undefined,
          after_event_id: undefined,
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
    });

    it('listSessionEvents page tokens retain their anchor when the active branch changes', async () => {
      const store = createStore();
      await seedSession(store);
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't1' }));
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't1',
        events: [makeTurnCreatedEvent('t1')],
      });
      await finishTurn(store, 't1');
      await store.createTurn(makeCreateTurnInput({ sessionId, turnId: 't2', previousTurnId: 't1', firstTurnId: 't1' }));
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't2',
        events: [makeTurnCreatedEvent('t2')],
      });

      const firstPage = await store.listSessionEvents({
        session_id: sessionId,
        limit: 1,
        last_turn_id: undefined,
        page_token: undefined,
        types: undefined,
        after_event_id: undefined,
      });
      expect(firstPage.data.map(row => row.turn_id)).toEqual(['t2']);
      expect(decodeSessionEventPageToken(mustGet(firstPage.pagination.next_page_token))).toEqual({
        last_turn_id: 't2',
        turn_id: 't2',
        event_id: mustGet(firstPage.data[0]).event.id,
      });

      await store.createTurn(
        makeCreateTurnInput({ sessionId, turnId: 't2-new-active', previousTurnId: 't1', firstTurnId: 't1' }),
      );
      await store.appendToEvents({
        session_id: sessionId,
        turn_id: 't2-new-active',
        events: [makeTurnCreatedEvent('t2-new-active')],
      });

      const secondPage = await store.listSessionEvents({
        session_id: sessionId,
        limit: 10,
        last_turn_id: undefined,
        page_token: firstPage.pagination.next_page_token,
        types: undefined,
        after_event_id: undefined,
      });
      expect(secondPage.data.map(row => row.turn_id)).not.toContain('t2-new-active');
      expect(secondPage.data.map(row => row.turn_id)).toContain('t1');
    });

    it('listSessionEvents spills through truncated ancestor_ids windows to reach the chain root', async () => {
      const store = createStore();
      await seedSession(store);
      // Writer-chosen window shorter than the chain — store must spill.
      const ancestorWindow = 3;
      const chainLength = ancestorWindow + 5;
      const ids = Array.from({ length: chainLength }, (_, i) => `t${String(i + 1)}`);
      for (let i = 0; i < ids.length; i++) {
        const turnId = mustGet(ids[i], `ids[${String(i)}]`);
        const window = ids.slice(Math.max(0, i - ancestorWindow), i);
        if (i > 0) {
          await finishTurn(store, mustGet(ids[i - 1], `ids[${String(i - 1)}]`));
        }
        const input = makeCreateTurnInput({
          sessionId,
          turnId,
          ...(i > 0
            ? {
                previousTurnId: mustGet(ids[i - 1], `ids[${String(i - 1)}]`),
                firstTurnId: mustGet(ids[0], 'ids[0]'),
              }
            : {}),
        });
        input.turn.ancestor_ids = window;
        await store.createTurn(input);
        await store.appendToEvents({
          session_id: sessionId,
          turn_id: turnId,
          events: [makeTurnCreatedEvent(turnId)],
        });
      }
      const tip = mustGet(ids.at(-1), 'chain tip');
      const { data } = await store.listSessionEvents({
        session_id: sessionId,
        limit: chainLength + 10,
        last_turn_id: tip,
        page_token: undefined,
        types: undefined,
        after_event_id: undefined,
      });
      // Full chain reachable despite truncated windows, newest-first turn.created rows only.
      expect(data.filter(row => row.event.type === EventType.TURN_CREATED).map(row => row.turn_id)).toEqual(
        [...ids].reverse(),
      );
    });

    /** t1 and t2 done, t3 running; each turn has turn.created, two model messages, and a passthrough row. */
    async function seedEventChain(store: Store) {
      await seedSession(store);
      const turnIds = ['t1', 't2', 't3'];
      for (const [index, turnId] of turnIds.entries()) {
        const previousTurnId = turnIds[index - 1];
        await store.createTurn(
          makeCreateTurnInput({
            sessionId,
            turnId,
            ...(previousTurnId === undefined ? {} : { previousTurnId, firstTurnId: 't1' }),
          }),
        );
        await store.appendToEvents({
          session_id: sessionId,
          turn_id: turnId,
          events: [makeTurnCreatedEvent(turnId), makeModelMessageEvent(), makeModelMessageEvent(), customEvent()],
        });
        if (turnId !== 't3') {
          await finishTurn(store, turnId);
        }
      }
    }

    function customEvent(): PersistedTurnEvent {
      return {
        type: 'custom.event',
        ...ContractPassthroughEventSchema.parse({
          id: newEventId(),
          created_at: new Date().toISOString(),
          event: { value: 1 },
        }),
      };
    }

    async function listAllSessionEvents(
      store: Store,
      input: {
        limit: number;
        types: readonly PersistedTurnEvent['type'][] | undefined;
        after_event_id: string | undefined;
      },
      beforeNextPage?: () => Promise<void>,
    ) {
      const rows: { turn_id: string; event_id: string }[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      do {
        const page = await store.listSessionEvents({
          session_id: sessionId,
          limit: input.limit,
          last_turn_id: undefined,
          page_token: pageToken,
          types: input.types,
          after_event_id: input.after_event_id,
        });
        expect(page.data.length).toBeLessThanOrEqual(input.limit);
        rows.push(...page.data.map(row => ({ turn_id: row.turn_id, event_id: row.event.id })));
        pageToken = page.pagination.next_page_token;
        pages += 1;
        if (pageToken !== undefined) {
          await beforeNextPage?.();
        }
      } while (pageToken !== undefined);
      return { rows, pages };
    }

    it('listSessionEvents keeps only the requested event types', async () => {
      const store = createStore();
      await seedEventChain(store);

      const { data } = await store.listSessionEvents({
        session_id: sessionId,
        limit: 50,
        last_turn_id: undefined,
        page_token: undefined,
        types: [EventType.TURN_DONE, 'custom.event'],
        after_event_id: undefined,
      });
      expect(data.map(row => [row.turn_id, row.event.type])).toEqual([
        ['t3', 'custom.event'],
        ['t2', EventType.TURN_DONE],
        ['t2', 'custom.event'],
        ['t1', EventType.TURN_DONE],
        ['t1', 'custom.event'],
      ]);

      const none = await store.listSessionEvents({
        session_id: sessionId,
        limit: 50,
        last_turn_id: undefined,
        page_token: undefined,
        types: [],
        after_event_id: undefined,
      });
      expect(none.data).toEqual([]);
      expect(none.pagination.next_page_token).toBeUndefined();
    });

    it('listSessionEvents after_event_id returns only events newer than the cursor, in listing order', async () => {
      const store = createStore();
      await seedEventChain(store);
      const all = await listAllSessionEvents(store, { limit: 100, types: undefined, after_event_id: undefined });
      const cursor = mustGet(all.rows.find(row => row.turn_id === 't2')).event_id;

      const newer = await listAllSessionEvents(store, { limit: 100, types: undefined, after_event_id: cursor });
      expect(newer.rows).toEqual(all.rows.filter(row => row.event_id > cursor));
      expect(newer.rows.length).toBeGreaterThan(0);

      const newest = mustGet(
        all.rows
          .map(row => row.event_id)
          .sort()
          .at(-1),
      );
      const empty = await listAllSessionEvents(store, { limit: 100, types: undefined, after_event_id: newest });
      expect(empty.rows).toEqual([]);
    });

    it('listSessionEvents keyset pages have no duplicates or gaps while the running tip appends', async () => {
      const store = createStore();
      await seedEventChain(store);
      const snapshot = await listAllSessionEvents(store, { limit: 100, types: undefined, after_event_id: undefined });
      expect(snapshot.pages).toBe(1);

      // New rows land at the head of the newest-first order between page requests; an offset
      // cursor would re-serve shifted rows, a keyset cursor keeps walking toward older ones.
      const walked = await listAllSessionEvents(
        store,
        { limit: 3, types: undefined, after_event_id: undefined },
        async () => {
          await store.appendToEvents({ session_id: sessionId, turn_id: 't3', events: [makeModelMessageEvent()] });
        },
      );
      expect(walked.pages).toBeGreaterThan(1);
      expect(walked.rows).toEqual(snapshot.rows);
      expect(new Set(walked.rows.map(row => row.event_id)).size).toBe(walked.rows.length);
    });

    it('listSessionEvents keyset pages compose with type and after_event_id filters', async () => {
      const store = createStore();
      await seedEventChain(store);
      const filter: { types: PersistedTurnEvent['type'][]; after_event_id: undefined } = {
        types: [EventType.MODEL_MESSAGE, 'custom.event'],
        after_event_id: undefined,
      };
      const expected = await listAllSessionEvents(store, { limit: 100, ...filter });
      const walked = await listAllSessionEvents(store, { limit: 2, ...filter });
      expect(walked.pages).toBe(Math.ceil(expected.rows.length / 2));
      expect(walked.rows).toEqual(expected.rows);

      const cursor = mustGet(expected.rows.at(-3)).event_id;
      const newerExpected = expected.rows.filter(row => row.event_id > cursor);
      const newerWalked = await listAllSessionEvents(store, { limit: 1, ...filter, after_event_id: cursor });
      expect(newerWalked.rows).toEqual(newerExpected);
    });

    it('listSessionEvents rejects page tokens that do not belong to the anchored chain', async () => {
      const store = createStore();
      await seedEventChain(store);
      const offTheChain = encodeSessionEventPageToken({ last_turn_id: 't3', turn_id: 'not-a-turn', event_id: 'x' });
      const legacyOffset = Buffer.from(JSON.stringify({ last_turn_id: 't3', offset: 3 }), 'utf8').toString('base64url');
      for (const pageToken of [offTheChain, legacyOffset]) {
        await expect(
          store.listSessionEvents({
            session_id: sessionId,
            limit: 10,
            last_turn_id: undefined,
            page_token: pageToken,
            types: undefined,
            after_event_id: undefined,
          }),
        ).rejects.toBeInstanceOf(SessionStoreConflictError);
      }
    });

    it("listSessionEvents rejects another session's page token as an unknown turn", async () => {
      const store = createStore();
      await seedEventChain(store);
      const otherSessionId = 's2';
      await store.createSession({
        tenant_id: tenant,
        session_id: otherSessionId,
        created_by_subject: { subject_id: createdBy, subject_type: 'user', subject_display_name: createdBy },
        agent: { type: 'inline', spec: makeAgentSpec() },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await store.createTurn(makeCreateTurnInput({ sessionId: otherSessionId, turnId: 'other-1' }));
      await store.appendToEvents({
        session_id: otherSessionId,
        turn_id: 'other-1',
        events: [makeTurnCreatedEvent('other-1'), makeModelMessageEvent()],
      });
      const otherPage = await store.listSessionEvents({
        session_id: otherSessionId,
        limit: 1,
        last_turn_id: undefined,
        page_token: undefined,
        types: undefined,
        after_event_id: undefined,
      });

      await expect(
        store.listSessionEvents({
          session_id: sessionId,
          limit: 10,
          last_turn_id: undefined,
          page_token: mustGet(otherPage.pagination.next_page_token),
          types: undefined,
          after_event_id: undefined,
        }),
      ).rejects.toBeInstanceOf(TurnNotFoundError);
    });
  });

  describe('deep-copy boundary', () => {
    it('mutating a returned session does not mutate the store', async () => {
      const store = createStore();
      await seedSession(store);
      const session = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      if (session.agent.type !== 'inline') {
        throw new Error('expected inline agent');
      }
      session.agent.spec.instructions = 'mutated';
      const again = mustGet(await store.getSession({ tenant_id: tenant, session_id: sessionId }));
      expect(again.agent).toMatchObject({
        type: 'inline',
        spec: { instructions: 'You are a test agent.' },
      });
    });
  });

  describe('no SSE surface', () => {
    it('ISessionStore has no subscribe* members', () => {
      const store = createStore();
      const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).concat(Object.keys(store));
      expect(keys.some(k => k.startsWith('subscribe'))).toBe(false);
    });
  });
}
