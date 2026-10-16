import type { HostToolCallPolicyCall } from '@truefoundry/trueforge-core/core';

import {
  buildInternalSourceToolPolicy,
  createInternalSourceState,
  noteLibraryLookup,
  noteRecallContent,
  PERSONA_LIBRARY_NEAR_MISS_MARKER,
  queriesAskSameQuestion,
  tokenize,
  webQueryTargetsOwnConversation,
} from '../../../src/runtime/internalSourceGuard';

function webSearchCall(query: string): HostToolCallPolicyCall {
  return {
    functionName: 'mcp__web__web_search',
    underlyingToolName: 'web_search',
    args: { query },
  };
}

describe('internal source tool policy', () => {
  describe('library near-miss (bug 1)', () => {
    it('blocks a paraphrased web_search about the question the library was asked and could not answer', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What was the solo bakery project sale price?',
        consulted: true,
        answered: false,
      });
      const policy = buildInternalSourceToolPolicy(state);

      const blocked = policy(webSearchCall('sale price for the solo bakery project'));
      expect(blocked).toBeDefined();
      expect(blocked?.message).toContain('knowledge library');
    });

    it('blocks the same question routed through the call_tool dispatcher', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What was the solo bakery project sale price?',
        consulted: true,
        answered: false,
      });
      const policy = buildInternalSourceToolPolicy(state);

      const blocked = policy({
        functionName: 'call_tool',
        underlyingToolName: 'web_search',
        args: { query: 'solo bakery project sale price' },
      });
      expect(blocked).toBeDefined();
      expect(blocked?.message).toContain('knowledge library');
    });

    it('does not block when the library answered the question', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What was the solo bakery project sale price?',
        consulted: true,
        answered: true,
      });
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('solo bakery project sale price'))).toBeUndefined();
    });

    it('does not block when the library was never consulted for a question', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What was the solo bakery project sale price?',
        consulted: false,
        answered: false,
      });
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('solo bakery project sale price'))).toBeUndefined();
    });

    it('leaves unrelated open-web questions alone during a near-miss', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What was the solo bakery project sale price?',
        consulted: true,
        answered: false,
      });
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('weather in Madrid tomorrow'))).toBeUndefined();
      expect(policy(webSearchCall('best tapas near Gran Via'))).toBeUndefined();
    });

    it('evaluates single-token queries against the library question: no auto-pass', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What is the quality assurance certification process?',
        consulted: true,
        answered: false,
      });
      const policy = buildInternalSourceToolPolicy(state);

      // Exact and initialism equality both block.
      expect(policy(webSearchCall('qa'))).toBeDefined();
      expect(policy(webSearchCall('certification'))).toBeDefined();
      // An unrelated lone token passes.
      expect(policy(webSearchCall('tapas'))).toBeUndefined();
    });

    it('does not let a lone "ai" collide with an "annual income" near-miss', () => {
      const state = createInternalSourceState();
      noteLibraryLookup(state, {
        query: 'What is the annual income reporting deadline?',
        consulted: true,
        answered: false,
      });
      const policy = buildInternalSourceToolPolicy(state);

      // Two-letter aliases are not generated generically, so the singleton
      // "ai" cannot reach the "annual income" expansion. The full phrase
      // still blocks, as it should.
      expect(policy(webSearchCall('ai'))).toBeUndefined();
      expect(policy(webSearchCall('annual income reporting deadline'))).toBeDefined();
    });

    it('logs instead of silently allowing a web_search with no readable query', () => {
      const warnings: string[] = [];
      const state = createInternalSourceState();
      noteRecallContent(state, ['QA rig v4.2.1 quality assurance version']);
      const policy = buildInternalSourceToolPolicy(state, {
        warn: (message: string) => warnings.push(message),
      });

      const allowed = policy({
        functionName: 'mcp__web__web_search',
        underlyingToolName: 'web_search',
        args: { limit: 5 },
      });
      expect(allowed).toBeUndefined();
      expect(warnings.some(w => w.includes('no readable query'))).toBe(true);
    });
  });

  describe('recall authority (bug 2)', () => {
    const recallTexts = [
      'The QA rig is the dedicated load-testing cluster for the checkout service.',
      'v4.2.1 is the current quality assurance build version running on the QA rig.',
      'QA rig notes: staging deploy of v4.2.1 finished Thursday.',
    ];

    it('blocks a paraphrased web_search about material recall already surfaced', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, recallTexts);
      const policy = buildInternalSourceToolPolicy(state);

      const blocked = policy(webSearchCall('What was the quality assurance version?'));
      expect(blocked).toBeDefined();
      expect(blocked?.message).toContain('Memory recall');
    });

    it('matches abbreviations against their expansions (QA rig vs quality assurance)', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, recallTexts);
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('QA rig version number'))).toBeDefined();
      expect(policy(webSearchCall('quality assurance build version'))).toBeDefined();
    });

    it('blocks direct and repeated attempts, including through the dispatcher', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, recallTexts);
      const policy = buildInternalSourceToolPolicy(state);

      const direct: HostToolCallPolicyCall = {
        functionName: 'mcp__web__web_search',
        underlyingToolName: 'web_search',
        args: { q: 'quality assurance version' },
      };
      expect(policy(direct)).toBeDefined();
      expect(policy(direct)).toBeDefined();
      expect(
        policy({
          functionName: 'call_tool',
          underlyingToolName: 'web_search',
          args: { query: 'quality assurance version' },
        }),
      ).toBeDefined();
    });

    it('does not block when recall injected nothing', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, []);
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('quality assurance version'))).toBeUndefined();
    });

    it('does not block open-web questions that merely share stopwords with recall', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, recallTexts);
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('version history of the Roman empire'))).toBeUndefined();
    });

    it('holds the higher recall bar: 2/3 overlap with recalled material passes', () => {
      // Acceptance probe for the over-blocking boundary: a Madrid-trip
      // recall mentions tapas and Madrid, but "best tapas Madrid" is a
      // genuine open-web question (2/3 < 0.75).
      const state = createInternalSourceState();
      noteRecallContent(state, [
        'Madrid trip: three nights near Gran Via, day trip to Toledo.',
        'Tapas crawl through La Latina; the gambas al ajillo stood out.',
      ]);
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('best tapas Madrid'))).toBeUndefined();
      // But a query squarely about the recalled material still blocks.
      expect(policy(webSearchCall('Madrid trip tapas crawl La Latina'))).toBeDefined();
    });

    it('evaluates single-token queries against recall: no auto-pass', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, recallTexts);
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('v4.2.1'))).toBeDefined();
      expect(policy(webSearchCall('tapas'))).toBeUndefined();
    });

    it('leaves non-web_search tools untouched', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, recallTexts);
      const policy = buildInternalSourceToolPolicy(state);

      expect(
        policy({
          functionName: 'mcp__memory__search_memory',
          underlyingToolName: 'search_memory',
          args: { query: 'quality assurance version' },
        }),
      ).toBeUndefined();
    });
  });

  describe('own-conversation queries', () => {
    it('blocks web queries that target the conversation or memory, whatever the turn state', () => {
      const state = createInternalSourceState();
      const policy = buildInternalSourceToolPolicy(state);

      const queries = [
        'dig it up from our earlier conversation about the launch',
        'what did we decide about the venue',
        'search my memory for the budget number',
        'from our earlier chat, the QA rig version',
        'you told me the price last week',
      ];
      for (const query of queries) {
        const blocked = policy(webSearchCall(query));
        expect(blocked).toBeDefined();
        expect(blocked?.message).toContain('conversation history');
      }
    });

    it('keeps blocking on repeated attempts', () => {
      const state = createInternalSourceState();
      const policy = buildInternalSourceToolPolicy(state);
      const call = webSearchCall('dig it up from our earlier conversation');
      expect(policy(call)).toBeDefined();
      expect(policy(call)).toBeDefined();
    });

    it('does not mistake ordinary web questions for conversation queries', () => {
      const state = createInternalSourceState();
      const policy = buildInternalSourceToolPolicy(state);

      expect(policy(webSearchCall('Madrid weather tomorrow'))).toBeUndefined();
      expect(policy(webSearchCall('Iberia flight IB6251 status'))).toBeUndefined();
    });
  });

  describe('robustness', () => {
    it('matches web_search case-insensitively and reads alternate query argument names', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, ['QA rig v4.2.1 quality assurance version']);
      const policy = buildInternalSourceToolPolicy(state);

      expect(
        policy({
          functionName: 'WEB_SEARCH',
          underlyingToolName: 'WEB_SEARCH',
          args: { q: 'quality assurance version' },
        }),
      ).toBeDefined();
    });

    it('skips calls with no usable query argument', () => {
      const state = createInternalSourceState();
      noteRecallContent(state, ['QA rig v4.2.1 quality assurance version']);
      const policy = buildInternalSourceToolPolicy(state);

      expect(
        policy({
          functionName: 'mcp__web__web_search',
          underlyingToolName: 'web_search',
          args: { limit: 5 },
        }),
      ).toBeUndefined();
    });
  });
});

