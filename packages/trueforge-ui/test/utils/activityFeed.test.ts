import { describe, expect, it } from 'vitest';

import { buildActivityItems } from '@/utils/activityFeed.js';
import type { SessionEventTimelineSegment, SessionEventType } from '@/utils/sessionEventTimeline.js';

const ORIGIN_MS = 1_757_000_000_000;

let nextId = 0;
function makeSegment(
  partial: Partial<SessionEventTimelineSegment> & { type: SessionEventType },
): SessionEventTimelineSegment {
  nextId += 1;
  return {
    id: `seg-${nextId}`,
    title: '',
    description: '',
    startMs: 0,
    endMs: 0,
    turnIndex: 0,
    threadId: 'main',
    ...partial,
  };
}

function toolCall(description: string, startMs: number, durationMs = 1_000): SessionEventTimelineSegment {
  return makeSegment({ type: 'tool_call', description, startMs, endMs: startMs + durationMs });
}

describe('buildActivityItems', () => {
  it('returns an empty list when there are no segments', () => {
    expect(buildActivityItems([], ORIGIN_MS)).toEqual([]);
  });

  it('groups consecutive web searches into one plain-language item', () => {
    const items = buildActivityItems(
      [toolCall('tavily_search', 1_000), toolCall('tavily_search', 2_000), toolCall('tavily_search', 3_000)],
      ORIGIN_MS,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Searched the web');
    expect(items[0]?.detail).toContain('3 searches');
    expect(items[0]?.count).toBe(3);
    expect(items[0]?.timestampMs).toBe(ORIGIN_MS + 1_000);
  });

  it('labels known tool families in plain language', () => {
    const items = buildActivityItems(
      [
        toolCall('tavily_extract', 1_000),
        toolCall('get_calendar_events', 2_000),
        toolCall('gmail_search_threads', 3_000),
      ],
      ORIGIN_MS,
    );
    expect(items.map(item => item.title)).toEqual(['Read web pages', 'Checked your calendar', 'Checked email']);
  });

  it('humanizes unknown tools instead of leaking snake_case', () => {
    const items = buildActivityItems([toolCall('list_projects', 1_000)], ORIGIN_MS);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Listed projects');
    expect(items[0]?.title).not.toContain('_');
  });

  it('renders sandbox intents as checks with the intent as detail', () => {
    const items = buildActivityItems([toolCall('Run the test suite', 1_000)], ORIGIN_MS);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Ran a check');
    expect(items[0]?.detail).toBe('Run the test suite');
  });

  it('skips internal bookkeeping tools', () => {
    const items = buildActivityItems([toolCall('record_finding', 1_000), toolCall('tavily_search', 2_000)], ORIGIN_MS);
    expect(items.map(item => item.title)).toEqual(['Searched the web']);
  });

  it('does not group tool calls separated by other events', () => {
    const items = buildActivityItems(
      [
        toolCall('tavily_search', 1_000),
        makeSegment({ type: 'approval', description: 'Approval required', startMs: 2_000 }),
        toolCall('tavily_search', 3_000),
      ],
      ORIGIN_MS,
    );
    expect(items.map(item => item.title)).toEqual(['Searched the web', 'Asked for your approval', 'Searched the web']);
  });

  it('translates approvals, waits, helpers, snags, and completion', () => {
    const items = buildActivityItems(
      [
        makeSegment({ type: 'approval', description: 'Approval required', startMs: 1_000 }),
        makeSegment({ type: 'waiting_on_human', description: 'Waiting for user response', startMs: 2_000 }),
        makeSegment({
          type: 'waiting_on_human',
          description: 'MCP authentication required',
          startMs: 3_000,
        }),
        makeSegment({ type: 'sub_agent', description: 'research-helper', startMs: 4_000 }),
        makeSegment({ type: 'error', description: 'Error: ECONNREFUSED 10.0.0.1:443', startMs: 5_000 }),
        makeSegment({ type: 'system', title: 'turn.done', description: 'Turn completed', startMs: 6_000 }),
      ],
      ORIGIN_MS,
    );
    expect(items.map(item => item.title)).toEqual([
      'Asked for your approval',
      'Paused for you',
      'Needed you to sign in',
      'Asked a helper',
      'Hit a snag',
      'Wrapped up',
    ]);
    const snag = items[4];
    expect(snag?.detail ?? '').not.toContain('ECONNREFUSED');
  });

  it('omits model, user, and other system segments', () => {
    const items = buildActivityItems(
      [
        makeSegment({ type: 'user', description: 'hello', startMs: 1_000 }),
        makeSegment({ type: 'model', description: 'thinking', startMs: 2_000 }),
        makeSegment({ type: 'system', description: 'Sandbox created', startMs: 3_000 }),
        toolCall('tavily_search', 4_000),
      ],
      ORIGIN_MS,
    );
    expect(items.map(item => item.title)).toEqual(['Searched the web']);
  });

  it('orders items chronologically regardless of input order', () => {
    const items = buildActivityItems(
      [
        makeSegment({ type: 'system', title: 'turn.done', description: 'Turn completed', startMs: 6_000 }),
        toolCall('tavily_search', 1_000),
      ],
      ORIGIN_MS,
    );
    expect(items.map(item => item.title)).toEqual(['Searched the web', 'Wrapped up']);
  });
});
