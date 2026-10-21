/**
 * Canonical owner of the space tool names. Reading or writing a space runs without asking: a space is
 * the person's own page on their own machine, and every write keeps a revision revert_space can restore.
 */
export const SPACE_SERVER_ID = 'space';

export const LIST_SPACES_TOOL_NAME = 'list_spaces';
export const GET_SPACE_TOOL_NAME = 'get_space';
export const CREATE_SPACE_TOOL_NAME = 'create_space';
export const UPDATE_SPACE_TOOL_NAME = 'update_space';
export const REVERT_SPACE_TOOL_NAME = 'revert_space';
export const LIST_BLOCKS_TOOL_NAME = 'list_blocks';

const SPACE_WRITE_TOOL_NAMES = [CREATE_SPACE_TOOL_NAME, UPDATE_SPACE_TOOL_NAME, REVERT_SPACE_TOOL_NAME] as const;
const SPACE_READ_TOOL_NAMES = [LIST_SPACES_TOOL_NAME, GET_SPACE_TOOL_NAME, LIST_BLOCKS_TOOL_NAME] as const;

/** Calls that create, change or restore a space. */
export function isSpaceWriteToolName(tool_name: string): boolean {
  return SPACE_WRITE_TOOL_NAMES.some(name => name === tool_name);
}

/** Calls that only read spaces. */
export function isSpaceReadToolName(tool_name: string): boolean {
  return SPACE_READ_TOOL_NAMES.some(name => name === tool_name);
}
