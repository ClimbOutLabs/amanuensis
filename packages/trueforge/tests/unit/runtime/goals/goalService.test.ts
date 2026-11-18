import { runManualCheck } from '../../../../src/runtime/goals/goalCheck';
import {
  createGoalService,
  GoalNotFoundError,
  GoalSetupChangedError,
  GoalStateError,
  type GoalService,
} from '../../../../src/runtime/goals/goalService';
import {
  AGENT_ID,
  FakeAgentStore,
  FakeSkillStore,
  FIXED_NOW,
  FixtureSourceReader,
  fundraiserDraft,
  fundraiserManifest,
  otherActor,
  ownerActor,
} from './fundraiserFixture';
import { InMemoryGoalStore } from './inMemoryGoalStore';

function setup() {
  const store = new InMemoryGoalStore(() => FIXED_NOW);
  const agents = new FakeAgentStore();
  const skills = new FakeSkillStore();
  const service = createGoalService({ store, agentStore: agents, skillStore: skills, now: () => FIXED_NOW });
  return { store, agents, skills, service };
}

async function activatedGoal(service: GoalService) {
  const actor = ownerActor();
  const draft = await service.createDraft(actor, fundraiserDraft());
  const preview = await service.previewActivation(actor, draft.goal.goal_id);
  const activated = await service.activate(actor, draft.goal.goal_id, {
    expected_revision: preview.goal.revision,
    setup_digest: preview.setup.digest,
  });
  return { actor, draft, preview, activated };
}

