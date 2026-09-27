/**
 * Plain-language descriptions for known OAuth scopes, shown in the connector details UI.
 * Covers Gmail, Calendar, and Tasks, in both shorthand (`calendar.readonly`) and full URL form.
 * Unknown scopes fall back to the raw scope string so nothing is ever hidden.
 */

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  // Gmail
  'https://www.googleapis.com/auth/gmail.readonly': 'Read your emails',
  'https://www.googleapis.com/auth/gmail.send': 'Send emails on your behalf',
  'https://www.googleapis.com/auth/gmail.compose': 'Create email drafts on your behalf',
  'https://www.googleapis.com/auth/gmail.modify': 'Read, send, and organize your emails',
  'https://www.googleapis.com/auth/gmail.labels': 'Manage your email labels',
  'https://www.googleapis.com/auth/gmail.metadata': 'View email metadata (headers, labels)',
  // Calendar
  'https://www.googleapis.com/auth/calendar.readonly': 'View your calendars and events',
  'https://www.googleapis.com/auth/calendar.events.readonly': 'View your calendar events',
  'https://www.googleapis.com/auth/calendar.events': 'View and manage your calendar events',
  'https://www.googleapis.com/auth/calendar': 'Manage your calendars, events, and sharing settings',
  // Tasks
  'https://www.googleapis.com/auth/tasks.readonly': 'View your task lists and tasks',
  'https://www.googleapis.com/auth/tasks': 'View and manage your task lists and tasks',
};

/** Shorthand scope names mapped to full Google API URLs. */
const SHORTHAND_TO_URL: Record<string, string> = {
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'gmail.compose': 'https://www.googleapis.com/auth/gmail.compose',
  'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail.labels': 'https://www.googleapis.com/auth/gmail.labels',
  'gmail.metadata': 'https://www.googleapis.com/auth/gmail.metadata',
  'calendar.readonly': 'https://www.googleapis.com/auth/calendar.readonly',
  'calendar.events.readonly': 'https://www.googleapis.com/auth/calendar.events.readonly',
  'calendar.events': 'https://www.googleapis.com/auth/calendar.events',
  calendar: 'https://www.googleapis.com/auth/calendar',
  'tasks.readonly': 'https://www.googleapis.com/auth/tasks.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks',
};

/** Plain-language description of one OAuth scope. Unknown scopes return the raw scope string. */
export function describeOAuthScope(scope: string): string {
  const url = SHORTHAND_TO_URL[scope] ?? scope;
  return SCOPE_DESCRIPTIONS[url] ?? scope;
}

/** Plain-language descriptions for a list of OAuth scopes. Empty or missing input yields []. */
export function describeOAuthScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) return [];
  return scopes.map(describeOAuthScope);
}
