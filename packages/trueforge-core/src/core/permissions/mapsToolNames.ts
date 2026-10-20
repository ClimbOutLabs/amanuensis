/**
 * Canonical owner of the embedded maps tool names and the reason code for a maps call that runs
 * without asking. Kept in a leaf module so the UI and the audit writer can import them without
 * pulling in the classifier's module graph.
 */
export const RENDER_MAP_TOOL_NAME = 'render_map';
export const RENDER_ROUTE_TOOL_NAME = 'render_route';
export const RENDER_PLACES_TOOL_NAME = 'render_places';
export const MAPS_TOOL_NAMES = [RENDER_MAP_TOOL_NAME, RENDER_ROUTE_TOOL_NAME, RENDER_PLACES_TOOL_NAME] as const;

/** Reason code for an embedded maps call the user let run without asking. */
export const MAPS_SILENT_REASON = 'maps_silent';

export function isMapsToolName(tool_name: string): boolean {
  return MAPS_TOOL_NAMES.some(name => name === tool_name);
}
