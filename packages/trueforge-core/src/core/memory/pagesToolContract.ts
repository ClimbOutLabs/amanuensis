/**
 * Canonical owner of the memory page tool names. Three tools write short facts to the pages Aman keeps about
 * people and matters. They run without a card: a line is saved as the person's own only when it is words they
 * typed, anything else is marked as read content and never replaces their words, nothing leaves the machine, and
 * every write is a commit that can be undone. Two tools only read: one lists the pages, one shows a page. They
 * run without a card too.
 */
export const MEMORY_PAGES_SERVER_ID = 'memory_pages';

export const REMEMBER_FACT_TOOL_NAME = 'remember_fact';
export const UPDATE_FACT_TOOL_NAME = 'update_fact';
export const FORGET_FACT_TOOL_NAME = 'forget_fact';
export const LIST_PAGES_TOOL_NAME = 'list_pages';
export const READ_PAGE_TOOL_NAME = 'read_page';

const MEMORY_PAGES_READ_TOOL_NAMES: readonly string[] = [LIST_PAGES_TOOL_NAME, READ_PAGE_TOOL_NAME];

const MEMORY_PAGES_WRITE_TOOL_NAMES: readonly string[] = [
  REMEMBER_FACT_TOOL_NAME,
  UPDATE_FACT_TOOL_NAME,
  FORGET_FACT_TOOL_NAME,
];

const MEMORY_PAGES_TOOL_NAMES: readonly string[] = [...MEMORY_PAGES_WRITE_TOOL_NAMES, ...MEMORY_PAGES_READ_TOOL_NAMES];

/** Whether a name is one of the host's three memory page tools that change a page. */
export function isMemoryPagesWriteToolName(tool_name: string): boolean {
  return MEMORY_PAGES_WRITE_TOOL_NAMES.includes(tool_name);
}

/** Whether a name is one of the host's memory page tools. */
export function isMemoryPagesToolName(tool_name: string): boolean {
  return MEMORY_PAGES_TOOL_NAMES.includes(tool_name);
}

/** Whether a name is one of the host's two memory page tools that only read. */
export function isMemoryPagesReadToolName(tool_name: string): boolean {
  return MEMORY_PAGES_READ_TOOL_NAMES.includes(tool_name);
}
