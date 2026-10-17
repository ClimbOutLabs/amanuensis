import envPaths from 'env-paths';
import path from 'node:path';
import configuration, { resolveAppDataDir } from '../../../src/config';

describe('app data dir', () => {
  it('uses APP_DATA_DIR as the root when it is set, made absolute', () => {
    expect(resolveAppDataDir({ override: '/data/app', suffix: 'dev' })).toBe('/data/app');
    expect(resolveAppDataDir({ override: 'relative/dir', suffix: '' })).toBe(path.resolve('relative/dir'));
  });

  it('falls back to the OS data dir, with the suffix, when APP_DATA_DIR is unset or blank', () => {
    const expected = envPaths('trueforge', { suffix: 'unit' }).data;
    expect(resolveAppDataDir({ override: undefined, suffix: 'unit' })).toBe(expected);
    expect(resolveAppDataDir({ override: '  ', suffix: 'unit' })).toBe(expected);
    expect(expected).toMatch(/trueforge-unit$/);
  });

  it('roots the sandbox runs and git bridge directories in one place', () => {
    const root = path.dirname(configuration.SANDBOX_RUNS_DIR);
    expect(configuration.SANDBOX_GIT_BRIDGE_DIR).toBe(path.join(root, 'git-bridge'));
  });
});
