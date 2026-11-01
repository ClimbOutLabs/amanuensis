import { describe, expect, it } from 'vitest';

import {
  dateGroupLabel,
  DEFAULT_MEMORY_FILTERS,
  filterMemories,
  forgetConfirmCopy,
  forgottenCopy,
  groupMemoriesByDate,
  memoryCountCopy,
  ownerFilterFromValue,
  sortNewestFirst,
  type ExplorerMemory,
  type MemoryFilters,
} from '@/atoms/memory/memoryExplorer.js';

// A fixed local "now" keeps every relative date deterministic across machines.
const NOW = new Date(2026, 9, 22, 12, 0, 0);

function localDay({ daysAgo, hour = 9 }: { daysAgo: number; hour?: number }): string {
  return new Date(2026, 9, 22 - daysAgo, hour, 0, 0).toISOString();
}

function memory(overrides: Partial<ExplorerMemory> & { id: string; text: string }): ExplorerMemory {
  return {
    timestamp: localDay({ daysAgo: 0 }),
    persona: null,
    owner: 'you',
    ...overrides,
  };
}

const MEMORIES: ExplorerMemory[] = [
  memory({ id: 'tea', text: 'Drinks **tea** in the morning.', timestamp: localDay({ daysAgo: 0 }) }),
  memory({ id: 'meetings', text: 'Prefers morning meetings.', timestamp: localDay({ daysAgo: 3 }) }),
  memory({ id: 'trip', text: 'Planning a trip to Lisbon.', timestamp: localDay({ daysAgo: 20 }), owner: 'shared' }),
  memory({
    id: 'alpha',
    text: 'Alpha prefers short replies.',
    timestamp: localDay({ daysAgo: 40 }),
    owner: 'persona',
    persona: 'Alpha',
  }),
  memory({
    id: 'beta',
    text: 'Beta books the room.',
    timestamp: localDay({ daysAgo: 1 }),
    owner: 'persona',
    persona: 'Beta',
  }),
];

function run(filters: Partial<MemoryFilters>, memories: ExplorerMemory[] = MEMORIES): string[] {
  return filterMemories({ memories, filters: { ...DEFAULT_MEMORY_FILTERS, ...filters }, now: NOW }).map(
    item => item.id,
  );
}

describe('filterMemories', () => {
  it('matches the search text without regard to case, on the stored text', () => {
    expect(run({ query: 'MORNING' })).toEqual(['tea', 'meetings']);
    expect(run({ query: '  lisbon  ' })).toEqual(['trip']);
  });

  it('keeps everything when the search is blank', () => {
    expect(run({ query: '   ' })).toHaveLength(MEMORIES.length);
  });

  it('narrows by whose memory it is', () => {
    expect(run({ owner: 'you' })).toEqual(['tea', 'meetings']);
    expect(run({ owner: 'shared' })).toEqual(['trip']);
    expect(run({ owner: 'persona:Alpha' })).toEqual(['alpha']);
    expect(run({ owner: ownerFilterFromValue('persona:Beta') })).toEqual(['beta']);
  });

  it('narrows to today, this week, and this month', () => {
    expect(run({ saved: 'today' })).toEqual(['tea']);
    expect(run({ saved: 'week' })).toEqual(['tea', 'meetings', 'beta']);
    expect(run({ saved: 'month' })).toEqual(['tea', 'meetings', 'trip', 'beta']);
  });

  it('narrows to a date range, with both ends inclusive', () => {
    expect(run({ saved: 'range', from: '2026-10-19', to: '2026-10-21' })).toEqual(['meetings', 'beta']);
    expect(run({ saved: 'range', from: '2026-10-22', to: '' })).toEqual(['tea']);
    expect(run({ saved: 'range', from: '', to: '2026-09-30' })).toEqual(['alpha']);
  });

  it('treats an unreadable range day as no limit on that side', () => {
    expect(run({ saved: 'range', from: 'not a day', to: '' })).toHaveLength(MEMORIES.length);
  });

  it('narrows to memories changed in the last seven days', () => {
    expect(run({ changedRecently: true })).toEqual(['tea', 'meetings', 'beta']);
  });

  it('combines filters with AND', () => {
    expect(run({ query: 'morning', owner: 'you', changedRecently: true })).toEqual(['tea', 'meetings']);
    expect(run({ query: 'morning', owner: 'persona:Alpha' })).toEqual([]);
  });

  it('keeps the order it was given', () => {
    expect(run({ saved: 'any' })).toEqual(MEMORIES.map(item => item.id));
  });
});

