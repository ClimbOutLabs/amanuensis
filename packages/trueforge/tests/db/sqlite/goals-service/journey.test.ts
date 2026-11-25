/**
 * The fundraiser journey end to end over the real SQLite goal store, through
 * the adapter the running app uses. The in-memory suites prove the service's
 * rules; this one proves the service's shapes survive the canonical store:
 * the plan's dependencies resolve to stored step ids, the pinned setup reads
 * back after a restart, and evidence read back carries the excerpt and cycle
 * the check recorded.
 */
import { GoalStore } from '../../../../src/db/goalStore';
import { runManualCheck } from '../../../../src/runtime/goals/goalCheck';
import { createGoalService, GoalNotFoundError, GoalStateError } from '../../../../src/runtime/goals/goalService';
import { createGoalStoreAdapter } from '../../../../src/runtime/goals/goalStoreAdapter';
import {
  AGENT_ID,
  FakeAgentStore,
  FakeSkillStore,
  FIXED_NOW,
  FixtureSourceReader,
  fundraiserDraft,
  otherActor,
  OWNER_SUBJECT_ID,
  ownerActor,
} from '../../../unit/runtime/goals/fundraiserFixture';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

function serviceOver(env: SqliteTestDatabase) {
  const store = createGoalStoreAdapter({ store: new GoalStore(env.db), db: env.db });
  const service = createGoalService({
    store,
    agentStore: new FakeAgentStore(),
    skillStore: new FakeSkillStore(),
    now: () => FIXED_NOW,
  });
  return { service, store };
}

