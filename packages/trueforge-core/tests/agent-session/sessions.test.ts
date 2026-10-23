import { EventType } from '../../src/agent-session/schemas/events';
import { CancellationReason } from '../../src/agent-session/schemas/turn';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnNotFoundError } from '../../src/agent-session/store/SessionStoreErrors';
import { TurnHandle } from '../../src/agent-session/TurnHandle';
import {
  mintImplementationPlanGrant,
  serializeImplementationPlanGrant,
} from '../../src/core/mcp/implementationPlanGrant';
import {
  makeAgentSpec,
  makeCreateTurnInput,
  makeDoneTurnState,
  makeTestResolver,
  makeTurnDoneEvent,
  mintTestTurnId,
} from './testHelpers';

describe('Sessions / SessionHandle / TurnHandle (storage + createTurn)', () => {
  const tenant = 'tenant-1';

  it('create/get persists metadata', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const created = await sessions.create({
      tenant_id: tenant,
      session_id: 's-meta',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec({ instructions: 'meta' }) },
      metadata: { env: 'test' },
      external_id: null,
    });
    expect(created.metadata).toEqual({ env: 'test' });

    await store.updateSession({
      tenant_id: tenant,
      session_id: 's-meta',
      agent: undefined,
      title: undefined,
      metadata: { env: 'prod' },
    });
    const afterReplace = await sessions.get({ tenant_id: tenant, session_id: 's-meta' });
    expect(afterReplace?.metadata).toEqual({ env: 'prod' });

    await store.updateSession({
      tenant_id: tenant,
      session_id: 's-meta',
      agent: undefined,
      title: 't',
      metadata: undefined,
    });
    const afterOmit = await sessions.get({ tenant_id: tenant, session_id: 's-meta' });
    expect(afterOmit?.record.title).toBe('t');
    expect(afterOmit?.metadata).toEqual({ env: 'prod' });
  });

  it('create/get persists an inline value-agent session', async () => {
    const store = new InMemorySessionStore<{ tag: string }>();
    const sessions = new Sessions<{ tag: string }>({ sessionStore: store });
    const created = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec({ instructions: 'hydrate-me' }) },
      custom: { tag: 'a' },
      external_id: null,
    });
    expect(created.agent).toEqual({
      type: 'inline',
      spec: expect.objectContaining({ instructions: 'hydrate-me' }),
    });
    expect(created.custom).toEqual({ tag: 'a' });
    expect(created.metadata).toEqual({});

    const loaded = await sessions.get({ tenant_id: tenant, session_id: 's1' });
    expect(loaded?.agent).toEqual({
      type: 'inline',
      spec: expect.objectContaining({ instructions: 'hydrate-me' }),
    });
    expect(loaded?.session_id).toBe('s1');
  });

  it('getOrCreateByExternalId creates once and returns the existing row on retry', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const agent = { type: 'inline' as const, spec: makeAgentSpec({ instructions: 'first' }) };

    const first = await sessions.getOrCreateByExternalId({
      tenant_id: tenant,
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent,
      external_id: 'run-1',
    });
    expect(first.created).toBe(true);
    expect(first.session.record.external_id).toBe('run-1');

    const again = await sessions.getOrCreateByExternalId({
      tenant_id: tenant,
      created_by_subject: { subject_id: 'other', subject_type: 'user', subject_display_name: 'other' },
      agent: { type: 'inline', spec: makeAgentSpec({ instructions: 'ignored' }) },
      external_id: 'run-1',
    });
    expect(again.created).toBe(false);
    expect(again.session.session_id).toBe(first.session.session_id);
    expect(again.session.record.created_by_subject.subject_id).toBe('user-1');
    expect(again.session.agent).toEqual({
      type: 'inline',
      spec: expect.objectContaining({ instructions: 'first' }),
    });
  });

  it('getOrCreateByExternalId returns the winner when create loses the unique race', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const agent = { type: 'inline' as const, spec: makeAgentSpec() };

    await sessions.create({
      tenant_id: tenant,
      session_id: 'winner',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent,
      external_id: 'run-1',
    });

    const getByExternalId = jest.spyOn(sessions, 'getByExternalId');
    getByExternalId.mockResolvedValueOnce(undefined);

    const { session, created } = await sessions.getOrCreateByExternalId({
      tenant_id: tenant,
      created_by_subject: { subject_id: 'user-2', subject_type: 'user', subject_display_name: 'user-2' },
      agent,
      external_id: 'run-1',
    });
    expect(created).toBe(false);
    expect(session.session_id).toBe('winner');
  });

  it('run() happy path commits a running turn without executing', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
      update_session_title_if_not_exist: { title: 'From first message', source: 'first_message' },
    });
    expect(turn.state.status).toBe('running');
    expect(turn.input).toHaveLength(1);

    const stored = await store.getTurn({
      session_id: 's1',
      turn_id: turn.id,
    });
    expect(stored?.state.status).toBe('running');
    const sessionRecord = await store.getSession({ tenant_id: tenant, session_id: 's1' });
    expect(sessionRecord?.title).toBe('From first message');
    expect(sessionRecord?.last_turn_id).toBe(turn.id);
  });

  it('never persists serialized implementation-plan grants in legacy approval_grants', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    await sessions.create({
      tenant_id: tenant,
      session_id: 'plan-grant-separation',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: { type: 'inline', spec: makeAgentSpec() },
    });
    store.setSessionRepositoryBindingForTest({
      tenant_id: tenant,
      created_by: 'user-1',
      session_id: 'plan-grant-separation',
      repository_id: 'repository-a',
      workspace_cwd: '/repo',
    });
    const planGrant = mintImplementationPlanGrant({
      tenant_id: tenant,
      created_by: 'user-1',
      session_id: 'plan-grant-separation',
      workspace_cwd: '/repo',
      checkout_id: `sha256:${'1'.repeat(64)}`,
      plan: {
        repository_id: 'repository-a',
        repository_revision: 1,
        branch: 'codex/plan-grants',
        head_sha: 'abcdef012345',
        file_globs: ['packages/core/src/**/*.ts'],
        approach: 'Update the scoped runtime behavior.',
        verify_command_ids: ['core-test'],
      },
    });
    const legacyGrant = '["v3","mcp","github","read_issue"]';
    const approvalTurnId = 'legacy-plan-snapshot';
    await store.createTurn(
      makeCreateTurnInput({
        sessionId: 'plan-grant-separation',
        turnId: approvalTurnId,
        approval_grants: [legacyGrant, serializeImplementationPlanGrant(planGrant)],
      }),
    );
    await store.persistImplementationPlanGrant({ grant: planGrant, turn_id: approvalTurnId });
    const doneState = makeDoneTurnState();
    await store.updateTurnState({
      session_id: 'plan-grant-separation',
      turn_id: approvalTurnId,
      state: doneState,
      turn_done_event: makeTurnDoneEvent(doneState),
    });

    const session = await sessions.get({ tenant_id: tenant, session_id: 'plan-grant-separation' });
    if (session === undefined) {
      throw new Error('expected the session to exist');
    }
    const nextTurnId = mintTestTurnId();
    await session.createTurn({
      turn_id: nextTurnId,
      input: [{ type: EventType.USER_MESSAGE, content: 'Continue.' }],
      previous_turn_id: 'auto',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });

    const persisted = await store.getSession({ tenant_id: tenant, session_id: 'plan-grant-separation' });
    expect(persisted?.approval_grants).toEqual([legacyGrant]);
    await expect(
      store.listImplementationPlanGrants({
        tenant_id: tenant,
        created_by: 'user-1',
        session_id: 'plan-grant-separation',
      }),
    ).resolves.toEqual([planGrant]);
  });

  it('loads turn handles without reading the session', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const created = await session.createTurn({
      turn_id: mintTestTurnId(),
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    const getSession = jest.spyOn(store, 'getSession');

    const direct = await TurnHandle.get({
      store,
      session_id: 's1',
      turn_id: created.id,
    });
    const throughSession = await session.getTurn(created.id);
    const missingDirect = await TurnHandle.get({
      store,
      session_id: 's1',
      turn_id: 'missing-turn',
    });
    const missingThroughSession = await session.getTurn('missing-turn');

    expect(direct?.id).toBe(created.id);
    expect(throughSession?.id).toBe(created.id);
    expect(missingDirect).toBeUndefined();
    expect(missingThroughSession).toBeUndefined();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('freezeTurn cancels a running turn with the given reason', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    const frozen = await session.freezeTurn({
      turn_id: turn.id,
      reason: CancellationReason.ClientCancelled,
    });
    expect(frozen.state).toMatchObject({
      status: 'cancelled',
      reason: CancellationReason.ClientCancelled,
      handoff: {
        cause: 'client_cancelled',
        summary: null,
        evidence: { repository: null, verification_receipt: { status: 'not_available' } },
      },
    });
    const { data: events } = await store.listTurnEvents({
      session_id: session.session_id,
      turn_id: turn.id,
      limit: 10,
      page_token: undefined,
      order: undefined,
    });
    const terminalEvents = events.filter(event => event.type === EventType.TURN_DONE);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.state).toEqual(frozen.state);
    await expect(
      session.freezeTurn({ turn_id: 'missing-turn', reason: CancellationReason.ClientCancelled }),
    ).rejects.toBeInstanceOf(TurnNotFoundError);
  });

  it('custom value vs merge-fn', async () => {
    const store = new InMemorySessionStore<{ tag: string }, { n: number }>();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const t1 = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'one' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver<{ n: number }>(),
      custom: { n: 1 },
    });
    expect(t1.custom).toEqual({ n: 1 });
    for await (const event of t1.stream()) {
      void event;
    }

    const t2 = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'two' }],
      previous_turn_id: 'auto',
      signal: new AbortController().signal,
      resolver: makeTestResolver<{ n: number }>(),
      custom: prev => ({ n: (prev?.n ?? 0) + 10 }),
    });
    expect(t2.custom).toEqual({ n: 11 });
  });

  it('previous_turn_id none creates a new root on a non-empty session', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    const first = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'one' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    for await (const event of first.stream()) {
      void event;
      // drain
    }
    const root2 = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'fresh root' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver(),
    });
    expect(root2.previous_turn_id).toBeNull();
    const sessionRecord = await store.getSession({ tenant_id: tenant, session_id: 's1' });
    expect(sessionRecord?.last_turn_id).toBe(root2.id);
  });

  it('send/validation failure in run() persists no turn', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });
    await expect(
      session.createTurn({
        turn_id: mintTestTurnId(),
        // Mixed batch — rejected by SessionHandle.toSendBatch / orchestrator validation path.
        input: [
          { type: EventType.USER_MESSAGE, content: 'hi' },
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: 'main',
            tool_call_id: 'tc1',
            approval: { status: 'allow' },
          },
        ],
        previous_turn_id: 'none',
        signal: new AbortController().signal,
        resolver: makeTestResolver(),
      }),
    ).rejects.toThrow();
    const turns = await store.listTurns({
      session_id: 's1',
      limit: 10,
      page_token: undefined,
    });
    expect(turns.data).toHaveLength(0);
    const sessionRecord = await store.getSession({ tenant_id: tenant, session_id: 's1' });
    expect(sessionRecord?.last_turn_id).toBeNull();
  });

  it('run() failure closes the resolver; success defers close() to stream()', async () => {
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });

    // Failure path: resources acquired before the throw must be released.
    const closeOnFailure = jest.fn().mockResolvedValue(undefined);
    await expect(
      session.createTurn({
        turn_id: mintTestTurnId(),
        // Mixed batch — rejected after sandbox/thread resolution.
        input: [
          { type: EventType.USER_MESSAGE, content: 'hi' },
          {
            type: EventType.USER_TOOL_APPROVAL,
            thread_id: 'main',
            tool_call_id: 'tc1',
            approval: { status: 'allow' },
          },
        ],
        previous_turn_id: 'none',
        signal: new AbortController().signal,
        resolver: makeTestResolver({ close: closeOnFailure }),
      }),
    ).rejects.toThrow();
    expect(closeOnFailure).toHaveBeenCalledTimes(1);

    // Success path: run() must NOT close — TurnHandle.stream()'s finally owns it.
    const closeOnSuccess = jest.fn().mockResolvedValue(undefined);
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({ close: closeOnSuccess }),
    });
    expect(closeOnSuccess).not.toHaveBeenCalled();
    for await (const event of turn.stream()) {
      void event;
      // drain
    }
    expect(closeOnSuccess).toHaveBeenCalledTimes(1);
  });
});
