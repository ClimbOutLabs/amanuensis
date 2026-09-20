/**
 * Plain-language activity feed model.
 *
 * The session timeline renders raw technical segments (tool names, model
 * events, error payloads) for debugging. Everyday users should never see
 * that. This module converts the same segments into a short, grouped,
 * human-readable activity list: "Searched the web", "Checked your calendar",
 * "Hit a snag" — never JSON, tool ids, or sandbox internals.
 */

import type { SessionEventTimelineSegment } from './sessionEventTimeline.js';

export type ActivityItemKind =
  'search' | 'read' | 'calendar' | 'mail' | 'check' | 'write' | 'delegate' | 'approval' | 'wait' | 'snag' | 'done';

export type ActivityItem = {
  id: string;
  kind: ActivityItemKind;
  title: string;
  detail?: string;
  /** Wall-clock milliseconds of the item start. */
  timestampMs: number;
  /** Milliseconds spanned by the grouped events. */
  durationMs: number;
  /** How many raw segments were grouped into this item. */
  count: number;
};

type ToolLabel = {
  kind: ActivityItemKind;
  title: string;
  /** Plural noun used when several calls collapse into one item. */
  plural: string;
};

/** Bookkeeping tools that are never meaningful to an everyday user. */
const INTERNAL_TOOLS = new Set(['record_finding']);

const TOOL_MATCHERS: Array<{ pattern: RegExp } & ToolLabel> = [
  { pattern: /^tavily_search/, kind: 'search', title: 'Searched the web', plural: 'searches' },
  { pattern: /^tavily_extract/, kind: 'read', title: 'Read web pages', plural: 'pages' },
  { pattern: /calendar/, kind: 'calendar', title: 'Checked your calendar', plural: 'lookups' },
  { pattern: /gmail|email/, kind: 'mail', title: 'Checked email', plural: 'messages' },
  { pattern: /weather/, kind: 'search', title: 'Checked the weather', plural: 'lookups' },
  { pattern: /flight|hotel/, kind: 'search', title: 'Looked up travel options', plural: 'lookups' },
  { pattern: /search/, kind: 'search', title: 'Searched', plural: 'searches' },
];

const VERB_LABELS: Record<string, string> = {
  get: 'Checked',
  list: 'Listed',
  fetch: 'Fetched',
  search: 'Searched',
  read: 'Read',
  create: 'Created',
  send: 'Sent',
  update: 'Updated',
  delete: 'Deleted',
  find: 'Found',
  lookup: 'Looked up',
};

const MAX_DETAIL_LENGTH = 90;

function capitalize(word: string): string {
  const first = word[0];
  if (first === undefined) return word;
  return first.toUpperCase() + word.slice(1);
}

/** Turn `get_weather_forecast` into `Checked weather forecast`. Never leaks snake_case. */
function humanizeToolName(name: string): string {
  const parts = name.split('_').filter(part => part.length > 0);
  const head = parts[0];
  if (head === undefined) return 'Used a tool';
  const verb = VERB_LABELS[head];
  const rest = parts.slice(1).join(' ');
  if (verb !== undefined && rest.length > 0) return `${verb} ${rest}`;
  return parts.map(capitalize).join(' ');
}

