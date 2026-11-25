/**
 * Regression: a draft's plan must cover the goal's outcome. The chat tool and
 * the API both hand createDraft two independent lists, the criteria and the
 * steps, and a plan that names only some of the criteria leaves the rest
 * invisible to every later check, because checks record evidence against
 * steps only. The service is the one place both entry points share, so the
 * coverage guarantee lives there: a criterion no step represents is appended
 * as a step carrying that criterion.
 */
import { createGoalService, type GoalService } from '../../../../src/runtime/goals/goalService';
import { AGENT_ID, FakeAgentStore, FakeSkillStore, FIXED_NOW, ownerActor } from './fundraiserFixture';
import { InMemoryGoalStore } from './inMemoryGoalStore';

const CRITERIA = [
  'The application form is filled in for both people',
  'The identity documents are copied and current',
  'The fee receipt is in hand',
  'The appointment letters are printed',
  'The bank letter covers the full required window',
  'The insurance certificate names both people',
  'The address proof is dated within the window',
  'The translations cover every foreign document',
  'The photographs meet the size rules',
  'The household register extract is apostilled',
  'The income evidence covers the last full year',
  'The submission checklist is signed',
  'Copies of the whole package are kept',
];

function setup(): GoalService {
  const store = new InMemoryGoalStore(() => FIXED_NOW);
  return createGoalService({
    store,
    agentStore: new FakeAgentStore(),
    skillStore: new FakeSkillStore(),
    now: () => FIXED_NOW,
  });
}

function coveredCriteria(
  criteria: readonly string[],
  steps: readonly { description: string; acceptance_criteria: string }[],
): string[] {
  return criteria.filter(criterion =>
    steps.some(step => step.description === criterion || step.acceptance_criteria === criterion),
  );
}

describe('draft plan coverage', () => {
  it('appends a step for every criterion the given plan leaves out', async () => {
    const service = setup();
    const actor = ownerActor('persona-1');
    const { goal, steps } = await service.createDraft(actor, {
      agent_id: AGENT_ID,
      title: 'Paperwork submission',
      outcome: 'Both applications are submitted complete and on time.',
      success_criteria: CRITERIA,
      target_at: null,
      timezone: 'UTC',
      selected_sources: [],
      steps: [
        {
          description: 'Fill in the application form',
          acceptance_criteria: CRITERIA[0] ?? '',
          source_refs: [],
        },
      ],
    });

    expect(goal.success_criteria).toEqual(CRITERIA);
    // The step the caller composed is kept, first and unchanged.
    expect(steps[0]?.description).toBe('Fill in the application form');
    // Every criterion is carried by some step, so every criterion can gather
    // evidence and be confirmed later.
    expect(coveredCriteria(CRITERIA, steps)).toEqual(CRITERIA);
    expect(steps).toHaveLength(CRITERIA.length);
  });

  it('builds the whole plan from the criteria when no steps are given', async () => {
    const service = setup();
    const actor = ownerActor();
    const criteria = ['The venue is booked', 'The deposit is paid', 'The invitations are sent'];
    const { steps } = await service.createDraft(actor, {
      agent_id: AGENT_ID,
      title: 'Hall booking',
      outcome: 'The hall is booked and paid for.',
      success_criteria: criteria,
      target_at: null,
      timezone: 'UTC',
      selected_sources: [],
      steps: [],
    });
    expect(coveredCriteria(criteria, steps)).toEqual(criteria);
    expect(steps).toHaveLength(criteria.length);
  });

  it('adds nothing when the given plan already covers every criterion', async () => {
    const service = setup();
    const actor = ownerActor();
    const criteria = ['The venue is booked', 'The deposit is paid'];
    const { steps } = await service.createDraft(actor, {
      agent_id: AGENT_ID,
      title: 'Hall booking',
      outcome: 'The hall is booked and paid for.',
      success_criteria: criteria,
      target_at: null,
      timezone: 'UTC',
      selected_sources: [],
      steps: [
        { description: 'Book the venue', acceptance_criteria: 'The venue is booked', source_refs: [] },
        { description: 'Pay the deposit', acceptance_criteria: 'The deposit is paid', source_refs: [] },
      ],
    });
    expect(steps.map(step => step.description)).toEqual(['Book the venue', 'Pay the deposit']);
  });
});
