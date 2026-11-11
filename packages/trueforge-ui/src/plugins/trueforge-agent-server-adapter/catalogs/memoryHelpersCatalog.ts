import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** How saved notes are sorted onto pages. `report` only writes down what Aman would do. */
export type PageSortMode = 'off' | 'report' | 'on';

/**
 * The page-sorting setting: `mode` is the stored value (an override, else the server default),
 * `effectiveMode` is what the server will do, which is `off` unless memory is kept as Markdown files.
 */
export interface MemoryPageSortingSetting {
  mode: PageSortMode;
  overridden: boolean;
  defaultMode: PageSortMode;
  effectiveMode: PageSortMode;
}

/** The nightly tidy-up setting, with the same stored and effective split as page sorting. */
export interface MemoryNightlySetting {
  enabled: boolean;
  overridden: boolean;
  defaultEnabled: boolean;
  effectiveEnabled: boolean;
}

export interface MemoryPageSortingCatalog {
  getMemoryPageSorting(): Promise<MemoryPageSortingSetting>;
  setMemoryPageSortingMode(mode: PageSortMode): Promise<MemoryPageSortingSetting>;
}

export interface MemoryNightlyCatalog {
  getMemoryNightly(): Promise<MemoryNightlySetting>;
  setMemoryNightlyEnabled(enabled: boolean): Promise<MemoryNightlySetting>;
}

const PageSortModeSchema = z.enum(['off', 'report', 'on']);

const PageSortingResponseSchema = z.object({
  data: z.object({
    mode: PageSortModeSchema,
    overridden: z.boolean(),
    default_mode: PageSortModeSchema,
    effective_mode: PageSortModeSchema,
  }),
});

const NightlyResponseSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    overridden: z.boolean(),
    default_enabled: z.boolean(),
    effective_enabled: z.boolean(),
  }),
});

/**
 * Calls GET/PUT on one /api/v1/settings route with the base URL, token and fetch the SDK client was built from.
 * Cookie auth rides along: the default base URL is same-origin, and a host pointing the UI at another origin
 * supplies its own `fetch`.
 */
function settingRequester(options: CreateTrueForgeClientOptions, path: string) {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  return async (method: 'GET' | 'PUT', body?: object): Promise<unknown> => {
    const response = await fetchImpl(`${base}${path}`, {
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
          : `The setting could not be saved (HTTP ${String(response.status)}). Try again in a moment.`,
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
    const { mode, overridden, default_mode, effective_mode } = parsed.data.data;
    return { mode, overridden, defaultMode: default_mode, effectiveMode: effective_mode };
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
    const { enabled, overridden, default_enabled, effective_enabled } = parsed.data.data;
    return { enabled, overridden, defaultEnabled: default_enabled, effectiveEnabled: effective_enabled };
  };
  return {
    getMemoryNightly: async () => parse(await request('GET')),
    setMemoryNightlyEnabled: async enabled => parse(await request('PUT', { enabled })),
  };
}

/** Human-readable error for the controls; callers render it inline. */
export function memoryHelperErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The setting could not be saved. Try again in a moment.');
}
