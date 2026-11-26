import { describe, expect, it } from 'vitest';

import {
  deriveGoalAttention,
  goalEventLine,
  goalProgressCounts,
  goalStatusSummary,
  lastCheckFromEvents,
} from '@/goals/goalAttention.js';
import type { GoalApproval, GoalEvent, GoalItem, GoalStep } from '@/goals/types.js';

const POLICY = {
  checksPerDay: 1,
  cycleMinutes: 15,
  modelCallLimit: 12,
  toolCallLimit: 40,
  cycleTokenLimit: 300_000,
  dailyTokenAllowance: 1_000_000,
};

function goal(overrides: Partial<GoalItem>): GoalItem {
  return {
    goalId: 'goal-1',
    title: 'Community fundraiser',
    outcome: 'Hold a community fundraiser with the venue and equipment confirmed',
    successCriteria: ['Venue confirmed in writing'],
    targetAt: '2026-06-20T17:00:00.000Z',
    targetHasTime: true,
    timezone: 'America/Los_Angeles',
    lifecycle: 'active',
    revision: 2,
    agentId: 'agent-1',
    selectedSources: [{ sourceKind: 'document', sourceRef: 'venue-booking-letter', label: 'Venue booking letter' }],
    executionPolicy: POLICY,
    notificationPolicy: { digest: true },
    linkedSpaceId: null,
    pinnedSetup: null,
    nextCheckAt: '2026-06-16T16:00:00.000Z',
    createdAt: '2026-06-10T16:00:00.000Z',
    updatedAt: '2026-06-15T16:00:00.000Z',
    ...overrides,
  };
}

function step(overrides: Partial<GoalStep>): GoalStep {
  return {
    stepId: 'step-venue',
    goalId: 'goal-1',
    description: 'Confirm the venue',
    dependsOn: [],
    status: 'planned',
    acceptanceCriteria: '',
    sourceRefs: [],
    evidenceIds: [],
    actionId: null,
    ...overrides,
  };
}

function event(overrides: Partial<GoalEvent>): GoalEvent {
  return {
    eventId: 'event-1',
    goalId: 'goal-1',
    sequence: 1,
    eventType: 'goal_created',
    actor: 'owner',
    payload: {},
    createdAt: '2026-06-15T16:00:00.000Z',
    ...overrides,
  };
}

function approval(overrides: Partial<GoalApproval>): GoalApproval {
  return {
    actionId: 'action-1',
    goalId: 'goal-1',
    cycleId: null,
    expectedRevision: 2,
    toolCallRef: null,
    approvalRef: null,
    executionState: 'waiting',
    receiptRef: null,
    createdAt: '2026-06-15T17:00:00.000Z',
    ...overrides,
  };
}

describe('lastCheckFromEvents', () => {
  it('reads the newest finished check, with its unread sources and evidence count', () => {
    const last = lastCheckFromEvents([
      event({
        eventType: 'goal_check_finished',
        createdAt: '2026-06-14T16:00:00.000Z',
        payload: { outcome: 'completed', new_evidence: ['ev-1'], unread_sources: [] },
      }),
      event({ eventType: 'goal_check_started', createdAt: '2026-06-15T16:00:00.000Z' }),
      event({
        eventType: 'goal_check_finished',
        createdAt: '2026-06-15T16:05:00.000Z',
        payload: { outcome: 'nothing_changed', new_evidence: [], unread_sources: ['venue-booking-letter'] },
      }),
    ]);
    expect(last).toEqual({
      finishedAt: '2026-06-15T16:05:00.000Z',
      outcome: 'nothing_changed',
      unreadSourceRefs: ['venue-booking-letter'],
      newEvidenceCount: 0,
    });
  });

  it('is null when no check has finished', () => {
    expect(lastCheckFromEvents([event({})])).toBeNull();
  });
});

