/**
 * Canonical owner of the goal tool names. Making a draft and asking for a check
 * change lasting state, so they ask first; listing and reading run without asking.
 */
export const GOALS_SERVER_ID = 'goals';

export const CREATE_GOAL_TOOL_NAME = 'create_goal';
export const LIST_GOALS_TOOL_NAME = 'list_goals';
export const GET_GOAL_TOOL_NAME = 'get_goal';
export const REQUEST_GOAL_CHECK_TOOL_NAME = 'request_goal_check';

const GOAL_READ_TOOL_NAMES = [LIST_GOALS_TOOL_NAME, GET_GOAL_TOOL_NAME] as const;

/** Calls that only read a goal, never change one. */
export function isGoalReadToolName(tool_name: string): boolean {
  return GOAL_READ_TOOL_NAMES.some(name => name === tool_name);
}
