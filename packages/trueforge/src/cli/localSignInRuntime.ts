import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';

import { LOCAL_NO_SIGN_IN_MESSAGE } from '../auth/localSignIn';
import type { ILocalUserStore } from '../db/localUserStore';
import type { ITerminalKeyStore } from '../db/terminalKeyStore';

/**
 * The real wiring for `aman create-account` and `aman reset-password`: the server probe, the
 * instance's SQLite database, and the terminal prompts. Loaded lazily by the commands, so
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

/**
 * Opens the standalone SQLite database the npx install uses, at the latest schema. With `create`,
 * a first run makes the database; otherwise a missing one means there is no sign-in to change.
 */
export async function openLocalUserStore({
  create,
}: {
  create: boolean;
}): Promise<{ store: ILocalUserStore; terminalKeyStore: ITerminalKeyStore; close(): Promise<void> }> {
  const { default: configuration } = await import('../config');
  if (!configuration.STANDALONE) {
    throw new Error(
      'This reset works on the install that runs on its own, on this computer. Run it there, where Aman keeps its SQLite database.',
    );
  }
  if (!create && !existsSync(configuration.SQLITE_PATH)) {
    throw new Error(LOCAL_NO_SIGN_IN_MESSAGE);
  }
  if (create) {
    await mkdir(path.dirname(configuration.SQLITE_PATH), { recursive: true });
  }
  const [{ createSqliteDb }, { migrateSqliteToLatest }, { SqliteLocalUserStore }, { TerminalKeyStore }] =
    await Promise.all([
      import('../db/sqlite/client'),
      import('../db/migrateSqlite'),
      import('../db/sqlite/local-user-store/SqliteLocalUserStore'),
      import('../db/terminalKeyStore'),
    ]);
  const db = createSqliteDb(configuration.SQLITE_PATH);
  try {
    await migrateSqliteToLatest(db);
  } catch (error) {
    await db.destroy();
    throw error;
  }
  return {
    store: new SqliteLocalUserStore(db),
    terminalKeyStore: new TerminalKeyStore(db),
    close: () => db.destroy(),
  };
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

/** One visible line from a terminal, for answers that are not secret. */
function readVisibleLine(prompt: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise<string>(resolve => {
    lines.question(prompt, answer => {
      lines.close();
      resolve(answer);
    });
  });
}

/** Every line piped in on stdin. */
async function readPipedLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const piece: unknown = chunk;
    if (Buffer.isBuffer(piece)) {
      chunks.push(piece);
    } else if (typeof piece === 'string') {
      chunks.push(Buffer.from(piece));
    }
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

/**
 * One answer per question. On a terminal each is asked in turn, and hidden ones are not shown;
 * piped in, the first lines are the answers in order, so the commands stay scriptable.
 */
export async function readAnswers(questions: readonly { prompt: string; hidden: boolean }[]): Promise<string[]> {
  if (process.stdin.isTTY) {
    const answers: string[] = [];
    for (const question of questions) {
      answers.push(question.hidden ? await readHiddenLine(question.prompt) : await readVisibleLine(question.prompt));
    }
    return answers;
  }
  const lines = await readPipedLines();
  return questions.map((_, index) => lines[index] ?? '');
}

/** The new password typed twice. */
export async function readPasswordPair(): Promise<{ password: string; confirm: string }> {
  const [password = '', confirm = ''] = await readAnswers([
    { prompt: 'New password: ', hidden: true },
    { prompt: 'Type the new password again: ', hidden: true },
  ]);
  return { password, confirm };
}
