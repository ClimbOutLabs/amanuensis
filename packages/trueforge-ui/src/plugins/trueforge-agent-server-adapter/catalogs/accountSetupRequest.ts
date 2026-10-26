/**
 * The one way a Settings connector card talks to its server routes (email, calendar): plain fetch with
 * the browser session cookie and no Authorization header, a JSON body on every state-changing call, and
 * a defensive parse of the answer. An unrecognized shape is dropped. Every failure ends as one fixed plain
 * line with one next step: the server's own line when it sent one, else a line for what went wrong.
 */
import { z } from 'zod';
import { ACCOUNT_CONNECTION_STATES } from '../../../server/accountSetup.js';
import type { CreateTrueForgeClientOptions } from '../client.js';

/** The connection state as the routes send it, shared by every account card. */
export const AccountConnectionStateWireSchema = z.enum(ACCOUNT_CONNECTION_STATES);

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

const COULD_NOT_REACH_LINE = "Couldn't reach the server. Check your internet connection and try again.";
const SIGNED_OUT_LINE = 'You are signed out. Sign in again, then try again.';
const OWNER_ONLY_LINE = 'Only the owner can change this. Sign in as the owner, then try again.';
const SERVER_TROUBLE_LINE = 'Something went wrong on the server. Wait a minute, then try again.';
const NOT_UNDERSTOOD_LINE = 'The server answered in a way this page cannot read. Reload the page, then try again.';
const DID_NOT_WORK_LINE = 'That did not work. Try again.';

/** The line for a failed answer. The server's own line is used only for the failures it words for the card. */
function failureLine({ status, body }: { status: number; body: unknown }): string {
  if (status === 401) {
    return SIGNED_OUT_LINE;
  }
  if (status === 403) {
    return OWNER_ONLY_LINE;
  }
  if (status >= 500 && status !== 502) {
    return SERVER_TROUBLE_LINE;
  }
  return serverErrorMessage(body) ?? DID_NOT_WORK_LINE;
}

export function createAccountSetupRequest<TWire, TStatus>({
  options,
  path,
  wireSchema,
  toStatus,
}: {
  options: CreateTrueForgeClientOptions;
  /** The server route, such as /api/v1/user/settings/email. */
  path: string;
  wireSchema: z.ZodType<TWire>;
  toStatus: (wire: TWire) => TStatus;
}) {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const url = `${base}${path}`;

  return async function request(input: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<TStatus> {
    let response: Response;
    try {
      response = await fetchImpl(input.method === 'GET' ? `${url}/status` : url, {
        method: input.method,
        credentials: 'same-origin',
        headers: input.method === 'GET' ? {} : { 'Content-Type': 'application/json' },
        ...(input.method === 'GET' ? {} : { body: JSON.stringify(input.body ?? {}) }),
      });
    } catch (cause) {
      throw new Error(COULD_NOT_REACH_LINE, { cause });
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(failureLine({ status: response.status, body }));
    }
    const parsed = z.object({ data: wireSchema }).safeParse(body);
    if (!parsed.success) {
      throw new Error(NOT_UNDERSTOOD_LINE, { cause: parsed.error });
    }
    return toStatus(parsed.data.data);
  };
}
