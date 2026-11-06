/**
 * Canonical owner of the memory page tool names. These tools write short facts to the pages Aman keeps about
 * people and matters. They run without a card: what they write is the person's own words from this chat, nothing
 * leaves the machine, and every write is a commit that can be undone. They refuse in a chat that has read mail,
 * the web, a document or any other outside text, so outside text can never reach a page this way.
 */
export const MEMORY_PAGES_SERVER_ID = 'memory_pages';

export const REMEMBER_FACT_TOOL_NAME = 'remember_fact';
export const UPDATE_FACT_TOOL_NAME = 'update_fact';
export const FORGET_FACT_TOOL_NAME = 'forget_fact';

const MEMORY_PAGES_TOOL_NAMES: readonly string[] = [
  REMEMBER_FACT_TOOL_NAME,
  UPDATE_FACT_TOOL_NAME,
  FORGET_FACT_TOOL_NAME,
];

/** Whether a name is one of the host's memory page tools. */
export function isMemoryPagesToolName(tool_name: string): boolean {
  return MEMORY_PAGES_TOOL_NAMES.includes(tool_name);
}
