/**
 * Canonical owner of the browser tool names and the reason codes for a browser call. Kept in a
 * leaf module so the UI and the audit writer can import them without pulling in the classifier's
 * module graph.
 */
export const BROWSER_OPEN_TOOL_NAME = 'browser_open';
export const BROWSER_READ_TOOL_NAME = 'browser_read';
export const BROWSER_SCROLL_TOOL_NAME = 'browser_scroll';
export const BROWSER_BACK_TOOL_NAME = 'browser_back';
export const BROWSER_SCREENSHOT_TOOL_NAME = 'browser_screenshot';

export const BROWSER_TOOL_NAMES = [
  BROWSER_OPEN_TOOL_NAME,
  BROWSER_READ_TOOL_NAME,
  BROWSER_SCROLL_TOOL_NAME,
  BROWSER_BACK_TOOL_NAME,
  BROWSER_SCREENSHOT_TOOL_NAME,
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/** Reason code for a browser call that reads or moves around without asking (explore, tier 1). */
export const BROWSER_EXPLORE_REASON = 'browser_explore';

export function isBrowserToolName(tool_name: string): tool_name is BrowserToolName {
  return BROWSER_TOOL_NAMES.some(name => name === tool_name);
}
