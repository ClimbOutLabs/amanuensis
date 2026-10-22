import {
  briefItemKey,
  isMorningBriefPrompt,
  MORNING_BRIEF_PROMPT,
  parseMorningBrief,
} from '../../../src/core/schedules/morningBrief';

const VALID = {
  digest: 'One thing to check, and Sunday is busy.',
  items: [
    {
      section: 'check_first',
      title: "Victor's Nov 16 invite says 4:00am PST",
      subtitle: ['Likely meant 4:00pm'],
      action: { label: 'Ask Victor', target: { kind: 'prompt', text: 'Ask Victor about the time' } },
    },
    {
      section: 'coming_up',
      title: 'Sunday party',
      subtitle: ['683 Florida St, SF', 'with Wendy'],
      when: '2026-10-25T15:30:00-07:00',
      action: { label: 'Plan route', target: { kind: 'link', url: 'https://maps.example.com/route' } },
    },
  ],
};

function answer(payload: unknown): string {
  return `Here is your brief.\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
}

describe('MORNING_BRIEF_PROMPT', () => {
  it('is the one brief prompt: numbered steps that ask for sources and never send or save', () => {
    expect(
      MORNING_BRIEF_PROMPT.startsWith('Give me my morning brief. 1. Read everything new since my last brief'),
    ).toBe(true);
    for (const step of [
      ' 2. Write one plain-words digest',
      ' 3. Give the answer as one JSON object',
      ' 4. If something',
    ]) {
      expect(MORNING_BRIEF_PROMPT).toContain(step);
    }
    expect(MORNING_BRIEF_PROMPT).toContain('do not send or save anything without asking me');
  });

  it('asks for the four item sections, with conflicts and likely errors under check_first', () => {
    expect(MORNING_BRIEF_PROMPT).toContain('"check_first" | "decision" | "coming_up" | "deadline"');
    expect(MORNING_BRIEF_PROMPT).toContain('Put anything that may be wrong');
  });
});

describe('isMorningBriefPrompt', () => {
  it('recognises the brief prompt and older briefs that share its opening', () => {
    expect(isMorningBriefPrompt(MORNING_BRIEF_PROMPT)).toBe(true);
    expect(isMorningBriefPrompt('Give me my morning brief.')).toBe(true);
  });

  it('does not match other messages', () => {
    expect(isMorningBriefPrompt('What is my morning routine?')).toBe(false);
    expect(isMorningBriefPrompt(`Please: ${MORNING_BRIEF_PROMPT}`)).toBe(false);
  });
});

describe('parseMorningBrief', () => {
  it('reads the brief from the json block of an answer', () => {
    expect(parseMorningBrief(answer(VALID))).toEqual(VALID);
  });

  it('returns null when there is no json block, so the answer shows as plain text', () => {
    expect(parseMorningBrief('Good morning. Nothing urgent today.')).toBeNull();
  });

  it('returns null for invalid json', () => {
    expect(parseMorningBrief('```json\n{ "digest": \n```')).toBeNull();
  });

  it('returns null when an item breaks the shape, such as an unknown section', () => {
    const broken = { ...VALID, items: [{ ...VALID.items[0], section: 'watch_out' }] };
    expect(parseMorningBrief(answer(broken))).toBeNull();
  });

  it('refuses a link that is not https', () => {
    const item = {
      section: 'decision',
      title: 'Pay the water bill',
      subtitle: [],
      action: { label: 'Open', target: { kind: 'link', url: 'javascript:alert(1)' } },
    };
    expect(parseMorningBrief(answer({ digest: 'One item.', items: [item] }))).toBeNull();
  });

  it('reads a block whose closing fence has no newline before it', () => {
    expect(parseMorningBrief(`\`\`\`json\n${JSON.stringify(VALID)}\`\`\``)).toEqual(VALID);
  });

  it('returns null while the block is still unfinished', () => {
    expect(parseMorningBrief('```json\n{"digest": "One')).toBeNull();
  });

  it('strips markdown from every shown field and lifts a bare source word into the source label', () => {
    const marked = {
      digest: '**Two things** to check, *one* from `mail`.',
      items: [
        {
          section: 'coming_up',
          title: '**Fri 10/23, 10:00 AM** _Dentist_ at [Oak Clinic](https://clinic.example.com)',
          subtitle: ['*calendar*', '**Ref PVNQDX6V4FW**', '__bring__ the `form`', '**'],
          when: '2026-10-23T10:00:00-07:00',
          action: { label: '[Check the route]', target: { kind: 'link', url: 'https://maps.example.com/r?a=1' } },
        },
        {
          section: 'decision',
          title: '# Reply to *Wren*',
          subtitle: ['- from snake_case_list'],
          source: '*email*',
          action: { label: '**Draft reply**', target: { kind: 'prompt', text: 'Draft a **reply** to Wren' } },
        },
      ],
    };
    expect(parseMorningBrief(answer(marked))).toEqual({
      digest: 'Two things to check, one from mail.',
      items: [
        {
          section: 'coming_up',
          title: 'Fri 10/23, 10:00 AM Dentist at Oak Clinic',
          subtitle: ['Ref PVNQDX6V4FW', 'bring the form'],
          source: 'calendar',
          when: '2026-10-23T10:00:00-07:00',
          action: { label: 'Check the route', target: { kind: 'link', url: 'https://maps.example.com/r?a=1' } },
        },
        {
          section: 'decision',
          title: 'Reply to Wren',
          subtitle: ['from snake_case_list'],
          source: 'email',
          // The prompt is sent, not shown, so it keeps the model's text as written.
          action: { label: 'Draft reply', target: { kind: 'prompt', text: 'Draft a **reply** to Wren' } },
        },
      ],
    });
  });

  it('returns null when a title is only markdown, so the answer shows as plain text', () => {
    const item = { ...VALID.items[0], title: '****' };
    expect(parseMorningBrief(answer({ digest: 'One item.', items: [item] }))).toBeNull();
  });

  it('requires a when only as an offset ISO time', () => {
    const item = { ...VALID.items[1], when: 'Sunday 3:30pm' };
    expect(parseMorningBrief(answer({ digest: 'One item.', items: [item] }))).toBeNull();
  });
});

describe('briefItemKey', () => {
  it('is the same for the same section and title, whatever the case or spacing', () => {
    const key = briefItemKey({ section: 'decision', title: 'Reply to Sofia' });
    expect(briefItemKey({ section: 'decision', title: '  reply to SOFIA ' })).toBe(key);
  });

  it('differs when the section differs', () => {
    expect(briefItemKey({ section: 'decision', title: 'Reply' })).not.toBe(
      briefItemKey({ section: 'deadline', title: 'Reply' }),
    );
  });
});
