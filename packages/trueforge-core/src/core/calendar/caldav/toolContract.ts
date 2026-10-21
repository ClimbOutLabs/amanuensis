/**
 * The CalDAV connector: the calendar server the operator runs beside Aman, reached over MCP.
 * The name is the MCP server name the classifier keys on, so only the mounted connector gets
 * these rules.
 */
export const CALDAV_SERVER_NAME = 'caldav';

/** The only tools the sidecar exposes. Anything else on the server is refused. */
export const CALDAV_TOOL_NAMES = [
  'list_calendars',
  'list_events',
  'get_event',
  'search_events',
  'create_event',
  'update_event',
  'delete_event',
  'respond_to_event',
] as const;

export type CaldavToolName = (typeof CALDAV_TOOL_NAMES)[number];

/** The reads that change nothing and run without a card. */
export const CALDAV_READ_TOOL_NAMES = ['list_calendars', 'list_events', 'get_event', 'search_events'] as const;

export function isCaldavToolName(name: string): name is CaldavToolName {
  return (CALDAV_TOOL_NAMES as readonly string[]).includes(name);
}
