import type { RequestContext } from './identity';

/** What the app's request handler is given for a request Aman makes in its own process. */
export type InProcessFetch = (request: Request, env: object) => Response | Promise<Response>;

interface InProcessGrant {
  context: RequestContext;
  pathPrefix: string;
}

const grants = new WeakMap<object, InProcessGrant>();

/**
 * Lets work the server started itself, such as a phone call it placed, run requests through the app's own routes as
 * the person it is for, so sign-in rules, ownership checks and approvals stay exactly those of the person's own
 * requests. The grant is an object handed to the app's handler in this process: it is never data on a request, so
 * nothing from the network can name or copy it. It covers paths under `pathPrefix` only and ends when revoked.
 */
export function grantInProcessCaller({ context, pathPrefix }: { context: RequestContext; pathPrefix: string }): {
  env: object;
  revoke: () => void;
} {
  const env = Object.freeze({});
  grants.set(env, { context, pathPrefix });
  return {
    env,
    revoke: () => {
      grants.delete(env);
    },
  };
}

/** The person a request made inside this process acts as, or undefined for any other request. */
export function inProcessCaller({ env, path }: { env: unknown; path: string }): RequestContext | undefined {
  if (typeof env !== 'object' || env === null) {
    return undefined;
  }
  const grant = grants.get(env);
  return grant !== undefined && path.startsWith(grant.pathPrefix) ? grant.context : undefined;
}
