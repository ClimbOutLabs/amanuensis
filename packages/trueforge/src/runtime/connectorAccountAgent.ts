/**
 * The calls every connector card makes to its sidecar's account agent over the instance's private
 * network. Only a response's shape is read. Its text is never logged or forwarded, because a
 * server's error can echo credentials that travelled with the request.
 */
import type { Logger } from 'winston';

/** One field of an agent response body; the body is untrusted, so every field stays unknown until checked. */
export function agentField(body: object, key: string): unknown {
  return new Map<string, unknown>(Object.entries(body)).get(key);
}

/** The fixed error word an agent answered with, or null when the body carries none. */
export function agentErrorKind(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const error = agentField(body, 'error');
  return typeof error === 'string' ? error : null;
}

/**
 * One call to an account agent. Returns null when the request cannot be made at all, so the caller
 * can say the connector is unreachable. `label` names the connector in the one log line.
 */
export async function callAccountAgent({
  accountUrl,
  fetchImpl,
  logger,
  label,
  method,
  payload,
  timeoutMs,
}: {
  accountUrl: string | undefined;
  fetchImpl: typeof fetch | undefined;
  logger: Pick<Logger, 'warn'>;
  label: string;
  method: 'GET' | 'POST' | 'DELETE';
  payload?: unknown;
  timeoutMs: number;
}): Promise<{ status: number; body: unknown } | null> {
  if (accountUrl === undefined) {
    return null;
  }
  const doFetch = fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${accountUrl}/account`, {
      method,
      headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // No error text is logged: a failed request's message can carry the address it went to,
    // and this module never risks printing anything that travelled with the password.
    logger.warn(`${label} account agent could not be reached`);
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}
