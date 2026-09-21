import { describe, expect, it } from 'vitest';

import type { SessionEventTimelineSegment } from '@/utils/sessionEventTimeline.js';
import { buildTimeBreakdown } from '@/utils/timeBreakdown.js';

function segment({
  type,
  startMs,
  endMs,
}: {
  type: SessionEventTimelineSegment['type'];
  startMs: number;
  endMs: number;
}): SessionEventTimelineSegment {
  return {
    id: `${type}-${startMs}`,
    type,
    title: type,
    description: type,
    startMs,
    endMs,
    turnIndex: 0,
    threadId: 'main',
  };
}

function valuesOf(breakdown: ReturnType<typeof buildTimeBreakdown>): Record<string, number> {
  return Object.fromEntries(breakdown.map(datum => [datum.label, datum.value]));
}

describe('buildTimeBreakdown', () => {
  it('sums model, tool, and waiting segments into their buckets', () => {
    const breakdown = buildTimeBreakdown({
      segments: [
        segment({ type: 'model', startMs: 0, endMs: 1000 }),
        segment({ type: 'model', startMs: 1500, endMs: 2000 }),
        segment({ type: 'tool_call', startMs: 2000, endMs: 3500 }),
        segment({ type: 'approval', startMs: 3500, endMs: 4500 }),
        segment({ type: 'waiting_on_human', startMs: 4500, endMs: 5000 }),
      ],
      wallTimeMs: 6000,
    });

    expect(valuesOf(breakdown)).toEqual({
      model: 1500,
      tools: 1500,
      'waiting on human': 1500,
      overhead: 1500,
    });
  });

  it('uses the session-level bucket labels and colours', () => {
    const breakdown = buildTimeBreakdown({ segments: [], wallTimeMs: 1000 });
    expect(breakdown.map(datum => datum.label)).toEqual(['model', 'tools', 'waiting on human', 'overhead']);
    for (const datum of breakdown) {
      expect(datum.color).toMatch(/^#/);
    }
  });

  it('clamps overhead at zero when segments exceed the wall time', () => {
    const breakdown = buildTimeBreakdown({
      segments: [segment({ type: 'model', startMs: 0, endMs: 5000 })],
      wallTimeMs: 1000,
    });
    expect(valuesOf(breakdown).overhead).toBe(0);
  });

  it('ignores inverted segments instead of going negative', () => {
    const breakdown = buildTimeBreakdown({
      segments: [segment({ type: 'tool_call', startMs: 900, endMs: 100 })],
      wallTimeMs: 1000,
    });
    expect(valuesOf(breakdown)).toEqual({ model: 0, tools: 0, 'waiting on human': 0, overhead: 1000 });
  });

  it('reports the full wall time as overhead when there are no segments', () => {
    const breakdown = buildTimeBreakdown({ segments: [], wallTimeMs: 2500 });
    expect(valuesOf(breakdown).overhead).toBe(2500);
  });
});
