import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { LOCAL_NO_SIGN_IN_MESSAGE } from '../auth/localSignIn';
import type { ILocalUserStore } from '../db/localUserStore';

/**
 * The real wiring for `aman reset-password`: the server probe, the instance's
 * SQLite database, and the terminal prompt. Loaded lazily by the command, so
 * importing the dispatcher never loads the server config.
 */

/** Any HTTP answer at all means a server is up; a refused or timed-out connection means it is not. */
export async function serverRunning(): Promise<boolean> {
  const { default: configuration } = await import('../config');
  const host = configuration.HOST === '0.0.0.0' || configuration.HOST === '::' ? '127.0.0.1' : configuration.HOST;
  try {
    await fetch(`http://${host}:${String(configuration.PORT)}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return true;
  } catch {
    return false;
  }
}

/** Opens the standalone SQLite database the npx install uses, at the latest schema. */
export async function openLocalUserStore(): Promise<{ store: ILocalUserStore; close(): Promise<void> }> {
  const { default: configuration } = await import('../config');
  if (!configuration.STANDALONE) {
    throw new Error(
      'This reset works on the install that runs on its own, on this computer. Run it there, where Aman keeps its SQLite database.',
    );
  }
  if (!existsSync(configuration.SQLITE_PATH)) {
    throw new Error(LOCAL_NO_SIGN_IN_MESSAGE);
  }
  const [{ createSqliteDb }, { migrateSqliteToLatest }, { SqliteLocalUserStore }] = await Promise.all([
    import('../db/sqlite/client'),
    import('../db/migrateSqlite'),
    import('../db/sqlite/local-user-store/SqliteLocalUserStore'),
  ]);
  const db = createSqliteDb(configuration.SQLITE_PATH);
  try {
    await migrateSqliteToLatest(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return { store: new SqliteLocalUserStore(db), close: () => db.destroy() };
}

/** One hidden line from a raw-mode terminal: characters are read, never echoed. Ctrl-C stops. */
async function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  const decoder = new StringDecoder('utf8');
  return new Promise<string>((resolve, reject) => {
    let text = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      for (const char of decoder.write(chunk)) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Stopped. Nothing was changed.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(text);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          text = text.slice(0, -1);
          continue;
        }
        text += char;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * The new password typed twice. On a terminal both are hidden; piped in, the
 * first two lines are the password and its repeat, so the command stays scriptable.
 */
export async function readPasswordPair(): Promise<{ password: string; confirm: string }> {
  if (process.stdin.isTTY) {
    const password = await readHiddenLine('New password: ');
    const confirm = await readHiddenLine('Type the new password again: ');
    return { password, confirm };
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const piece: unknown = chunk;
    if (Buffer.isBuffer(piece)) {
      chunks.push(piece);
    } else if (typeof piece === 'string') {
      chunks.push(Buffer.from(piece));
    }
  }
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return { password: lines[0] ?? '', confirm: lines[1] ?? '' };
}
