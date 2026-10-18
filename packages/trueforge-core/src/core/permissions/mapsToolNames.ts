/**
 * Canonical owner of the embedded maps tool names. Kept in a leaf module so the UI can import
 * them without pulling in the classifier's module graph.
 */
export const RENDER_MAP_TOOL_NAME = 'render_map';
export const RENDER_ROUTE_TOOL_NAME = 'render_route';
export const RENDER_PLACES_TOOL_NAME = 'render_places';
export const MAPS_TOOL_NAMES = [RENDER_MAP_TOOL_NAME, RENDER_ROUTE_TOOL_NAME, RENDER_PLACES_TOOL_NAME] as const;

export function isMapsToolName(tool_name: string): boolean {
  return MAPS_TOOL_NAMES.some(name => name === tool_name);
}
