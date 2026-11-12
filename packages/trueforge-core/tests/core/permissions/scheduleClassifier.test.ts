import {
  classifyTier,
  type ClassifyContext,
  type ReminderLine,
  type SentinelAction,
} from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, forUnattendedRun } from '../../../src/core/permissions/context';
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

/** The same chat context while a schedule runs it with nobody watching. */
function scheduledRunCtx(): ClassifyContext {
  const ctx = makeCtx();
  return { ...ctx, services: forUnattendedRun(ctx.services) };
}

function statusAction(tool_name: string, name?: string): SentinelAction {
  return { ...scheduleAction(tool_name), ...(name === undefined ? {} : { schedule_status: { name } }) };
}

describe('A scheduled run asks before it changes a schedule or a reminder', () => {
  it.each([
    ['pause_schedule', 'Pause the schedule "Morning brief"?'],
    ['resume_schedule', 'Resume the schedule "Morning brief"?'],
  ])('%s asks and names the schedule', async (tool_name, plain_what) => {
    const decision = await classifyTier(statusAction(tool_name, 'Morning brief'), scheduledRunCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, card: { plain_what } });
    expect(decision.approval_token_id).not.toBeNull();
  });

  it('asks before a pause even when the host could not name the schedule', async () => {
    const decision = await classifyTier(statusAction('pause_schedule'), scheduledRunCtx());
    expect(decision).toMatchObject({ tier: 3, auto_deny: null, card: { plain_what: 'Pause a schedule?' } });
  });

  it('asks before it sets a reminder, with the time and the words', async () => {
    const decision = await classifyTier(
      reminderAction('set_reminder', { when: 'Monday, October 26 at 6:00 PM', what: 'Take the medicine' }),
      scheduledRunCtx(),
    );
    expect(decision).toMatchObject({
      tier: 3,
      auto_deny: null,
      card: { plain_what: 'Set a reminder for Monday, October 26 at 6:00 PM: Take the medicine?' },
    });
    expect(decision.approval_token_id).not.toBeNull();
  });

  it('asks before it cancels a reminder, with the words of the reminder', async () => {
    const decision = await classifyTier(
      reminderAction('cancel_reminder', { when: null, what: 'Take the medicine' }),
      scheduledRunCtx(),
    );
    expect(decision).toMatchObject({
      tier: 3,
      auto_deny: null,
      card: { plain_what: 'Cancel the reminder: Take the medicine?' },
    });
  });

  it('asks before a reminder change even when the host gave no details', async () => {
    const set = await classifyTier(reminderAction('set_reminder'), scheduledRunCtx());
    const cancel = await classifyTier(reminderAction('cancel_reminder'), scheduledRunCtx());
    expect(set).toMatchObject({ tier: 3, card: { plain_what: 'Set a reminder?' } });
    expect(cancel).toMatchObject({ tier: 3, card: { plain_what: 'Cancel a reminder?' } });
  });

  it.each(['list_schedules', 'list_reminders'])('%s still runs without a card', async tool_name => {
    const decision = await classifyTier(scheduleAction(tool_name), scheduledRunCtx());
    expect(decision).toMatchObject({ tier: 1, card: null, auto_deny: null });
  });
});

function readAction(input: { server: string; tool_name: string; params?: Record<string, unknown> }): SentinelAction {
  return {
    tool_name: input.tool_name,
    canonical_params: input.params ?? {},
    tool_type: 'truefoundry-system',
    mcp_server_name: input.server,
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

describe('A scheduled run still does its ordinary work without a card', () => {
  it.each([
    ['gmail', 'list_inbox_threads'],
    ['gmail', 'read_email'],
    ['google_calendar', 'list_events'],
    ['space', 'list_spaces'],
    ['space', 'get_space'],
    ['schedules', 'list_reminders'],
  ])('a morning brief reads with %s %s', async (server, tool_name) => {
    const decision = await classifyTier(readAction({ server, tool_name }), scheduledRunCtx());
    expect(decision).toMatchObject({ tier: 1, card: null, auto_deny: null });
  });

  it('a schedule that keeps a space up to date edits it', async () => {
    const decision = await classifyTier(
      readAction({
        server: 'space',
        tool_name: 'edit_space',
        params: { space_name: 'Groceries', edits: [{ type: 'search', search: 'milk', replace: 'oat milk' }] },
      }),
      scheduledRunCtx(),
    );
    expect(decision).toMatchObject({ tier: 1, reason: 'space_write', card: null, auto_deny: null });
  });
});