describe('queriesAskSameQuestion', () => {
  it('matches paraphrases with different word order', () => {
    expect(
      queriesAskSameQuestion({
        a: tokenize('sale price for the solo bakery project'),
        b: tokenize('What was the solo bakery project sale price?'),
      }),
    ).toBe(true);
  });

  it('matches abbreviations against multi-word expansions', () => {
    expect(
      queriesAskSameQuestion({
        a: tokenize('QA rig version number'),
        b: tokenize('quality assurance build version running on the QA rig'),
      }),
    ).toBe(true);
  });

  it('rejects questions about different topics that share a word or two', () => {
    expect(
      queriesAskSameQuestion({
        a: tokenize('version history of the Roman empire'),
        b: tokenize('quality assurance version v4.2.1'),
      }),
    ).toBe(false);
  });

  it('evaluates single-token queries by exact equality: no auto-pass', () => {
    expect(queriesAskSameQuestion({ a: tokenize('qa'), b: tokenize('qa') })).toBe(true);
    expect(queriesAskSameQuestion({ a: ['qa'], b: ['qa', 'rig'] })).toBe(true);
    expect(queriesAskSameQuestion({ a: tokenize('tapas'), b: tokenize('quality assurance') })).toBe(false);
    expect(queriesAskSameQuestion({ a: [], b: tokenize('quality assurance') })).toBe(false);
  });

  it('evaluates single-token queries by initialism equality', () => {
    // web_search("qa") after a "quality assurance certification" near-miss:
    // "qa" is allowlisted as the "quality assurance" initialism.
    expect(queriesAskSameQuestion({ a: tokenize('qa'), b: tokenize('quality assurance certification') })).toBe(true);
    // But generic two-letter aliases are not generated: a lone "ai" does not
    // match "artificial intelligence policy" — the collision is avoided.
    expect(queriesAskSameQuestion({ a: tokenize('ai'), b: tokenize('artificial intelligence policy') })).toBe(false);
  });

  it('only generates the allowlisted two-letter initialism, not generic ones', () => {
    // "qa" matches "quality assurance" via the explicit allowlist: 2/2.
    expect(
      queriesAskSameQuestion({ a: tokenize('qa certification'), b: tokenize('quality assurance certification') }),
    ).toBe(true);
    // "qa" does not match other q-a expansions: 0/2.
    expect(queriesAskSameQuestion({ a: tokenize('qa rig'), b: tokenize('quantum algorithms certification') })).toBe(
      false,
    );
    // And "ai" no longer abbreviates anything at all: 1/2 < 0.6.
    expect(queriesAskSameQuestion({ a: tokenize('ai policy'), b: tokenize('annual income policy') })).toBe(false);
  });

  it('never counts alias-on-both-sides intersections toward the threshold', () => {
    // Both sides abbreviate to "ai", but neither side literally says it:
    // coincidence, not paraphrase. Only "policy" counts: 1/3 < 0.6.
    expect(
      queriesAskSameQuestion({
        a: tokenize('artificial intelligence policy'),
        b: tokenize('annual income policy'),
      }),
    ).toBe(false);
  });

  it('applies a caller-supplied threshold to multi-token queries', () => {
    const a = tokenize('best tapas Madrid');
    const b = tokenize('Madrid trip tapas bars itinerary');
    // 2/3 overlap: passes the 0.6 library bar, blocked by nothing at 0.75.
    expect(queriesAskSameQuestion({ a, b, threshold: 0.6 })).toBe(true);
    expect(queriesAskSameQuestion({ a, b, threshold: 0.75 })).toBe(false);
  });
});

