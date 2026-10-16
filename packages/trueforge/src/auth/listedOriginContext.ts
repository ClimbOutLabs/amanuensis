import type { MiddlewareHandler } from 'hono';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestAllowedOrigin } from './allowedOrigins';

const storage = new AsyncLocalStorage<string>();

/** The listed address of the request being served, or undefined outside one or without a list of addresses. */
export function currentListedOrigin(): string | undefined {
  return storage.getStore();
}

/** Makes the listed address a request came to available to code far from the request that needs it. */
export function listedOriginMiddleware(allowedOrigins: () => readonly string[]): MiddlewareHandler {
  return (c, next) => {
    const origin = requestAllowedOrigin({ context: c, allowedOrigins: allowedOrigins() });
    return origin === undefined ? next() : storage.run(origin, next);
  };
}
