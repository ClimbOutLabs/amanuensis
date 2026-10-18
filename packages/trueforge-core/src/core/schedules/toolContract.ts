/**
 * Canonical owner of the schedule tool names. Creating or deleting a schedule always asks; listing, pausing and
 * resuming run without asking.
 */
export const SCHEDULE_SERVER_ID = 'schedules';

export const CREATE_SCHEDULE_TOOL_NAME = 'create_schedule';
export const LIST_SCHEDULES_TOOL_NAME = 'list_schedules';
export const PAUSE_SCHEDULE_TOOL_NAME = 'pause_schedule';
export const RESUME_SCHEDULE_TOOL_NAME = 'resume_schedule';
export const DELETE_SCHEDULE_TOOL_NAME = 'delete_schedule';

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
