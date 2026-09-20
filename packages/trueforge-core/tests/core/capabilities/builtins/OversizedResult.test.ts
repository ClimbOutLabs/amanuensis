import {
  oversizedResultFingerprint,
  renderOversizedResultSummary,
  summarizeOversizedResult,
  OVERSIZED_RESULT_PARSE_MAX_BYTES,
} from '../../../../src/core/capabilities/builtins/OversizedResult';

const NEXT = 'Re-run example_tool with maxResults=10 and pageToken="tok" to fetch the next page.';

function summarize(
  content: string,
  overrides?: { collectionField?: string; totalCount?: number | null; next?: string | null },
): ReturnType<typeof summarizeOversizedResult> {
  return summarizeOversizedResult({
    content,
    collectionField: overrides?.collectionField,
    totalCount: overrides?.totalCount,
    totalDisplay: undefined,
    next: overrides?.next ?? NEXT,
    totalBytes: undefined,
  });
}

describe('summarizeOversizedResult', () => {
  it('emits complete items only, never a severed object', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      id: `item-${String(index)}`,
      payload: 'x'.repeat(500),
    }));
    const summary = summarize(JSON.stringify({ items }), { collectionField: 'items', totalCount: 200 });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.items.length).toBeLessThan(200);
    expect(summary.items.length).toBeGreaterThan(0);
    expect(summary.truncated).toBe(true);
    // Every emitted item parses as a complete value with its id intact.
    for (const item of summary.items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('payload');
    }
    // The byte budget holds: emitted items stay well under the summary cap.
    expect(JSON.stringify(summary.items).length).toBeLessThanOrEqual(20_000 + 1_000);
  });

  it('accounts exactly when the source reports a total', () => {
    const summary = summarize(JSON.stringify({ items: [{ a: 1 }, { a: 2 }] }), {
      collectionField: 'items',
      totalCount: 2,
    });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.total_count).toBe(2);
    expect(summary.items_seen).toBe(2);
    expect(summary.items_extracted).toBe(2);
    expect(summary.unseen_count).toBe(0);
    expect(summary.truncated).toBe(false);
    expect(summary.unseen_statement).toContain('Total: 2 items in');
  });

  it('says total unknown explicitly when the source reports none', () => {
    const summary = summarize(JSON.stringify({ items: [{ a: 1 }] }), { collectionField: 'items' });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.total_count).toBeNull();
    expect(summary.unseen_count).toBeNull();
    expect(summary.unseen_statement).toContain('Total unknown');
  });

  it('finds a root-level array without an envelope field', () => {
    const summary = summarize(JSON.stringify([{ a: 1 }, { a: 2 }]), { totalCount: 2 });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.items_seen).toBe(2);
  });

  it('emits a bounded text excerpt for non-collections, cut at a line boundary', () => {
    // A JSON string literal: text mode uses the parsed string itself, which
    // carries real newlines (an object envelope would be re-serialized
    // compactly and lose them).
    const rawText = `${'line\n'.repeat(3000)}tail without newline ${'y'.repeat(3000)}`;
    const summary = summarize(JSON.stringify(rawText));
    if (summary === undefined || summary.result_kind !== 'text') {
      throw new Error('unreachable');
    }
    expect(summary.chars_shown).toBeLessThanOrEqual(4000);
    expect(summary.chars_total).toBe(rawText.length);
    expect(summary.truncated).toBe(true);
    // Clean cut: the excerpt is a prefix of the content and stops right
    // before a newline, never mid-line.
    expect(rawText.startsWith(summary.text_excerpt)).toBe(true);
    expect(rawText[summary.text_excerpt.length]).toBe('\n');
    expect(summary.unseen_statement).toContain('were not shown and were not seen');
  });

  it('measures bytes as UTF-8, not UTF-16 code units', () => {
    // 300k emoji = 300k UTF-16 code-unit pairs but 1.2M UTF-8 bytes: over the
    // parse ceiling in bytes, under it in string length. Must fail closed.
    const emoji = '😀'.repeat(300_000);
    expect(emoji.length).toBeLessThan(OVERSIZED_RESULT_PARSE_MAX_BYTES);
    expect(summarize(JSON.stringify({ items: [{ text: emoji }] }))).toBeUndefined();
  });

  it('fails closed on unparseable content and on deeply hostile nesting', () => {
    expect(summarize('{"items": [')).toBeUndefined();
    // Deep nesting below the collection level is not expanded (walk stops at
    // depth 2), so hostile nesting is harmless — the collection at depth 1 is
    // still found without burning budget on the nesting.
    let deep: unknown = { leaf: true };
    for (let depth = 0; depth < 200; depth += 1) {
      deep = { nested: deep };
    }
    const result = summarize(JSON.stringify({ items: [deep] }), { collectionField: 'items' });
    expect(result).toBeDefined();
  });

  it('fails closed over the parse ceiling', () => {
    expect(summarize('x'.repeat(OVERSIZED_RESULT_PARSE_MAX_BYTES + 1))).toBeUndefined();
  });

  it('renders an approximate total display when provided', () => {
    const summary = summarizeOversizedResult({
      content: JSON.stringify({ items: [{ a: 1 }] }),
      collectionField: 'items',
      totalCount: 250,
      totalDisplay: '~250 items (server estimate)',
      next: NEXT,
      totalBytes: undefined,
    });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.unseen_statement).toContain('~250 items (server estimate)');
    expect(summary.total_count).toBe(250);
  });

  it('reports the caller-measured original byte count when summarizing a projection', () => {
    const summary = summarizeOversizedResult({
      content: JSON.stringify({ items: [{ a: 1 }] }),
      collectionField: 'items',
      totalCount: 1,
      totalDisplay: undefined,
      next: NEXT,
      totalBytes: 2_000_000,
    });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    expect(summary.total_bytes).toBe(2_000_000);
    expect(summary.unseen_statement).toContain('2,000,000 bytes');
  });
});

