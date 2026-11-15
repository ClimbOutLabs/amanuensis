import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { migrateSqliteToLatest } from '../db/migrateSqlite';
import { createSqliteDb, rekeySqliteFile, sqliteFileState } from '../db/sqlite/client';
import { deriveDatabaseKey } from '../secrets/databaseKey';
import { KeyRecordFile, keyRecordPath } from '../secrets/keyRecordFile';
import type { SecretsDatabase } from './secretsRuntime';

const OTHER_KEY =
  'This database is encrypted with a different key. Unlock it with its recovery key instead of running setup.';

/** Setup's view of a SQLite instance: its key records beside the file, and the file itself kept encrypted. */
export function sqliteSecretsDatabase({
  sqlitePath,
  keyFile,
}: {
  sqlitePath: string;
  keyFile: string;
}): SecretsDatabase {
  return {
    settings: new KeyRecordFile(keyRecordPath(sqlitePath)),
    keyFile,
    ready: masterKey => {
      const state = sqliteFileState({ filename: sqlitePath, key: deriveDatabaseKey(masterKey) });
      return Promise.resolve(state === 'encrypted');
    },
    async prepare(masterKey) {
      const key = deriveDatabaseKey(masterKey);
      const state = sqliteFileState({ filename: sqlitePath, key });
      if (state === 'other_key') {
        throw new Error(OTHER_KEY);
      }
      if (state === 'plain') {
        rekeySqliteFile({ filename: sqlitePath, from: undefined, to: key });
      }
      await mkdir(path.dirname(sqlitePath), { recursive: true, mode: 0o700 });
      // Setup runs before the first start, so it also makes the database Aman then opens.
      const db = createSqliteDb(sqlitePath, { key });
      try {
        await migrateSqliteToLatest(db);
      } finally {
        await db.destroy();
      }
    },
    rekey({ from, to }) {
      const target = deriveDatabaseKey(to);
      const state = sqliteFileState({ filename: sqlitePath, key: target });
      // Already moved by a run that stopped before the key records were written.
      if (state !== 'encrypted' && state !== 'missing') {
        rekeySqliteFile({
          filename: sqlitePath,
          from: state === 'plain' ? undefined : deriveDatabaseKey(from),
          to: target,
        });
      }
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}
