/**
 * The one way a Settings connector card talks to its server routes (email, calendar): plain fetch with
 * the browser session cookie and no Authorization header, a JSON body on every state-changing call, and
 * a defensive parse of the answer. An unrecognized shape is dropped, and only the server's own plain
 * failure line is ever shown.
 */
import { z } from 'zod';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** The server's plain failure line, when the body carries one; the server only sends fixed lines. */
function serverErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const error = new Map(Object.entries(body)).get('error');
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const message = new Map(Object.entries(error)).get('message');
  return typeof message === 'string' && message !== '' ? message : undefined;
}

export function createAccountSetupRequest<TWire, TStatus>({
  options,
  path,
  label,
  wireSchema,
  toStatus,
}: {
  options: CreateTrueForgeClientOptions;
  /** The server route, such as /api/v1/user/settings/email. */
  path: string;
  /** Names the connector in the one generic failure line, such as Email. */
  label: string;
  wireSchema: z.ZodType<TWire>;
  toStatus: (wire: TWire) => TStatus;
}) {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const url = `${base}${path}`;

  return async function request(input: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<TStatus> {
    const response = await fetchImpl(input.method === 'GET' ? `${url}/status` : url, {
      method: input.method,
      credentials: 'same-origin',
      headers: input.method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      ...(input.method === 'GET' ? {} : { body: JSON.stringify(input.body ?? {}) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(serverErrorMessage(body) ?? `${label} request failed with HTTP ${String(response.status)}`);
    }
    const parsed = z.object({ data: wireSchema }).safeParse(body);
    if (!parsed.success) {
      throw new Error(`The server returned an unexpected ${label.toLowerCase()} payload`);
    }
    return toStatus(parsed.data.data);
  };
}
