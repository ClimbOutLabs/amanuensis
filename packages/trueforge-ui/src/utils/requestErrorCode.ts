function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

/** The server's `error.code` on a refused request, read from the response body the client kept. */
export function requestErrorCode(error: Error): string | undefined {
  const body: unknown = Reflect.get(error, 'body');
  const detail = isRecord(body) ? body.error : undefined;
  const code = isRecord(detail) ? detail.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The server refused a send because the chat's previous reply is still running. */
export function isPreviousTurnRunningError(error: unknown): boolean {
  return (
    error instanceof Error &&
    Reflect.get(error, 'statusCode') === 409 &&
    requestErrorCode(error) === 'previous_turn_running'
  );
}
