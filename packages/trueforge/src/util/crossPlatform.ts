import { pathToFileURL } from 'node:url';

/** Dynamic-import an absolute module path (e.g. Kysely migration files). */
export function importAbsoluteModule(filePath: string): Promise<unknown> {
  // Jest's resolver takes raw absolute paths but chokes on file:// URLs.
  // Everywhere else (tsx, node) an absolute path must be a file:// URL: the
  // default ESM loader rejects bare Windows paths (protocol 'c:').
  // Direct process.env read: test-runner detection, not app config — config.ts
  // is never loaded in unit tests.
  if (process.env['JEST_WORKER_ID'] !== undefined) {
    return import(filePath);
  }
  return import(pathToFileURL(filePath).href);
}
