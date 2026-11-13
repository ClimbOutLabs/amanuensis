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
  /** How many minutes one sorting or tidying question may wait for the model, 1 to 20. */
  modelWaitMinutes: number;
}

/** Where a tidy-up stands. `busy`: one is running. `ran`: the last one finished, with what it did. `failed`: it stopped on an error. `idle`: none ended lately. */
export interface MemoryTidyRun {
  status: 'ran' | 'failed' | 'busy' | 'idle';
  movedToEarlier: number;
  /** Saved notes the model was asked about. */
  notesAsked: number;
  /** Of those, the notes whose answer was understood. */
  notesSorted: number;
  pairsListed: number;
  /** The sorting choice the run worked under. */
  sorting: PageSortMode;
  /** True when sorting was not off and no model was found to ask. */
  modelMissing: boolean;
  /** Why notes were left unsorted: the server's name for each cause, such as `model_slow`, each once. */
  unsortedReasons: string[];
}

export interface MemoryPageSortingCatalog {
  getMemoryPageSorting(): Promise<MemoryPageSortingSetting>;
  setMemoryPageSortingMode(mode: PageSortMode): Promise<MemoryPageSortingSetting>;
}

export interface MemoryNightlyCatalog {
  getMemoryNightly(): Promise<MemoryNightlySetting>;
  /** Saves the fields given; a field left out stays as it is. */
  setMemoryNightly(change: {
    enabled?: boolean;
    hour?: number;
    modelWaitMinutes?: number;
  }): Promise<MemoryNightlySetting>;
  /** Starts a tidy-up unless one is running. It answers at once; ask `getMemoryTidyState` for how it ended. */
  tidyMemoryNow(): Promise<MemoryTidyRun>;
  /** Where a tidy-up stands, without starting one: running, finished a short while ago, or neither. */
  getMemoryTidyState(): Promise<MemoryTidyRun>;
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
    model_wait_minutes: z.number().int().min(1).max(20),
  }),
});

const TidyRunResponseSchema = z.object({
  data: z.object({
    status: z.enum(['ran', 'failed', 'busy', 'idle']),
    moved_to_earlier: z.number(),
    notes_asked: z.number(),
    notes_sorted: z.number(),
    pairs_listed: z.number(),
    sorting: z.enum(['off', 'report', 'on']),
    model_missing: z.boolean(),
    unsorted_reasons: z.array(z.string()),
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
    const { enabled, overridden, default_enabled, hour, model_wait_minutes } = parsed.data.data;
    return { enabled, overridden, defaultEnabled: default_enabled, hour, modelWaitMinutes: model_wait_minutes };
  };
  const parseRun = (response: unknown): MemoryTidyRun => {
    const parsed = TidyRunResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error('The server sent back something unexpected. Reload the page and try again.');
    }
    const run = parsed.data.data;
    return {
      status: run.status,
      movedToEarlier: run.moved_to_earlier,
      notesAsked: run.notes_asked,
      notesSorted: run.notes_sorted,
      pairsListed: run.pairs_listed,
      sorting: run.sorting,
      modelMissing: run.model_missing,
      unsortedReasons: run.unsorted_reasons,
    };
  };
  return {
    getMemoryNightly: async () => parse(await request('GET')),
    setMemoryNightly: async ({ enabled, hour, modelWaitMinutes }) =>
      parse(await request('PUT', { enabled, hour, model_wait_minutes: modelWaitMinutes })),
    tidyMemoryNow: async () => parseRun(await request('POST', undefined, '/run')),
    getMemoryTidyState: async () => parseRun(await request('GET', undefined, '/run')),
  };
}

/** Human-readable error for the controls; callers render it inline. */
export function memoryHelperErrorMessage(error: unknown): string {
  // The browser words a request that never reached the server as "Failed to fetch", which tells a person nothing.
  if (error instanceof TypeError) {
    return 'The app could not be reached. Check that it is running, then try again.';
  }
  return getErrorMessage(error, 'That did not work. Try again in a moment.');
}
