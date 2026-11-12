/**
 * Canonical owner of the embedded maps tool names and the reason codes for a maps call. Kept in a
 * leaf module so the UI and the audit writer can import them without pulling in the classifier's
 * module graph.
 */
export const RENDER_MAP_TOOL_NAME = 'render_map';
export const RENDER_ROUTE_TOOL_NAME = 'render_route';
export const RENDER_PLACES_TOOL_NAME = 'render_places';
export const MAPS_TOOL_NAMES = [RENDER_MAP_TOOL_NAME, RENDER_ROUTE_TOOL_NAME, RENDER_PLACES_TOOL_NAME] as const;

/** Reason code for an embedded maps call that asks first. Its card may be answered for the chat or for every chat. */
export const MAPS_ASK_REASON = 'maps_tool';

/**
 * Reason code for an embedded maps call that asks every time: it would send text that looks like a password, a
 * key, a card number or a long block of text. No lasting answer covers it.
 */
export const MAPS_HOLD_REASON = 'maps_hold';

/** Reason code for an embedded maps call the user let run without asking. */
export const MAPS_SILENT_REASON = 'maps_silent';

/** Whether a reason code is one of a maps call that showed a card. */
export function isMapsCardReason(reason: string | undefined): boolean {
  return reason === MAPS_ASK_REASON || reason === MAPS_HOLD_REASON;
}

export function isMapsToolName(tool_name: string): boolean {
  return MAPS_TOOL_NAMES.some(name => name === tool_name);
}