describe('renderOversizedResultSummary', () => {
  it('renders structured accounting with the exact continuation', () => {
    const summary = summarize(JSON.stringify({ items: [{ a: 1 }] }), { totalCount: 10 });
    if (summary === undefined) {
      throw new Error('unreachable');
    }
    const rendered = JSON.parse(renderOversizedResultSummary(summary)) as Record<string, unknown>;
    expect(rendered['total_count']).toBe(10);
    expect(rendered['items_seen']).toBe(1);
    expect(rendered['items_extracted']).toBe(1);
    expect(rendered['unseen_count']).toBe(9);
    expect(rendered['screened_out']).toBe(0);
    expect(rendered['truncated']).toBe(true);
    expect(rendered['next']).toBe(NEXT);
    expect(typeof rendered['unseen_statement']).toBe('string');
    expect(Array.isArray(rendered['items'])).toBe(true);
  });

  it('merges the envelope without letting it override core accounting', () => {
    const summary = summarize(JSON.stringify({ items: [{ a: 1 }] }), { totalCount: 10 });
    if (summary === undefined || summary.result_kind !== 'collection') {
      throw new Error('unreachable');
    }
    const rendered = JSON.parse(
      renderOversizedResultSummary({ ...summary, envelope: { seen: 'metadata_only', total_count: 999 } }),
    ) as Record<string, unknown>;
    expect(rendered['seen']).toBe('metadata_only');
    expect(rendered['total_count']).toBe(10);
  });

  it('renders text summaries with excerpt fields', () => {
    const summary = summarize(JSON.stringify({ blob: 'hello world' }));
    if (summary === undefined) {
      throw new Error('unreachable');
    }
    const rendered = JSON.parse(renderOversizedResultSummary(summary)) as Record<string, unknown>;
    expect(rendered['result_kind']).toBe('text');
    expect(typeof rendered['text_excerpt']).toBe('string');
  });
});

describe('oversizedResultFingerprint', () => {
  it('is content-free, stable, and distinguishes inputs', () => {
    const secret = 'super-secret-body-content';
    const a = oversizedResultFingerprint({ toolName: 'get_thread', content: secret });
    const b = oversizedResultFingerprint({ toolName: 'get_thread', content: secret });
    const c = oversizedResultFingerprint({ toolName: 'get_thread', content: 'different' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('super-secret');
    expect(a).toContain('get_thread');
  });
});
