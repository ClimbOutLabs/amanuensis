import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/**
 * The item-tracking setting: `enabled` is the stored value (persisted override when
 * one is stored, else the default, which is on); `overridden` says which of the
 * two it is.
 */
export interface MemoryItemTrackingSetting {
  enabled: boolean;
  overridden: boolean;
  defaultEnabled: boolean;
}

export interface MemoryItemTrackingCatalog {
  getMemoryItemTracking(): Promise<MemoryItemTrackingSetting>;
  /**
   * Persists the override: `true`/`false` turns item tracking on/off; `null` clears
   * the override back to the default. Returns the stored setting.
   */
  setMemoryItemTrackingEnabled(enabled: boolean | null): Promise<MemoryItemTrackingSetting>;
}

const MemoryItemTrackingResponseSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    overridden: z.boolean(),
    default_enabled: z.boolean(),
  }),
});

function parseSetting(body: unknown): MemoryItemTrackingSetting {
  const parsed = MemoryItemTrackingResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected item-tracking payload');
  }
  return {
    enabled: parsed.data.data.enabled,
    overridden: parsed.data.data.overridden,
    defaultEnabled: parsed.data.data.default_enabled,
  };
}

/**
 * Calls GET/PUT /api/v1/settings/memory-item-tracking with the same base URL, token,
 * and fetch the SDK client was built from. Direct rather than through the client
 * because the generated SDK does not carry this route yet; it moves onto the client
 * at the next regeneration. Cookie auth rides along: the default base URL is
 * same-origin, and a host pointing the UI at another origin supplies its own `fetch`.
 */
export function createMemoryItemTrackingCatalog(options: CreateTrueForgeClientOptions = {}): MemoryItemTrackingCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(
    method: 'GET' | 'PUT',
    body?: { enabled: boolean | null },
  ): Promise<MemoryItemTrackingSetting> {
    const response = await fetchImpl(`${base}/api/v1/settings/memory-item-tracking`, {
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
          : `Item-tracking setting failed with HTTP ${String(response.status)}`,
      );
    }
    return parseSetting(responseBody);
  }

  return {
    getMemoryItemTracking: () => request('GET'),
    setMemoryItemTrackingEnabled: enabled => request('PUT', { enabled }),
  };
}

/** Human-readable error for the toggle; callers render it inline. */
export function memoryItemTrackingErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The item-tracking setting could not be saved');
}
