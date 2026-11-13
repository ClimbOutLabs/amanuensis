import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryNightlyCatalog,
  createMemoryPageSortingCatalog,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/memoryHelpersCatalog.js';

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('createMemoryPageSortingCatalog', () => {
  const wire = { data: { mode: 'report', overridden: true, default_mode: 'off' } };

  it('GETs through the supplied base URL, token and fetch, mapping snake_case fields', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://aman.example/api/v1/settings/memory-page-sorting');
      expect(init?.method).toBe('GET');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer secret' });
      return okJson(wire);
    });
    const catalog = createMemoryPageSortingCatalog({
      baseUrl: 'https://aman.example/',
      token: 'secret',
      fetch: fetchImpl,
    });
    await expect(catalog.getMemoryPageSorting()).resolves.toEqual({
      mode: 'report',
      overridden: true,
      defaultMode: 'off',
    });
  });

  it('PUTs the chosen mode', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      bodies.push(String(init?.body));
      return okJson(wire);
    });
    await createMemoryPageSortingCatalog({ fetch: fetchImpl }).setMemoryPageSortingMode('on');
    expect(bodies).toEqual([JSON.stringify({ mode: 'on' })]);
  });

  it('shows the server message when the save is refused', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: 'Send off, report or on.' } }), { status: 400 }),
    );
    await expect(createMemoryPageSortingCatalog({ fetch: fetchImpl }).setMemoryPageSortingMode('on')).rejects.toThrow(
      'Send off, report or on.',
    );
  });

  it('refuses an unexpected payload', async () => {
    const fetchImpl = vi.fn(async () => okJson({ data: { mode: 'sometimes' } }));
    await expect(createMemoryPageSortingCatalog({ fetch: fetchImpl }).getMemoryPageSorting()).rejects.toThrow(
      'unexpected',
    );
  });
});

describe('createMemoryNightlyCatalog', () => {
  const wire = { data: { enabled: true, overridden: true, default_enabled: false, hour: 21, model_wait_minutes: 10 } };

  it('GETs and PUTs the nightly setting', async () => {
    const seen: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        body: init?.body === undefined ? undefined : String(init.body),
      });
      return okJson(wire);
    });
    const catalog = createMemoryNightlyCatalog({ fetch: fetchImpl });
    await expect(catalog.getMemoryNightly()).resolves.toEqual({
      enabled: true,
      overridden: true,
      defaultEnabled: false,
      hour: 21,
      modelWaitMinutes: 10,
    });
    await catalog.setMemoryNightly({ enabled: false });
    await catalog.setMemoryNightly({ hour: 6 });
    await catalog.setMemoryNightly({ modelWaitMinutes: 30 });
    expect(seen).toEqual([
      { url: '/api/v1/settings/memory-nightly', method: 'GET', body: undefined },
      { url: '/api/v1/settings/memory-nightly', method: 'PUT', body: JSON.stringify({ enabled: false }) },
      { url: '/api/v1/settings/memory-nightly', method: 'PUT', body: JSON.stringify({ hour: 6 }) },
      { url: '/api/v1/settings/memory-nightly', method: 'PUT', body: JSON.stringify({ model_wait_minutes: 30 }) },
    ]);
  });

  it('POSTs a tidy-up and maps what it did', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/v1/settings/memory-nightly/run');
      expect(init?.method).toBe('POST');
      return okJson({
        data: {
          status: 'ran',
          moved_to_earlier: 2,
          notes_asked: 3,
          notes_sorted: 1,
          pairs_listed: 0,
          sorting: 'on',
          model_missing: false,
          unsorted_reasons: ['reply_too_long'],
        },
      });
    });
    await expect(createMemoryNightlyCatalog({ fetch: fetchImpl }).tidyMemoryNow()).resolves.toEqual({
      status: 'ran',
      movedToEarlier: 2,
      notesAsked: 3,
      notesSorted: 1,
      pairsListed: 0,
      sorting: 'on',
      modelMissing: false,
      unsortedReasons: ['reply_too_long'],
    });
  });

  it('asks where a tidy-up stands with a GET, which starts nothing', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/v1/settings/memory-nightly/run');
      expect(init?.method).toBe('GET');
      return okJson({
        data: {
          status: 'idle',
          moved_to_earlier: 0,
          notes_asked: 0,
          notes_sorted: 0,
          pairs_listed: 0,
          sorting: 'off',
          model_missing: false,
          unsorted_reasons: [],
        },
      });
    });
    await expect(createMemoryNightlyCatalog({ fetch: fetchImpl }).getMemoryTidyState()).resolves.toMatchObject({
      status: 'idle',
    });
  });
});
