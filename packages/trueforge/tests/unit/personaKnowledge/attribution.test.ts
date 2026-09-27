import {
  dedupeHitsByDocument,
  findUsedKnowledgeHits,
  formatSourceEntry,
  isPassageUsedInAnswer,
  knowledgeCitationMarker,
  knowledgeHitDocumentKey,
  neutralizeSpoofedCitationMarkers,
  passageSignatureTerms,
  repairAssistantMessageContent,
  repairKnowledgeAttribution,
} from '../../../src/personaKnowledge/knowledgeAttribution';
import type {
  AssistantRefusalPart,
  AssistantTextPart,
} from '../../../src/personaKnowledge/knowledgeAttribution';
import type { PersonaKnowledgeHit } from '../../../src/personaKnowledge/knowledgeRetrieval';

function hit(overrides: Partial<PersonaKnowledgeHit> = {}): PersonaKnowledgeHit {
  return {
    text: 'Giant pandas eat almost exclusively bamboo, consuming 26 to 84 pounds daily.',
    title: 'Giant Panda Diet Notes',
    sourceLabel: 'Panda Care Manual',
    sourceUrl: null,
    similarity: 0.9,
    ...overrides,
  };
}

describe('knowledgeCitationMarker', () => {
  it('is stable and 1-based per passage index', () => {
    expect(knowledgeCitationMarker(0)).toBe('⟦src:1⟧');
    expect(knowledgeCitationMarker(2)).toBe('⟦src:3⟧');
  });
});

describe('neutralizeSpoofedCitationMarkers', () => {
  it('rewrites marker-shaped text inside attacker-influenced content', () => {
    expect(neutralizeSpoofedCitationMarkers('see ⟦src:2⟧ for details')).toBe('see [src] for details');
  });

  it('leaves ordinary brackets alone', () => {
    expect(neutralizeSpoofedCitationMarkers('[1] a normal citation')).toBe('[1] a normal citation');
  });
});

describe('passageSignatureTerms', () => {
  it('surfaces distinctive vocabulary and drops stopwords', () => {
    const terms = passageSignatureTerms('The giant panda eats bamboo shoots and leaves daily.');
    expect(terms).toContain('bamboo');
    expect(terms).toContain('panda');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('and');
  });

  it('tokenizes Spanish text without splitting accented words', () => {
    const terms = passageSignatureTerms('El niño come bambú todos los días en la montaña.');
    expect(terms).toContain('niño');
    expect(terms).toContain('bambú');
    expect(terms).toContain('montaña');
    expect(terms).not.toContain('ni');
  });
});

