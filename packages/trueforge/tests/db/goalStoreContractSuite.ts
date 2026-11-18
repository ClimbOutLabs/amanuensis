import {
  GoalClaimFencedError,
  GoalImportValidationError,
  GoalLifecycleTransitionError,
  GoalNotFoundError,
  GoalRevisionConflictError,
  type CreateGoalInput,
  type GoalStore,
  type IGoalStore,
} from '../../src/db/goalStore';
import type { Goal, GoalPlanStep } from '../../src/schemas/goals';

const TENANT = 'default';
const OWNER = 'fundraiser-organizer';
const OTHER_OWNER = 'someone-else';
const PERSONA = 'fundraiser-persona';

/**
 * The fictional community fundraiser from the Goals brief: a venue milestone
 * and an equipment milestone that depends on it. All data is invented.
 */
function fundraiserGoal(overrides: Partial<CreateGoalInput> = {}): CreateGoalInput {
  return {
    tenant_id: TENANT,
    created_by: OWNER,
    persona_id: PERSONA,
    pinned_agent_id: null,
    pinned_agent_version: null,
    pinned_agent_snapshot: null,
    title: 'Community fundraiser',
    outcome: 'Have the venue, volunteers, and equipment confirmed by 1 June',
    success_criteria: ['Venue confirmed', 'Equipment quote accepted', 'Ten volunteers confirmed'],
    target_at: '2027-06-01T17:00:00.000Z',
    timezone: 'America/New_York',
    lifecycle: 'draft',
    linked_space_id: null,
    execution_policy: { check_frequency: 'daily' },
    notification_policy: { digest: 'short' },
    next_check_at: null,
    ...overrides,
  };
}

const ZERO_USAGE = { model_calls: 0, tool_calls: 0, input_tokens: 0, output_tokens: 0 };

const VENUE_EVIDENCE_INPUT = {
  source_kind: 'document',
  source_ref: 'venue-email-1',
  source_revision: null,
  content_hash: 'hash-venue-email-1',
  observed_at: '2027-05-02T09:00:00.000Z',
  claimed_event_at: null,
  freshness: 'current',
  admission: 'selected_source',
  extraction_method: 'exact_source_values',
};

const STARTED_CYCLE_INPUT = {
  input_revision: 1,
  trigger_ids: ['manual-check'],
  lease: null,
  budgets: { max_tokens: 300000 },
  usage: ZERO_USAGE,
  started_at: '2027-05-02T08:00:00.000Z',
  finished_at: null,
  outcome: null,
  outcome_detail: null,
  next_check_at: null,
};

const VENUE_ACTION_INPUT = {
  cycle_id: null,
  expected_revision: 1,
  preconditions: { step: 'venue' },
  tool_call_ref: null,
  approval_ref: null,
  execution_state: 'proposed',
  receipt_ref: null,
};

