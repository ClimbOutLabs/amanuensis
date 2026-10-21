import { AMAN_GUIDE_NAME } from '@truefoundry/trueforge-core/core';
/**
 * Help check as the app shows it. The wire shape comes from GET /api/v1/help/health-check; the server
 * schema is its canonical owner, and the frontend checks each response against these fields.
 */
export type HelpHealthStatus = 'pass' | 'warn' | 'fail' | 'not_set_up';

export interface HelpHealthItem {
  id: string;
  name: string;
  status: HelpHealthStatus;
  message: string;
  next_step: string | null;
}

export type HelpHostReportState = 'ok' | 'missing' | 'invalid' | 'stale';

export interface HelpHostReport {
  state: HelpHostReportState;
  checked_at: string | null;
  message: string | null;
  next_step: string | null;
}

export interface HelpHealthCheck {
  checked_at: string;
  model_ready: boolean;
  items: HelpHealthItem[];
  host_report: HelpHostReport;
}

/** The guide's name. Naming her in a message is what invokes her. */

export const HELP_BUTTON_LABEL = "Help, I'm stuck";

/** One-tap answers under Iris's first message. Tapping one sends it as the person's own message. */
export const IRIS_HELP_CHOICES: readonly string[] = [
  'Setting up a model',
  'Connecting email or calendar',
  'An approval card',
  'Something went wrong',
  'Something else',
];

export const NO_LAST_ERROR = 'none';

export interface IrisHelpMessageInput {
  check: HelpHealthCheck;
  /** The screen the person was on, such as "Settings, Connectors". */
  screen: string;
  /** The text of the last error message the person saw, or null when there was none. */
  lastError: string | null;
}

function statusWord(status: HelpHealthStatus): string {
  switch (status) {
    case 'pass':
      return 'ok';
    case 'warn':
      return 'needs a look';
    case 'fail':
      return 'failed';
    case 'not_set_up':
      return 'not set up';
  }
}

/** The "You were on" line with one full stop, whether or not the error text already ends with one. */
export function youWereOnLine({ screen, lastError }: { screen: string; lastError: string | null }): string {
  const error = lastError === null ? NO_LAST_ERROR : lastError.trim().replace(/[.!?]+$/, '');
  return `You were on: ${screen}. Last error: ${error}.`;
}

/**
 * The hidden message that makes Iris speak first. It carries only the check results, the screen
 * and the last error text. It never carries chat, mail, calendar or file content.
 */
export function buildIrisHelpMessage({ check, screen, lastError }: IrisHelpMessageInput): string {
  const lines = check.items.map(item => `- ${item.name}: ${statusWord(item.status)}. ${item.message}`);
  if (check.host_report.message !== null) {
    lines.push(`- Last full check: ${check.host_report.message}`);
  }
  return [
    `${AMAN_GUIDE_NAME}, I am stuck and need help. Start by asking me: Where are you stuck? Then wait for my answer.`,
    'Health check results:',
    ...lines,
    youWereOnLine({ screen, lastError }),
  ].join('\n');
}

const MODEL_ITEM_ID = 'model';

/** The model always comes first; then failed and warned lines, so the red items sit at the top. */
export function sortHelpItems(items: readonly HelpHealthItem[]): HelpHealthItem[] {
  const rank: Record<HelpHealthStatus, number> = { fail: 1, warn: 2, pass: 3, not_set_up: 4 };
  const rankOf = (item: HelpHealthItem): number => (item.id === MODEL_ITEM_ID ? 0 : rank[item.status]);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rankOf(a.item) - rankOf(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** "Last full check: <time>" in the person's own time zone, from the UTC time the report carries. */
export function formatLastFullCheck(checkedAt: string, locale?: string): string {
  const date = new Date(checkedAt);
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