describe('isPassageUsedInAnswer', () => {
  const passage = 'Giant pandas eat almost exclusively bamboo, consuming 26 to 84 pounds daily.';

  it('detects a paraphrased use with no verbatim overlap', () => {
    const answer =
      'Giant pandas subsist almost entirely on bamboo shoots, putting away dozens of pounds every single day.';
    expect(isPassageUsedInAnswer({ passageText: passage, answerText: answer })).toBe(true);
  });

  it('detects the synthetic-fact shape from live testing', () => {
    const fact = 'Maya Chen sold her startup for $20M in 2024.';
    const answer = 'Maya Chen sold her company for twenty million dollars back in 2024.';
    expect(isPassageUsedInAnswer({ passageText: fact, answerText: answer })).toBe(true);
  });

  it('requires the passage\u2019s distinctive terms, not just shared topic words', () => {
    // Three shared topic words (giant, pandas, bamboo) but only one
    // distinctive term — a same-topic answer, not a use of the passage.
    expect(
      isPassageUsedInAnswer({
        passageText: passage,
        answerText: 'Giant pandas spend most of the day eating bamboo.',
      }),
    ).toBe(false);
    // The same topic words plus the passage's rarest vocabulary.
    expect(
      isPassageUsedInAnswer({
        passageText: passage,
        answerText: 'Giant pandas eat almost exclusively bamboo, dozens of pounds daily.',
      }),
    ).toBe(true);
  });

  it('treats names and numbers as distinctive even when short', () => {
    const fact = 'Maya Chen sold her startup for $20M in 2024 after three years of grinding.';
    expect(
      isPassageUsedInAnswer({
        passageText: fact,
        answerText: 'Maya Chen sold her company for twenty million dollars back in 2024.',
      }),
    ).toBe(true);
  });

  it('does not attribute a short passage on generic topic overlap alone', () => {
    // A 9-word passage has only 5 signature terms; its "rarest 40%" tier is
    // bamboo/eating — generic topic words, not evidence of use. A same-topic
    // answer from general knowledge must not buy a citation.
    const passageText = 'Giant pandas spend most of the day eating bamboo.';
    const answerText = 'Pandas spend hours each day eating bamboo shoots in the wild.';
    expect(isPassageUsedInAnswer({ passageText, answerText })).toBe(false);
  });

  it('still attributes a short passage on near-verbatim overlap', () => {
    const passageText = 'Giant pandas spend most of the day eating bamboo.';
    expect(isPassageUsedInAnswer({ passageText, answerText: passageText })).toBe(true);
  });

  it('attributes short passages anchored by shared numbers', () => {
    // Pure-numeric tokens below the 4-character floor are signature terms,
    // and numbers are hard identifiers, so a short passage still attributes
    // when the answer shares the anchoring numbers.
    const passageText = 'The safe combination is 26 84 for the side gate.';
    const answerText = 'Use 26 84 on the side gate keypad.';
    expect(isPassageUsedInAnswer({ passageText, answerText })).toBe(true);
  });

  it('does not fire on a same-topic answer sharing only generic words', () => {
    const answer = 'Pandas are bears native to the mountains of China.';
    expect(isPassageUsedInAnswer({ passageText: passage, answerText: answer })).toBe(false);
  });

  it('does not fire on an unrelated answer', () => {
    expect(
      isPassageUsedInAnswer({ passageText: passage, answerText: 'The best recipe for sourdough bread.' }),
    ).toBe(false);
  });

  it('does not fire on an empty answer', () => {
    expect(isPassageUsedInAnswer({ passageText: passage, answerText: '   ' })).toBe(false);
  });
});

