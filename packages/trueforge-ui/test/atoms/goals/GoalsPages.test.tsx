// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoalDetailPage } from '@/atoms/goals/GoalDetailPage.js';
import { GoalsListPage } from '@/atoms/goals/GoalsListPage.js';
import { GoalsProvider } from '@/goals/GoalsContext.js';
import {
  GoalSetupChangedError,
  type GoalActivationPreview,
  type GoalCheckResult,
  type GoalDetail,
  type GoalEvidence,
  type GoalItem,
  type GoalStep,
  type GoalsApi,
} from '@/goals/types.js';

const shell = {
  openGoals: vi.fn(),
  closeGoals: vi.fn(),
  openSpaces: vi.fn(),
  mode: { status: 'idle' },
};

vi.mock('@/server/ShellModeContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ShellModeContext.js')>()),
  useOptionalShellMode: () => shell,
  useShellMode: () => shell,
}));

vi.mock('@/server/ServerContext.js', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/ServerContext.js')>()),
  useOptionalServer: () => null,
}));

const POLICY = {
  checksPerDay: 1,
  cycleMinutes: 15,
  modelCallLimit: 12,
  toolCallLimit: 40,
  cycleTokenLimit: 300_000,
  dailyTokenAllowance: 1_000_000,
};

const VENUE_SOURCE = {
  sourceKind: 'document',
  sourceRef: 'venue-booking-letter',
  label: 'Venue booking letter',
} as const;

function fundraiserGoal(overrides: Partial<GoalItem>): GoalItem {
  return {
    goalId: 'goal-1',
    title: 'Community fundraiser',
    outcome: 'Hold a community fundraiser with the venue, equipment, and volunteers confirmed',
    successCriteria: ['Venue confirmed in writing', 'Equipment booked'],
    targetAt: '2026-06-20T17:00:00.000Z',
    timezone: 'America/Los_Angeles',
    lifecycle: 'draft',
    revision: 1,
    agentId: 'agent-1',
    selectedSources: [{ ...VENUE_SOURCE }],
    executionPolicy: { ...POLICY },
    notificationPolicy: { digest: true },
    linkedSpaceId: null,
    pinnedSetup: null,
    nextCheckAt: null,
    createdAt: '2026-06-10T16:00:00.000Z',
    updatedAt: '2026-06-10T16:00:00.000Z',
    ...overrides,
  };
}

function venueStep(overrides: Partial<GoalStep>): GoalStep {
  return {
    stepId: 'step-venue',
    goalId: 'goal-1',
    description: 'Confirm the venue',
    dependsOn: [],
    status: 'planned',
    acceptanceCriteria: 'The venue confirms in writing',
    sourceRefs: ['venue-booking-letter'],
    evidenceIds: [],
    actionId: null,
    ...overrides,
  };
}

function equipmentStep(overrides: Partial<GoalStep>): GoalStep {
  return {
    stepId: 'step-equipment',
    goalId: 'goal-1',
    description: 'Book the equipment',
    dependsOn: ['step-venue'],
    status: 'planned',
    acceptanceCriteria: '',
    sourceRefs: [],
    evidenceIds: [],
    actionId: null,
    ...overrides,
  };
}

const SETUP = {
  agentId: 'agent-1',
  agentName: 'Fundraiser helper',
  agentVersion: 'v3',
  modelName: 'test/fundraiser-model',
  mcpServerNames: [],
  skillNames: [],
  digest: 'digest-1',
  pinnedAt: '2026-06-10T16:00:00.000Z',
};

const VENUE_EVIDENCE: GoalEvidence = {
  evidenceId: 'ev-1',
  goalId: 'goal-1',
  cycleId: 'cycle-1',
  sourceKind: 'document',
  sourceRef: 'venue-booking-letter',
  sourceRevision: 'rev-2',
  observedAt: '2026-06-15T16:05:00.000Z',
  claimedEventAt: null,
  freshness: 'current',
  admission: 'selected_source',
  extractionMethod: 'read',
  excerpt: 'The hall is free on Saturday, June 6 and holds 120 people.',
};

