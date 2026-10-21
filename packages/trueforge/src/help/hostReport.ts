import { readFile } from 'node:fs/promises';

import { HostReportFileSchema, type HostReportFile } from '../schemas/help';

/** A full check older than this is shown as stale and the person is asked to run it again. */
export const HOST_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** What the app could make of the installer's report. Anything unreadable is `invalid`, never a crash. */
export type HostReportRead =
  | { state: 'ok'; report: HostReportFile }
  | { state: 'stale'; report: HostReportFile }
  | { state: 'missing' }
  | { state: 'invalid' };

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/**
 * Reads the report the installer wrote. Read only: the app never runs a host command to make one.
 * A missing file, bad JSON, an unknown `schema_version` or a bad timestamp all read as a report
 * the app cannot use; the caller decides what to tell the person.
 */
export async function readHostReport({ path, now }: { path: string; now: Date }): Promise<HostReportRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return isMissingFileError(error) ? { state: 'missing' } : { state: 'invalid' };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: 'invalid' };
  }
  const parsed = HostReportFileSchema.safeParse(json);
  if (!parsed.success) {
    return { state: 'invalid' };
  }
  const checkedAt = Date.parse(parsed.data.checked_at);
  if (Number.isNaN(checkedAt)) {
    return { state: 'invalid' };
  }
  if (now.getTime() - checkedAt > HOST_REPORT_MAX_AGE_MS) {
    return { state: 'stale', report: parsed.data };
  }
  return { state: 'ok', report: parsed.data };
}
