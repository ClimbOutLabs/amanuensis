/**
 * The CalDAV connector: the calendar server the operator runs beside Aman, reached over MCP.
 * The name is the MCP server name the classifier keys on, so only the mounted connector gets
 * these rules.
 */
export const CALDAV_SERVER_NAME = 'Calendar';

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

/**
 * Every argument a change tool acts on, as the connector names them. The approval card shows each
 * of them; a call with any other argument gets the generic card instead.
 */
export const CALDAV_WRITE_FIELDS: Partial<Record<CaldavToolName, readonly string[]>> = {
  create_event: [
    'calendar_id',
    'summary',
    'start',
    'end',
    'timezone',
    'description',
    'location',
    'categories',
    'status',
    'transparent',
    'recurrence',
    'alarms',
  ],
  update_event: [
    'id',
    'scope',
    'summary',
    'start',
    'end',
    'timezone',
    'description',
    'location',
    'categories',
    'status',
    'transparent',
    'alarms',
  ],
  delete_event: ['id', 'scope'],
  respond_to_event: ['id', 'response'],
};

export function isCaldavToolName(name: string): name is CaldavToolName {
  return (CALDAV_TOOL_NAMES as readonly string[]).includes(name);
}
