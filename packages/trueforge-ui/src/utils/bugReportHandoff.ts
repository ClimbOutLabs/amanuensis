/**
 * The "file it" handoff for a bug report: turning a generated (server-redacted) bundle into
 * a pre-filled issue-tracker URL the reporter opens in their browser.
 *
 * Redaction boundary: everything embedded here comes from either the reporter's own typed
 * description or the server-generated bundle, which the server already redacted. This module
 * never reads session data, message text, tool arguments/results, or credentials — it only
 * reshapes the allowlisted bundle fields into the issue form's fields. The full bundle JSON
 * stays behind the Download button; the issue carries a bounded human-readable summary so
 * the URL stays well under browser length limits.
 */

import type { AppBugReportBundle, BugReportBundle } from '../components/BugReportContext.js';

/** Longest description portion of the issue title, before the `[Bug] ` prefix is added. */
const MAX_TITLE_CHARS = 80;
/** Bound on the pre-filled `logs` field so the handoff URL stays small. */
const MAX_LOGS_CHARS = 4000;
/**
 * Bound on the pre-filled `what-happened` field: the reporter's free text is the one
 * unbounded input to the URL (the server already caps it at 8000 chars on the wire).
 */
const MAX_DESCRIPTION_CHARS = 2000;
/**
 * Deliberate ceiling on the final pre-filled issue URL. Modern browsers open far longer
 * URLs, but a handoff link should stay comfortably openable everywhere — and this catches
 * any unbounded field before it reaches the address bar.
 */
export const MAX_HANDOFF_URL_CHARS = 16000;

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.trim();
}

/** Code-point-aware slice: never splits a surrogate pair (a lone surrogate would break URL encoding). */
function slicePoints(text: string, maxPoints: number): string {
  return Array.from(text).slice(0, Math.max(0, maxPoints)).join('');
}

/** `[Bug] <first line of the description>`, truncated; falls back to a generic title. */
export function buildHandoffTitle(description: string): string {
  const line = firstLine(description);
  if (line === '') {
    return '[Bug] Report from the app';
  }
  const truncated =
    Array.from(line).length > MAX_TITLE_CHARS ? `${slicePoints(line, MAX_TITLE_CHARS - 1).trimEnd()}…` : line;
  return `[Bug] ${truncated}`;
}

export type IssuePrefillFields = {
  /** Maps to the template's `what-happened` field: the reporter's own words. */
  whatHappened?: string;
  /** Maps to the template's `version` field. */
  version?: string;
  /** Maps to the template's `logs` field: the bounded bundle summary. */
  logs?: string;
  /** Maps to the template's `environment` field: deployment facts from the bundle. */
  environment?: string;
};

/**
 * Builds the pre-filled new-issue URL. `baseIssueUrl` is the host-configured tracker URL
 * (including `?template=bug_report.yml`); field keys match the issue template's field `id`s,
 * which GitHub pre-fills from query parameters. Empty fields are left out.
 *
 * The reporter's free text is bounded before it reaches the URL (`MAX_DESCRIPTION_CHARS`),
 * and the finished URL is fitted to `MAX_HANDOFF_URL_CHARS` by encoded length — shedding
 * the free text first, then the logs — so no input can produce an unopenable link.
 */
export function buildIssuePrefillUrl(input: {
  baseIssueUrl: string;
  title: string;
  fields: IssuePrefillFields;
}): string {
  const fields: IssuePrefillFields = { ...input.fields };
  if (fields.whatHappened !== undefined && fields.whatHappened !== '') {
    fields.whatHappened = truncate(fields.whatHappened, MAX_DESCRIPTION_CHARS);
  }
  let url = assemblePrefillUrl(input.baseIssueUrl, input.title, fields);
  if (url.length > MAX_HANDOFF_URL_CHARS && fields.whatHappened !== undefined && fields.whatHappened !== '') {
    // Shed the reporter's free text first: the bundle summary is the diagnostic payload.
    const over = url.length - MAX_HANDOFF_URL_CHARS;
    fields.whatHappened = truncateEncoded(fields.whatHappened, encodeURIComponent(fields.whatHappened).length - over);
    url = assemblePrefillUrl(input.baseIssueUrl, input.title, fields);
  }
  if (url.length > MAX_HANDOFF_URL_CHARS && fields.logs !== undefined && fields.logs !== '') {
    const over = url.length - MAX_HANDOFF_URL_CHARS;
    fields.logs = truncateEncoded(fields.logs, encodeURIComponent(fields.logs).length - over);
    url = assemblePrefillUrl(input.baseIssueUrl, input.title, fields);
  }
  return url;
}

function assemblePrefillUrl(baseIssueUrl: string, title: string, fields: IssuePrefillFields): string {
  const url = new URL(baseIssueUrl);
  if (!url.searchParams.has('template')) {
    url.searchParams.set('template', 'bug_report.yml');
  }
  url.searchParams.set('title', title);
  const { whatHappened, version, logs, environment } = fields;
  if (whatHappened !== undefined && whatHappened !== '') {
    url.searchParams.set('what-happened', whatHappened);
  }
  if (version !== undefined && version !== '') {
    url.searchParams.set('version', version);
  }
  if (logs !== undefined && logs !== '') {
    url.searchParams.set('logs', logs);
  }
  if (environment !== undefined && environment !== '') {
    url.searchParams.set('environment', environment);
  }
  return url.toString();
}

