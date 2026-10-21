import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readHostReport } from '../../../src/help/hostReport';

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'help', 'host-report.json');
const UNKNOWN_VERSION = path.join(__dirname, '..', '..', 'fixtures', 'help', 'host-report.unknown-version.json');
/** Five days after the fixture's checked_at: inside the seven day window. */
const FRESH_NOW = new Date('2026-10-25T08:30:00Z');
/** Fifteen days after the fixture's checked_at: stale. */
const STALE_NOW = new Date('2026-11-04T08:30:00Z');

function tempFile(name: string, text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aman-host-report-'));
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

describe('readHostReport', () => {
  it('reads the installer contract fixture as a usable report', async () => {
    const read = await readHostReport({ path: FIXTURE, now: FRESH_NOW });

    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(read.report.command).toBe('doctor');
    expect(read.report.overall).toBe('warn');
    expect(read.report.checks.map(check => check.id)).toEqual(['docker', 'disk_space', 'ports']);
  });

  it('reports a report older than seven days as stale and keeps its checks', async () => {
    const read = await readHostReport({ path: FIXTURE, now: STALE_NOW });

    expect(read.state).toBe('stale');
    if (read.state !== 'stale') return;
    expect(read.report.checked_at).toBe('2026-10-20T08:30:00Z');
  });

  it('treats a missing file as missing', async () => {
    const read = await readHostReport({ path: path.join(tmpdir(), 'no-such-host-report.json'), now: FRESH_NOW });

    expect(read).toEqual({ state: 'missing' });
  });

  it('treats invalid JSON as missing, never as a crash', async () => {
    const file = tempFile('host-report.json', '{ "schema_version": 1, ');

    await expect(readHostReport({ path: file, now: FRESH_NOW })).resolves.toEqual({ state: 'invalid' });
  });

  it('refuses a schema_version it does not know', async () => {
    const read = await readHostReport({ path: UNKNOWN_VERSION, now: FRESH_NOW });

    expect(read).toEqual({ state: 'invalid' });
  });

  it('refuses a report whose checked_at is not a date', async () => {
    const text = JSON.stringify({
      schema_version: 1,
      command: 'install',
      checked_at: 'yesterday afternoon',
      overall: 'pass',
      checks: [],
    });
    const file = tempFile('host-report.json', text);

    await expect(readHostReport({ path: file, now: FRESH_NOW })).resolves.toEqual({ state: 'invalid' });
  });
});
