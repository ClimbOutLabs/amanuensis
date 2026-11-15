import type { HeldActionOutcome } from '@truefoundry/trueforge-chat';

/**
 * The plain words the terminal shows. The web app keeps a fuller dictionary of
 * tool wording; the terminal derives a plain name from the tool's own name, so
 * a tool it has never seen still reads as words and never as a raw identifier.
 */

/** A tool's plain name: the part after any server prefix, with separators as spaces. */
export function plainToolName(rawName: string): string {
  const afterPrefix = rawName.split('__').pop() ?? rawName;
  const words = afterPrefix.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (words === '') {
    return 'A tool';
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DETAIL_KEYS = ['path', 'file_path', 'query', 'url', 'title', 'name', 'command', 'pattern', 'subject'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** What a tool call is doing, from the one argument a person would recognise: a path, a query, a title. */
export function toolCallDetail(argumentsJson: string | undefined): string | null {
  if (argumentsJson === undefined || argumentsJson === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  for (const key of DETAIL_KEYS) {
    const value: unknown = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const trimmed = value.trim();
      return trimmed.length > 90 ? `${trimmed.slice(0, 87)}...` : trimmed;
    }
  }
  return null;
}

/** How a finished tool call reads. */
export type ToolOutcome = 'done' | 'failed' | 'unclear' | 'not_run' | 'waiting_approval';

export function outcomeWord(outcome: ToolOutcome): string {
  switch (outcome) {
    case 'done':
      return 'Done';
    case 'failed':
      return 'Did not work';
    case 'unclear':
      return 'Finished, but the result is not clear';
    case 'not_run':
      return 'Did not run';
    case 'waiting_approval':
      return 'Waiting for approval';
  }
}

/** The outcome a stream disposition names, in the words above. */
export function outcomeOfDisposition(disposition: string): HeldActionOutcome {
  switch (disposition) {
    case 'executed_ok':
      return 'done';
    case 'executed_nonzero':
      return 'failed';
    case 'outcome_unknown':
      return 'unclear';
    default:
      // denied, policy_blocked, never_ran, and anything unrecognised: the call did not run.
      return 'not_run';
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** When a chat was last active, in the words a person scans a list by. */
export function lastActiveWord(iso: string, now: Date): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return '';
  }
  const diffMs = now.getTime() - then.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && then.getDate() === now.getDate()) {
    return `${String(hours)} hr ago`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.getDate() === yesterday.getDate() && then.getMonth() === yesterday.getMonth()) {
    return 'Yesterday';
  }
  const month = MONTHS[then.getMonth()] ?? '';
  return `${month} ${String(then.getDate())}`;
}