describe('repairKnowledgeAttribution', () => {
  it('appends a Sources line when a paraphrased passage goes unattributed', () => {
    const answer =
      'Giant pandas subsist almost entirely on bamboo, eating dozens of pounds every day.';
    const repaired = repairKnowledgeAttribution(answer, [hit()]);
    expect(repaired).toBe(`${answer}\n\nSources: Giant Panda Diet Notes (Panda Care Manual)`);
  });

  it('renders the URL when the hit has one', () => {
    const answer = 'Maya Chen sold her startup for $20M in 2024, a huge outcome.';
    const repaired = repairKnowledgeAttribution(answer, [
      hit({
        text: 'Maya Chen sold her startup for $20M in 2024 after three years of grinding.',
        title: 'Startup Exit Story',
        sourceLabel: 'web',
        sourceUrl: 'https://example.com/exit-story',
      }),
    ]);
    expect(repaired).toContain('Sources: Startup Exit Story — https://example.com/exit-story');
  });

  it('strips a model-echoed marker and renders the citation instead', () => {
    const answer = 'Giant pandas eat bamboo daily ⟦src:1⟧, dozens of pounds of it.';
    const repaired = repairKnowledgeAttribution(answer, [hit()]);
    expect(repaired).not.toContain('⟦src:1⟧');
    expect(repaired).toContain('Sources: Giant Panda Diet Notes (Panda Care Manual)');
  });

  it('attributes via the marker even when the prose is too short for overlap', () => {
    const repaired = repairKnowledgeAttribution('Yes, exactly ⟦src:1⟧.', [hit()]);
    expect(repaired).toContain('Sources: Giant Panda Diet Notes (Panda Care Manual)');
  });

  it('leaves the text untouched when no passage was used', () => {
    const answer = 'The weather in Madrid is lovely this time of year.';
    expect(repairKnowledgeAttribution(answer, [hit()])).toBe(answer);
  });

  it('leaves the text untouched when nothing was injected', () => {
    const answer = 'Giant pandas eat bamboo, dozens of pounds daily.';
    expect(repairKnowledgeAttribution(answer, [])).toBe(answer);
  });

  it('lists every used passage, not just the first', () => {
    const first = hit();
    const second = hit({
      text: 'Maya Chen sold her startup for $20M in 2024 after three years of grinding.',
      title: 'Startup Exit Story',
      sourceLabel: 'web',
      sourceUrl: 'https://example.com/exit-story',
    });
    const answer =
      'Giant pandas eat almost exclusively bamboo, dozens of pounds daily. Separately, Maya Chen sold her startup for $20M in 2024.';
    const repaired = repairKnowledgeAttribution(answer, [first, second]);
    expect(repaired).toContain('Giant Panda Diet Notes (Panda Care Manual)');
    expect(repaired).toContain('Startup Exit Story — https://example.com/exit-story');
  });

  it('still appends the single canonical footer when the model already named the title', () => {
    const answer =
      'According to Giant Panda Diet Notes, giant pandas eat dozens of pounds of bamboo daily.';
    const repaired = repairKnowledgeAttribution(answer, [hit()]);
    expect(repaired).toContain('Sources: Giant Panda Diet Notes (Panda Care Manual)');
    expect(repaired.match(/Sources:/g)).toHaveLength(1);
  });

  it('fails open on malformed hits instead of throwing', () => {
    const malformed: PersonaKnowledgeHit = JSON.parse(
      '{"text": 42, "title": null, "sourceLabel": "web", "sourceUrl": null, "similarity": 0}',
    );
    const answer = 'Giant pandas eat almost exclusively bamboo, dozens of pounds daily.';
    expect(() => findUsedKnowledgeHits(answer, [malformed])).not.toThrow();
    expect(findUsedKnowledgeHits(answer, [malformed])).toEqual([]);
    expect(repairKnowledgeAttribution(answer, [malformed])).toBe(answer);
  });
});

describe('adversarial same-topic negatives', () => {
  // Each answer below shares ordinary topic words with the injected passage
  // but none of its distinctive content; all tripped the old ≥3-shared-terms
  // bar and produced bogus footers. A wrong citation is worse than none.
  const cases: Array<[string, string]> = [
    [
      'hibernation question',
      "No — giant pandas don't hibernate the way brown bears do. They stay active through the winter, foraging for bamboo in their mountain habitat.",
    ],
    [
      'danger question',
      'Are pandas dangerous? Giant pandas are generally gentle, but they are still bears — a startled panda defending its bamboo patch can be dangerous.',
    ],
    [
      'habitat question',
      "Giant pandas live in the misty bamboo forests of central China's mountain ranges.",
    ],
    [
      'generic diet sentence',
      'Giant pandas spend most of the day eating bamboo.',
    ],
  ];

  it.each(cases)('leaves a topically-adjacent answer byte-identical (%s)', (_name, answer) => {
    expect(repairKnowledgeAttribution(answer, [hit()])).toBe(answer);
  });

  it('leaves a same-topic startup answer byte-identical', () => {
    const maya = hit({
      text: 'Maya Chen sold her startup for $20M in 2024 after three years of grinding.',
      title: 'Startup Exit Story',
      sourceLabel: 'web',
      sourceUrl: 'https://example.com/exit-story',
    });
    const answer =
      'Many founders sell their companies after years of hard work; eight-figure exits stay rare but celebrated.';
    expect(repairKnowledgeAttribution(answer, [maya])).toBe(answer);
  });
});