function makeApi(overrides: Partial<GoalsApi>): GoalsApi {
  const base: GoalsApi = {
    listGoals: () => Promise.resolve([]),
    getGoal: () => Promise.reject(new Error('not stubbed')),
    createGoal: () => Promise.reject(new Error('not stubbed')),
    updateGoal: () => Promise.reject(new Error('not stubbed')),
    getActivationPreview: () => Promise.reject(new Error('not stubbed')),
    activateGoal: () => Promise.reject(new Error('not stubbed')),
    pauseGoal: () => Promise.reject(new Error('not stubbed')),
    resumeGoal: () => Promise.reject(new Error('not stubbed')),
    endGoal: () => Promise.reject(new Error('not stubbed')),
    confirmStep: () => Promise.reject(new Error('not stubbed')),
    checkGoal: () => Promise.reject(new Error('not stubbed')),
    listEvidence: () => Promise.resolve([]),
    listEvents: () => Promise.resolve([]),
    listApprovals: () => Promise.resolve([]),
    listAgents: () => Promise.resolve([{ id: 'agent-1', name: 'Fundraiser helper' }]),
  };
  return { ...base, ...overrides };
}

function renderWithApi(api: GoalsApi, node: React.ReactNode) {
  return render(<GoalsProvider api={api}>{node}</GoalsProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Goals list page', () => {
  it('shows the fundraiser draft with its standing line', async () => {
    const api = makeApi({ listGoals: () => Promise.resolve([fundraiserGoal({})]) });
    renderWithApi(api, <GoalsListPage />);
    expect(await screen.findByText('Community fundraiser')).toBeDefined();
    expect(screen.getByText('Draft')).toBeDefined();
    expect(screen.getByText(/Not started yet/)).toBeDefined();
  });
});

