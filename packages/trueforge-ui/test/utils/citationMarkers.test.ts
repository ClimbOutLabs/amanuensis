import { describe, expect, it } from 'vitest';

import { extractCitationMarkers, resolveCitationSource, type CitationSource } from '@/utils/citationMarkers.js';

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
