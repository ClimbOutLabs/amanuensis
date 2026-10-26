/**
 * Canonical owner of the schedule tool names. Creating or deleting a schedule always asks; listing, pausing and
 * resuming run without asking. Reminders are the person's own note to themselves, so none of their tools ever asks.
 */
export const SCHEDULE_SERVER_ID = 'schedules';

export const CREATE_SCHEDULE_TOOL_NAME = 'create_schedule';
export const LIST_SCHEDULES_TOOL_NAME = 'list_schedules';
export const PAUSE_SCHEDULE_TOOL_NAME = 'pause_schedule';
export const RESUME_SCHEDULE_TOOL_NAME = 'resume_schedule';
export const DELETE_SCHEDULE_TOOL_NAME = 'delete_schedule';

export const SET_REMINDER_TOOL_NAME = 'set_reminder';
export const LIST_REMINDERS_TOOL_NAME = 'list_reminders';
export const CANCEL_REMINDER_TOOL_NAME = 'cancel_reminder';

const SCHEDULE_WRITE_TOOL_NAMES = [CREATE_SCHEDULE_TOOL_NAME, DELETE_SCHEDULE_TOOL_NAME] as const;
const SCHEDULE_STATUS_TOOL_NAMES = [PAUSE_SCHEDULE_TOOL_NAME, RESUME_SCHEDULE_TOOL_NAME] as const;

/** Calls that save or remove a schedule and so show an approval card first. */
export function isScheduleWriteToolName(tool_name: string): boolean {
  return SCHEDULE_WRITE_TOOL_NAMES.some(name => name === tool_name);
}

/** Calls that only pause or resume an existing schedule. */
export function isScheduleStatusToolName(tool_name: string): boolean {
  return SCHEDULE_STATUS_TOOL_NAMES.some(name => name === tool_name);
}

/** Calls that set, list or cancel a reminder. A reminder only ever reaches the person, so none of them asks. */
export function isReminderToolName(tool_name: string): boolean {
  return (
    tool_name === SET_REMINDER_TOOL_NAME ||
    tool_name === LIST_REMINDERS_TOOL_NAME ||
    tool_name === CANCEL_REMINDER_TOOL_NAME
  );
}

/** The Reminders chat's fixed name. */
export const REMINDERS_CHAT_TITLE = 'Reminders';

/** Session metadata that marks the Reminders chat and says what came in last and when, so the chat list can show it. */
export const REMINDERS_METADATA_KEY = 'is_reminders';
export const LATEST_REMINDER_METADATA_KEY = 'latest_reminder';
export const LATEST_REMINDER_AT_METADATA_KEY = 'latest_reminder_at';