describe('Goal page, draft and activation card', () => {
  function draftApi(overrides: Partial<GoalsApi>): GoalsApi {
    const draft = fundraiserGoal({});
    const steps = [venueStep({}), equipmentStep({})];
    return makeApi({
      getGoal: () => Promise.resolve({ goal: draft, steps, nextStepId: null }),
      getActivationPreview: () => Promise.resolve({ goal: draft, steps, setup: { ...SETUP } }),
      ...overrides,
    });
  }

  it('renders the card with the daily default and the Advanced limits, then activates against the digest', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    // The refetch after activation answers a later revision whose next check
    // falls a day later than the activation answer's. That June 17 date can
    // only reach the screen if the refetched detail is applied.
    const refetched = fundraiserGoal({
      lifecycle: 'active',
      revision: 3,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-17T16:00:00.000Z',
    });
    const steps = [venueStep({}), equipmentStep({})];
    const draft = fundraiserGoal({});
    let current: GoalDetail = { goal: draft, steps, nextStepId: null };
    const activateGoal = vi.fn<GoalsApi['activateGoal']>(() => {
      current = { goal: refetched, steps, nextStepId: 'step-venue' };
      return Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' });
    });
    const updateGoal = vi.fn<GoalsApi['updateGoal']>();
    const api = makeApi({
      getGoal: () => Promise.resolve(current),
      getActivationPreview: () => Promise.resolve({ goal: draft, steps, setup: { ...SETUP } }),
      activateGoal,
      updateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    expect(await screen.findByText('Review and activate')).toBeDefined();
    expect(screen.getByText('Fundraiser helper · test/fundraiser-model')).toBeDefined();
    const frequency = screen.getByLabelText('Routine checks');
    expect(frequency instanceof HTMLSelectElement ? frequency.value : '').toBe('1');
    expect(screen.getByText(/A check may work for up to about 15 minutes at a time/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced: work limits' }));
    expect(screen.getByText('300,000 tokens')).toBeDefined();
    expect(screen.getByDisplayValue('1000000')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Activate goal' }));
    await waitFor(() => expect(activateGoal).toHaveBeenCalledTimes(1));
    expect(activateGoal).toHaveBeenCalledWith('goal-1', { expectedRevision: 1, setupDigest: 'digest-1' });
    expect(updateGoal).not.toHaveBeenCalled();
    // Wait for the refetched detail's June 17 next check to replace the
    // activation answer's June 16 one, then assert on the settled screen.
    expect(await screen.findByText(/Next check: June 17, 2026/)).toBeDefined();
    expect(screen.queryByText(/Next check: June 16, 2026/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDefined();
  });

  it('reads a comma-grouped daily allowance at its full value when activating', async () => {
    const steps = [venueStep({}), equipmentStep({})];
    const draft = fundraiserGoal({ executionPolicy: { ...POLICY, dailyTokenAllowance: 500_000 } });
    const updated = fundraiserGoal({ revision: 2 });
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 3,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const updateGoal = vi.fn<GoalsApi['updateGoal']>(() => Promise.resolve({ goal: updated, steps, nextStepId: null }));
    const activateGoal = vi.fn<GoalsApi['activateGoal']>(() =>
      Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
    );
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: draft, steps, nextStepId: null }),
      getActivationPreview: () => Promise.resolve({ goal: draft, steps, setup: { ...SETUP } }),
      updateGoal,
      activateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    expect(await screen.findByText('Review and activate')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced: work limits' }));
    fireEvent.change(screen.getByLabelText('Tokens per day'), { target: { value: '1,000,000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Activate goal' }));

    await waitFor(() => expect(activateGoal).toHaveBeenCalledTimes(1));
    expect(updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedRevision: 1,
      executionPolicy: { ...POLICY, dailyTokenAllowance: 1_000_000 },
      notificationPolicy: { digest: true },
    });
    expect(activateGoal).toHaveBeenCalledWith('goal-1', { expectedRevision: 2, setupDigest: 'digest-1' });
  });

  it('refuses a malformed daily allowance on the card and activates nothing', async () => {
    const activateGoal = vi.fn<GoalsApi['activateGoal']>();
    const updateGoal = vi.fn<GoalsApi['updateGoal']>();
    const api = draftApi({ activateGoal, updateGoal });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    expect(await screen.findByText('Review and activate')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced: work limits' }));
    fireEvent.change(screen.getByLabelText('Tokens per day'), { target: { value: '10x00' } });
    expect(screen.getByText('Enter a whole number of tokens above zero.')).toBeDefined();
    const button = screen.getByRole('button', { name: 'Activate goal' });
    expect(button instanceof HTMLButtonElement ? button.disabled : false).toBe(true);
    fireEvent.click(button);
    expect(updateGoal).not.toHaveBeenCalled();
    expect(activateGoal).not.toHaveBeenCalled();
  });

  it('shows the updated card instead of activating when the setup changed', async () => {
    const updatedPreview: GoalActivationPreview = {
      goal: fundraiserGoal({}),
      steps: [venueStep({}), equipmentStep({})],
      setup: { ...SETUP, agentName: 'Fundraiser helper, updated', digest: 'digest-2' },
    };
    const activateGoal = vi.fn<GoalsApi['activateGoal']>(() =>
      Promise.reject(new GoalSetupChangedError('The agent setup changed since the card was shown.', updatedPreview)),
    );
    const api = draftApi({ activateGoal });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    expect(await screen.findByText('Review and activate')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Activate goal' }));
    expect(await screen.findByText(/The agent setup changed since this card was first shown/)).toBeDefined();
    expect(screen.getByText('Fundraiser helper, updated · test/fundraiser-model')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });
});

describe('Goal page, running goal', () => {
  it('after a check, shows the venue step verified, its evidence, and the equipment step as next', async () => {
    const before = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const afterSteps = [venueStep({ status: 'verified', evidenceIds: ['ev-1'] }), equipmentStep({ status: 'ready' })];
    const after = { ...before, revision: 3 };
    let current: GoalDetail = { goal: before, steps: [venueStep({}), equipmentStep({})], nextStepId: 'step-venue' };
    const checkResult: GoalCheckResult = {
      cycle: {
        cycleId: 'cycle-1',
        goalId: 'goal-1',
        inputRevision: 2,
        trigger: 'manual',
        startedAt: '2026-06-15T16:04:00.000Z',
        finishedAt: '2026-06-15T16:05:00.000Z',
        outcome: 'completed',
        outcomeDetail: null,
        sessionId: null,
        nextCheckAt: '2026-06-16T16:00:00.000Z',
      },
      goal: after,
      steps: afterSteps,
      newEvidence: [VENUE_EVIDENCE],
      unreadSources: [],
      nextStepId: 'step-equipment',
    };
    const api = makeApi({
      getGoal: () => Promise.resolve(current),
      listEvidence: () => Promise.resolve([VENUE_EVIDENCE]),
      checkGoal: () => {
        current = { goal: after, steps: afterSteps, nextStepId: 'step-equipment' };
        return Promise.resolve(checkResult);
      },
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('The hall is free on Saturday, June 6 and holds 120 people.')).toBeDefined();
    expect(screen.getByText('Verified')).toBeDefined();
    expect(screen.getByText('Next step')).toBeDefined();
    expect(screen.getByText(/It recorded 1 new piece of evidence/)).toBeDefined();
  });

  it('sends only the changed limit when a running goal\u2019s daily allowance is raised', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const steps = [venueStep({}), equipmentStep({})];
    const updateGoal = vi.fn<GoalsApi['updateGoal']>(() =>
      Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
    );
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
      updateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const outcomeField = await screen.findByLabelText('Outcome');
    if (!(outcomeField instanceof HTMLTextAreaElement)) throw new Error('The outcome field is not a text area.');
    expect(outcomeField.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Tokens per day'), { target: { value: '2000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    expect(updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedRevision: 2,
      executionPolicy: { ...POLICY, dailyTokenAllowance: 2_000_000 },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
  });

  it('reads a comma-grouped daily allowance at its full value when saving an edit', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
      executionPolicy: { ...POLICY, dailyTokenAllowance: 500_000 },
    });
    const steps = [venueStep({}), equipmentStep({})];
    const updateGoal = vi.fn<GoalsApi['updateGoal']>(() =>
      Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
    );
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
      updateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Tokens per day'), { target: { value: '1,000,000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    expect(updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedRevision: 2,
      executionPolicy: { ...POLICY, dailyTokenAllowance: 1_000_000 },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
  });

  it('refuses a malformed daily allowance in the edit dialog and saves nothing', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const steps = [venueStep({}), equipmentStep({})];
    const updateGoal = vi.fn<GoalsApi['updateGoal']>();
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
      updateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Tokens per day'), { target: { value: '10x00' } });
    expect(screen.getByText(/keep the limits as whole numbers in range/)).toBeDefined();
    const saveButton = screen.getByRole('button', { name: 'Save changes' });
    expect(saveButton instanceof HTMLButtonElement ? saveButton.disabled : false).toBe(true);
    fireEvent.click(saveButton);
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it('closes the edit dialog without sending anything when nothing was changed', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const steps = [venueStep({}), equipmentStep({})];
    const updateGoal = vi.fn<GoalsApi['updateGoal']>();
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
      updateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(updateGoal).not.toHaveBeenCalled();
  });

  it('shows Work limit reached with the saved next step and the resume time', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const api = makeApi({
      getGoal: () =>
        Promise.resolve({ goal: active, steps: [venueStep({}), equipmentStep({})], nextStepId: 'step-venue' }),
      listEvents: () =>
        Promise.resolve([
          {
            eventId: 'event-9',
            goalId: 'goal-1',
            sequence: 9,
            eventType: 'goal_check_finished',
            actor: 'agent',
            payload: { outcome: 'budget_exhausted', new_evidence: [], unread_sources: [] },
            createdAt: '2026-06-15T16:05:00.000Z',
          },
        ]),
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);
    expect(await screen.findByRole('heading', { name: 'Work limit reached' })).toBeDefined();
    expect(screen.getByText(/The next step is saved: Confirm the venue/)).toBeDefined();
    expect(screen.getAllByText(/Work can resume at the next check/).length).toBeGreaterThan(0);
  });

  it('shows the plain reason when a check could not read anything', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
      selectedSources: [],
    });
    const steps = [venueStep({ sourceRefs: [] }), equipmentStep({})];
    const checkResult: GoalCheckResult = {
      cycle: {
        cycleId: 'cycle-9',
        goalId: 'goal-1',
        inputRevision: 2,
        trigger: 'manual',
        startedAt: '2026-06-15T16:04:00.000Z',
        finishedAt: '2026-06-15T16:04:01.000Z',
        outcome: 'failed',
        outcomeDetail: 'This goal has no sources selected, so the check had nothing to read.',
        sessionId: null,
        nextCheckAt: '2026-06-16T16:00:00.000Z',
      },
      goal: active,
      steps,
      newEvidence: [],
      unreadSources: [],
      nextStepId: 'step-venue',
    };
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: active, steps, nextStepId: 'step-venue' }),
      checkGoal: () => Promise.resolve(checkResult),
      listEvents: () =>
        Promise.resolve([
          {
            eventId: 'event-10',
            goalId: 'goal-1',
            sequence: 10,
            eventType: 'goal_check_finished',
            actor: 'owner-1',
            payload: { outcome: 'failed', new_evidence: [], unread_sources: [] },
            createdAt: '2026-06-15T16:04:01.000Z',
          },
        ]),
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(
      await screen.findByText(
        'That check failed. This goal has no sources selected, so the check had nothing to read.',
      ),
    ).toBeDefined();
    expect(screen.getByText('This goal has no sources selected, so its checks have nothing to read.')).toBeDefined();
  });
});

describe('Goal page, confirming a step', () => {
  it('a check records evidence without confirming, and confirming the venue step makes the equipment step ready', async () => {
    const before = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const checkedSteps = [venueStep({ status: 'ready', evidenceIds: ['ev-1'] }), equipmentStep({})];
    const confirmedSteps = [
      venueStep({ status: 'owner_confirmed', evidenceIds: ['ev-1'] }),
      equipmentStep({ status: 'ready' }),
    ];
    let current: GoalDetail = {
      goal: before,
      steps: [venueStep({ status: 'ready' }), equipmentStep({})],
      nextStepId: 'step-venue',
    };
    let evidence: GoalEvidence[] = [];
    const checkResult: GoalCheckResult = {
      cycle: {
        cycleId: 'cycle-1',
        goalId: 'goal-1',
        inputRevision: 2,
        trigger: 'manual',
        startedAt: '2026-06-15T16:04:00.000Z',
        finishedAt: '2026-06-15T16:05:00.000Z',
        outcome: 'completed',
        outcomeDetail: null,
        sessionId: null,
        nextCheckAt: '2026-06-16T16:00:00.000Z',
      },
      goal: { ...before, revision: 3 },
      steps: checkedSteps,
      newEvidence: [VENUE_EVIDENCE],
      unreadSources: [],
      nextStepId: 'step-venue',
    };
    const confirmStep = vi.fn<GoalsApi['confirmStep']>(() => {
      current = { goal: { ...before, revision: 4 }, steps: confirmedSteps, nextStepId: 'step-equipment' };
      return Promise.resolve(current);
    });
    const api = makeApi({
      getGoal: () => Promise.resolve(current),
      listEvidence: () => Promise.resolve(evidence),
      checkGoal: () => {
        current = { goal: checkResult.goal, steps: checkedSteps, nextStepId: 'step-venue' };
        evidence = [VENUE_EVIDENCE];
        return Promise.resolve(checkResult);
      },
      confirmStep,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('The hall is free on Saturday, June 6 and holds 120 people.')).toBeDefined();

    const venueRow = screen.getByText('Confirm the venue').closest('li');
    if (venueRow === null) throw new Error('The venue step row is missing.');
    const equipmentRow = screen.getByText('Book the equipment').closest('li');
    if (equipmentRow === null) throw new Error('The equipment step row is missing.');
    // The check attached the evidence and nothing more: the venue step is not
    // confirmed, and the equipment step is still waiting on it.
    expect(within(venueRow).queryByText('Confirmed by you')).toBeNull();
    expect(within(equipmentRow).getByText('After Confirm the venue')).toBeDefined();
    expect(within(equipmentRow).getByText('Planned')).toBeDefined();
    expect(within(equipmentRow).queryByText('Next step')).toBeNull();
    expect(screen.getByText(/0 of 2 steps confirmed/)).toBeDefined();

    fireEvent.click(within(venueRow).getByRole('button', { name: 'Confirm step' }));
    await waitFor(() => expect(confirmStep).toHaveBeenCalledTimes(1));
    expect(confirmStep).toHaveBeenCalledWith({ goalId: 'goal-1', stepId: 'step-venue' });

    expect(await screen.findByText('Confirmed by you')).toBeDefined();
    const equipmentRowAfter = screen.getByText('Book the equipment').closest('li');
    if (equipmentRowAfter === null) throw new Error('The equipment step row is missing after confirming.');
    expect(within(equipmentRowAfter).getByText('Ready')).toBeDefined();
    expect(within(equipmentRowAfter).getByText('Next step')).toBeDefined();
    expect(screen.getByText(/1 of 2 steps confirmed/)).toBeDefined();
    // Confirming a step never finishes the goal: it is still running.
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDefined();
  });

  it('offers no Confirm step on a verified step or a confirmed step', async () => {
    const active = fundraiserGoal({
      lifecycle: 'active',
      revision: 2,
      pinnedSetup: { ...SETUP },
      nextCheckAt: '2026-06-16T16:00:00.000Z',
    });
    const api = makeApi({
      getGoal: () =>
        Promise.resolve({
          goal: active,
          steps: [venueStep({ status: 'verified' }), equipmentStep({ status: 'owner_confirmed' })],
          nextStepId: null,
        }),
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);
    expect(await screen.findByText('Verified')).toBeDefined();
    expect(screen.getByText('Confirmed by you')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Confirm step' })).toBeNull();
  });
});

describe('Goal page, editing a draft', () => {
  it('sends a changed outcome on a draft, and nothing else', async () => {
    const draft = fundraiserGoal({});
    const steps = [venueStep({}), equipmentStep({})];
    const updateGoal = vi.fn<GoalsApi['updateGoal']>(() =>
      Promise.resolve({
        goal: { ...draft, outcome: 'Hold the fundraiser in the park instead' },
        steps,
        nextStepId: null,
      }),
    );
    const api = makeApi({
      getGoal: () => Promise.resolve({ goal: draft, steps, nextStepId: null }),
      getActivationPreview: () => Promise.resolve({ goal: draft, steps, setup: { ...SETUP } }),
      updateGoal,
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Outcome'), {
      target: { value: 'Hold the fundraiser in the park instead' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    expect(updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedRevision: 1,
      outcome: 'Hold the fundraiser in the park instead',
    });
  });

  it('lets an agent-less draft gain an agent in the edit dialog, then activate', async () => {
    const steps = [venueStep({}), equipmentStep({})];
    let current: GoalDetail = { goal: fundraiserGoal({ agentId: null }), steps, nextStepId: null };
    const updateGoal = vi.fn<GoalsApi['updateGoal']>(() => {
      current = { goal: fundraiserGoal({ agentId: 'agent-2', revision: 2 }), steps, nextStepId: null };
      return Promise.resolve(current);
    });
    const activateGoal = vi.fn<GoalsApi['activateGoal']>(() =>
      Promise.resolve({
        goal: fundraiserGoal({
          agentId: 'agent-2',
          revision: 3,
          lifecycle: 'active',
          pinnedSetup: { ...SETUP },
          nextCheckAt: '2026-06-16T16:00:00.000Z',
        }),
        steps,
        nextStepId: 'step-venue',
      }),
    );
    const api = makeApi({
      getGoal: () => Promise.resolve(current),
      getActivationPreview: () =>
        current.goal.agentId === null
          ? Promise.reject(
              new Error('This goal has no agent yet. Pick the agent that will do the work, then activate.'),
            )
          : Promise.resolve({ goal: current.goal, steps, setup: { ...SETUP } }),
      updateGoal,
      activateGoal,
      listAgents: () =>
        Promise.resolve([
          { id: 'agent-1', name: 'Fundraiser helper' },
          { id: 'agent-2', name: 'Weekend planner' },
        ]),
    });
    renderWithApi(api, <GoalDetailPage goalId="goal-1" />);

    expect(await screen.findByText(/This goal has no agent yet/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(await screen.findByLabelText('Agent'), { target: { value: 'agent-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    expect(updateGoal).toHaveBeenCalledWith('goal-1', { expectedRevision: 1, agentId: 'agent-2' });

    expect(await screen.findByText('Review and activate')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Activate goal' }));
    await waitFor(() => expect(activateGoal).toHaveBeenCalledTimes(1));
    expect(activateGoal).toHaveBeenCalledWith('goal-1', { expectedRevision: 2, setupDigest: 'digest-1' });
  });
});
