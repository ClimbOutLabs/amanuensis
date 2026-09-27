import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/**
 * The stored recall screen setting: `enabled` is the persisted override when one is
 * stored, else the `MEMORY_SCREEN_ENABLED` env default; `overridden` says which of the
 * two it is. This is the stored value, not the effective runtime state — recall screening
 * is effectively off when no screening service is configured (see the capability's
 * `configured` flag).
 */
export interface MemoryScreenSetting {
  enabled: boolean;
  overridden: boolean;
  defaultEnabled: boolean;
}

export interface MemoryScreenCatalog {
  getMemoryScreen(): Promise<MemoryScreenSetting>;
  /**
   * Persists the override: `true`/`false` turns recall screening on/off; `null` clears
   * the override back to the server default. Returns the stored setting.
   */
  setMemoryScreenEnabled(enabled: boolean | null): Promise<MemoryScreenSetting>;
}

const MemoryScreenResponseSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    overridden: z.boolean(),
    default_enabled: z.boolean(),
  }),
});

function parseSetting(body: unknown): MemoryScreenSetting {
  const parsed = MemoryScreenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected recall screen payload');
  }
  return {
    enabled: parsed.data.data.enabled,
    overridden: parsed.data.data.overridden,
    defaultEnabled: parsed.data.data.default_enabled,
  };
}

/**
 * Calls GET/PUT /api/v1/settings/memory-screens with the same base URL, token,
 * and fetch the SDK client was built from. Direct rather than through the client
 * because the generated SDK does not carry this route yet; it moves onto the client
 * at the next regeneration. Cookie auth rides along: the default base URL is
 * same-origin, and a host pointing the UI at another origin supplies its own `fetch`.
 */
export function createMemoryScreenCatalog(options: CreateTrueForgeClientOptions = {}): MemoryScreenCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: 'GET' | 'PUT', body?: { enabled: boolean | null }): Promise<MemoryScreenSetting> {
    const response = await fetchImpl(`${base}/api/v1/settings/memory-screens`, {
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
          : `Recall screen setting failed with HTTP ${String(response.status)}`,
      );
    }
    return parseSetting(responseBody);
  }

  return {
    getMemoryScreen: () => request('GET'),
    setMemoryScreenEnabled: enabled => request('PUT', { enabled }),
  };
}

/** Human-readable error for the toggle; callers render it inline. */
export function memoryScreenErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The recall screen setting could not be saved');
}
