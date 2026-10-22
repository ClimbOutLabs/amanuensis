import path from 'node:path';

import { buildEvalSources } from '../../../src/eval/fixtures';

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'evals', 'fixtures');

describe('eval fixtures', () => {
  it('load the invented inbox and calendar from the evals folder', () => {
    const sources = buildEvalSources(FIXTURE_DIR);

    expect(sources.mailOwner).toBe('dana.park@example.com');
    expect(sources.timeZone).toBe('Europe/Lisbon');
  });

  it('refuse a fixture that does not match its format, and say which file', () => {
    expect(() => buildEvalSources(path.resolve(__dirname, 'missing-folder'))).toThrow(/inbox\.json/);
  });
});
