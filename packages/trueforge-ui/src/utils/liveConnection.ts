/**
 * The server still holds the chat's state; only this page lost its connection to it (a
 * backgrounded phone, a network change). The chat reconnects and resyncs instead of showing a
 * failure.
 */
export class LiveConnectionLostError extends Error {
  constructor(options?: { cause: unknown }) {
    super('Lost the live connection to the chat. It reconnects on its own when your network is back.', options);
    this.name = 'LiveConnectionLostError';
  }
}

/**
 * A reply that was still running when the server restarted: its live updates died with the
 * restart and it will never finish, so it was ended and the person sends their message again.
 */
export class ReplyStoppedByRestartError extends Error {
  constructor(options: { cause: unknown }) {
    super('The reply stopped because the server restarted.', options);
    this.name = 'ReplyStoppedByRestartError';
  }
}

/** The texts browsers use when a request or an open response never reached the server. */
function isNetworkFailureMessage(message: string): boolean {
  return (
    message === 'Failed to fetch' ||
    message === 'NetworkError when attempting to fetch resource.' ||
    message === 'Load failed' ||
    message === 'The network connection was lost.' ||
    /^network error$/i.test(message) ||
    /network request failed/i.test(message)
  );
}

/** True when the request never got an answer from the server, as opposed to an answer that was an error. */
export function isNetworkFailureError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const statusCode: unknown = Reflect.get(current, 'statusCode');
    if (typeof statusCode === 'number') return false;
    if (current instanceof Error && isNetworkFailureMessage(current.message)) return true;
    current = Reflect.get(current, 'cause');
  }
  return false;
}
