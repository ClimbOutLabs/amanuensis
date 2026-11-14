import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appendSortReport,
  forgetSortReport,
  SORT_REPORT_FILE,
  SORT_REPORT_MAX_BYTES,
  type SortReportLine,
} from '../../../../src/runtime/memory/pageSortReport';

function line(n: number): SortReportLine {
  return {
    note_id: `md:v:2026-11-06.md#${String(n)}`,
    day: '2026-11-06',
    outcome: 'sorted',
    decisions: [{ decision: 'ignore', reason: 'x'.repeat(2000) }],
  };
}

describe('the sorting report', () => {
  it('stays under its size cap by dropping the oldest lines, even when lines are added at once', async () => {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'report-'));
    const count = Math.ceil(SORT_REPORT_MAX_BYTES / 2000) + 40;
    await Promise.all(Array.from({ length: count }, (_, n) => appendSortReport({ vaultDir, line: line(n) })));

    const file = path.join(vaultDir, SORT_REPORT_FILE);
    expect((await stat(file)).size).toBeLessThanOrEqual(SORT_REPORT_MAX_BYTES);
    const kept = (await readFile(file, 'utf8')).trim().split('\n');
    expect(kept.length).toBeLessThan(count);
    expect(kept.length).toBeGreaterThan(0);
    // The newest line is always kept.
    expect(JSON.parse(kept.at(-1) ?? '{}')).toMatchObject({ note_id: `md:v:2026-11-06.md#${String(count - 1)}` });
  });

  it('drops the lines about a note and keeps the rest', async () => {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'report-'));
    await appendSortReport({ vaultDir, line: line(1) });
    await appendSortReport({ vaultDir, line: line(2) });
    await appendSortReport({ vaultDir, line: line(1) });

    await forgetSortReport({ vaultDir, noteIds: ['md:v:2026-11-06.md#1'] });

    const kept = (await readFile(path.join(vaultDir, SORT_REPORT_FILE), 'utf8')).trim().split('\n');
    expect(kept.map(text => JSON.parse(text))).toEqual([line(2)]);
  });

  it('does nothing when there is no report', async () => {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'report-'));
    await expect(forgetSortReport({ vaultDir, noteIds: ['md:v:2026-11-06.md#1'] })).resolves.toBeUndefined();
  });
});
