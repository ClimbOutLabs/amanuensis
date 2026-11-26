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

describe('coverage matching', () => {
  async function draftSteps(
    criteria: readonly string[],
    given: readonly { description: string; acceptance_criteria: string }[],
  ): Promise<readonly { description: string; acceptance_criteria: string }[]> {
    const service = setup();
    const { steps } = await service.createDraft(ownerActor(), {
      agent_id: AGENT_ID,
      title: 'Coverage check',
      outcome: 'The thing is done.',
      success_criteria: criteria,
      target_at: null,
      timezone: 'UTC',
      selected_sources: [],
      steps: given.map(step => ({ ...step, source_refs: [] })),
    });
    return steps;
  }

  // Each pair below was covered by the old half-of-the-words rule, so the
  // criterion got no step of its own and stayed invisible to every check.
  // The step shares a verb, a neighbouring object, or part of the wording,
  // but it does not carry the criterion, so the criterion must be appended.
  const SWALLOWED: readonly { criterion: string; step: string }[] = [
    { criterion: 'The passport is renewed', step: 'Renew the library card' },
    { criterion: 'The license is renewed', step: 'Renew the passport' },
    { criterion: 'The venue is booked', step: 'Pay the venue deposit' },
    { criterion: 'Copies are filed with the office', step: 'File the tax forms at the office' },
    { criterion: 'The hall deposit is refunded in full', step: 'Pay the hall deposit' },
    { criterion: 'No fee is charged', step: 'Charge the fee' },
    { criterion: 'Ana signs the lease', step: 'Ben signs the lease' },
  ];
  for (const { criterion, step } of SWALLOWED) {
    it(`appends "${criterion}" when the only step is "${step}"`, async () => {
      const steps = await draftSteps([criterion], [{ description: step, acceptance_criteria: '' }]);
      expect(steps.map(candidate => candidate.description)).toEqual([step, criterion]);
    });
  }

  // Each pair below shares every fact-carrying word, so a word-membership
  // rule calls the criterion covered. The step states the opposite of the
  // criterion: the parties are swapped, the amount is negated, or the step
  // forbids what the criterion requires. The criterion must stay visible on
  // the plan, so it is appended as its own step.
  const REVERSED: readonly { criterion: string; step: string }[] = [
    { criterion: 'Nora pays Sam 50', step: 'Sam pays Nora 50' },
    { criterion: 'Pay 50', step: 'Pay -50' },
    { criterion: 'The fee is charged', step: 'Do not charge the fee' },
  ];
  for (const { criterion, step } of REVERSED) {
    it(`appends "${criterion}" when the only step is "${step}"`, async () => {
      const steps = await draftSteps([criterion], [{ description: step, acceptance_criteria: '' }]);
      expect(steps.map(candidate => candidate.description)).toEqual([step, criterion]);
    });
  }

  it('appends all three printing criteria when one step prints only the form', async () => {
    const criteria = ['The form is printed', 'The letters are printed', 'The photos are printed'];
    const steps = await draftSteps(criteria, [{ description: 'Print the form', acceptance_criteria: '' }]);
    // The letters and photos are different objects the step never names. The
    // form criterion names the same object and action as the step, but in
    // the opposite order, and word order is part of the match: a step that
    // cannot be read as restating the criterion leaves the criterion
    // appended, where the person can see it on the plan.
    expect(steps.map(step => step.description)).toEqual([
      'Print the form',
      'The form is printed',
      'The letters are printed',
      'The photos are printed',
    ]);
  });

  it('treats fees and fee as the same word, and paid and pay as the same word', async () => {
    const steps = await draftSteps(
      ['The fees are paid'],
      [{ description: 'The fee is paid', acceptance_criteria: '' }],
    );
    expect(steps.map(step => step.description)).toEqual(['The fee is paid']);
  });

  it('treats charged and charge as the same word', async () => {
    const steps = await draftSteps(
      ['The fee is charged'],
      [{ description: 'Fee charge recorded', acceptance_criteria: '' }],
    );
    expect(steps.map(step => step.description)).toEqual(['Fee charge recorded']);
  });
});
