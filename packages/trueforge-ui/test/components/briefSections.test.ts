import { briefItemKey, type MorningBrief } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { describe, expect, it } from 'vitest';

import {
  briefFooterLine,
  briefGreeting,
  briefTopBarTitle,
  briefWhenLabel,
  buildBriefView,
  summarizeBriefAudit,
} from '@/components/briefSections.js';

function item(section: MorningBrief['items'][number]['section'], title: string) {
  const action = { label: 'Open', target: { kind: 'prompt' as const, text: `Open ${title}` } };
  return { section, title, subtitle: ['Part one', 'Part two'], action };
}

const BRIEF: MorningBrief = {
  digest: 'One thing to check.',
  items: [
    item('decision', 'Reply to Ines'),
    item('check_first', 'Mateo invite says 4:00am'),
    item('decision', 'Pick a dentist slot'),
    item('deadline', 'Permit form due'),
    item('decision', 'Sign the lease'),
    item('decision', 'Confirm the cake order'),
    item('decision', 'Book the van'),
    item('decision', 'Ask about the parking pass'),
  ],
};

describe('buildBriefView', () => {
  it('shows the sections in order and leaves out empty ones', () => {
    const view = buildBriefView({ brief: BRIEF, hiddenKeys: new Set(), expanded: true });
    expect(view.sections.map(section => section.label)).toEqual(['Check first', 'Needs a decision', 'Deadlines']);
  });

  it('shows at most six items by default and says how many are hidden', () => {
    const view = buildBriefView({ brief: BRIEF, hiddenKeys: new Set(), expanded: false });
    const shown = view.sections.reduce((total, section) => total + section.items.length, 0);
    expect(shown).toBe(6);
    expect(view.hiddenCount).toBe(2);
  });

  it('keeps each section count equal to its real items, even when some are hidden behind the limit', () => {
    const view = buildBriefView({ brief: BRIEF, hiddenKeys: new Set(), expanded: false });
    expect(view.sections.find(section => section.section === 'decision')?.count).toBe(6);
  });

  it('shows every item once expanded', () => {
    const view = buildBriefView({ brief: BRIEF, hiddenKeys: new Set(), expanded: true });
    expect(view.hiddenCount).toBe(0);
  });

  it('leaves out items whose keys are hidden, such as ones already done', () => {
    const key = briefItemKey({ section: 'check_first', title: 'Mateo invite says 4:00am' });
    const view = buildBriefView({ brief: BRIEF, hiddenKeys: new Set([key]), expanded: true });
    expect(view.sections.some(section => section.section === 'check_first')).toBe(false);
  });
});

describe('briefGreeting', () => {
  it('uses the part of the day by local hour, with the name when there is one', () => {
    expect(briefGreeting({ now: new Date(2026, 9, 20, 9), name: 'Ana' })).toBe('Good morning, Ana');
    expect(briefGreeting({ now: new Date(2026, 9, 20, 14), name: 'Ana' })).toBe('Good afternoon, Ana');
    expect(briefGreeting({ now: new Date(2026, 9, 20, 20), name: undefined })).toBe('Good evening');
  });
});

describe('briefTopBarTitle', () => {
  it('names the weekday, day and month', () => {
    expect(briefTopBarTitle(new Date(2026, 9, 20))).toBe('Brief · Tuesday 20 October');
  });
});

describe('briefWhenLabel', () => {
  it('shows the day, day of month, and time in the browser time zone', () => {
    expect(briefWhenLabel(new Date(2026, 9, 25, 15, 30).toISOString())).toBe('Sun 25 / 3:30pm');
  });

  it('is undefined for a time that does not parse', () => {
    expect(briefWhenLabel('not a time')).toBeUndefined();
  });
});

describe('summarizeBriefAudit and briefFooterLine', () => {
  it('leaves out brief item marks from the counts', () => {
    const summary = summarizeBriefAudit([
      { outcome: 'logged', action_type: 'mail.read' },
      { outcome: 'logged', action_type: 'brief.item_done' },
      { outcome: 'ran', action_type: 'mail.send' },
    ]);
    expect(summary).toEqual({ readQuietly: 1, actionsRan: 1 });
  });

  it('says what was read and that nothing was sent when no action ran', () => {
    expect(briefFooterLine({ readQuietly: 12, actionsRan: 0 })).toBe('Read 12 things quietly. Sent nothing.');
  });

  it('counts the actions that ran instead of claiming nothing was sent', () => {
    expect(briefFooterLine({ readQuietly: 1, actionsRan: 2 })).toBe('Read 1 thing quietly. 2 actions ran.');
  });
});