describe('tokenize', () => {
  it('keeps version compounds whole so they overlap as one token', () => {
    // Behavioral: the compound must survive as a single matchable token,
    // not how the token array is spelled.
    expect(queriesAskSameQuestion({ a: tokenize('v4.2.1 release'), b: tokenize('v4.2.1 release notes') })).toBe(true);
    expect(queriesAskSameQuestion({ a: tokenize('v4 release'), b: tokenize('v4.2.1 release notes') })).toBe(false);
  });

  it('stems plurals symmetrically and drops stopwords for overlap purposes', () => {
    expect(queriesAskSameQuestion({ a: tokenize('QA versions'), b: tokenize('qa version') })).toBe(true);
    expect(queriesAskSameQuestion({ a: tokenize('the version'), b: tokenize('version') })).toBe(true);
  });
});

describe('webQueryTargetsOwnConversation', () => {
  it('flags own-conversation phrasings and ignores open-web phrasings', () => {
    expect(webQueryTargetsOwnConversation('dig it up from our earlier conversation')).toBe(true);
    expect(webQueryTargetsOwnConversation('what did we discuss about pricing')).toBe(true);
    expect(webQueryTargetsOwnConversation('Iberia flight status')).toBe(false);
  });
});

describe('internal source state', () => {
  it('recording functions tolerate an absent state without throwing', () => {
    expect(() => noteLibraryLookup(undefined, { query: 'q', consulted: true, answered: false })).not.toThrow();
    expect(() => noteRecallContent(undefined, ['text'])).not.toThrow();
  });

  it('the near-miss marker names the library and its absence plainly', () => {
    expect(PERSONA_LIBRARY_NEAR_MISS_MARKER).toContain('knowledge library');
    expect(PERSONA_LIBRARY_NEAR_MISS_MARKER.length).toBeGreaterThan(0);
  });

  it('is turn-scoped: each created state is a fresh, unshared object', () => {
    const first = createInternalSourceState();
    const second = createInternalSourceState();
    expect(first).not.toBe(second);
    noteRecallContent(first, ['secret recall material']);
    noteLibraryLookup(first, { query: 'secret library question', consulted: true, answered: false });
    // Nothing leaks across instances: the second turn's state is untouched,
    // and there is no module-level shared state to persist or log.
    expect(second.recallTokens).toBeUndefined();
    expect(second.libraryQuery).toBeUndefined();
    expect(second.libraryConsulted).toBe(false);
  });
});
