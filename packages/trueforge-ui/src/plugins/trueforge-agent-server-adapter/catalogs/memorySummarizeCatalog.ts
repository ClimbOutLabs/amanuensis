import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/**
 * The turn-summarization setting: `enabled` is the stored value (persisted override when
 * one is stored, else the `MEMORY_SUMMARIZE` env default); `overridden` says which of the
 * two it is; `effectiveEnabled` is what the server will actually do for the next turn —
 * the stored value with the markdown-only gate applied. The toggle shows the effective
 * value: what you see is the truth.
 */
export interface MemorySummarizeSetting {
  enabled: boolean;
  overridden: boolean;
  defaultEnabled: boolean;
  effectiveEnabled: boolean;
}

export interface MemorySummarizeCatalog {
  getMemorySummarize(): Promise<MemorySummarizeSetting>;
  /**
   * Persists the override: `true`/`false` turns summarization on/off; `null` clears
   * the override back to the server default. Returns the stored setting.
   */
  setMemorySummarizeEnabled(enabled: boolean | null): Promise<MemorySummarizeSetting>;
}

const MemorySummarizeResponseSchema = z.object({
  data: z.object({
    enabled: z.boolean(),
    overridden: z.boolean(),
    default_enabled: z.boolean(),
    effective_enabled: z.boolean(),
  }),
});

function parseSetting(body: unknown): MemorySummarizeSetting {
  const parsed = MemorySummarizeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('The server returned an unexpected turn-summarization payload');
  }
  return {
    enabled: parsed.data.data.enabled,
    overridden: parsed.data.data.overridden,
    defaultEnabled: parsed.data.data.default_enabled,
    effectiveEnabled: parsed.data.data.effective_enabled,
  };
}

/**
 * Calls GET/PUT /api/v1/settings/memory-summarize with the same base URL, token,
 * and fetch the SDK client was built from. Direct rather than through the client
 * because the generated SDK does not carry this route yet; it moves onto the client
 * at the next regeneration. Cookie auth rides along: the default base URL is
 * same-origin, and a host pointing the UI at another origin supplies its own `fetch`.
 */
export function createMemorySummarizeCatalog(options: CreateTrueForgeClientOptions = {}): MemorySummarizeCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: 'GET' | 'PUT', body?: { enabled: boolean | null }): Promise<MemorySummarizeSetting> {
    const response = await fetchImpl(`${base}/api/v1/settings/memory-summarize`, {
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
          : `Turn-summarization setting failed with HTTP ${String(response.status)}`,
      );
    }
    return parseSetting(responseBody);
  }

  return {
    getMemorySummarize: () => request('GET'),
    setMemorySummarizeEnabled: enabled => request('PUT', { enabled }),
  };
}

/** Human-readable error for the toggle; callers render it inline. */
export function memorySummarizeErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The turn-summarization setting could not be saved');
}
