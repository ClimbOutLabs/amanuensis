import { randomBytes } from 'node:crypto';

import type { RequestContext } from './identity';

/** The header a request made inside this process carries to act as a person. It never leaves the process. */
export const IN_PROCESS_CALLER_HEADER = 'x-aman-in-process-caller';

const grants = new Map<string, RequestContext>();

/**
 * Lets work the server started itself, such as a phone call it placed, run requests through the app's own routes as
 * the person it is for, so sign-in rules, ownership checks and approvals stay exactly those of the person's own
 * requests. The key is random, lives only in this process's memory and works until it is revoked.
 */
export function grantInProcessCaller(context: RequestContext): { key: string; revoke: () => void } {
  const key = randomBytes(32).toString('base64url');
  grants.set(key, context);
  return {
    key,
    revoke: () => {
      grants.delete(key);
    },
  };
}

/** The person a request made inside this process acts as, or undefined for any other request. */
export function inProcessCaller(header: string | undefined): RequestContext | undefined {
  return header === undefined ? undefined : grants.get(header);
}
