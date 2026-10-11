/**
 * Shared presentation model for the Sessions timeline.
 *
 * Raw server events are intentionally converted to this small, stable shape
 * before they reach Chart.js. That keeps transport compatibility and event
 * correlation out of the chart component and makes atoms easy to override.
 */

import { TIMELINE_EVENT_FALLBACKS } from './chartThemeColors.js';

/** Events without a thread id belong to the root agent conversation. */
export const MAIN_THREAD_ID = 'main';

export type SessionEventType =
  'system' | 'user' | 'model' | 'tool_call' | 'approval' | 'sub_agent' | 'waiting_on_human' | 'error';

export type SessionEventTypeDefinition = {
  id: SessionEventType;
  label: string;
  color: string;
  darkColor?: string;
};

/**
 * One drawable interval on the timeline.
 *
 * Times are milliseconds relative to the session origin, not wall-clock
 * timestamps. Equal start/end times are rendered as markers; intervals become
 * horizontal bars. `turnIndex` groups intervals into turn backgrounds and
 * `threadId` assigns sub-agent work to its lane.
 */
export type SessionEventTimelineSegment = {
  id: string;
  type: SessionEventType;
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  turnIndex: number;
  threadId: string;
  isMarker?: boolean;
};

/**
 * Canonical legend order, labels, and base colours for timeline event types.
 * The hex values are fallbacks for SSR/tests; the themed colors come from
 * --chart-N via getSessionEventChartVar / resolveSessionEventColor.
 */
export const SESSION_EVENT_TYPES: SessionEventTypeDefinition[] = [
  { id: 'system', label: 'System', ...TIMELINE_EVENT_FALLBACKS.system },
  { id: 'user', label: 'User', ...TIMELINE_EVENT_FALLBACKS.user },
  { id: 'model', label: 'Model', ...TIMELINE_EVENT_FALLBACKS.model },
  { id: 'tool_call', label: 'Tool call', ...TIMELINE_EVENT_FALLBACKS.tool_call },
  { id: 'approval', label: 'Approval / HITL', ...TIMELINE_EVENT_FALLBACKS.approval },
  { id: 'sub_agent', label: 'Sub-agent', ...TIMELINE_EVENT_FALLBACKS.sub_agent },
  { id: 'waiting_on_human', label: 'Waiting on human', ...TIMELINE_EVENT_FALLBACKS.waiting_on_human },
  { id: 'error', label: 'Error', ...TIMELINE_EVENT_FALLBACKS.error },
];

/**
 * The `--chart-N` variable carrying this event type's themed color. Event
 * types map to chart tokens in canonical legend order, so themes control the
 * timeline palette through the same tokens as the data-series charts.
 */
export function getSessionEventChartVar(type: SessionEventType): string {
  const index = SESSION_EVENT_TYPES.findIndex(eventType => eventType.id === type);
  return `var(--chart-${index === -1 ? 1 : index + 1})`;
}

/** Resolve a segment's color from the theme for canvas/Chart.js, which cannot read `var()` itself. */
export function resolveSessionEventColor(type: SessionEventType, isDarkMode = false): string {
  const fallback = getSessionEventColor(type, isDarkMode);
  if (typeof document === 'undefined') return fallback;
  const index = SESSION_EVENT_TYPES.findIndex(eventType => eventType.id === type);
  const root = document.querySelector('.aui-theme-root') ?? document.documentElement;
  const value = getComputedStyle(root)
    .getPropertyValue(`--chart-${index === -1 ? 1 : index + 1}`)
    .trim();
  return value === '' ? fallback : value;
}

/** Marker-like events have no meaningful elapsed duration in their tooltip. */
export const SESSION_EVENT_TOOLTIP_HIDE_DURATION = new Set<SessionEventType>(['system', 'user', 'error']);

const TOOLTIP_HEADINGS: Partial<Record<SessionEventType, string>> = {
  user: 'User Message',
  model: 'Model Response',
};

/** Format an axis/tooltip duration compactly while retaining roughly three significant digits. */
export function formatTimelineDuration(durationMs: number): string {
  if (durationMs <= 0) return '0ms';
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${Number((durationMs / 1_000).toPrecision(3))}s`;
  if (durationMs < 3_600_000) return `${Number((durationMs / 60_000).toPrecision(3))}m`;
  return `${Number((durationMs / 3_600_000).toPrecision(3))}h`;
}

/** Resolve a segment's color from the same registry used to build the legend. */
export function getSessionEventColor(type: SessionEventType, isDarkMode = false): string {
  const eventType = SESSION_EVENT_TYPES.find(eventType => eventType.id === type);
  return (isDarkMode ? eventType?.darkColor : undefined) ?? eventType?.color ?? TIMELINE_EVENT_FALLBACKS.system.color;
}

/** Darken the base color by 10% so hover remains recognizable in either theme. */
export function getSessionEventHoverColor(type: SessionEventType, isDarkMode = false): string {
  const color = getSessionEventColor(type, isDarkMode);
  return darkenHex(color);
}

/** Themed hover color for canvas/Chart.js: resolves the theme color, then darkens it. */
export function resolveSessionEventHoverColor(type: SessionEventType, isDarkMode = false): string {
  return darkenHex(resolveSessionEventColor(type, isDarkMode));
}

function darkenHex(color: string): string {
  const hex = color.replace('#', '');
  const normalized =
    hex.length === 3
      ? hex
          .split('')
          .map(char => `${char}${char}`)
          .join('')
      : hex;
  if (normalized.length !== 6) return color;
  const value = Number.parseInt(normalized, 16);
  const channel = (shift: number) =>
    Math.max(0, Math.round(((value >> shift) & 255) * 0.9))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/** Return the contributor-facing label shown in the event-type filter and dataset metadata. */
export function getSessionEventLabel(type: SessionEventType): string {
  return SESSION_EVENT_TYPES.find(eventType => eventType.id === type)?.label ?? type;
}

/** Use message-specific tooltip headings while falling back to the legend label. */
export function getSessionEventTooltipHeading(type: SessionEventType): string {
  return TOOLTIP_HEADINGS[type] ?? getSessionEventLabel(type);
}
