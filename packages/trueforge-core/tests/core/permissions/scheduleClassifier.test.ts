import {
  classifyTier,
  type ClassifyContext,
  type ReminderLine,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import type { Tier3Schedule } from '../../../src/core/permissions/tier';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

const MORNING_BRIEF: Tier3Schedule = {
  action: 'create',
  name: 'Morning brief',
  when: 'Every weekday at 8:00 AM',
  time_zone: 'America/New_York',
  task: 'Give me a morning brief.',
  runs_as: 'Aman',
  next_runs: ['Monday, October 19 at 8:00 AM', 'Tuesday, October 20 at 8:00 AM', 'Wednesday, October 21 at 8:00 AM'],
};

function scheduleAction(tool_name: string, schedule_write?: Tier3Schedule): SentinelAction {
  return {
    tool_name,
    canonical_params: { schedule: 'morning-brief' },
    tool_type: 'truefoundry-system',
    mcp_server_name: 'schedules',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
    ...(schedule_write === undefined ? {} : { schedule_write }),
  };
}

describe('Schedule tool classification', () => {
  it('asks before creating, with the schedule in plain words', async () => {
    const decision = await classifyTier(scheduleAction('create_schedule', MORNING_BRIEF), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'schedule_write', auto_deny: null });
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.plain_what).toBe(
      'Create the schedule "Morning brief"? It runs every weekday at 8:00 AM (America/New_York) and starts as soon as you approve.',
    );
    expect(decision.card?.schedule).toEqual(MORNING_BRIEF);
  });

  it('asks before deleting and says it cannot be undone', async () => {
    const decision = await classifyTier(
      scheduleAction('delete_schedule', { ...MORNING_BRIEF, action: 'delete', next_runs: [] }),
      makeCtx(),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'schedule_write' });
    expect(decision.card?.plain_what).toBe(
      'Delete the schedule "Morning brief", which runs every weekday at 8:00 AM (America/New_York)?',
    );
    expect(decision.card?.cannot_be_undone).toBe('Once deleted, the schedule is gone for good.');
  });

  it('refuses a create or delete the host could not show', async () => {
    const decision = await classifyTier(scheduleAction('create_schedule'), makeCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: 'destination_unverifiable', card: null });
  });

  it.each(['list_schedules', 'pause_schedule', 'resume_schedule'])('runs %s without asking', async name => {
    const decision = await classifyTier(scheduleAction(name), makeCtx());
    expect(decision).toMatchObject({ tier: 1, card: null, auto_deny: null, sensitive_read: false });
  });

  it('fails closed on an unknown schedule tool', async () => {
    const decision = await classifyTier(scheduleAction('wipe_schedules'), makeCtx());
    expect(decision.tier).toBe(3);
    expect(decision.reason).not.toBe('schedule_write');
  });
});

function reminderAction(tool_name: string, reminder?: ReminderLine): SentinelAction {
  return {
    tool_name,
    canonical_params: { what: 'Take the medicine', at: '2026-10-26T18:00:00-04:00' },
    tool_type: 'truefoundry-system',
    mcp_server_name: 'schedules',
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: false },
    ...(reminder === undefined ? {} : { reminder }),
  };
}

describe('Reminder tool classification', () => {
  it('sets a reminder without a card and says what was set', async () => {
    const decision = await classifyTier(
      reminderAction('set_reminder', { when: 'Monday, October 26 at 6:00 PM', what: 'Take the medicine' }),
      makeCtx(),
    );
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'reminder_write',
      reason_detail: 'Set a reminder for Monday, October 26 at 6:00 PM: Take the medicine',
      card: null,
      auto_deny: null,
      approval_token_id: null,
      sensitive_read: false,
    });
  });

  it('cancels a reminder without a card', async () => {
    const decision = await classifyTier(
      reminderAction('cancel_reminder', { when: null, what: 'Take the medicine' }),
      makeCtx(),
    );
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'reminder_write',
      reason_detail: 'Cancelled a reminder: Take the medicine',
      card: null,
      auto_deny: null,
    });
  });

  it('lists reminders without a card', async () => {
    const decision = await classifyTier(reminderAction('list_reminders'), makeCtx());
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'reminder_read',
      reason_detail: 'Looked at your reminders.',
      card: null,
      auto_deny: null,
    });
  });

  it('still runs without a card when the host gave no details', async () => {
    const decision = await classifyTier(reminderAction('set_reminder'), makeCtx());
    expect(decision).toMatchObject({ tier: 1, reason: 'reminder_write', reason_detail: 'Set a reminder.', card: null });
  });

  it('shortens a very long note in the line', async () => {
    const decision = await classifyTier(
      reminderAction('set_reminder', { when: 'Monday at 6:00 PM', what: 'x'.repeat(200) }),
      makeCtx(),
    );
    expect((decision.reason_detail ?? '').length).toBeLessThan(140);
  });
});
