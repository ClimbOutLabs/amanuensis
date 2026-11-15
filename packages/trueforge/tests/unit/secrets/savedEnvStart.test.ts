import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { encodeKeyFile } from '../../../src/secrets/fileKeyProvider';
import { createMasterKey } from '../../../src/secrets/keyCheck';
import { KeyRecordFile, keyRecordPath } from '../../../src/secrets/keyRecordFile';
import { putSavedEnv } from '../../../src/secrets/savedEnv';

const NAMES = ['SQLITE_PATH', 'SECRETS_KEY_FILE', 'STANDALONE', 'NEBIUS_API_KEY', 'TAVILY_API_KEY'];

describe('the saved keys at start', () => {
  let dir: string;
  const before = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const name of NAMES) {
      before.set(name, process.env[name]);
    }
    dir = await mkdtemp(path.join(tmpdir(), 'aman-saved-env-'));
    const key = createMasterKey();
    const sqlite = path.join(dir, 'data', 'db.sqlite');
    await mkdir(path.join(dir, 'secrets'));
    await writeFile(path.join(dir, 'secrets', 'master.key'), encodeKeyFile(key), { mode: 0o600 });
    const settings = new KeyRecordFile(keyRecordPath(sqlite));
    await putSavedEnv({ settings, key, name: 'NEBIUS_API_KEY', value: 'saved-model-key' });
    await putSavedEnv({ settings, key, name: 'TAVILY_API_KEY', value: 'saved-search-key' });
    process.env['SQLITE_PATH'] = sqlite;
    process.env['SECRETS_KEY_FILE'] = path.join(dir, 'secrets', 'master.key');
    delete process.env['STANDALONE'];
    delete process.env['NEBIUS_API_KEY'];
  });

  afterEach(async () => {
    for (const name of NAMES) {
      const value = before.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('are in the environment once the start step is imported, and a value set there already wins', async () => {
    process.env['TAVILY_API_KEY'] = 'set-by-hand';
    await jest.isolateModulesAsync(async () => {
      await import('../../../src/secrets/savedEnvStart');
    });
    expect(process.env['NEBIUS_API_KEY']).toBe('saved-model-key');
    expect(process.env['TAVILY_API_KEY']).toBe('set-by-hand');
  });
});
