import {
  BRIEF_LIMITS,
  briefItemKey,
  isMorningBriefPrompt,
  MORNING_BRIEF_PROMPT,
  MorningBriefSchema,
  parseMorningBrief,
  unreadableBriefText,
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

  it('names every limit the schema holds the model to, from the same constants', () => {
    const limits = [
      BRIEF_LIMITS.digest,
      BRIEF_LIMITS.items,
      BRIEF_LIMITS.title,
      BRIEF_LIMITS.subtitleParts,
      BRIEF_LIMITS.subtitlePart,
      BRIEF_LIMITS.actionLabel,
      BRIEF_LIMITS.promptText,
      BRIEF_LIMITS.source,
    ];
    for (const limit of limits) {
      expect(MORNING_BRIEF_PROMPT).toContain(`at most ${String(limit)} `);
    }
    expect(MORNING_BRIEF_PROMPT).toContain(`digest sentence of at most ${String(BRIEF_LIMITS.digest)} characters`);
    expect(MORNING_BRIEF_PROMPT).toContain(`a title is at most ${String(BRIEF_LIMITS.title)} characters`);
    expect(MORNING_BRIEF_PROMPT).toContain(`an action label is at most ${String(BRIEF_LIMITS.actionLabel)} characters`);
  });

  it('states limits the schema enforces: an item at each limit passes and one over it does not', () => {
    const base = VALID.items[0];
    const atLimits = {
      ...base,
      title: 'a'.repeat(BRIEF_LIMITS.title),
      subtitle: Array.from({ length: BRIEF_LIMITS.subtitleParts }, () => 'b'.repeat(BRIEF_LIMITS.subtitlePart)),
      source: 'c'.repeat(BRIEF_LIMITS.source),
      action: {
        label: 'd'.repeat(BRIEF_LIMITS.actionLabel),
        target: { kind: 'prompt', text: 'e'.repeat(BRIEF_LIMITS.promptText) },
      },
    };
    expect(MorningBriefSchema.safeParse({ digest: 'x', items: [atLimits] }).success).toBe(true);
    const overs = [
      { ...atLimits, title: 'a'.repeat(BRIEF_LIMITS.title + 1) },
      { ...atLimits, subtitle: [...atLimits.subtitle, 'x'] },
      { ...atLimits, subtitle: ['b'.repeat(BRIEF_LIMITS.subtitlePart + 1)] },
      { ...atLimits, source: 'c'.repeat(BRIEF_LIMITS.source + 1) },
      { ...atLimits, action: { ...atLimits.action, label: 'd'.repeat(BRIEF_LIMITS.actionLabel + 1) } },
      {
        ...atLimits,
        action: { ...atLimits.action, target: { kind: 'prompt', text: 'e'.repeat(BRIEF_LIMITS.promptText + 1) } },
      },
    ];
    for (const over of overs) {
      expect(MorningBriefSchema.safeParse({ digest: 'x', items: [over] }).success).toBe(false);
    }
  });

  it('asks only for prompt next steps, never web links', () => {
    expect(MORNING_BRIEF_PROMPT).not.toContain('"link"');
    expect(MORNING_BRIEF_PROMPT).not.toContain('https link');
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
    expect(parseMorningBrief(answer(VALID))).toEqual({ brief: VALID, omittedCount: 0 });
  });

  it('returns null when there is no json block, so the answer shows as plain text', () => {
    expect(parseMorningBrief('Good morning. Nothing urgent today.')).toBeNull();
  });

  it('returns null for invalid json', () => {
    expect(parseMorningBrief('```json\n{ "digest": \n```')).toBeNull();
  });

  it('leaves out an item that breaks the shape, such as an unknown section, and counts it', () => {
    const broken = { ...VALID, items: [{ ...VALID.items[0], section: 'watch_out' }, VALID.items[1]] };
    expect(parseMorningBrief(answer(broken))).toEqual({
      brief: { digest: VALID.digest, items: [VALID.items[1]] },
      omittedCount: 1,
    });
  });

  it('leaves out a link that is not https', () => {
    const item = {
      section: 'decision',
      title: 'Pay the water bill',
      subtitle: [],
      action: { label: 'Open', target: { kind: 'link', url: 'javascript:alert(1)' } },
    };
    expect(parseMorningBrief(answer({ digest: 'One item.', items: [item] }))).toEqual({
      brief: { digest: 'One item.', items: [] },
      omittedCount: 1,
    });
  });

  it('reads a block whose closing fence has no newline before it', () => {
    expect(parseMorningBrief(`\`\`\`json\n${JSON.stringify(VALID)}\`\`\``)).toEqual({ brief: VALID, omittedCount: 0 });
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
    expect(parseMorningBrief(answer(marked))?.brief).toEqual({
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

  it('leaves out an item whose title is only markdown', () => {
    const item = { ...VALID.items[0], title: '****' };
    expect(parseMorningBrief(answer({ digest: 'One item.', items: [item] }))?.omittedCount).toBe(1);
  });

  it('requires a when only as an offset ISO time, and leaves out an item without one', () => {
    const item = { ...VALID.items[1], when: 'Sunday 3:30pm' };
    expect(parseMorningBrief(answer({ digest: 'One item.', items: [item] }))?.omittedCount).toBe(1);
  });
});

function decisionItem(index: number) {
  return {
    section: 'decision',
    title: `Reply to person ${String(index)}`,
    subtitle: ['Lease'],
    action: { label: 'Draft a reply', target: { kind: 'prompt', text: `Draft a reply to person ${String(index)}` } },
  };
}

describe('parseMorningBrief with a long digest', () => {
  const SENTENCE = 'Nine things need you today and the lease reply is the most urgent one.';
  const LONG_DIGEST = `${SENTENCE} ${SENTENCE} ${SENTENCE} ${SENTENCE} ${SENTENCE} Please start with the first.`;

  it('shows all 9 items when the digest runs to about 390 characters', () => {
    const items = Array.from({ length: 9 }, (_, index) => decisionItem(index + 1));
    const oneSentence = `${Array.from({ length: 56 }, (_, index) => `word${String(index)}`).join(' ')}.`;
    const read = parseMorningBrief(answer({ digest: oneSentence, items }));
    expect(oneSentence.length).toBeGreaterThan(380);
    expect(read).not.toBeNull();
    expect(read?.brief.items).toHaveLength(9);
    expect(read?.omittedCount).toBe(0);
  });

  it('shortens a long digest at the last whole sentence that fits', () => {
    const digest = parseMorningBrief(answer({ digest: LONG_DIGEST, items: [] }))?.brief.digest;
    expect(digest).toBe(`${SENTENCE} ${SENTENCE} ${SENTENCE}`);
    expect(digest?.length).toBeLessThanOrEqual(BRIEF_LIMITS.digest);
  });

  it('shortens one very long sentence at a word, with an ellipsis, inside the limit', () => {
    const words = Array.from({ length: 80 }, (_, index) => `word${String(index)}`).join(' ');
    const digest = parseMorningBrief(answer({ digest: `${words}.`, items: [] }))?.brief.digest ?? '';
    expect(digest.endsWith('…')).toBe(true);
    expect(digest.length).toBeLessThanOrEqual(BRIEF_LIMITS.digest);
    expect(words.startsWith(digest.slice(0, -1))).toBe(true);
    expect(/\sword\d*$/.test(digest.slice(0, -1))).toBe(true);
    expect(words.slice(digest.length - 1)).toMatch(/^\s?word\d+/);
  });

  it('cuts one unbroken run of letters inside the limit', () => {
    const digest = parseMorningBrief(answer({ digest: 'x'.repeat(500), items: [] }))?.brief.digest ?? '';
    expect(digest).toBe(`${'x'.repeat(BRIEF_LIMITS.digest - 1)}…`);
  });

  it('keeps a digest that is exactly at the limit', () => {
    const digest = 'y'.repeat(BRIEF_LIMITS.digest);
    expect(parseMorningBrief(answer({ digest, items: [] }))?.brief.digest).toBe(digest);
  });

  it('refuses a digest far beyond any sane length', () => {
    const digest = 'z'.repeat(BRIEF_LIMITS.digestCeiling + 1);
    expect(parseMorningBrief(answer({ digest, items: [] }))).toBeNull();
  });
});

describe('parseMorningBrief with items that do not fit', () => {
  it('shows the other items and counts the one it left out', () => {
    const items = [decisionItem(1), { ...decisionItem(2), title: 'x'.repeat(BRIEF_LIMITS.title + 1) }, decisionItem(3)];
    const read = parseMorningBrief(answer({ digest: 'Three replies.', items }));
    expect(read?.brief.items.map(item => item.title)).toEqual(['Reply to person 1', 'Reply to person 3']);
    expect(read?.omittedCount).toBe(1);
  });

  it('counts items past the most a brief holds as left out', () => {
    const items = Array.from({ length: BRIEF_LIMITS.items + 2 }, (_, index) => decisionItem(index + 1));
    const read = parseMorningBrief(answer({ digest: 'Many replies.', items }));
    expect(read?.brief.items).toHaveLength(BRIEF_LIMITS.items);
    expect(read?.omittedCount).toBe(2);
  });

  it('returns null when the items are not a list', () => {
    expect(parseMorningBrief(answer({ digest: 'One.', items: 'none' }))).toBeNull();
  });
});

describe('unreadableBriefText', () => {
  it('drops a cut-off json block and keeps the words before it', () => {
    const text = unreadableBriefText('Here is **your** brief.\n\n```json\n{"digest": "One thing", "items": [{"sec');
    expect(text).toBe('Here is your brief.');
  });

  it('drops a finished json block that could not be read', () => {
    const text = unreadableBriefText('Your mail could not be read.\n\n```json\n{"digest": 5}\n```\n\nSorry.');
    expect(text).toBe('Your mail could not be read.\nSorry.');
  });

  it('gives nothing when only json was sent, bare or fenced', () => {
    expect(unreadableBriefText('```json\n{"digest":')).toBe('');
    expect(unreadableBriefText('{"digest": "One", "items": []}')).toBe('');
  });

  it('gives null when the answer holds no json, so it shows as written', () => {
    expect(unreadableBriefText('Your **mail** could not be read this morning.')).toBeNull();
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
