import envPaths from 'env-paths';
import path from 'node:path';
import { appDataDirFromEnv, resolveAppDataDir, voiceModelDirFromEnv } from '../../src/appDataDir';
import { processEnv } from '../../src/cli/env';
import configuration from '../../src/config';

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

  it('reads the data folder from the environment names the server uses', () => {
    expect(appDataDirFromEnv({ APP_DATA_DIR: '/data/app' })).toBe('/data/app');
    expect(appDataDirFromEnv({})).toBe(resolveAppDataDir({ override: undefined, suffix: '' }));
    expect(appDataDirFromEnv({ APP_DATA_DIR_SUFFIX: 'dev' })).toBe(
      resolveAppDataDir({ override: undefined, suffix: 'dev' }),
    );
  });

  it('keeps the voice model under the data folder unless a folder is named, for the server and the setup script alike', () => {
    expect(voiceModelDirFromEnv({ APP_DATA_DIR: '/data/app' })).toBe('/data/app/voice-model');
    expect(voiceModelDirFromEnv({ APP_DATA_DIR: '/data/app', VOICE_VAD_MODEL_DIR: '/opt/aman-voice' })).toBe(
      '/opt/aman-voice',
    );
    expect(voiceModelDirFromEnv({ APP_DATA_DIR: '/data/app', VOICE_VAD_MODEL_DIR: '  ' })).toBe(
      '/data/app/voice-model',
    );
  });

  it('gives the server and the setup script the same model folder, and an absolute one', () => {
    expect(configuration.VOICE_VAD_MODEL_DIR).toBe(voiceModelDirFromEnv(processEnv()));
    expect(path.isAbsolute(configuration.VOICE_VAD_MODEL_DIR)).toBe(true);
    expect(voiceModelDirFromEnv({ VOICE_VAD_MODEL_DIR: '.cache/voice-model' })).toBe(
      path.resolve('.cache/voice-model'),
    );
  });
});