describe('formatSourceEntry', () => {
  it('renders a phishing-shaped title inert: no markdown link can form', () => {    const entry = formatSourceEntry(
      hit({
        title: 'Password reset — [verify now](https://accounts-verify.example)',
        sourceLabel: 'web',
        sourceUrl: 'https://accounts-verify.example/reset',
      }),
    );
    expect(entry).not.toContain('[verify now](https://accounts-verify.example)');
    expect(entry).toContain('Password reset — \\[verify now\\]\\(https://accounts-verify.example\\)');
    expect(entry).toContain('https://accounts-verify.example/reset');
  });

  it('escapes a literal backslash exactly once', () => {
    const entry = formatSourceEntry(hit({ title: 'C:\\docs\\notes' }));
    expect(entry).toContain('C:\\\\docs\\\\notes');
    expect(entry).not.toContain('C:\\\\\\\\docs');
  });

  it('strips bidi overrides and control characters from titles', () => {
    const entry = formatSourceEntry(hit({ title: 'Invoice\u202A\u202Efdp.exe' }));
    expect(entry).not.toContain('\u202A');
    expect(entry).not.toContain('\u202E');
    expect(entry).toContain('Invoicefdp.exe');
  });

  it('neutralizes marker-shaped text in titles, like the injection path does', () => {
    expect(formatSourceEntry(hit({ title: 'Doc ⟦src:2⟧ notes' }))).toBe(
      'Doc \\[src\\] notes (Panda Care Manual)',
    );
  });

  it('omits non-http(s) URLs and falls back to the label', () => {
    const entry = formatSourceEntry(
      hit({ title: 'Evil Doc', sourceUrl: 'javascript:alert(document.domain)' }),
    );
    expect(entry).not.toContain('javascript:');
    expect(entry).toBe('Evil Doc (Panda Care Manual)');
  });

  it('keeps https URLs usable while percent-encoding markdown link syntax', () => {
    const entry = formatSourceEntry(
      hit({ title: 'Notes', sourceUrl: 'https://en.wikipedia.org/wiki/Panda_(disambiguation)' }),
    );
    // Parens cannot form a markdown link; they stay percent-encoded (still a
    // valid, copy-pasteable URL) instead of backslash-escaped.
    expect(entry).toBe('Notes — https://en.wikipedia.org/wiki/Panda_%28disambiguation%29');
  });

  it.each([
    {
      name: 'spaced markdown link attack',
      url: 'https://docs.legit.example/guide [Verify document](https://evil.example/phish)',
    },
    {
      name: 'no-space markdown link attack',
      url: 'https://docs.legit.example/guide[Verify document](https://evil.example/phish)',
    },
    {
      name: 'newline markdown link attack',
      url: 'https://docs.legit.example/guide\n[Verify document](https://evil.example/phish)',
    },
  ])('does not render $name URLs as markdown links', ({ url }) => {
    const entry = formatSourceEntry(hit({ title: 'Docs', sourceUrl: url }));
    expect(entry).not.toContain('](https://evil.example/phish)');
    expect(entry).toContain('%5BVerify document%5D%28https://evil.example/phish%29');
  });

  it('percent-encodes brackets and parens in plain URLs without touching the rest', () => {
    const entry = formatSourceEntry(
      hit({ title: 'Docs', sourceUrl: 'https://docs.legit.example/path_(v2)/[draft]' }),
    );
    expect(entry).toBe('Docs — https://docs.legit.example/path_%28v2%29/%5Bdraft%5D');
  });

  it('neutralizes an angle-bracket autolink appended to a legit URL', () => {
    const entry = formatSourceEntry(
      hit({ title: 'Docs', sourceUrl: 'https://docs.legit.example/guide <https://evil.example>' }),
    );
    expect(entry).not.toContain('<https://evil.example>');
    expect(entry).toContain('%3Chttps://evil.example%3E');
  });

  it('omits a bare autolink URL via the scheme allowlist and falls back to the label', () => {
    const entry = formatSourceEntry(hit({ title: 'Docs', sourceUrl: '<https://evil.example>' }));
    expect(entry).not.toContain('<https://evil.example>');
    expect(entry).toBe('Docs (Panda Care Manual)');
  });

  it('escapes angle brackets in titles so no autolink can form', () => {
    const entry = formatSourceEntry(
      hit({ title: 'Legit Guide <https://evil.example>', sourceUrl: 'https://docs.legit.example/guide' }),
    );
    expect(entry).not.toContain('<https://evil.example>');
    expect(entry).toContain('Legit Guide \\<https://evil.example\\>');
  });

  it('neutralizes marker-shaped text in URLs, like the title path does', () => {
    const entry = formatSourceEntry(hit({ title: 'Docs', sourceUrl: 'https://evil.example/⟦src:2⟧' }));
    expect(entry).not.toContain('⟦src:2⟧');
    expect(entry).toBe('Docs — https://evil.example/%5Bsrc%5D');
  });

  it('truncates overlong titles', () => {
    const entry = formatSourceEntry(hit({ title: 'x'.repeat(300) }));
    expect(entry).toContain('x'.repeat(200));
    expect(entry).not.toContain('x'.repeat(201));
  });
});

