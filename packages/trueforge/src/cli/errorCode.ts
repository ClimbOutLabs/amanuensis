/** System or driver error code (ENOENT, SQLITE_BUSY, ...), read structurally so it works across realms. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
