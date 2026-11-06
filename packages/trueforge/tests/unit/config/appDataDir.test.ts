import envPaths from 'env-paths';
import path from 'node:path';
import { defaultVoiceModelDir, resolveAppDataDir } from '../../../src/appDataDir';
import configuration from '../../../src/config';

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

  it('roots the sandbox runs, state and git bridge directories in one place', () => {
    const root = path.dirname(configuration.SANDBOX_RUNS_DIR);
    expect(configuration.SANDBOX_STATE_DIR).toBe(path.join(root, 'sandbox-state'));
    expect(configuration.SANDBOX_GIT_BRIDGE_DIR).toBe(path.join(root, 'git-bridge'));
  });

  it('keeps the voice model folder under the data root so the setup script and the server agree', () => {
    expect(defaultVoiceModelDir('/data/app')).toBe('/data/app/voice-model');
    expect(configuration.VOICE_VAD_MODEL_DIR).toBe(
      process.env.VOICE_VAD_MODEL_DIR ?? defaultVoiceModelDir(path.dirname(configuration.SANDBOX_RUNS_DIR)),
    );
  });
});
