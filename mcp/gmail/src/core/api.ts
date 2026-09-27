// Per-call options for googleapis methods.
//
// googleapis (via gaxios) honors an AbortSignal passed as the per-method
// `options` bag. Threading the MCP request's signal through every Gmail API
// call means tool timeouts (withTimeout in server/build.ts) and client
// cancellations (notifications/cancelled) actually abort the in-flight HTTPS
// request instead of merely racing it and leaking the socket.

export interface ApiSignal {
  signal?: AbortSignal;
}

/**
 * Build the googleapis per-call options bag carrying the operation's
 * AbortSignal. Pass as the second argument to any
 * `gmail.users.….<method>(params, apiOpts(ctx))` call.
 */
export function apiOpts(ctx: { signal?: AbortSignal }): ApiSignal {
  return { signal: ctx.signal };
}