describe('sortNewestFirst', () => {
  it('puts the newest first and an unreadable timestamp last', () => {
    const sorted = sortNewestFirst([
      memory({ id: 'old', text: 'old', timestamp: localDay({ daysAgo: 5 }) }),
      memory({ id: 'broken', text: 'broken', timestamp: 'nope' }),
      memory({ id: 'new', text: 'new', timestamp: localDay({ daysAgo: 0 }) }),
    ]);
    expect(sorted.map(item => item.id)).toEqual(['new', 'old', 'broken']);
  });
});

describe('dateGroupLabel', () => {
  it('names today, yesterday, last week, then the month and year', () => {
    expect(dateGroupLabel({ timestamp: localDay({ daysAgo: 0, hour: 1 }), now: NOW })).toBe('Today');
    expect(dateGroupLabel({ timestamp: localDay({ daysAgo: 1 }), now: NOW })).toBe('Yesterday');
    expect(dateGroupLabel({ timestamp: localDay({ daysAgo: 6 }), now: NOW })).toBe('Last week');
    expect(dateGroupLabel({ timestamp: localDay({ daysAgo: 7 }), now: NOW })).toBe('Last week');
    expect(dateGroupLabel({ timestamp: localDay({ daysAgo: 8 }), now: NOW })).toBe('October 2026');
    expect(dateGroupLabel({ timestamp: new Date(2026, 2, 14, 9).toISOString(), now: NOW })).toBe('March 2026');
  });

  it('files a memory with an unreadable timestamp under Earlier', () => {
    expect(dateGroupLabel({ timestamp: 'nope', now: NOW })).toBe('Earlier');
  });
});

describe('groupMemoriesByDate', () => {
  it('groups consecutive memories under one heading, keeping the newest-first order', () => {
    const groups = groupMemoriesByDate({
      memories: sortNewestFirst([
        memory({ id: 'a', text: 'a', timestamp: localDay({ daysAgo: 0, hour: 18 }) }),
        memory({ id: 'b', text: 'b', timestamp: localDay({ daysAgo: 0, hour: 8 }) }),
        memory({ id: 'c', text: 'c', timestamp: localDay({ daysAgo: 2 }) }),
        memory({ id: 'd', text: 'd', timestamp: localDay({ daysAgo: 30 }) }),
      ]),
      now: NOW,
    });
    expect(groups.map(group => group.label)).toEqual(['Today', 'Last week', 'September 2026']);
    expect(groups[0]?.memories.map(item => item.id)).toEqual(['a', 'b']);
  });
});

describe('plain-words copy', () => {
  it('counts memories about you and those that belong to personas, by the display name', () => {
    expect(memoryCountCopy({ total: 1240, personas: 86, assistant: 'Juniper' })).toBe(
      'Juniper remembers 1,240 things about you. 86 belong to personas.',
    );
    expect(memoryCountCopy({ total: 1, personas: 0, assistant: 'Juniper' })).toBe(
      'Juniper remembers 1 thing about you. None belong to personas.',
    );
    expect(memoryCountCopy({ total: 5, personas: 1, assistant: 'Juniper' })).toBe(
      'Juniper remembers 5 things about you. 1 belongs to a persona.',
    );
  });

  it('asks before forgetting several memories', () => {
    expect(forgetConfirmCopy({ count: 12, assistant: 'Juniper' })).toBe(
      "Forget 12 memories? Juniper won't use them again.",
    );
    expect(forgetConfirmCopy({ count: 1, assistant: 'Juniper' })).toBe(
      "Forget 1 memory? Juniper won't use them again.",
    );
  });

  it('confirms what was forgotten', () => {
    expect(forgottenCopy(1)).toBe('Forgot 1 memory.');
    expect(forgottenCopy(3)).toBe('Forgot 3 memories.');
  });

  it('never shows the internal words in these strings', () => {
    const strings = [
      memoryCountCopy({ total: 2, personas: 2, assistant: 'Juniper' }),
      forgetConfirmCopy({ count: 2, assistant: 'Juniper' }),
      forgottenCopy(2),
    ];
    for (const text of strings) {
      expect(text).not.toMatch(/vault|namespace|entry|specialist|\bagents?\b/i);
    }
  });
});
