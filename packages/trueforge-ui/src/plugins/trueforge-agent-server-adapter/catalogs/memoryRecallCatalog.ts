import { z } from 'zod';

import { getErrorMessage } from '../../../utils/getErrorMessage.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

const MemoryRecallSettingSchema = z.object({ enabled: z.boolean().nullable() });

/** The person-level "use memories in replies" switch. `enabled` is null until someone sets it. */
export type MemoryRecallSetting = z.infer<typeof MemoryRecallSettingSchema>;

export interface MemoryRecallCatalog {
  getMemoryRecall(): Promise<MemoryRecallSetting>;
  /** Persists the switch for every chat; `null` clears it so each agent follows its own setting. */
  setMemoryRecallEnabled(enabled: boolean | null): Promise<MemoryRecallSetting>;
}

const MemoryRecallResponseSchema = z.object({ data: MemoryRecallSettingSchema });

/**
 * Calls GET/PUT /api/v1/settings/memory-recall with the same base URL, token, and fetch the SDK
 * client was built from. Direct because the generated SDK does not carry this route yet.
 */
export function createMemoryRecallCatalog(options: CreateTrueForgeClientOptions = {}): MemoryRecallCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request(method: 'GET' | 'PUT', body?: { enabled: boolean | null }): Promise<MemoryRecallSetting> {
    const response = await fetchImpl(`${base}/api/v1/settings/memory-recalls`, {
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
          : `The memory switch failed with HTTP ${String(response.status)}. Try again in a moment.`,
      );
    }
    const parsed = MemoryRecallResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new Error(
        'The server sent back something unexpected for the memory switch. Reload the page and try again.',
      );
    }
    return { enabled: parsed.data.data.enabled };
  }

  return {
    getMemoryRecall: () => request('GET'),
    setMemoryRecallEnabled: enabled => request('PUT', { enabled }),
  };
}

/** Plain-words error for the switch; callers render it inline. */
export function memoryRecallErrorMessage(error: unknown): string {
  return getErrorMessage(error, 'The memory switch could not be saved. Try again in a moment.');
}