/** Appended when `truncate` cuts a field; its length counts against `maxChars`. */
const TRUNCATION_SUFFIX = '… (truncated — the full bundle is in the downloaded .json)';

function truncate(text: string, maxChars: number): string {
  const points = Array.from(text);
  if (points.length <= maxChars) {
    return text;
  }
  const keep = Math.max(0, maxChars - Array.from(TRUNCATION_SUFFIX).length);
  return `${points.slice(0, keep).join('').trimEnd()}${TRUNCATION_SUFFIX}`;
}

/**
 * Cuts text so its URL-encoded form fits `maxEncodedChars`, keeping the truncation suffix.
 * Raw-char caps alone cannot bound URL length — one char can encode to up to 12 chars — so
 * the handoff URL gets a final fitting pass by encoded length.
 */
function truncateEncoded(text: string, maxEncodedChars: number): string {
  if (encodeURIComponent(text).length <= maxEncodedChars) {
    return text;
  }
  if (encodeURIComponent(TRUNCATION_SUFFIX).length >= maxEncodedChars) {
    return '';
  }
  const points = Array.from(text);
  let end = points.length;
  while (end > 0) {
    const candidate = `${points.slice(0, end).join('').trimEnd()}${TRUNCATION_SUFFIX}`;
    if (encodeURIComponent(candidate).length <= maxEncodedChars) {
      return candidate;
    }
    end = Math.max(0, end - 16);
  }
  return TRUNCATION_SUFFIX;
}

function configFlagsLine(flags: AppBugReportBundle['config_flags']): string {
  return `sandbox ${flags.sandbox_enabled ? 'on' : 'off'}, skills ${flags.skill_enabled ? 'on' : 'off'}, settings ${flags.settings_enabled ? 'on' : 'off'}`;
}

/**
 * Session-scoped bundle summary for the issue `logs` field: counts, the per-turn one-liners,
 * and the recent errors — all already redacted server-side. Never includes message text,
 * tool arguments/results, or memory content (the bundle does not carry them).
 */
function summarizeSessionBundle(bundle: BugReportBundle): { logs: string; environment: string } {
  const turns = bundle.trace.length;
  const events = bundle.trace.reduce((total, turn) => total + turn.events.length, 0);
  const lines = [
    `Redacted diagnostic bundle (schema v${String(bundle.schema_version)}, generated ${bundle.generated_at}).`,
    `Build ${bundle.build.version}${bundle.build.ref ? ` (${bundle.build.ref})` : ''}, session ${bundle.session.id}.`,
    `${String(turns)} turn${turns === 1 ? '' : 's'}, ${String(events)} event${events === 1 ? '' : 's'}, ${String(bundle.recent_errors.length)} recent error${bundle.recent_errors.length === 1 ? '' : 's'}.`,
  ];
  if (bundle.summary.length > 0) {
    lines.push('', ...bundle.summary.map(line => `- ${line}`));
  }
  if (bundle.recent_errors.length > 0) {
    lines.push(
      '',
      'Recent errors:',
      ...bundle.recent_errors.map(item => `- ${item.event_type}${item.code ? ` (${item.code})` : ''}: ${item.message}`),
    );
  }
  lines.push('', bundle.redaction.notes);
  const environment = [
    `Model ${bundle.session.model ?? 'unknown'}`,
    `connectors: ${bundle.session.connectors.length > 0 ? bundle.session.connectors.join(', ') : 'none'}`,
    `skills: ${bundle.session.skills.length > 0 ? bundle.session.skills.join(', ') : 'none'}`,
    configFlagsLine(bundle.config_flags),
    `chat included: ${bundle.chat ? `yes (${String(bundle.chat.messages.length)} messages)` : 'no'}`,
  ].join('\n');
  return { logs: truncate(lines.join('\n'), MAX_LOGS_CHARS), environment };
}

function summarizeAppBundle(bundle: AppBugReportBundle): { logs: string; environment: string } {
  const lines = [
    `Redacted app-level diagnostic bundle (schema v${String(bundle.schema_version)}, generated ${bundle.generated_at}).`,
    `Build ${bundle.build.version}${bundle.build.ref ? ` (${bundle.build.ref})` : ''}.`,
    'No session attached: this report carries no chat, trace, or session data.',
    '',
    bundle.redaction.notes,
  ];
  return { logs: truncate(lines.join('\n'), MAX_LOGS_CHARS), environment: configFlagsLine(bundle.config_flags) };
}

/** Discriminates the session bundle from the app bundle by the session-only `trace` field. */
function isSessionBundle(bundle: BugReportBundle | AppBugReportBundle): bundle is BugReportBundle {
  return 'trace' in bundle;
}

/**
 * Builds the bounded, human-readable issue fields for a generated bundle. Only allowlisted,
 * server-redacted bundle fields are read; the reporter's description is passed through as
 * `whatHappened` separately by the caller.
 */
export function summarizeBundleForIssue(bundle: BugReportBundle | AppBugReportBundle): IssuePrefillFields {
  const { logs, environment } = isSessionBundle(bundle) ? summarizeSessionBundle(bundle) : summarizeAppBundle(bundle);
  return {
    version: bundle.build.version,
    logs,
    environment,
  };
}
