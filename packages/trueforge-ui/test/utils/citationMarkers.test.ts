import { describe, expect, it } from 'vitest';

import {
  buildCitationSourceIndex,
  extractCitationMarkers,
  extractSearchCitationSources,
  renderCitationReplacement,
  resolveCitationSource,
  type CitationSource,
  type CitationToolCall,
} from '@/utils/citationMarkers.js';

describe('extractCitationMarkers', () => {
  it('extracts a simple citation marker', () => {
    const markers = extractCitationMarkers('This is a citation【14†excerpts】here.');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      sourceId: 14,
      descriptor: 'excerpts',
      text: '【14†excerpts】',
    });
  });

  it('extracts multiple citation markers', () => {
    const markers = extractCitationMarkers('First【1†source】and second【2†other】');
    expect(markers).toHaveLength(2);
    expect(markers[0]?.sourceId).toBe(1);
    expect(markers[1]?.sourceId).toBe(2);
  });

  it('extracts line-range descriptors', () => {
    const markers = extractCitationMarkers('Code example【5†L3-L9】follows.');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.descriptor).toBe('L3-L9');
  });

  it('ignores citation markers inside fenced code blocks', () => {
    const source = 'Text【1†excerpt】\n```\ncode【2†ignored】\n```\nmore【3†excerpt】';
    const markers = extractCitationMarkers(source);
    expect(markers).toHaveLength(2);
    expect(markers[0]?.sourceId).toBe(1);
    expect(markers[1]?.sourceId).toBe(3);
  });

  it('ignores citation markers inside inline code spans', () => {
    const markers = extractCitationMarkers('text `【1†inline】code` more【2†prose】');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.sourceId).toBe(2);
  });

  it('preserves citation marker positions correctly', () => {
    const source = 'This【1†test】text';
    const markers = extractCitationMarkers(source);
    expect(markers[0]?.start).toBe(4);
    expect(markers[0]?.end).toBe(12);
    expect(source.substring(markers[0]!.start, markers[0]!.end)).toBe('【1†test】');
  });

  it('handles markers with multi-digit IDs', () => {
    const markers = extractCitationMarkers('Citation【123†source】here');
    expect(markers[0]?.sourceId).toBe(123);
  });

  it('returns empty array when no markers present', () => {
    const markers = extractCitationMarkers('Plain text without any markers');
    expect(markers).toHaveLength(0);
  });

  it('handles markers with special characters in descriptors', () => {
    const markers = extractCitationMarkers('Example【10†figure-1.2】text');
    expect(markers[0]?.descriptor).toBe('figure-1.2');
  });

  it('does not treat similar but incorrect formats as markers', () => {
    const markers = extractCitationMarkers('Text [14†excerpts】 and 【14excerpt】 and 【14†】');
    expect(markers).toHaveLength(0);
  });
});

describe('resolveCitationSource', () => {
  it('resolves a marker from an array of sources', () => {
    const sources: CitationSource[] = [
      { id: 1, title: 'First Source', url: 'https://example.com/1' },
      { id: 2, title: 'Second Source', url: 'https://example.com/2' },
    ];
    const marker = { sourceId: 2, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, sources);
    expect(resolved?.title).toBe('Second Source');
  });

  it('resolves a marker from a Map of sources', () => {
    const sources = new Map<number, CitationSource>([[14, { id: 14, title: 'My Source', url: 'https://example.com' }]]);
    const marker = { sourceId: 14, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, sources);
    expect(resolved?.title).toBe('My Source');
  });

  it('returns null when source is not found in array', () => {
    const sources: CitationSource[] = [{ id: 1, title: 'First' }];
    const marker = { sourceId: 99, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, sources);
    expect(resolved).toBeNull();
  });

  it('returns null when source is not found in map', () => {
    const sources = new Map<number, CitationSource>();
    const marker = { sourceId: 14, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, sources);
    expect(resolved).toBeNull();
  });

  it('returns null when sources is null', () => {
    const marker = { sourceId: 1, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, null);
    expect(resolved).toBeNull();
  });

  it('returns null when sources is undefined', () => {
    const marker = { sourceId: 1, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, undefined);
    expect(resolved).toBeNull();
  });

  it('resolves from an unordered array by matching id', () => {
    const sources: CitationSource[] = [
      { id: 3, title: 'Third Source', url: 'https://example.com/3' },
      { id: 1, title: 'First Source', url: 'https://example.com/1' },
      { id: 2, title: 'Second Source', url: 'https://example.com/2' },
    ];
    const marker = { sourceId: 2, text: '', start: 0, end: 0, descriptor: '' };
    const resolved = resolveCitationSource(marker, sources);
    expect(resolved?.title).toBe('Second Source');
  });
});

describe('retrieval-ID citation markers', () => {
  it('extracts a retrieval-ID marker', () => {
    const markers = extractCitationMarkers('See the docs【a3f9c21e†excerpts】for details.');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      sourceId: 'a3f9c21e',
      descriptor: 'excerpts',
      text: '【a3f9c21e†excerpts】',
    });
  });

  it('extracts a chunk-style retrieval ID with dashes and underscores', () => {
    const markers = extractCitationMarkers('Context【chunk_9F-2a†L3-L9】here.');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.sourceId).toBe('chunk_9F-2a');
    expect(markers[0]?.descriptor).toBe('L3-L9');
  });

  it('still skips retrieval-ID markers inside code spans', () => {
    const markers = extractCitationMarkers('text `【abc123†inline】code` more【def456†prose】');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.sourceId).toBe('def456');
  });

  it('rejects malformed IDs', () => {
    expect(extractCitationMarkers('bad【†x】')).toHaveLength(0);
    expect(extractCitationMarkers('bad【 12†x】')).toHaveLength(0);
    expect(extractCitationMarkers(`bad【${'a'.repeat(129)}†x】`)).toHaveLength(0);
  });
});