describe('deriveGoalAttention', () => {
  const steps = [
    step({}),
    step({ stepId: 'step-equipment', description: 'Book the equipment', dependsOn: ['step-venue'] }),
  ];

  it('puts a used up work limit first, ahead of a waiting decision', () => {
    const attention = deriveGoalAttention({
      goal: goal({}),
      steps,
      nextStepId: 'step-venue',
      approvals: [approval({})],
      lastCheck: {
        finishedAt: '2026-06-15T16:05:00.000Z',
        outcome: 'budget_exhausted',
        unreadSourceRefs: [],
        newEvidenceCount: 0,
      },
    });
    expect(attention?.state).toBe('work_limit_reached');
    expect(attention?.reason).toContain('Work can resume at the next check');
  });

  it('waits for the owner when a decision is waiting', () => {
    const attention = deriveGoalAttention({
      goal: goal({}),
      steps,
      nextStepId: 'step-venue',
      approvals: [approval({})],
      lastCheck: null,
    });
    expect(attention?.state).toBe('waiting_for_you');
  });

  it('is blocked when a step failed', () => {
    const attention = deriveGoalAttention({
      goal: goal({}),
      steps: [step({ status: 'failed' }), steps[1] ?? step({})],
      nextStepId: null,
      approvals: [],
      lastCheck: null,
    });
    expect(attention?.state).toBe('blocked');
    expect(attention?.reason).toContain('Confirm the venue');
  });

  it('is ready to finish when every step is confirmed', () => {
    const attention = deriveGoalAttention({
      goal: goal({}),
      steps: [step({ status: 'verified' }), step({ stepId: 'step-equipment', status: 'owner_confirmed' })],
      nextStepId: null,
      approvals: [],
      lastCheck: null,
    });
    expect(attention?.state).toBe('ready_to_finish');
  });

  it('waits for a source the last check could not read, naming it by its label', () => {
    const attention = deriveGoalAttention({
      goal: goal({}),
      steps,
      nextStepId: 'step-venue',
      approvals: [],
      lastCheck: {
        finishedAt: '2026-06-15T16:05:00.000Z',
        outcome: 'completed',
        unreadSourceRefs: ['venue-booking-letter'],
        newEvidenceCount: 0,
      },
    });
    expect(attention?.state).toBe('waiting_for_a_source');
    expect(attention?.reason).toContain('Venue booking letter');
  });

  it('works on the next step otherwise, and says nothing for a goal that is not running', () => {
    const attention = deriveGoalAttention({
      goal: goal({}),
      steps: [step({ status: 'ready' })],
      nextStepId: 'step-venue',
      approvals: [],
      lastCheck: null,
    });
    expect(attention).toEqual({ state: 'working', reason: 'Next step: Confirm the venue' });
    expect(
      deriveGoalAttention({
        goal: goal({ lifecycle: 'paused' }),
        steps,
        nextStepId: null,
        approvals: [],
        lastCheck: null,
      }),
    ).toBeNull();
  });
});

describe('goalStatusSummary and goalProgressCounts', () => {
  it('gives a draft its plain standing line', () => {
    expect(
      goalStatusSummary({
        goal: goal({ lifecycle: 'draft' }),
        steps: [],
        nextStepId: null,
        approvals: [],
        lastCheck: null,
      }),
    ).toEqual({ label: 'Draft', reason: 'Not started yet. Review the card and activate it when you are ready.' });
  });

  it('counts only steps with evidence or the owner confirmation', () => {
    expect(
      goalProgressCounts([
        step({ status: 'verified' }),
        step({ stepId: 'a', status: 'owner_confirmed' }),
        step({ stepId: 'b', status: 'ready' }),
      ]),
    ).toEqual({ confirmed: 2, total: 3 });
  });
});

describe('goalEventLine', () => {
  it('says what a finished check recorded', () => {
    expect(
      goalEventLine(
        event({ eventType: 'goal_check_finished', payload: { outcome: 'completed', new_evidence: ['ev-1', 'ev-2'] } }),
      ),
    ).toBe('A check finished and recorded 2 new pieces of evidence.');
    expect(goalEventLine(event({ eventType: 'goal_check_finished', payload: { outcome: 'budget_exhausted' } }))).toBe(
      'A check stopped early. The work limit was reached.',
    );
    expect(goalEventLine(event({ eventType: 'goal_step_confirmed', payload: { step_id: 'step-venue' } }))).toBe(
      'You confirmed a step as done.',
    );
    expect(goalEventLine(event({ eventType: 'something_new' }))).toBe('Something changed on this goal.');
  });
});
