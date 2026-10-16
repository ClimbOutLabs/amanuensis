function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

/** The HTTP status and the server's machine-readable `error.code` of an API error, when it has them. */
export function apiErrorCode(error: unknown): { statusCode: unknown; code: unknown } | undefined {
  if (!(error instanceof Error)) return undefined;
  const body: unknown = Reflect.get(error, 'body');
  const detail = isRecord(body) ? body.error : undefined;
  return { statusCode: Reflect.get(error, 'statusCode'), code: isRecord(detail) ? detail.code : undefined };
}
