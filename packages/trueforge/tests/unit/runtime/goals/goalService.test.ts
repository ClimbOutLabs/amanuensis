import { runManualCheck, type GoalSourceRead, type GoalSourceReader } from '../../../../src/runtime/goals/goalCheck';
import {
  createGoalService,
  GoalNotFoundError,
  GoalSetupChangedError,
  GoalStateError,
  type GoalService,
} from '../../../../src/runtime/goals/goalService';
import type { GoalRecord } from '../../../../src/runtime/goals/goalStorePort';
import {
  AGENT_ID,
  CATERING_QUOTE_READ,
  FakeAgentStore,
  FakeSkillStore,
  FIXED_NOW,
  FixtureSourceReader,
  fundraiserDraft,
  fundraiserManifest,
  otherActor,
  OWNER_SUBJECT_ID,
  ownerActor,
  TENANT_ID,
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

/** A reader over a small invented document world a test defines for itself. */
class MapSourceReader implements GoalSourceReader {
  readonly askedFor: string[] = [];
  readonly #world: Map<string, GoalSourceRead>;

  constructor(world: Record<string, GoalSourceRead>) {
    this.#world = new Map(Object.entries(world));
  }

  async read(input: { goal: GoalRecord; source: { source_ref: string } }): Promise<GoalSourceRead | undefined> {
    await Promise.resolve();
    this.askedFor.push(input.source.source_ref);
    return this.#world.get(input.source.source_ref);
  }
}

describe('goal service', () => {
  it('carries the fundraiser from draft to a check that records the venue evidence, then the confirmed venue names the next step', async () => {
    const { store, service } = setup();
    const { actor, draft, preview, activated } = await activatedGoal(service);

    // The draft starts with the venue and volunteers ready, the equipment
    // waiting on the venue, and one appended step at the end: no composed
    // step carries the "in writing" part of the first criterion, so the
    // coverage rule appends that criterion as a step of its own.
    expect(draft.goal.lifecycle).toBe('draft');
    expect(draft.steps.map(step => step.status)).toEqual(['ready', 'planned', 'ready', 'ready']);

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

    // Check now reads the selected sources and records what it found. The host
    // records evidence only and never marks a step verified, so the venue step
    // keeps its ready status and the equipment step stays blocked behind it.
    const reader = new FixtureSourceReader();
    const check = await runManualCheck({
      service: restarted,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: reader,
    });
    expect(check.cycle.outcome).toBe('completed');
    expect(check.cycle.outcome_detail).toBe('Recorded 2 new sources.');
    expect(check.new_evidence).toHaveLength(2);

    const venueStep = check.steps.find(step => step.description === 'Confirm the venue');
    const venueEvidence = check.new_evidence.find(evidence => evidence.source_ref === 'venue-letter');
    expect(venueEvidence).toBeDefined();
    expect(venueStep?.status).toBe('ready');
    expect(venueStep?.evidence_ids).toEqual([venueEvidence?.evidence_id]);
    expect(check.steps.find(step => step.description === 'Book the equipment')?.status).toBe('planned');
    expect(check.next_step?.description).toBe('Confirm the venue');

    // The check is on the goal's history.
    const events = await restarted.listEvents(actor, draft.goal.goal_id, { limit: undefined, page_token: undefined });
    expect(events.data.map(event => event.event_type)).toContain('goal_check_finished');

    // The owner confirms the venue step on the evidence the check recorded.
    if (venueStep === undefined) {
      throw new Error('The venue step is missing from the check result.');
    }
    await store.updateStep({
      tenant_id: TENANT_ID,
      created_by: OWNER_SUBJECT_ID,
      goal_id: draft.goal.goal_id,
      step_id: venueStep.step_id,
      status: 'owner_confirmed',
    });

    // A second check at the same source revisions finds nothing new, and the
    // confirmed venue unblocks the equipment step, which becomes the next step.
    const again = await runManualCheck({
      service: restarted,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: reader,
    });
    expect(again.cycle.outcome).toBe('nothing_changed');
    expect(again.new_evidence).toHaveLength(0);
    expect(again.steps.find(step => step.description === 'Confirm the venue')?.status).toBe('owner_confirmed');
    expect(again.steps.find(step => step.description === 'Book the equipment')?.status).toBe('ready');
    expect(again.next_step?.description).toBe('Book the equipment');
  });

  it('records a declined venue letter as evidence without verifying the step or unblocking its dependent', async () => {
    const { service } = setup();
    const { actor, draft } = await activatedGoal(service);
    const reader = new MapSourceReader({
      'venue-letter': {
        content:
          'Booking declined. The community hall cannot host the fundraiser on 15 June. The date is no longer available and the deposit is being returned.',
        source_revision: 'space-revision:4',
        claimed_event_at: '2026-11-18T09:00:00.000Z',
      },
      'catering-quote': CATERING_QUOTE_READ,
    });
    const check = await runManualCheck({ service, actor, goal_id: draft.goal.goal_id, sourceReader: reader });

    // The declining text is recorded as evidence with its excerpt, and that is
    // all the host does with it: the step keeps its status, the dependent step
    // stays blocked, and the cycle reports evidence, never a confirmation.
    const venueEvidence = check.new_evidence.find(evidence => evidence.source_ref === 'venue-letter');
    expect(venueEvidence?.excerpt).toContain('Booking declined');
    expect(check.cycle.outcome_detail).toBe('Recorded 2 new sources.');
    const venueStep = check.steps.find(step => step.description === 'Confirm the venue');
    expect(venueStep?.status).toBe('ready');
    expect(venueStep?.evidence_ids).toEqual([venueEvidence?.evidence_id]);
    expect(check.steps.find(step => step.description === 'Book the equipment')?.status).toBe('planned');
    expect(check.next_step?.description).toBe('Confirm the venue');
  });

  it('keeps a step unverified while its prerequisite is unconfirmed, and keeps its own dependent blocked', async () => {
    const { service } = setup();
    const actor = ownerActor();
    const draft = await service.createDraft(actor, {
      ...fundraiserDraft(),
      selected_sources: [
        { source_kind: 'space', source_ref: 'venue-letter', label: 'Venue letter' },
        { source_kind: 'space', source_ref: 'equipment-quote', label: 'Equipment quote' },
      ],
      steps: [
        {
          description: 'Confirm the venue',
          acceptance_criteria: 'The venue letter confirms the hall for the fundraiser date.',
          source_refs: ['venue-letter'],
        },
        {
          description: 'Book the equipment',
          depends_on_indexes: [0],
          acceptance_criteria: 'The sound and lighting hire is booked.',
          source_refs: ['equipment-quote'],
        },
        {
          description: 'Print the programmes',
          depends_on_indexes: [1],
          acceptance_criteria: 'The programmes are printed and folded.',
        },
      ],
    });
    const preview = await service.previewActivation(actor, draft.goal.goal_id);
    await service.activate(actor, draft.goal.goal_id, {
      expected_revision: preview.goal.revision,
      setup_digest: preview.setup.digest,
    });

    // The venue letter cannot be read, so the venue step stays unconfirmed.
    // The equipment quote reads fine and its step gains the evidence, but the
    // step stays unverified behind its prerequisite, and the programmes step
    // stays blocked behind it.
    const reader = new MapSourceReader({
      'equipment-quote': {
        content: 'Equipment quote: sound and lighting hire for the hall, 300 in total.',
        source_revision: 'space-revision:2',
        claimed_event_at: '2026-11-17T10:00:00.000Z',
      },
    });
    const check = await runManualCheck({ service, actor, goal_id: draft.goal.goal_id, sourceReader: reader });

    expect(check.unread_sources.map(source => source.source_ref)).toEqual(['venue-letter']);
    expect(check.cycle.outcome_detail).toBe('Recorded 1 new source.');
    const equipmentStep = check.steps.find(step => step.description === 'Book the equipment');
    expect(equipmentStep?.evidence_ids).toHaveLength(1);
    expect(equipmentStep?.status).toBe('planned');
    expect(check.steps.find(step => step.description === 'Print the programmes')?.status).toBe('planned');
    expect(check.next_step?.description).toBe('Confirm the venue');
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

  it('confirms a step through the service after a check, unblocking the next step without completing the goal', async () => {
    const { service } = setup();
    const { actor, draft } = await activatedGoal(service);
    const check = await runManualCheck({
      service,
      actor,
      goal_id: draft.goal.goal_id,
      sourceReader: new FixtureSourceReader(),
    });
    const venueStep = check.steps.find(step => step.description === 'Confirm the venue');
    if (venueStep === undefined) {
      throw new Error('The venue step is missing from the check result.');
    }
    // The check attached the venue evidence and nothing more: the venue step
    // is still only ready, and the equipment step is still blocked behind it.
    expect(venueStep.status).toBe('ready');
    expect(venueStep.evidence_ids).toHaveLength(1);
    expect(check.steps.find(step => step.description === 'Book the equipment')?.status).toBe('planned');

    const confirmed = await service.confirmStep(actor, draft.goal.goal_id, venueStep.step_id);
    expect(confirmed.goal.lifecycle).toBe('active');
    expect(confirmed.steps.find(step => step.step_id === venueStep.step_id)?.status).toBe('owner_confirmed');
    expect(confirmed.steps.find(step => step.description === 'Book the equipment')?.status).toBe('ready');
    expect(confirmed.steps.find(step => step.description === 'Confirm the volunteers')?.status).toBe('ready');
    // Confirming one step verifies no other step, and the goal itself stays open.
    expect(confirmed.steps.every(step => step.status !== 'verified')).toBe(true);

    // The confirmation is on the goal's record: who confirmed, which step, and when.
    const events = await service.listEvents(actor, draft.goal.goal_id, { limit: undefined, page_token: undefined });
    const confirmation = events.data.find(event => event.event_type === 'goal_step_confirmed');
    expect(confirmation).toBeDefined();
    expect(confirmation?.actor).toBe(OWNER_SUBJECT_ID);
    expect(confirmation?.payload['step_id']).toBe(venueStep.step_id);
    expect(confirmation?.payload['confirmed_by']).toBe(OWNER_SUBJECT_ID);
    expect(confirmation?.created_at).toBe(FIXED_NOW.toISOString());
  });

  it('refuses to confirm a step twice, a verified step, or a step on a draft or finished goal', async () => {
    const { store, service } = setup();
    const { actor, draft, activated } = await activatedGoal(service);
    const venueStep = draft.steps[0];
    const equipmentStep = draft.steps[1];
    if (venueStep === undefined || equipmentStep === undefined) {
      throw new Error('The fundraiser draft is missing its first steps.');
    }

    // A draft's steps cannot be confirmed before the goal is activated.
    const otherDraft = await service.createDraft(actor, fundraiserDraft());
    const otherFirstStep = otherDraft.steps[0];
    if (otherFirstStep === undefined) {
      throw new Error('The second draft is missing its first step.');
    }
    await expect(service.confirmStep(actor, otherDraft.goal.goal_id, otherFirstStep.step_id)).rejects.toBeInstanceOf(
      GoalStateError,
    );
    await expect(service.confirmStep(actor, otherDraft.goal.goal_id, otherFirstStep.step_id)).rejects.toThrow(
      'still a draft',
    );

    await service.confirmStep(actor, draft.goal.goal_id, venueStep.step_id);
    // A second confirmation of the same step refuses instead of succeeding quietly.
    await expect(service.confirmStep(actor, draft.goal.goal_id, venueStep.step_id)).rejects.toBeInstanceOf(
      GoalStateError,
    );
    await expect(service.confirmStep(actor, draft.goal.goal_id, venueStep.step_id)).rejects.toThrow(
      'already confirmed',
    );

    // A step that is already verified has nothing left to confirm.
    await store.updateStep({
      tenant_id: TENANT_ID,
      created_by: OWNER_SUBJECT_ID,
      goal_id: draft.goal.goal_id,
      step_id: equipmentStep.step_id,
      status: 'verified',
    });
    await expect(service.confirmStep(actor, draft.goal.goal_id, equipmentStep.step_id)).rejects.toBeInstanceOf(
      GoalStateError,
    );
    await expect(service.confirmStep(actor, draft.goal.goal_id, equipmentStep.step_id)).rejects.toThrow(
      'already verified',
    );

    // A finished goal's steps can no longer be confirmed.
    const volunteersStep = draft.steps[2];
    if (volunteersStep === undefined) {
      throw new Error('The fundraiser draft is missing its third step.');
    }
    await service.end(actor, draft.goal.goal_id, { expected_revision: activated.goal.revision });
    await expect(service.confirmStep(actor, draft.goal.goal_id, volunteersStep.step_id)).rejects.toBeInstanceOf(
      GoalStateError,
    );
    await expect(service.confirmStep(actor, draft.goal.goal_id, volunteersStep.step_id)).rejects.toThrow('finished');
  });

  it('hides step confirmation from another owner and refuses a step that is not on the goal', async () => {
    const { service } = setup();
    const { actor, draft } = await activatedGoal(service);
    const venueStep = draft.steps[0];
    if (venueStep === undefined) {
      throw new Error('The fundraiser draft is missing its first step.');
    }
    await expect(service.confirmStep(otherActor(), draft.goal.goal_id, venueStep.step_id)).rejects.toBeInstanceOf(
      GoalNotFoundError,
    );
    await expect(service.confirmStep(actor, draft.goal.goal_id, 'step-not-on-this-goal')).rejects.toBeInstanceOf(
      GoalNotFoundError,
    );
    const after = await service.getGoal(actor, draft.goal.goal_id);
    expect(after.steps.find(step => step.step_id === venueStep.step_id)?.status).toBe('ready');
  });

  it('lets the owner confirm a step while the goal is paused', async () => {
    const { service } = setup();
    const { actor, draft, activated } = await activatedGoal(service);
    await service.pause(actor, draft.goal.goal_id, { expected_revision: activated.goal.revision });
    const venueStep = draft.steps[0];
    if (venueStep === undefined) {
      throw new Error('The fundraiser draft is missing its first step.');
    }
    const confirmed = await service.confirmStep(actor, draft.goal.goal_id, venueStep.step_id);
    expect(confirmed.goal.lifecycle).toBe('paused');
    expect(confirmed.steps.find(step => step.step_id === venueStep.step_id)?.status).toBe('owner_confirmed');
    expect(confirmed.steps.find(step => step.description === 'Book the equipment')?.status).toBe('ready');
  });
});