export function runGoalStoreContractSuite(getStore: () => IGoalStore | GoalStore): void {
  it('creates a goal at revision 1 and reads it back whole', async () => {
    const store = getStore();
    const created = await store.createGoal(fundraiserGoal());
    expect(created.revision).toBe(1);
    expect(created.lifecycle).toBe('draft');
    expect(created.success_criteria).toEqual([
      'Venue confirmed',
      'Equipment quote accepted',
      'Ten volunteers confirmed',
    ]);
    expect(created.execution_policy).toEqual({ check_frequency: 'daily' });
    expect(await store.getGoal({ tenant_id: TENANT, created_by: OWNER, goal_id: created.goal_id })).toEqual(created);
  });

  it('keeps owner binding on reads: another owner sees nothing', async () => {
    const store = getStore();
    const created = await store.createGoal(fundraiserGoal());
    expect(
      await store.getGoal({ tenant_id: TENANT, created_by: OTHER_OWNER, goal_id: created.goal_id }),
    ).toBeUndefined();
    expect(
      await store.getGoal({ tenant_id: 'other-tenant', created_by: OWNER, goal_id: created.goal_id }),
    ).toBeUndefined();
    const page = await store.listGoals({ tenant_id: TENANT, created_by: OTHER_OWNER, limit: 10 });
    expect(page.data).toEqual([]);
    expect(await store.listSteps({ tenant_id: TENANT, created_by: OTHER_OWNER, goal_id: created.goal_id })).toEqual([]);
    const evidence = await store.listEvidence({
      tenant_id: TENANT,
      created_by: OTHER_OWNER,
      goal_id: created.goal_id,
      limit: 10,
    });
    expect(evidence.data).toEqual([]);
    await expect(
      store.updateGoal({
        tenant_id: TENANT,
        created_by: OTHER_OWNER,
        goal_id: created.goal_id,
        expected_revision: 1,
        patch: { title: 'Taken over' },
      }),
    ).rejects.toBeInstanceOf(GoalNotFoundError);
    expect(await store.getGoal({ tenant_id: TENANT, created_by: OWNER, goal_id: created.goal_id })).toEqual(created);
  });

  it('rejects a stale update and changes nothing', async () => {
    const store = getStore();
    const created = await store.createGoal(fundraiserGoal());
    const updated = await store.updateGoal({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: created.goal_id,
      expected_revision: 1,
      patch: { title: 'Community fundraiser and raffle' },
    });
    expect(updated.revision).toBe(2);
    await expect(
      store.updateGoal({
        tenant_id: TENANT,
        created_by: OWNER,
        goal_id: created.goal_id,
        expected_revision: 1,
        patch: { title: 'Stale write' },
      }),
    ).rejects.toBeInstanceOf(GoalRevisionConflictError);
    const after = await store.getGoal({ tenant_id: TENANT, created_by: OWNER, goal_id: created.goal_id });
    expect(after).toEqual(updated);
  });

  it('refuses lifecycle moves the store does not allow', async () => {
    const store = getStore();
    const created = await store.createGoal(fundraiserGoal());
    await expect(
      store.updateGoal({
        tenant_id: TENANT,
        created_by: OWNER,
        goal_id: created.goal_id,
        expected_revision: 1,
        patch: { lifecycle: 'paused' },
      }),
    ).rejects.toBeInstanceOf(GoalLifecycleTransitionError);
    const ended = await store.updateGoal({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: created.goal_id,
      expected_revision: 1,
      patch: { lifecycle: 'ended' },
    });
    expect(ended.lifecycle).toBe('ended');
    await expect(
      store.updateGoal({
        tenant_id: TENANT,
        created_by: OWNER,
        goal_id: created.goal_id,
        expected_revision: 2,
        patch: { lifecycle: 'completed' },
      }),
    ).rejects.toBeInstanceOf(GoalLifecycleTransitionError);
    const after = await store.getGoal({ tenant_id: TENANT, created_by: OWNER, goal_id: created.goal_id });
    expect(after?.lifecycle).toBe('ended');
    expect(after?.revision).toBe(2);
  });

  it('walks the allowed lifecycle: draft, active, paused, active, completed, active', async () => {
    const store = getStore();
    let goal: Goal = await store.createGoal(fundraiserGoal());
    const move = async (lifecycle: Goal['lifecycle']) => {
      goal = await store.updateGoal({
        tenant_id: TENANT,
        created_by: OWNER,
        goal_id: goal.goal_id,
        expected_revision: goal.revision,
        patch: { lifecycle },
      });
    };
    await move('active');
    await move('paused');
    await move('active');
    await move('completed');
    await move('active');
    expect(goal.lifecycle).toBe('active');
    expect(goal.revision).toBe(6);
  });

  it('stores plan steps with dependencies and updates status under a revision check', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal());
    const venue = await store.addStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      description: 'Confirm the community hall for 15 June',
      depends_on: [],
      status: 'ready',
      acceptance_criteria: ['The hall replies with the date held'],
      evidence_ids: [],
      action_id: null,
    });
    const equipment = await store.addStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      description: 'Get the equipment quote',
      depends_on: [venue.step_id],
      status: 'planned',
      acceptance_criteria: ['A written quote is on file'],
      evidence_ids: [],
      action_id: null,
    });
    expect(equipment.depends_on).toEqual([venue.step_id]);
    const steps = await store.listSteps({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id });
    expect(steps.map(step => step.step_id)).toEqual([venue.step_id, equipment.step_id]);

    const confirmed = await store.updateStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      step_id: venue.step_id,
      expected_revision: 1,
      patch: { status: 'verified' },
    });
    expect(confirmed.status).toBe('verified');
    expect(confirmed.revision).toBe(2);
    await expect(
      store.updateStep({
        tenant_id: TENANT,
        created_by: OWNER,
        goal_id: goal.goal_id,
        step_id: venue.step_id,
        expected_revision: 1,
        patch: { status: 'failed' },
      }),
    ).rejects.toBeInstanceOf(GoalRevisionConflictError);
  });

  it('pages evidence newest first without repeats', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal());
    const add = (ref: string, observedAt: string) =>
      store.addEvidence({
        tenant_id: TENANT,
        created_by: OWNER,
        goal_id: goal.goal_id,
        source_kind: 'document',
        source_ref: ref,
        source_revision: null,
        content_hash: `hash-${ref}`,
        observed_at: observedAt,
        claimed_event_at: null,
        freshness: 'current',
        admission: 'selected_source',
        extraction_method: 'exact_source_values',
      });
    const first = await add('venue-email-1', '2027-05-02T09:00:00.000Z');
    const second = await add('venue-email-2', '2027-05-03T09:00:00.000Z');
    const third = await add('quote-pdf-1', '2027-05-04T09:00:00.000Z');
    const page1 = await store.listEvidence({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id, limit: 2 });
    expect(page1.data.map(item => item.evidence_id)).toEqual([third.evidence_id, second.evidence_id]);
    expect(page1.next_page_token).toBeDefined();
    const page2 = await store.listEvidence({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      limit: 2,
      page_token: page1.next_page_token,
    });
    expect(page2.data.map(item => item.evidence_id)).toEqual([first.evidence_id]);
    expect(page2.next_page_token).toBeUndefined();
  });

  it('appends events in sequence order and pages through them', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal());
    const e1 = await store.appendEvent({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      event_type: 'goal_created',
      actor: 'owner',
      payload: {},
    });
    const e2 = await store.appendEvent({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      event_type: 'goal_activated',
      actor: 'owner',
      payload: { revision: 2 },
    });
    const e3 = await store.appendEvent({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      event_type: 'observation_recorded',
      actor: 'cycle',
      payload: { source_ref: 'venue-email-1' },
    });
    expect([e1.sequence, e2.sequence, e3.sequence]).toEqual([1, 2, 3]);
    const page1 = await store.listEvents({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id, limit: 2 });
    expect(page1.data.map(event => event.sequence)).toEqual([1, 2]);
    const page2 = await store.listEvents({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      limit: 2,
      page_token: page1.next_page_token,
    });
    expect(page2.data.map(event => event.sequence)).toEqual([3]);
    expect(page2.next_page_token).toBeUndefined();
  });

  it('records cycles and actions and reads them back', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal());
    const cycle = await store.recordCycle({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      input_revision: 1,
      trigger_ids: ['manual-check'],
      lease: null,
      budgets: { max_tokens: 300000 },
      usage: ZERO_USAGE,
      started_at: '2027-05-02T08:00:00.000Z',
      finished_at: null,
      outcome: null,
      outcome_detail: null,
      next_check_at: null,
    });
    const finished = await store.updateCycle({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      cycle_id: cycle.cycle_id,
      patch: {
        finished_at: '2027-05-02T08:05:00.000Z',
        outcome: 'completed',
        usage: { model_calls: 2, tool_calls: 3, input_tokens: 1200, output_tokens: 300 },
        next_check_at: '2027-05-03T08:00:00.000Z',
      },
    });
    expect(finished.outcome).toBe('completed');
    expect(finished.usage.input_tokens).toBe(1200);
    const cycles = await store.listCycles({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id, limit: 10 });
    expect(cycles.data).toEqual([finished]);

    const action = await store.recordAction({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      cycle_id: cycle.cycle_id,
      expected_revision: 1,
      preconditions: { step: 'venue' },
      tool_call_ref: null,
      approval_ref: null,
      execution_state: 'proposed',
      receipt_ref: null,
    });
    const approved = await store.updateAction({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      action_id: action.action_id,
      patch: { execution_state: 'approved', approval_ref: 'approval-1' },
    });
    expect(approved.execution_state).toBe('approved');
    expect(approved.approval_ref).toBe('approval-1');
    const actions = await store.listActions({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id, limit: 10 });
    expect(actions.data).toEqual([approved]);
  });

  it('fences a taken-over claim out of committing the next revision', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };

    const first = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 60_000 });
    expect(first?.fencing_token).toBe(1);
    expect(await store.claimGoal({ ...owner, worker_id: 'worker-b', ttl_ms: 60_000 })).toBeUndefined();

    const renewed = await store.renewClaim({ ...owner, fencing_token: 1, ttl_ms: 60_000 });
    expect(renewed?.fencing_token).toBe(1);
    expect(await store.releaseClaim({ ...owner, fencing_token: 1 })).toBe(true);

    const second = await store.claimGoal({ ...owner, worker_id: 'worker-b', ttl_ms: 60_000 });
    expect(second?.fencing_token).toBe(2);

    await expect(
      store.updateGoal({ ...owner, expected_revision: 1, fencing_token: 1, patch: { title: 'Fenced write' } }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    const committed = await store.updateGoal({
      ...owner,
      expected_revision: 1,
      fencing_token: 2,
      patch: { title: 'Claimed write' },
    });
    expect(committed.revision).toBe(2);
    expect(committed.title).toBe('Claimed write');
  });

  it('takes over an expired claim with a higher fencing token', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const first = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 0 });
    expect(first?.fencing_token).toBe(1);
    const second = await store.claimGoal({ ...owner, worker_id: 'worker-b', ttl_ms: 60_000 });
    expect(second?.fencing_token).toBe(2);
    expect(second?.worker_id).toBe('worker-b');
    await expect(
      store.updateGoal({ ...owner, expected_revision: 1, fencing_token: 1, patch: { title: 'Too late' } }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
  });

  /**
   * The takeover interleaving the fencing tests below share: worker A claims
   * with a lease that has already lapsed, then worker B takes the claim over
   * with the higher token. A's token is stale from that moment on.
   */
  async function takenOverClaim(
    store: IGoalStore | GoalStore,
    owner: { tenant_id: string; created_by: string; goal_id: string },
  ): Promise<{ staleToken: number; liveToken: number }> {
    const stale = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 0 });
    if (stale === undefined) {
      throw new Error('Expected worker A to claim the goal');
    }
    const live = await store.claimGoal({ ...owner, worker_id: 'worker-b', ttl_ms: 60_000 });
    if (live === undefined) {
      throw new Error('Expected worker B to take over the claim');
    }
    return { staleToken: stale.fencing_token, liveToken: live.fencing_token };
  }

  it('fences a taken-over claim out of updateGoal, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.updateGoal({ ...owner, expected_revision: 1, fencing_token: staleToken, patch: { title: 'Fenced write' } }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    const after = await store.getGoal(owner);
    expect(after?.revision).toBe(1);
    expect(after?.title).toBe('Community fundraiser');
    const committed = await store.updateGoal({
      ...owner,
      expected_revision: 1,
      fencing_token: liveToken,
      patch: { title: 'Claimed write' },
    });
    expect(committed.revision).toBe(2);
    expect(committed.title).toBe('Claimed write');
  });

  it('fences a taken-over claim out of updateStep, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const step = await store.addStep({
      ...owner,
      description: 'Confirm the community hall for 15 June',
      depends_on: [],
      status: 'ready',
      acceptance_criteria: ['The hall replies with the date held'],
      evidence_ids: [],
      action_id: null,
    });
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.updateStep({
        ...owner,
        step_id: step.step_id,
        expected_revision: 1,
        fencing_token: staleToken,
        patch: { status: 'verified' },
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect(await store.listSteps(owner)).toEqual([step]);
    const committed = await store.updateStep({
      ...owner,
      step_id: step.step_id,
      expected_revision: 1,
      fencing_token: liveToken,
      patch: { status: 'verified' },
    });
    expect(committed.status).toBe('verified');
    expect(committed.revision).toBe(2);
  });

  it('fences a taken-over claim out of addEvidence, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.addEvidence({ ...owner, ...VENUE_EVIDENCE_INPUT, fencing_token: staleToken }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listEvidence({ ...owner, limit: 10 })).data).toEqual([]);
    const committed = await store.addEvidence({ ...owner, ...VENUE_EVIDENCE_INPUT, fencing_token: liveToken });
    expect(committed.source_ref).toBe('venue-email-1');
    expect((await store.listEvidence({ ...owner, limit: 10 })).data).toEqual([committed]);
  });

  it('fences a taken-over claim out of appendEvent, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.appendEvent({
        ...owner,
        event_type: 'observation_recorded',
        actor: 'cycle',
        payload: {},
        fencing_token: staleToken,
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listEvents({ ...owner, limit: 10 })).data).toEqual([]);
    const committed = await store.appendEvent({
      ...owner,
      event_type: 'observation_recorded',
      actor: 'cycle',
      payload: {},
      fencing_token: liveToken,
    });
    expect(committed.sequence).toBe(1);
  });

  it('fences a taken-over claim out of recordCycle, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.recordCycle({ ...owner, ...STARTED_CYCLE_INPUT, fencing_token: staleToken }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listCycles({ ...owner, limit: 10 })).data).toEqual([]);
    const committed = await store.recordCycle({ ...owner, ...STARTED_CYCLE_INPUT, fencing_token: liveToken });
    expect(committed.input_revision).toBe(1);
    expect((await store.listCycles({ ...owner, limit: 10 })).data).toEqual([committed]);
  });

  it('fences a taken-over claim out of updateCycle, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const cycle = await store.recordCycle({ ...owner, ...STARTED_CYCLE_INPUT });
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.updateCycle({
        ...owner,
        cycle_id: cycle.cycle_id,
        fencing_token: staleToken,
        patch: { outcome: 'completed' },
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listCycles({ ...owner, limit: 10 })).data).toEqual([cycle]);
    const committed = await store.updateCycle({
      ...owner,
      cycle_id: cycle.cycle_id,
      fencing_token: liveToken,
      patch: { outcome: 'completed' },
    });
    expect(committed.outcome).toBe('completed');
  });

  it('fences a taken-over claim out of recordAction, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.recordAction({ ...owner, ...VENUE_ACTION_INPUT, fencing_token: staleToken }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listActions({ ...owner, limit: 10 })).data).toEqual([]);
    const committed = await store.recordAction({ ...owner, ...VENUE_ACTION_INPUT, fencing_token: liveToken });
    expect(committed.execution_state).toBe('proposed');
    expect((await store.listActions({ ...owner, limit: 10 })).data).toEqual([committed]);
  });

  it('fences a taken-over claim out of updateAction, and the live claim still commits', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const action = await store.recordAction({ ...owner, ...VENUE_ACTION_INPUT });
    const { staleToken, liveToken } = await takenOverClaim(store, owner);
    await expect(
      store.updateAction({
        ...owner,
        action_id: action.action_id,
        fencing_token: staleToken,
        patch: { execution_state: 'approved' },
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listActions({ ...owner, limit: 10 })).data).toEqual([action]);
    const committed = await store.updateAction({
      ...owner,
      action_id: action.action_id,
      fencing_token: liveToken,
      patch: { execution_state: 'approved', approval_ref: 'approval-1' },
    });
    expect(committed.execution_state).toBe('approved');
    expect(committed.approval_ref).toBe('approval-1');
  });

  it('an owner pause revokes the live claim, and the paused worker is fenced out', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const step = await store.addStep({
      ...owner,
      description: 'Confirm the community hall for 15 June',
      depends_on: [],
      status: 'ready',
      acceptance_criteria: ['The hall replies with the date held'],
      evidence_ids: [],
      action_id: null,
    });
    const claim = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 60_000 });
    if (claim === undefined) {
      throw new Error('Expected worker A to claim the goal');
    }
    const paused = await store.updateGoal({ ...owner, expected_revision: 1, patch: { lifecycle: 'paused' } });
    expect(paused.lifecycle).toBe('paused');
    const after = await store.getClaim(owner);
    expect(after?.fencing_token).toBe(claim.fencing_token);
    expect(after !== undefined && after.expires_at <= new Date().toISOString()).toBe(true);
    await expect(
      store.updateStep({
        ...owner,
        step_id: step.step_id,
        expected_revision: 1,
        fencing_token: claim.fencing_token,
        patch: { status: 'verified' },
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect(await store.listSteps(owner)).toEqual([step]);
  });

  it('an owner end revokes the live claim, and the ended worker is fenced out', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const claim = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 60_000 });
    if (claim === undefined) {
      throw new Error('Expected worker A to claim the goal');
    }
    const ended = await store.updateGoal({ ...owner, expected_revision: 1, patch: { lifecycle: 'ended' } });
    expect(ended.lifecycle).toBe('ended');
    await expect(
      store.appendEvent({
        ...owner,
        event_type: 'observation_recorded',
        actor: 'cycle',
        payload: {},
        fencing_token: claim.fencing_token,
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listEvents({ ...owner, limit: 10 })).data).toEqual([]);
  });

  it('an owner completion revokes the live claim, and the worker is fenced out', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const claim = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 60_000 });
    if (claim === undefined) {
      throw new Error('Expected worker A to claim the goal');
    }
    const completed = await store.updateGoal({ ...owner, expected_revision: 1, patch: { lifecycle: 'completed' } });
    expect(completed.lifecycle).toBe('completed');
    await expect(
      store.recordAction({ ...owner, ...VENUE_ACTION_INPUT, fencing_token: claim.fencing_token }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listActions({ ...owner, limit: 10 })).data).toEqual([]);
  });

  it('refuses writes whose claim lease expired with no takeover', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    const claim = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 0 });
    if (claim === undefined) {
      throw new Error('Expected the claim to succeed');
    }
    await expect(
      store.addEvidence({ ...owner, ...VENUE_EVIDENCE_INPUT, fencing_token: claim.fencing_token }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    await expect(
      store.appendEvent({
        ...owner,
        event_type: 'observation_recorded',
        actor: 'cycle',
        payload: {},
        fencing_token: claim.fencing_token,
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    await expect(
      store.recordAction({ ...owner, ...VENUE_ACTION_INPUT, fencing_token: claim.fencing_token }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    expect((await store.listEvidence({ ...owner, limit: 10 })).data).toEqual([]);
    expect((await store.listEvents({ ...owner, limit: 10 })).data).toEqual([]);
    expect((await store.listActions({ ...owner, limit: 10 })).data).toEqual([]);
  });

  it('stores a wake-up with the update that caused it, once per event key', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    await store.updateGoal({
      ...owner,
      expected_revision: 1,
      patch: { next_check_at: '2027-05-03T08:00:00.000Z' },
      wakeup: { event_key: 'check-due:2027-05-03', kind: 'scheduled_check', payload: {} },
    });
    const again = await store.enqueueWakeup({
      ...owner,
      event_key: 'check-due:2027-05-03',
      kind: 'scheduled_check',
      payload: {},
    });
    expect(again.created).toBe(false);
    const claimed = await store.claimWakeups({ worker_id: 'worker-a', limit: 10, ttl_ms: 60_000 });
    expect(claimed.map(wakeup => wakeup.event_key)).toEqual(['check-due:2027-05-03']);
    expect(claimed[0]?.goal_id).toBe(goal.goal_id);
    expect(await store.claimWakeups({ worker_id: 'worker-b', limit: 10, ttl_ms: 60_000 })).toEqual([]);
    const wakeup = claimed[0];
    if (wakeup === undefined) {
      throw new Error('Expected one claimed wake-up');
    }
    expect(await store.markWakeupDelivered({ wakeup_id: wakeup.wakeup_id, worker_id: 'worker-b' })).toBe(false);
    expect(await store.markWakeupDelivered({ wakeup_id: wakeup.wakeup_id, worker_id: 'worker-a' })).toBe(true);
    expect(await store.claimWakeups({ worker_id: 'worker-a', limit: 10, ttl_ms: 60_000 })).toEqual([]);
  });

  it('exports nothing from an empty store and round-trips a full goal through export and import', async () => {
    const store = getStore();
    const owner = { tenant_id: TENANT, created_by: OWNER };
    expect(await store.exportGoalData(owner)).toEqual({
      goals: [],
      steps: [],
      evidence: [],
      events: [],
      cycles: [],
      actions: [],
    });
    expect(
      await store.importGoalData({
        ...owner,
        bundle: { goals: [], steps: [], evidence: [], events: [], cycles: [], actions: [] },
      }),
    ).toEqual({
      goals_added: 0,
    });

    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const venue = await store.addStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      description: 'Confirm the community hall for 15 June',
      depends_on: [],
      status: 'verified',
      acceptance_criteria: ['The hall replies with the date held'],
      evidence_ids: [],
      action_id: null,
    });
    await store.addStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      description: 'Get the equipment quote',
      depends_on: [venue.step_id],
      status: 'planned',
      acceptance_criteria: ['A written quote is on file'],
      evidence_ids: [],
      action_id: null,
    });
    await store.addEvidence({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      source_kind: 'document',
      source_ref: 'venue-confirmation',
      source_revision: 'v3',
      content_hash: null,
      observed_at: '2027-05-02T09:00:00.000Z',
      claimed_event_at: '2027-05-02T08:30:00.000Z',
      freshness: 'current',
      admission: 'selected_source',
      extraction_method: 'exact_source_values',
    });
    await store.appendEvent({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      event_type: 'goal_activated',
      actor: 'owner',
      payload: { revision: 1 },
    });
    const bundle = await store.exportGoalData(owner);
    expect(bundle.goals).toHaveLength(1);
    expect(bundle.steps).toHaveLength(2);
    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.events).toHaveLength(1);

    expect(await store.importGoalData({ ...owner, bundle })).toEqual({ goals_added: 0 });

    const restored = getStore();
    await restored.deleteGoal({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id });
    expect(await restored.getGoal({ tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id })).toBeUndefined();
    expect(await restored.importGoalData({ ...owner, bundle })).toEqual({ goals_added: 1 });
    expect(await restored.exportGoalData(owner)).toEqual(bundle);
  });

  it('refuses to graft imported children onto a goal another owner holds', async () => {
    const store = getStore();
    const goal_id = 'fundraiser-shared-goal';
    await store.createGoal(fundraiserGoal({ goal_id }));
    const held = await store.getGoal({ tenant_id: TENANT, created_by: OWNER, goal_id });
    if (held === undefined) {
      throw new Error('Expected the created goal to be readable');
    }
    const grafted: GoalPlanStep = {
      step_id: 'grafted-step',
      goal_id,
      description: 'A step planted by another owner',
      depends_on: [],
      status: 'ready',
      acceptance_criteria: [],
      evidence_ids: [],
      action_id: null,
      revision: 1,
      created_at: '2027-05-02T09:00:00.000Z',
      updated_at: '2027-05-02T09:00:00.000Z',
    };
    const result = await store.importGoalData({
      tenant_id: TENANT,
      created_by: OTHER_OWNER,
      bundle: { goals: [held], steps: [grafted], evidence: [], events: [], cycles: [], actions: [] },
    });
    expect(result).toEqual({ goals_added: 0 });
    expect(await store.listSteps({ tenant_id: TENANT, created_by: OWNER, goal_id })).toEqual([]);
    expect(await store.exportGoalData({ tenant_id: TENANT, created_by: OTHER_OWNER })).toEqual({
      goals: [],
      steps: [],
      evidence: [],
      events: [],
      cycles: [],
      actions: [],
    });
  });

  it('refuses an import bundle holding an invalid record and stores nothing', async () => {
    const store = getStore();
    const owner = { tenant_id: TENANT, created_by: OWNER };
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const step = await store.addStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      description: 'Confirm the community hall for 15 June',
      depends_on: [],
      status: 'ready',
      acceptance_criteria: ['The hall replies with the date held'],
      evidence_ids: [],
      action_id: null,
    });
    const bundle = await store.exportGoalData(owner);
    await store.deleteGoal({ ...owner, goal_id: goal.goal_id });
    // Import data reaches the store as parsed JSON, so a record can carry a
    // value the types would never produce. Object.assign is the deliberate
    // seam: it overwrites the status after the type check has passed.
    const corrupted = Object.assign({}, step, { status: 'not_a_real_status' });
    await expect(store.importGoalData({ ...owner, bundle: { ...bundle, steps: [corrupted] } })).rejects.toBeInstanceOf(
      GoalImportValidationError,
    );
    expect(await store.exportGoalData(owner)).toEqual({
      goals: [],
      steps: [],
      evidence: [],
      events: [],
      cycles: [],
      actions: [],
    });
  });

  it('deleting a goal removes its steps, events, claim, and wake-ups with it', async () => {
    const store = getStore();
    const goal = await store.createGoal(fundraiserGoal({ lifecycle: 'active' }));
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id: goal.goal_id };
    await store.addStep({
      tenant_id: TENANT,
      created_by: OWNER,
      goal_id: goal.goal_id,
      description: 'Confirm the community hall for 15 June',
      depends_on: [],
      status: 'ready',
      acceptance_criteria: [],
      evidence_ids: [],
      action_id: null,
    });
    await store.appendEvent({ ...owner, event_type: 'goal_activated', actor: 'owner', payload: {} });
    await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 60_000 });
    await store.enqueueWakeup({ ...owner, event_key: 'check-due:1', kind: 'scheduled_check', payload: {} });
    await store.deleteGoal(owner);
    expect(await store.getGoal(owner)).toBeUndefined();
    expect(await store.listSteps(owner)).toEqual([]);
    expect(await store.getClaim(owner)).toBeUndefined();
    expect(await store.claimWakeups({ worker_id: 'worker-a', limit: 10, ttl_ms: 60_000 })).toEqual([]);
  });

  it('keeps fencing tokens rising across a delete and recreate under the same id', async () => {
    const store = getStore();
    const goal_id = 'fundraiser-recreated-goal';
    const owner = { tenant_id: TENANT, created_by: OWNER, goal_id };
    await store.createGoal(fundraiserGoal({ goal_id, lifecycle: 'active' }));
    const first = await store.claimGoal({ ...owner, worker_id: 'worker-a', ttl_ms: 60_000 });
    if (first === undefined) {
      throw new Error('Expected the first claim to succeed');
    }
    expect(first.fencing_token).toBe(1);
    await store.deleteGoal(owner);
    expect(await store.getGoal(owner)).toBeUndefined();
    await store.createGoal(fundraiserGoal({ goal_id, lifecycle: 'active' }));
    const second = await store.claimGoal({ ...owner, worker_id: 'worker-b', ttl_ms: 60_000 });
    if (second === undefined) {
      throw new Error('Expected the recreated goal to be claimable');
    }
    expect(second.fencing_token).toBeGreaterThan(first.fencing_token);
    await expect(
      store.updateGoal({
        ...owner,
        expected_revision: 1,
        fencing_token: first.fencing_token,
        patch: { title: 'Written by the stale incarnation' },
      }),
    ).rejects.toBeInstanceOf(GoalClaimFencedError);
    const committed = await store.updateGoal({
      ...owner,
      expected_revision: 1,
      fencing_token: second.fencing_token,
      patch: { title: 'Written by the new incarnation' },
    });
    expect(committed.revision).toBe(2);
    expect(committed.title).toBe('Written by the new incarnation');
  });
}
