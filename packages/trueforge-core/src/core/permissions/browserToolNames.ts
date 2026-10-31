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

/** Reason code for a page the browser opened without asking: it passed every outbound check (tier 1). */
export const BROWSER_OPEN_SILENT_REASON = 'browser_open';

/**
 * Reason code for an open that asks because the chat has read other people's content and the person never gave the
 * address: the address itself is sent to the site, so whatever the assistant put in it leaves with the request.
 */
export const BROWSER_OPEN_UNVOUCHED_REASON = 'browser_open_unvouched';

/** Reason code for an open that asks because its address carries a private detail, in a chat that read other content. */
export const BROWSER_OPEN_PRIVATE_DETAIL_REASON = 'browser_open_private_detail';

/** Reason code for an open that asks because the outbound guard or the person's search setting holds it. */
export const BROWSER_OPEN_GUARD_REASON = 'browser_open_guard';

export function isBrowserToolName(tool_name: string): tool_name is BrowserToolName {
  return BROWSER_TOOL_NAMES.some(name => name === tool_name);
}
