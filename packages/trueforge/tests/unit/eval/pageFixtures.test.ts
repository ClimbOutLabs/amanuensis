import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildEvalPageFixtures, EVAL_PAGE_FIXTURE_HOST } from '../../../src/eval/pageFixtures';

const PAGE_DIR = path.resolve(__dirname, '..', '..', '..', 'evals', 'fixtures', 'pages');

describe('eval page fixtures', () => {
  it('serve the reserved host from the pages folder, and no other host', () => {
    const fixtures = buildEvalPageFixtures(PAGE_DIR);

    expect(EVAL_PAGE_FIXTURE_HOST).toBe('fixtures.aman.invalid');
    expect(fixtures.serves(`https://${EVAL_PAGE_FIXTURE_HOST}/long-report`)).toBe(true);
    expect(fixtures.serves('https://docs.example.invalid/long-report')).toBe(false);
    expect(fixtures.read(`https://${EVAL_PAGE_FIXTURE_HOST}/long-report`)?.text).toContain('Riverside Footbridge');
  });

  it('answer no page for a name the folder does not hold', () => {
    const fixtures = buildEvalPageFixtures(PAGE_DIR);

    expect(fixtures.read(`https://${EVAL_PAGE_FIXTURE_HOST}/no-such-page`)).toBeUndefined();
    expect(fixtures.read(`https://${EVAL_PAGE_FIXTURE_HOST}/`)).toBeUndefined();
  });

  it('refuse a page file whose name a link path cannot name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'eval-pages-'));
    try {
      await writeFile(path.join(dir, 'Bad Name.md'), 'text');
      expect(() => buildEvalPageFixtures(dir)).toThrow(/Bad Name\.md/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('say which folder is missing when the pages cannot be listed', () => {
    expect(() => buildEvalPageFixtures(path.resolve(__dirname, 'missing-pages'))).toThrow(/missing-pages/);
  });
});
