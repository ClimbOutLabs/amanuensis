import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** How saved notes are sorted onto pages. `report` only writes down what Aman would do. */
export type PageSortMode = 'off' | 'report' | 'on';

/** The page-sorting setting: `mode` is the stored value (an override, else the server default). */
export interface MemoryPageSortingSetting {
  mode: PageSortMode;
  overridden: boolean;
  defaultMode: PageSortMode;
}

/** The nightly tidy-up setting: `enabled` is the stored value (an override, else the server default). */
export interface MemoryNightlySetting {
  enabled: boolean;
  overridden: boolean;
  defaultEnabled: boolean;
  /** The hour of the server's day the tidy-up starts at, 0 to 23. */
  hour: number;
}

/** What a tidy-up asked for now did; `busy` means one was already running and nothing was started. */
export interface MemoryTidyRun {
  status: 'ran' | 'busy';
  movedToEarlier: number;
  notesSorted: number;
  pairsListed: number;
}

export interface MemoryPageSortingCatalog {
  getMemoryPageSorting(): Promise<MemoryPageSortingSetting>;
  setMemoryPageSortingMode(mode: PageSortMode): Promise<MemoryPageSortingSetting>;
}

export interface MemoryNightlyCatalog {
  getMemoryNightly(): Promise<MemoryNightlySetting>;
  /** Saves the fields given; a field left out stays as it is. */
  setMemoryNightly(change: { enabled?: boolean; hour?: number }): Promise<MemoryNightlySetting>;
  tidyMemoryNow(): Promise<MemoryTidyRun>;
}

const PageSortModeSchema = z.enum(['off', 'report', 'on']);

const PageSortingResponseSchema = z.object({
  data: z.object({
    mode: PageSortModeSchema,
    overridden: z.boolean(),
    default_mode: PageSortModeSchema,
  }),
});

const NightlyResponseSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    overridden: z.boolean(),
    default_enabled: z.boolean(),
    hour: z.number().int().min(0).max(23),
  }),
});

const TidyRunResponseSchema = z.object({
  data: z.object({
    status: z.enum(['ran', 'busy']),
    moved_to_earlier: z.number(),
    notes_sorted: z.number(),
    pairs_listed: z.number(),
  }),
});

/**
 * Calls GET, PUT or POST on one /api/v1/settings route with the base URL, token and fetch the SDK client was built from.
 * Cookie auth rides along: the default base URL is same-origin, and a host pointing the UI at another origin
 * supplies its own `fetch`.
 */
function settingRequester(options: CreateTrueForgeClientOptions, path: string) {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  return async (method: 'GET' | 'PUT' | 'POST', body?: object, action = ''): Promise<unknown> => {
    const response = await fetchImpl(`${base}${path}${action}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseBody: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(responseBody);
      throw new Error(
        failure.success
          ? failure.data.error.message
          : `That did not work (HTTP ${String(response.status)}). Try again in a moment.`,
      );
    }
    return responseBody;
  };
}

export function createMemoryPageSortingCatalog(options: CreateTrueForgeClientOptions = {}): MemoryPageSortingCatalog {
  const request = settingRequester(options, '/api/v1/settings/memory-page-sorting');
  const parse = (body: unknown): MemoryPageSortingSetting => {
    const parsed = PageSortingResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('The server sent back something unexpected. Reload the page and try again.');
    }
    const { mode, overridden, default_mode } = parsed.data.data;
    return { mode, overridden, defaultMode: default_mode };
  };
  return {
    getMemoryPageSorting: async () => parse(await request('GET')),
    setMemoryPageSortingMode: async mode => parse(await request('PUT', { mode })),
  };
}

export function createMemoryNightlyCatalog(options: CreateTrueForgeClientOptions = {}): MemoryNightlyCatalog {
  const request = settingRequester(options, '/api/v1/settings/memory-nightly');
  const parse = (body: unknown): MemoryNightlySetting => {
    const parsed = NightlyResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('The server sent back something unexpected. Reload the page and try again.');
    }
    const { enabled, overridden, default_enabled, hour } = parsed.data.data;
    return { enabled, overridden, defaultEnabled: default_enabled, hour };
  };
  return {
    getMemoryNightly: async () => parse(await request('GET')),
    setMemoryNightly: async change => parse(await request('PUT', change)),
    tidyMemoryNow: async () => {
      const parsed = TidyRunResponseSchema.safeParse(await request('POST', undefined, '/run'));
      if (!parsed.success) {
        throw new Error('The server sent back something unexpected. Reload the page and try again.');
      }
      const { status, moved_to_earlier, notes_sorted, pairs_listed } = parsed.data.data;
      return { status, movedToEarlier: moved_to_earlier, notesSorted: notes_sorted, pairsListed: pairs_listed };
    },
  };
}

/** Human-readable error for the controls; callers render it inline. */
export function memoryHelperErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'That did not work. Try again in a moment.');
}