describe('findUsedKnowledgeHits', () => {
  it('returns the used hits in injection order', () => {
    const first = hit();
    const second = hit({ title: 'Unrelated Doc', text: 'A treatise on sourdough starters and hydration.' });
    const used = findUsedKnowledgeHits(
      'Giant pandas eat almost exclusively bamboo, dozens of pounds daily.',
      [first, second],
    );
    expect(used).toEqual([first]);
  });
});

describe('repairAssistantMessageContent', () => {
  it('repairs plain string content', () => {
    const answer = 'Giant pandas eat almost exclusively bamboo, dozens of pounds daily.';
    const repaired = repairAssistantMessageContent(answer, [hit()]);
    expect(typeof repaired).toBe('string');
    expect(repaired).toContain('Sources: Giant Panda Diet Notes (Panda Care Manual)');
  });

  it('leaves the string byte-identical when nothing was used', () => {
    const answer = 'The weather in Madrid is lovely.';
    expect(repairAssistantMessageContent(answer, [hit()])).toBe(answer);
  });

  it('keeps content-part shape: strips markers per part, footer on the last text part', () => {
    const content: (AssistantTextPart | AssistantRefusalPart)[] = [
      { type: 'text', text: 'Giant pandas eat bamboo ⟦src:1⟧, dozens of pounds daily.' },
      { type: 'refusal', refusal: 'I cannot help with that other thing.' },
      { type: 'text', text: 'They are native to China.' },
    ];
    const repaired = repairAssistantMessageContent(content, [hit()]);
    const texts = repaired.filter((part): part is AssistantTextPart => part.type === 'text');
    const refusals = repaired.filter((part): part is AssistantRefusalPart => part.type === 'refusal');
    expect(texts).toHaveLength(2);
    expect(texts[0]?.text).not.toContain('⟦src:1⟧');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.refusal).toBe('I cannot help with that other thing.');
    expect(texts[texts.length - 1]?.text).toContain('Sources: Giant Panda Diet Notes (Panda Care Manual)');
  });

  it('leaves the content-part array value-unchanged when nothing was used', () => {
    const content: (AssistantTextPart | AssistantRefusalPart)[] = [
      { type: 'text', text: 'The weather in Madrid is lovely.' },
    ];
    expect(repairAssistantMessageContent(content, [hit()])).toEqual(content);
  });

  it('passes null and undefined through', () => {
    expect(repairAssistantMessageContent(null, [hit()])).toBeNull();
    expect(repairAssistantMessageContent(undefined, [hit()])).toBeUndefined();
  });
});

describe('knowledgeHitDocumentKey', () => {
  it('prefers the indexed document id over the URL', () => {
    const first = hit({ documentId: 'doc-a', sourceUrl: 'https://example.com/x' });
    const second = hit({ documentId: 'doc-b', sourceUrl: 'https://example.com/x' });
    expect(knowledgeHitDocumentKey(first)).not.toBe(knowledgeHitDocumentKey(second));
  });

  it('normalizes cosmetic URL differences when there is no document id', () => {
    const first = hit({ sourceUrl: 'https://en.wikipedia.org/wiki/Giant_panda' });
    const second = hit({ sourceUrl: 'HTTPS://en.wikipedia.org/wiki/Giant_panda/' });
    expect(knowledgeHitDocumentKey(first)).toBe(knowledgeHitDocumentKey(second));
  });

  it('keeps query strings: they can name different documents', () => {
    const first = hit({ sourceUrl: 'https://docs.example.com/page?id=1' });
    const second = hit({ sourceUrl: 'https://docs.example.com/page?id=2' });
    expect(knowledgeHitDocumentKey(first)).not.toBe(knowledgeHitDocumentKey(second));
  });

  it('falls back to title and label when there is no URL', () => {
    const first = hit({ sourceUrl: null, title: 'Notes', sourceLabel: 'web' });
    const second = hit({ sourceUrl: null, title: 'Notes', sourceLabel: 'web' });
    const third = hit({ sourceUrl: null, title: 'Other', sourceLabel: 'web' });
    expect(knowledgeHitDocumentKey(first)).toBe(knowledgeHitDocumentKey(second));
    expect(knowledgeHitDocumentKey(first)).not.toBe(knowledgeHitDocumentKey(third));
  });
});