describe('resolveCitationSource with retrieval IDs', () => {
  const marker = (sourceId: number | string) => ({ sourceId, text: '', start: 0, end: 0, descriptor: '' });

  it('resolves a retrieval ID from a string-keyed map', () => {
    const sources = new Map<string, CitationSource>([
      ['a3f9c21e', { id: 'a3f9c21e', title: 'Chunk A', url: 'https://example.com/a' }],
    ]);
    expect(resolveCitationSource(marker('a3f9c21e'), sources)?.title).toBe('Chunk A');
  });

  it('does not cross numeric and string key spaces', () => {
    const sources = new Map<string, CitationSource>([['14', { id: '14', title: 'String fourteen' }]]);
    expect(resolveCitationSource(marker(14), sources)).toBeNull();
  });

  it('buildCitationSourceIndex keeps the first source for a duplicated ID', () => {
    const index = buildCitationSourceIndex([
      { id: 1, title: 'First' },
      { id: 1, title: 'Second' },
    ]);
    expect(index.size).toBe(1);
    expect(index.get('n:1')?.title).toBe('First');
  });
});

describe('renderCitationReplacement', () => {
  const marker = (sourceId: number | string) => ({ sourceId, text: '', start: 0, end: 0, descriptor: '' });

  it('renders a resolved numeric source as the established numbered link', () => {
    expect(renderCitationReplacement(marker(14), { id: 14, title: 'Fourteen', url: 'https://example.com/14' })).toBe(
      '[【14】](https://example.com/14 "Fourteen")',
    );
  });

  it('renders a resolved retrieval ID as a human-readable link on the source title', () => {
    expect(
      renderCitationReplacement(marker('a3f9c21e'), {
        id: 'a3f9c21e',
        title: 'Chunk A',
        url: 'https://example.com/a',
      }),
    ).toBe('[Chunk A](https://example.com/a)');
  });

  it('renders a URL-less retrieval source as the plain title', () => {
    expect(renderCitationReplacement(marker('a3f9c21e'), { id: 'a3f9c21e', title: 'Chunk A' })).toBe('[Chunk A]');
  });

  it('removes unresolved markers and numeric sources without a URL — raw IDs never render', () => {
    expect(renderCitationReplacement(marker('a3f9c21e'), null)).toBe('');
    expect(renderCitationReplacement(marker(7), { id: 7, title: 'Seven' })).toBe('');
    expect(renderCitationReplacement(marker('a3f9c21e'), null)).not.toContain('a3f9c21e');
  });
});

function searchCall(toolName: string, argsText: string | undefined, result: unknown): CitationToolCall {
  return { toolName, argsText, result };
}

function searchEnvelope(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    schema_version: 'tool.response.v2',
    outcome: { disposition: 'executed_ok' },
    result: { results },
  });
}

describe('extractSearchCitationSources', () => {
  it('numbers web_search results 1..N with titles, falling back to the URL', () => {
    const sources = extractSearchCitationSources([
      searchCall(
        'web_search',
        undefined,
        searchEnvelope([
          { url: 'https://a.example/1', title: 'First result' },
          { url: 'https://b.example/2' },
          { title: 'No URL — skipped' },
        ]),
      ),
    ]);
    expect(sources).toEqual([
      { id: 1, title: 'First result', url: 'https://a.example/1' },
      { id: 2, title: 'https://b.example/2', url: 'https://b.example/2' },
    ]);
  });

  it('resolves MCP call_tool through tool_name and caps at the first page of ten', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://x.example/${String(i)}` }));
    const sources = extractSearchCitationSources([
      searchCall('call_tool', JSON.stringify({ tool_name: 'web_search', input: {} }), searchEnvelope(many)),
    ]);
    expect(sources).toHaveLength(10);
    expect(sources[0]).toMatchObject({ id: 1, url: 'https://x.example/0' });
  });

  it('ignores non-search tools, empty results, and non-envelope payloads', () => {
    expect(
      extractSearchCitationSources([searchCall('exec', undefined, searchEnvelope([{ url: 'https://a.example/1' }]))]),
    ).toEqual([]);
    expect(extractSearchCitationSources([searchCall('web_search', undefined, undefined)])).toEqual([]);
    expect(extractSearchCitationSources([searchCall('web_search', undefined, 'not json')])).toEqual([]);
    expect(
      extractSearchCitationSources([searchCall('web_search', undefined, JSON.stringify({ results: [] }))]),
    ).toEqual([]);
  });

  it('lets the latest search call win for a repeated number', () => {
    const sources = extractSearchCitationSources([
      searchCall('web_search', undefined, searchEnvelope([{ url: 'https://a.example/1', title: 'Old' }])),
      searchCall('web_fetch', undefined, searchEnvelope([{ url: 'https://b.example/1', title: 'New' }])),
    ]);
    expect(sources).toEqual([{ id: 1, title: 'New', url: 'https://b.example/1' }]);
  });
});