describe('goal service', () => {
  it('carries the fundraiser from draft to a check that verifies the venue and names the next step', async () => {
    const { store, service } = setup();
    const { actor, draft, preview, activated } = await activatedGoal(service);

    // The draft starts with the venue and volunteers ready, the equipment waiting on the venue.
    expect(draft.goal.lifecycle).toBe('draft');
    expect(draft.steps.map(step => step.status)).toEqual(['ready', 'planned', 'ready']);

    // Activation pins the setup the card showed and starts the daily checks.
    expect(activated.goal.lifecycle).toBe('active');
    expect(activated.goal.pinned_setup?.digest).toBe(preview.setup.digest);
    expect(activated.goal.pinned_setup?.agent_id).toBe(AGENT_ID);
    expect(activated.goal.next_check_at).not.toBeNull();

    // The restart leg: a fresh service over the same store sees the goal as it was left.
    const restarted = createGoalService({
      store,
      agentStore: new FakeAgentStore(),
      skillStore: new FakeSkillStore(),
      now: () => FIXED_NOW,
    });
    const reloaded = await restarted.getGoal(actor, draft.goal.goal_id);
    expect(reloaded.goal.lifecycle).toBe('active');
    expect(reloaded.goal.pinned_setup?.digest).toBe(preview.setup.digest);

    // Check now reads the selected sources and records what it found.
    const reader = new FixtureSourceReader();
    const check = await runManualCheck({
      service: restarted,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: reader,
    });
    expect(check.cycle.outcome).toBe('completed');
    expect(check.new_evidence).toHaveLength(2);

    const venueStep = check.steps.find(step => step.description === 'Confirm the venue');
    const venueEvidence = check.new_evidence.find(evidence => evidence.source_ref === 'venue-letter');
    expect(venueEvidence).toBeDefined();
    expect(venueStep?.status).toBe('verified');
    expect(venueStep?.evidence_ids).toEqual([venueEvidence?.evidence_id]);

    // The equipment step is unblocked by the venue and is the next step the plan shows.
    expect(check.next_step?.description).toBe('Book the equipment');
    expect(check.steps.find(step => step.description === 'Book the equipment')?.status).toBe('ready');

    // The check is on the goal's history.
    const events = await restarted.listEvents(actor, draft.goal.goal_id, { limit: undefined, page_token: undefined });
    expect(events.data.map(event => event.event_type)).toContain('goal_check_finished');

    // A second check at the same source revisions finds nothing new.
    const again = await runManualCheck({
      service: restarted,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: reader,
    });
    expect(again.cycle.outcome).toBe('nothing_changed');
    expect(again.new_evidence).toHaveLength(0);
  });

  it('never reads a document outside the goal selected sources into a check', async () => {
    const { service } = setup();
    const { actor, draft } = await activatedGoal(service);
    const reader = new FixtureSourceReader();
    const check = await runManualCheck({ service, actor, goal_id: draft.goal.goal_id, sourceReader: reader });

    // The sponsor ledger exists in the reader's world, but the goal never selected it:
    // the reader was never asked for it, and no evidence mentions it.
    expect(reader.askedFor).toEqual(['venue-letter', 'catering-quote']);
    expect(check.new_evidence.map(evidence => evidence.source_ref)).not.toContain('sponsor-ledger');
    const evidence = await service.listEvidence(actor, draft.goal.goal_id, { limit: undefined, page_token: undefined });
    expect(evidence.data.map(row => row.source_ref)).not.toContain('sponsor-ledger');
  });

  it('refuses activation when the agent setup changed after the card was shown', async () => {
    const { agents, service } = setup();
    const actor = ownerActor();
    const draft = await service.createDraft(actor, fundraiserDraft());
    const preview = await service.previewActivation(actor, draft.goal.goal_id);

    agents.changeManifest(
      AGENT_ID,
      fundraiserManifest('Help the owner run the fundraiser, and book nothing yourself.'),
    );

    const refusal: unknown = await service
      .activate(actor, draft.goal.goal_id, {
        expected_revision: preview.goal.revision,
        setup_digest: preview.setup.digest,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(GoalSetupChangedError);
    if (refusal instanceof GoalSetupChangedError) {
      // The refusal carries the updated card state, and nothing was activated.
      expect(refusal.current_setup.digest).not.toBe(preview.setup.digest);
      expect(refusal.current_setup.spec.instructions).toContain('book nothing yourself');
    }
    const after = await service.getGoal(actor, draft.goal.goal_id);
    expect(after.goal.lifecycle).toBe('draft');
    expect(after.goal.pinned_setup).toBeNull();
  });

  it('refuses a check on a paused goal', async () => {
    const { service } = setup();
    const { actor, activated } = await activatedGoal(service);
    await service.pause(actor, activated.goal.goal_id, { expected_revision: activated.goal.revision });
    await expect(
      runManualCheck({ service, actor, goal_id: activated.goal.goal_id, sourceReader: new FixtureSourceReader() }),
    ).rejects.toBeInstanceOf(GoalStateError);
    await expect(
      runManualCheck({ service, actor, goal_id: activated.goal.goal_id, sourceReader: new FixtureSourceReader() }),
    ).rejects.toThrow('paused');
  });

  it('keeps another owner from reading or changing the goal', async () => {
    const { service } = setup();
    const { draft } = await activatedGoal(service);
    await expect(service.getGoal(otherActor(), draft.goal.goal_id)).rejects.toBeInstanceOf(GoalNotFoundError);
    await expect(
      service.pause(otherActor(), draft.goal.goal_id, { expected_revision: draft.goal.revision }),
    ).rejects.toBeInstanceOf(GoalNotFoundError);
    const list = await service.listGoals(otherActor(), { limit: undefined, page_token: undefined });
    expect(list.data).toHaveLength(0);
  });

  it('binds a goal made in a persona chat to that persona', async () => {
    const { service } = setup();
    const draft = await service.createDraft(ownerActor('persona-mannie'), fundraiserDraft());
    await expect(service.getGoal(ownerActor('persona-other'), draft.goal.goal_id)).rejects.toBeInstanceOf(
      GoalNotFoundError,
    );
    const visible = await service.getGoal(ownerActor('persona-mannie'), draft.goal.goal_id);
    expect(visible.goal.goal_id).toBe(draft.goal.goal_id);
  });
});
