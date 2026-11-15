import { z } from 'zod';

import type { CreateTrueForgeClientOptions } from '../client.js';

const ErrorSchema = z.object({ error: z.object({ message: z.string() }) });

type RequestMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

/**
 * Calls the memory routes with the same base URL, token, and fetch the SDK client was built from.
 * An error answer becomes an Error carrying the server's own message, so callers show it as it is.
 * Cookie auth rides along: the default base URL is same-origin, and a host pointing the UI at
 * another origin supplies its own `fetch`.
 */
export function createMemoryRequester(options: CreateTrueForgeClientOptions) {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  async function request<T>(
    method: RequestMethod,
    path: string,
    body: unknown,
    parse: (payload: unknown) => T,
  ): Promise<T> {
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
      const failure = ErrorSchema.safeParse(responseBody);
      throw new Error(
        failure.success ? failure.data.error.message : `Memory request failed with HTTP ${String(response.status)}`,
      );
    }
    return parse(responseBody);
  }

  /** The `?namespace=` suffix for a vault namespace; blank means the shared vault and adds nothing. */
  function namespaceQuery(namespace: string | undefined): string {
    const trimmed = (namespace ?? '').trim();
    return trimmed === '' ? '' : `?namespace=${encodeURIComponent(trimmed)}`;
  }

  return { request, namespaceQuery };
}
