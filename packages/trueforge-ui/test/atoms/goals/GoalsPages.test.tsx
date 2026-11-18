// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    const activateGoal = vi.fn<GoalsApi['activateGoal']>(() =>
      Promise.resolve({ goal: active, steps: [venueStep({}), equipmentStep({})], nextStepId: 'step-venue' }),
    );
    const updateGoal = vi.fn<GoalsApi['updateGoal']>();
    const api = draftApi({ activateGoal, updateGoal });
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
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeDefined();
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
});