describe('dedupeHitsByDocument', () => {
  it('collapses two used passages from the same document to one entry', () => {
    const first = hit({ documentId: 'doc-panda' });
    const second = hit({ documentId: 'doc-panda' });
    expect(dedupeHitsByDocument([first, second])).toEqual([first]);
  });

  it('keeps genuinely distinct documents apart', () => {
    const first = hit({ documentId: 'doc-a' });
    const second = hit({ documentId: 'doc-b' });
    expect(dedupeHitsByDocument([first, second])).toEqual([first, second]);
  });
});

describe('formatSourceEntry URL-title rendering', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Giant_panda';

  it('renders a single clean entry when the title is the source URL', () => {
    expect(formatSourceEntry(hit({ title: wiki, sourceUrl: wiki }))).toBe(wiki);
  });

  it('renders a single clean entry when the title is empty', () => {
    expect(formatSourceEntry(hit({ title: '', sourceUrl: wiki }))).toBe(wiki);
  });

  it('renders a single clean entry when the title is a different URL', () => {
    expect(
      formatSourceEntry(hit({ title: 'https://en.wikipedia.org/wiki/Giant_panda_(zoo)', sourceUrl: wiki })),
    ).toBe(wiki);
  });

  it('prettifies a URL-slug title with spaces instead of escaped underscores', () => {
    const entry = formatSourceEntry(hit({ title: 'Giant_panda', sourceUrl: wiki }));
    expect(entry).toBe(`Giant panda — ${wiki}`);
    expect(entry).not.toContain('\\_');
  });

  it('leaves prose titles alone', () => {
    expect(formatSourceEntry(hit({ title: 'Giant panda diet notes', sourceUrl: wiki }))).toBe(
      `Giant panda diet notes — ${wiki}`,
    );
  });
});

describe('repairKnowledgeAttribution same-document dedup', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Giant_panda';
  const first = hit({
    documentId: 'doc-panda',
    text: 'The giant panda (Ailuropoda melanoleuca) is a bear species endemic to China, with a bold black-and-white coat.',
    title: wiki,
    sourceLabel: 'web',
    sourceUrl: wiki,
  });
  const second = hit({
    documentId: 'doc-panda',
    text: 'Giant pandas eat almost exclusively bamboo, 26 to 84 pounds daily, in the misty mountains of Sichuan.',
    title: wiki,
    sourceLabel: 'web',
    sourceUrl: wiki,
  });
  const answer =
    'Giant pandas (Ailuropoda melanoleuca) are bears endemic to China with a bold black-and-white coat. ' +
    'They eat almost exclusively bamboo, 26 to 84 pounds daily, in the misty mountains of Sichuan.';

  it('renders one clean footer entry for two used passages from one document', () => {
    expect(repairKnowledgeAttribution(answer, [first, second])).toBe(`${answer}\n\nSources: ${wiki}`);
  });

  it('renders one clean footer entry through the content-parts path too', () => {
    const content: (AssistantTextPart | AssistantRefusalPart)[] = [{ type: 'text', text: answer }];
    const repaired = repairAssistantMessageContent(content, [first, second]);
    const texts = repaired.filter((part): part is AssistantTextPart => part.type === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe(`${answer}\n\nSources: ${wiki}`);
  });
});