describe('the fundraiser journey over the real SQLite goal store', () => {
  let env: SqliteTestDatabase;

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
  });

  afterEach(async () => {
    await env.teardown();
  });

  it('carries the fundraiser from draft to a check that records the venue evidence, then the confirmed venue names the next step', async () => {
    const { service } = serviceOver(env);
    const actor = ownerActor();
    const draft = await service.createDraft(actor, fundraiserDraft());

    expect(draft.goal.lifecycle).toBe('draft');
    expect(draft.goal.revision).toBe(1);
    expect(draft.goal.agent_id).toBe(AGENT_ID);
    expect(draft.goal.persona_id).toBeNull();
    expect(draft.goal.selected_sources.map(source => source.source_ref)).toEqual(['venue-letter', 'catering-quote']);
    // The fourth step is appended by the coverage rule: no composed step
    // carries the "in writing" part of the first criterion, so that
    // criterion becomes a step of its own rather than staying invisible.
    expect(draft.steps.map(step => step.description)).toEqual([
      'Confirm the venue',
      'Book the equipment',
      'Confirm the volunteers',
      'The venue is confirmed in writing',
    ]);
    expect(draft.steps.map(step => step.status)).toEqual(['ready', 'planned', 'ready', 'ready']);

    // The plan's dependencies were plan positions at create time; the stored
    // steps name the venue step's assigned id, and its source refs survived.
    const venueStep = draft.steps[0];
    const equipmentStep = draft.steps[1];
    expect(venueStep).toBeDefined();
    expect(equipmentStep?.depends_on).toEqual([venueStep?.step_id]);
    expect(venueStep?.source_refs).toEqual(['venue-letter']);
    expect(venueStep?.acceptance_criteria).toBe('The venue letter confirms the hall for the fundraiser date.');

    const preview = await service.previewActivation(actor, draft.goal.goal_id);
    const activated = await service.activate(actor, draft.goal.goal_id, {
      expected_revision: preview.goal.revision,
      setup_digest: preview.setup.digest,
    });
    expect(activated.goal.lifecycle).toBe('active');
    expect(activated.goal.pinned_setup?.digest).toBe(preview.setup.digest);
    expect(activated.goal.pinned_agent_id).toBe(AGENT_ID);
    expect(activated.goal.next_check_at).not.toBeNull();

    // The restart leg: a fresh store and service over the same database see
    // the goal as it was left, pin and agent included.
    const restarted = serviceOver(env).service;
    const reloaded = await restarted.getGoal(actor, draft.goal.goal_id);
    expect(reloaded.goal.lifecycle).toBe('active');
    expect(reloaded.goal.agent_id).toBe(AGENT_ID);
    expect(reloaded.goal.pinned_setup?.digest).toBe(preview.setup.digest);
    expect(reloaded.goal.pinned_setup?.spec.instructions).toContain('fundraiser');

    const reader = new FixtureSourceReader();
    const check = await runManualCheck({
      service: restarted,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: reader,
      now: () => FIXED_NOW,
    });
    expect(check.cycle.outcome).toBe('completed');
    expect(check.cycle.outcome_detail).toBe('Recorded 2 new sources.');
    expect(check.new_evidence).toHaveLength(2);

    // The host check records the evidence and links it, and that is all it
    // does to step state: the venue step keeps its ready status, and the
    // equipment step stays blocked behind it.
    const checkedVenueStep = check.steps.find(step => step.description === 'Confirm the venue');
    const venueEvidence = check.new_evidence.find(evidence => evidence.source_ref === 'venue-letter');
    expect(venueEvidence).toBeDefined();
    expect(checkedVenueStep?.status).toBe('ready');
    expect(checkedVenueStep?.evidence_ids).toEqual([venueEvidence?.evidence_id]);
    expect(check.next_step?.description).toBe('Confirm the venue');
    expect(check.steps.find(step => step.description === 'Book the equipment')?.status).toBe('planned');

    // The owner confirms the venue step on the evidence the check recorded.
    // Confirmation is the owner's call; the host check itself never marks a
    // step verified. The confirmed venue unblocks the equipment step at
    // once, and the goal itself stays active.
    if (checkedVenueStep === undefined) {
      throw new Error('The venue step is missing from the check result.');
    }
    const confirmed = await restarted.confirmStep(actor, draft.goal.goal_id, checkedVenueStep.step_id);
    expect(confirmed.goal.lifecycle).toBe('active');
    expect(confirmed.steps.find(step => step.description === 'Confirm the venue')?.status).toBe('owner_confirmed');
    expect(confirmed.steps.find(step => step.description === 'Book the equipment')?.status).toBe('ready');

    // Evidence read back afterwards still knows its cycle and shows what was read.
    const evidence = await restarted.listEvidence(actor, draft.goal.goal_id, {
      limit: undefined,
      page_token: undefined,
    });
    expect(evidence.data).toHaveLength(2);
    const readBackVenue = evidence.data.find(row => row.source_ref === 'venue-letter');
    expect(readBackVenue?.cycle_id).toBe(check.cycle.cycle_id);
    expect(readBackVenue?.excerpt).toContain('the community hall is confirmed');
    expect(readBackVenue?.source_revision).toBe('space-revision:3');

    // The history is in the order it happened.
    const events = await restarted.listEvents(actor, draft.goal.goal_id, { limit: undefined, page_token: undefined });
    const types = events.data.map(event => event.event_type);
    expect(types).toContain('goal_check_finished');
    expect(types).toContain('goal_step_confirmed');
    const confirmation = events.data.find(event => event.event_type === 'goal_step_confirmed');
    expect(confirmation?.actor).toBe(OWNER_SUBJECT_ID);
    expect(confirmation?.payload['step_id']).toBe(checkedVenueStep.step_id);
    expect(confirmation?.payload['confirmed_by']).toBe(OWNER_SUBJECT_ID);
    const sequences = events.data.map(event => event.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));

    // A second check at the same source revisions finds nothing new, and the
    // confirmed venue unblocks the equipment step, which becomes the next step.
    const again = await runManualCheck({
      service: restarted,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: reader,
      now: () => FIXED_NOW,
    });
    expect(again.cycle.outcome).toBe('nothing_changed');
    expect(again.new_evidence).toHaveLength(0);
    expect(again.steps.find(step => step.description === 'Confirm the venue')?.status).toBe('owner_confirmed');
    expect(again.steps.find(step => step.description === 'Book the equipment')?.status).toBe('ready');
    expect(again.next_step?.description).toBe('Book the equipment');
    const evidenceAfter = await restarted.listEvidence(actor, draft.goal.goal_id, {
      limit: undefined,
      page_token: undefined,
    });
    expect(evidenceAfter.data).toHaveLength(2);
  });

  it('keeps another owner from reading or listing the goal', async () => {
    const { service } = serviceOver(env);
    const draft = await service.createDraft(ownerActor(), fundraiserDraft());
    await expect(service.getGoal(otherActor(), draft.goal.goal_id)).rejects.toBeInstanceOf(GoalNotFoundError);
    const list = await service.listGoals(otherActor(), { limit: undefined, page_token: undefined });
    expect(list.data).toHaveLength(0);
  });

  it('lets a draft gain its agent through an update, and refuses that change once active', async () => {
    const { service } = serviceOver(env);
    const actor = ownerActor();
    const draft = await service.createDraft(actor, { ...fundraiserDraft(), agent_id: null });
    expect(draft.goal.agent_id).toBeNull();
    await expect(service.previewActivation(actor, draft.goal.goal_id)).rejects.toBeInstanceOf(GoalStateError);

    const updated = await service.updateGoal(actor, draft.goal.goal_id, {
      expected_revision: draft.goal.revision,
      patch: { agent_id: AGENT_ID },
    });
    expect(updated.goal.agent_id).toBe(AGENT_ID);

    const preview = await service.previewActivation(actor, draft.goal.goal_id);
    const activated = await service.activate(actor, draft.goal.goal_id, {
      expected_revision: preview.goal.revision,
      setup_digest: preview.setup.digest,
    });
    await expect(
      service.updateGoal(actor, draft.goal.goal_id, {
        expected_revision: activated.goal.revision,
        patch: { agent_id: null },
      }),
    ).rejects.toBeInstanceOf(GoalStateError);
  });
});
