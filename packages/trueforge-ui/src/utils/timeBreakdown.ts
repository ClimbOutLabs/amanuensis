import type { SessionMetricBarDatum } from './buildSessionMetrics.js';
import { resolveSessionEventColor, type SessionEventTimelineSegment } from './sessionEventTimeline.js';

/**
 * Shared "where the time went" buckets for session and turn scopes.
 *
 * Model and tool time come from their timeline segments; approval and
 * waiting-on-human segments fold into one human-wait bucket. Anything left
 * over against the wall-clock duration is overhead (context processing,
 * queueing, persistence). The buckets use the same labels and colours as the
 * session-level breakdown so both read identically.
 */
export function buildTimeBreakdown({
  segments,
  wallTimeMs,
}: {
  segments: SessionEventTimelineSegment[];
  wallTimeMs: number;
}): SessionMetricBarDatum[] {
  const durationOf = (segment: SessionEventTimelineSegment): number => Math.max(0, segment.endMs - segment.startMs);
  const sumTypes = (types: SessionEventTimelineSegment['type'][]): number =>
    segments.filter(segment => types.includes(segment.type)).reduce((sum, segment) => sum + durationOf(segment), 0);

  const modelMs = sumTypes(['model']);
  const toolMs = sumTypes(['tool_call']);
  const waitingMs = sumTypes(['waiting_on_human', 'approval']);
  const overheadMs = Math.max(0, wallTimeMs - modelMs - toolMs - waitingMs);

  return [
    { label: 'model', value: modelMs, color: resolveSessionEventColor('model') },
    { label: 'tools', value: toolMs, color: resolveSessionEventColor('tool_call') },
    { label: 'waiting on human', value: waitingMs, color: resolveSessionEventColor('approval') },
    { label: 'overhead', value: overheadMs, color: resolveSessionEventColor('system') },
  ];
}
