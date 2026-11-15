import path from 'node:path';

import { runSecrets } from '../../../src/cli/secrets';
import { fakeIo } from '../cli/fakeIo';

/**
 * Sets up this data folder's key and database the way setup does before a first start.
 * Returns the environment the server needs to find the key.
 */
export async function setUpSecrets({
  dataDir,
  sqlitePath = path.join(dataDir, 'db', 'db.sqlite'),
}: {
  dataDir: string;
  sqlitePath?: string;
}): Promise<{ SECRETS_KEY_FILE: string }> {
  const keyFile = path.join(dataDir, 'machine-key', 'master.key');
  await runSecrets({ args: ['init', '--sqlite', sqlitePath, '--key-file', keyFile], io: fakeIo(), env: {} });
  return { SECRETS_KEY_FILE: keyFile };
}
