import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('the old reminder polling', () => {
  const sources = sourceFiles(SRC).map(path => ({ path, text: readFileSync(path, 'utf8') }));

  it.each([
    'aman.reminders.',
    'seen_at',
    'notified_at',
    'REMINDERS_POLL_MS',
    'RemindersProvider',
    'sessionRemindersMarker',
  ])('leaves no trace of %s in the browser code', needle => {
    // seen_at is the server's wire key; only the browser-storage uses are gone.
    const hits = sources.filter(source =>
      needle === 'seen_at' ? source.text.includes("'aman.reminders.seen_at'") : source.text.includes(needle),
    );
    expect(hits.map(hit => hit.path)).toEqual([]);
  });

  it('searches no sessions to find a Reminders chat', () => {
    const provider = sources.find(source => source.path.endsWith('DeliveriesContext.tsx'));
    expect(provider?.text).not.toContain('listSessions');
    expect(provider?.text).not.toContain('localStorage');
  });
});
