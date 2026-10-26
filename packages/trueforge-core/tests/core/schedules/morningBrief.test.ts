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

  it('never leaves half of an emoji before the ellipsis', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const glyph of ['\u{1F600}', '\u{20BB7}']) {
      const digest = parseMorningBrief(answer({ digest: glyph.repeat(300), items: [] }))?.brief.digest ?? '';
      expect(digest.endsWith('…')).toBe(true);
      expect(digest.length).toBeLessThanOrEqual(BRIEF_LIMITS.digest);
      expect(lone.test(digest)).toBe(false);
      expect(digest.slice(0, -1)).toBe(glyph.repeat((digest.length - 1) / 2));
    }
  });

  it('does not end the digest after an abbreviation such as Dr.', () => {
    const filler = 'word '.repeat(30);
    const digest = `${filler}Please ask Dr. Smith about the ${'word '.repeat(60)}end.`;
    const shortened = parseMorningBrief(answer({ digest, items: [] }))?.brief.digest ?? '';
    expect(shortened.endsWith('…')).toBe(true);
    expect(shortened).toContain('Smith');
    expect(shortened.length).toBeLessThanOrEqual(BRIEF_LIMITS.digest);
  });

  it('still ends the digest at a full stop that follows an ordinary word', () => {
    const digest = `${'word '.repeat(30)}Please ask Dr. Smith about it. ${'word '.repeat(60)}end.`;
    expect(parseMorningBrief(answer({ digest, items: [] }))?.brief.digest.endsWith('about it.')).toBe(true);
  });

  it('ends the digest at a full stop after a short name, which is not an abbreviation', () => {
    const digest = `${'word '.repeat(30)}Please ask Bob. ${'word '.repeat(60)}end.`;
    expect(parseMorningBrief(answer({ digest, items: [] }))?.brief.digest.endsWith('ask Bob.')).toBe(true);
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

describe('parseMorningBrief with other ways of writing the JSON', () => {
  const json = JSON.stringify(VALID);

  it.each([
    ['an untagged fence', `Here.\n\n\`\`\`\n${json}\n\`\`\``],
    ['an upper case tag', `Here.\n\n\`\`\`JSON\n${json}\n\`\`\``],
    ['a different tag', `Here.\n\n\`\`\`js\n${json}\n\`\`\``],
    ['a bare object after prose', `Here is your brief: ${json}\nHave a good day.`],
  ])('reads the brief from %s', (_name, text) => {
    expect(parseMorningBrief(text)).toEqual({ brief: VALID, omittedCount: 0 });
  });

  it('keeps a good brief when a later block is some other json', () => {
    const text = `${answer(VALID)}\n\nExtra:\n\n\`\`\`json\n{"note": "done"}\n\`\`\``;
    expect(parseMorningBrief(text)).toEqual({ brief: VALID, omittedCount: 0 });
  });

  it('keeps a good brief when a later block is cut off or broken', () => {
    expect(parseMorningBrief(`${answer(VALID)}\n\n\`\`\`json\n{"digest": "Mor`)?.brief).toEqual(VALID);
    expect(parseMorningBrief(`${answer(VALID)}\n\n\`\`\`json\n{ nope }\n\`\`\``)?.brief).toEqual(VALID);
  });

  it('takes the last block that is a brief when several are', () => {
    const first = { ...VALID, digest: 'Old.' };
    expect(parseMorningBrief(`${answer(first)}\n\n${answer(VALID)}`)?.brief.digest).toBe(VALID.digest);
  });

  it('is not fooled by braces inside strings or in the prose around the object', () => {
    const tricky = { ...VALID, digest: 'Use } and { in text, "quoted" too.' };
    expect(parseMorningBrief(`A { stray brace first. ${JSON.stringify(tricky)}`)?.brief.digest).toBe(tricky.digest);
  });
});

describe('parseMorningBrief and unreadableBriefText on hostile or odd answers', () => {
  const json = JSON.stringify(VALID);

  function milliseconds(run: () => unknown): number {
    const started = performance.now();
    run();
    return performance.now() - started;
  }

  it('finishes fast on an unclosed fence followed by a long run of spaces', () => {
    const text = `\`\`\`${' '.repeat(10000)}`;
    expect(milliseconds(() => parseMorningBrief(text))).toBeLessThan(50);
    expect(milliseconds(() => unreadableBriefText(text))).toBeLessThan(50);
  });

  it('finishes fast on tens of thousands of open braces', () => {
    const text = '{'.repeat(40000);
    expect(milliseconds(() => parseMorningBrief(text))).toBeLessThan(100);
    expect(milliseconds(() => unreadableBriefText(text))).toBeLessThan(100);
  });

  it('finishes fast on many fence openers, quotes and backticks', () => {
    const text = '```json {"a": "`'.repeat(5000) + '```'.repeat(5000);
    expect(milliseconds(() => parseMorningBrief(text))).toBeLessThan(100);
    expect(milliseconds(() => unreadableBriefText(text))).toBeLessThan(100);
  });

  it('keeps a fence open across backticks that sit inside a JSON string', () => {
    const tricky = { ...VALID, digest: 'Use ``` to start a code block.' };
    const text = `Here.\n\n\`\`\`json\n${JSON.stringify(tricky)}\n\`\`\``;
    expect(parseMorningBrief(text)?.brief.digest).toBe('Use to start a code block.');
    const broken = `Here.\n\n\`\`\`json\n{"digest": 5, "note": "see \`\`\` here", "items": []}\n\`\`\`\n\nBye.`;
    expect(unreadableBriefText(broken)).toBe('Here.\nBye.');
  });

  it('finds a full brief after a cut-off object that is followed by a new line', () => {
    const text = `Sorry {"digest": "One", "items": [{"sec\n\nTry again: ${json}`;
    expect(parseMorningBrief(text)).toEqual({ brief: VALID, omittedCount: 0 });
  });

  it('finds a full brief inside an object that never closes and is not json', () => {
    expect(parseMorningBrief(`{ not json at all ${json}`)?.brief).toEqual(VALID);
  });

  it('keeps fenced code in another language, even when it starts with a bracket or brace', () => {
    expect(unreadableBriefText('Try this:\n\n```python\n[n * 2 for n in items]\n```')).toBeNull();
    expect(unreadableBriefText('Try this:\n\n```text\n{ "not": json\n```')).toBeNull();
    expect(unreadableBriefText('Try this:\n\n```python\n{"a": 1\n')).toBeNull();
  });

  it('drops a four-backtick fence without leaving its tag behind', () => {
    expect(unreadableBriefText('Sorry.\n\n````json\n{"digest": 5}\n````')).toBe('Sorry.');
    expect(unreadableBriefText('Sorry.\n\n````json\n{"digest": 5')).toBe('Sorry.');
    expect(parseMorningBrief(`\`\`\`\`json\n${json}\n\`\`\`\``)?.brief).toEqual(VALID);
  });
});

describe('unreadableBriefText', () => {
  it('drops an untagged, upper case or cut-off fence', () => {
    expect(unreadableBriefText('Sorry.\n\n```\n{"digest": 5}\n```')).toBe('Sorry.');
    expect(unreadableBriefText('Sorry.\n\n```JSON\n{"digest": 5}\n```')).toBe('Sorry.');
    expect(unreadableBriefText('Sorry.\n\n```\n{"digest": "One", "ite')).toBe('Sorry.');
    expect(unreadableBriefText('Sorry.\n\n```json\n{ "digest": \n```')).toBe('Sorry.');
  });

  it('drops a bare json object after prose, whole or cut off', () => {
    expect(unreadableBriefText('Sorry. {"digest": 5, "items": []} Bye.')).toBe('Sorry.\nBye.');
    expect(unreadableBriefText('Sorry. {"digest": "One", "items": [{"sec')).toBe('Sorry.');
  });

  it('keeps every word of an answer that only starts with a bracket or brace', () => {
    expect(unreadableBriefText('[Note] I could not open your inbox.')).toBeNull();
    expect(unreadableBriefText('[Open the inbox](https://mail.example.com) did not load.')).toBeNull();
    expect(unreadableBriefText('{Draft} nothing came back.')).toBeNull();
    expect(unreadableBriefText('[Note] Sorry.\n\n```json\n{"digest": 5}\n```')).toBe('Note Sorry.');
  });

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
