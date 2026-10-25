/**
 * Canonical owner of the space tool names and of the plain line each call shows in the chat. Reading or
 * writing a space runs without asking: a space is the person's own page on their own machine, and every
 * write keeps a revision revert_space can restore. Each tool carries its line here, so a space tool
 * cannot be added without one.
 */
export const SPACE_SERVER_ID = 'space';

export const LIST_SPACES_TOOL_NAME = 'list_spaces';
export const GET_SPACE_TOOL_NAME = 'get_space';
export const CREATE_SPACE_TOOL_NAME = 'create_space';
export const UPDATE_SPACE_TOOL_NAME = 'update_space';
export const EDIT_SPACE_TOOL_NAME = 'edit_space';
export const REVERT_SPACE_TOOL_NAME = 'revert_space';
export const LIST_BLOCKS_TOOL_NAME = 'list_blocks';

/** The plain line one space call shows, given the space's display name (null when the call names no space). */
export type SpaceActivityLine = (space_name: string | null) => string;

/** One space tool: its name and the line a call to it shows. */
export interface SpaceToolContract {
  name: string;
  activity_line: SpaceActivityLine;
}

const SPACE_WRITE_TOOLS: readonly SpaceToolContract[] = [
  {
    name: CREATE_SPACE_TOOL_NAME,
    activity_line: space_name => (space_name === null ? 'Created a space.' : `Created the space ${space_name}.`),
  },
  {
    name: UPDATE_SPACE_TOOL_NAME,
    activity_line: space_name => (space_name === null ? 'Updated a space.' : `Updated the space ${space_name}.`),
  },
  {
    name: EDIT_SPACE_TOOL_NAME,
    activity_line: space_name => (space_name === null ? 'Updated a space.' : `Updated the space ${space_name}.`),
  },
  {
    name: REVERT_SPACE_TOOL_NAME,
    activity_line: () => 'Restored an earlier version of a space.',
  },
];

const SPACE_READ_TOOLS: readonly SpaceToolContract[] = [
  { name: LIST_SPACES_TOOL_NAME, activity_line: () => 'Looked at your spaces.' },
  { name: GET_SPACE_TOOL_NAME, activity_line: () => 'Read a space.' },
  { name: LIST_BLOCKS_TOOL_NAME, activity_line: () => 'Looked at the sections of a space.' },
];

export const SPACE_READ_TOOL_NAMES = SPACE_READ_TOOLS.map(tool => tool.name);

/** Calls that create, change or restore a space. */
export function isSpaceWriteToolName(tool_name: string): boolean {
  return SPACE_WRITE_TOOLS.some(tool => tool.name === tool_name);
}

/** Calls that only read spaces. */
export function isSpaceReadToolName(tool_name: string): boolean {
  return SPACE_READ_TOOLS.some(tool => tool.name === tool_name);
}

/** The line a call to a space tool shows, or null when the name is not one of the host's space tools. */
export function spaceActivityLine(input: { tool_name: string; space_name: string | null }): string | null {
  const tool = [...SPACE_WRITE_TOOLS, ...SPACE_READ_TOOLS].find(candidate => candidate.name === input.tool_name);
  return tool === undefined ? null : tool.activity_line(input.space_name);
}
