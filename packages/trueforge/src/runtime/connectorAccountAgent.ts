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

/** What an account agent answered, or why no answer came. The cause is for the caller to attach, never to log. */
export type AccountAgentAnswer = { reached: true; status: number; body: unknown } | { reached: false; cause: unknown };

/**
 * One call to an account agent. `reached: false` means the request could not be made at all, so the caller
 * can say the connector is unreachable. `label` names the connector in the one log line. `secret`, when the
 * agent needs one, travels as a bearer token and is never logged.
 */
export async function callAccountAgent({
  accountUrl,
  secret,
  fetchImpl,
  logger,
  label,
  method,
  payload,
  timeoutMs,
}: {
  accountUrl: string;
  secret: string | undefined;
  fetchImpl: typeof fetch | undefined;
  logger: Pick<Logger, 'warn'>;
  label: string;
  method: 'GET' | 'POST' | 'DELETE';
  payload?: unknown;
  timeoutMs: number;
}): Promise<AccountAgentAnswer> {
  const doFetch = fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (secret !== undefined) {
    headers['Authorization'] = `Bearer ${secret}`;
  }
  let response: Response;
  try {
    response = await doFetch(`${accountUrl}/account`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // Only a fixed line is logged: a failed request's message can carry the address it went to.
    logger.warn(`${label} account agent could not be reached`);
    return { reached: false, cause };
  }
  const body: unknown = await response.json().catch(() => null);
  return { reached: true, status: response.status, body };
}
