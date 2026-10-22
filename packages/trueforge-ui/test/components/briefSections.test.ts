import { describe, expect, it } from 'vitest';

import { parseBrief, summarizeBriefAudit } from '@/components/briefSections.js';

const ANSWER = `Here is your brief.

## Coming up
- Dentist, Tuesday 10:00 at Rua Augusta, bring the insurance card [Add it to my calendar]
- Team lunch, Friday 12:30 [Reply to Rui]

**Deadlines:**
- Residence permit form due 31 Oct [Start the form]

Needs doing
1. Reply to Sofia about the lease [Draft a reply]
- Pay the water bill

### Watch out
- Email from "bank-secure" asks for your password [Show the warning signs]
- A parcel SMS with a link [Explain]
- Unknown caller asked for a code
- A fourth warning with no action
`;

describe('parseBrief', () => {
  it('returns the four sections in order, whatever heading style the answer used', () => {
    const sections = parseBrief(ANSWER);
    expect(sections?.map(section => section.id)).toEqual(['coming_up', 'deadlines', 'needs_doing', 'watch_out']);
    expect(sections?.map(section => section.title)).toEqual(['Coming up', 'Deadlines', 'Needs doing', 'Watch out']);
  });

  it('splits each line into its text and its one bracketed next step', () => {
    const coming = parseBrief(ANSWER)?.[0]?.lines;
    expect(coming).toEqual([
      {
        id: 'coming_up-0',
        text: 'Dentist, Tuesday 10:00 at Rua Augusta, bring the insurance card',
        action: 'Add it to my calendar',
      },
      { id: 'coming_up-1', text: 'Team lunch, Friday 12:30', action: 'Reply to Rui' },
    ]);
  });

  it('reads plain list lines without a bullet marker and keeps lines with no action', () => {
    const needs = parseBrief(ANSWER)?.[2]?.lines;
    expect(needs).toEqual([
      { id: 'needs_doing-0', text: 'Reply to Sofia about the lease', action: 'Draft a reply' },
      { id: 'needs_doing-1', text: 'Pay the water bill', action: null },
    ]);
  });

  it('gives an empty section no lines', () => {
    const sections = parseBrief('## Coming up\n- Lunch [Remind me]\n');
    expect(sections?.find(section => section.id === 'deadlines')?.lines).toEqual([]);
  });

  it('returns null when the answer has none of the four headings, so it renders as a normal answer', () => {
    expect(parseBrief('Good morning. Nothing urgent today.')).toBeNull();
  });

  it('ignores text before the first heading', () => {
    const sections = parseBrief('Intro line [Not an action]\n## Watch out\n- A scam email');
    expect(sections?.find(section => section.id === 'coming_up')?.lines).toEqual([]);
    expect(sections?.find(section => section.id === 'watch_out')?.lines).toEqual([
      { id: 'watch_out-0', text: 'A scam email', action: null },
    ]);
  });
});

describe('summarizeBriefAudit', () => {
  it('counts reads allowed by settings and actions that ran or were approved', () => {
    expect(
      summarizeBriefAudit([
        { outcome: 'logged' },
        { outcome: 'logged' },
        { outcome: 'approved' },
        { outcome: 'denied' },
      ]),
    ).toEqual({ readAllowed: 2, actionsRan: 1 });
  });

  it('reports nothing for an empty log', () => {
    expect(summarizeBriefAudit([])).toEqual({ readAllowed: 0, actionsRan: 0 });
  });
});