function truncate(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= MAX_DETAIL_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DETAIL_LENGTH - 1).trimEnd()}…`;
}

/**
 * Map a tool-call segment description to a plain-language label.
 *
 * Non-sandbox tools carry the raw snake_case tool name; sandbox tools carry
 * an already-human intent sentence (see `toolCallDescription`), which we
 * keep as the detail line under a generic "Ran a check" title.
 */
function labelToolCall(description: string): (ToolLabel & { detail?: string }) | null {
  const raw = description.trim();
  if (raw.length === 0) return null;
  if (INTERNAL_TOOLS.has(raw)) return null;
  if (!raw.includes('_')) {
    return { kind: 'check', title: 'Ran a check', plural: 'checks', detail: truncate(raw) };
  }
  for (const matcher of TOOL_MATCHERS) {
    if (matcher.pattern.test(raw)) {
      return { kind: matcher.kind, title: matcher.title, plural: matcher.plural };
    }
  }
  return { kind: 'check', title: humanizeToolName(raw), plural: 'times' };
}

function formatDuration(durationMs: number): string | null {
  if (durationMs < 5_000) return null;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  if (durationMs < 3_600_000) return `${Math.round(durationMs / 60_000)}m`;
  return `${Math.round(durationMs / 3_600_000)}h`;
}

/**
 * Convert raw timeline segments into grouped, plain-language activity items
 * in chronological order. `originMs` is the session-start wall-clock time;
 * segment offsets are relative to it.
 */
export function buildActivityItems(segments: readonly SessionEventTimelineSegment[], originMs: number): ActivityItem[] {
  const items: ActivityItem[] = [];
  let group: {
    id: string;
    kind: ActivityItemKind;
    title: string;
    plural: string;
    timestampMs: number;
    durationMs: number;
    count: number;
  } | null = null;

  const flushGroup = () => {
    if (group === null) return;
    const detailParts: string[] = [];
    if (group.count > 1) detailParts.push(`${group.count} ${group.plural}`);
    const duration = formatDuration(group.durationMs);
    if (duration !== null) detailParts.push(duration);
    items.push({
      id: group.id,
      kind: group.kind,
      title: group.title,
      detail: detailParts.length > 0 ? detailParts.join(' · ') : undefined,
      timestampMs: group.timestampMs,
      durationMs: group.durationMs,
      count: group.count,
    });
    group = null;
  };

  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
  for (const segment of ordered) {
    const timestampMs = originMs + segment.startMs;
    const durationMs = Math.max(0, segment.endMs - segment.startMs);

    if (segment.type === 'tool_call') {
      const label = labelToolCall(segment.description);
      if (label === null) continue;
      if (group !== null && group.kind === label.kind && group.title === label.title) {
        group.count += 1;
        group.durationMs += durationMs;
        continue;
      }
      flushGroup();
      group = {
        id: `activity-${segment.id}`,
        kind: label.kind,
        title: label.title,
        plural: label.plural,
        timestampMs,
        durationMs,
        count: 1,
      };
      if (label.detail !== undefined) {
        // Sandbox intents are already sentences; keep the first one's text.
        items.push({
          id: `activity-${segment.id}`,
          kind: label.kind,
          title: label.title,
          detail: label.detail,
          timestampMs,
          durationMs,
          count: 1,
        });
        group = null;
      }
      continue;
    }

    flushGroup();
    if (segment.type === 'approval') {
      items.push({
        id: `activity-${segment.id}`,
        kind: 'approval',
        title: 'Asked for your approval',
        timestampMs,
        durationMs,
        count: 1,
      });
    } else if (segment.type === 'waiting_on_human') {
      const needsAuth = segment.description.toLowerCase().includes('authentication');
      items.push({
        id: `activity-${segment.id}`,
        kind: 'wait',
        title: needsAuth ? 'Needed you to sign in' : 'Paused for you',
        timestampMs,
        durationMs,
        count: 1,
      });
    } else if (segment.type === 'sub_agent') {
      const detail = segment.description.trim();
      items.push({
        id: `activity-${segment.id}`,
        kind: 'delegate',
        title: 'Asked a helper',
        detail: detail.length > 0 ? truncate(detail) : undefined,
        timestampMs,
        durationMs,
        count: 1,
      });
    } else if (segment.type === 'error') {
      items.push({
        id: `activity-${segment.id}`,
        kind: 'snag',
        title: 'Hit a snag',
        timestampMs,
        durationMs,
        count: 1,
      });
    } else if (segment.type === 'system' && segment.title === 'turn.done') {
      items.push({
        id: `activity-${segment.id}`,
        kind: 'done',
        title: 'Wrapped up',
        timestampMs,
        durationMs,
        count: 1,
      });
    }
    // model, user, and other system segments are internal detail; skip them.
  }
  flushGroup();
  return items;
}
