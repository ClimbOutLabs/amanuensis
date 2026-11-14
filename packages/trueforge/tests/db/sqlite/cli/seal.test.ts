import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { z } from 'zod';

import { UsageError } from '../../../../src/cli/io';
import { createSealCommand, type SealDeps } from '../../../../src/cli/seal';
import { runSecrets } from '../../../../src/cli/secrets';
import { fakeIo } from '../../../unit/cli/fakeIo';
import { createSqliteTestDatabase, type SqliteTestDatabase } from '../testDatabase';

const CANARY = 'backup-canary-8c14e6f0a3';
const InitResultSchema = z.object({ recovery_key: z.string() });

describe('aman seal and unseal', () => {
  let env: SqliteTestDatabase;
  let dir: string;
  let keyFile: string;
  let recoveryKey: string;
  let plain: string;
  const original = Buffer.concat([Buffer.from(CANARY), randomBytes(300_000), Buffer.from(CANARY)]);

  function deps(overrides: Partial<SealDeps> = {}): SealDeps {
    return {
      env: {},
      stdin: () => Readable.from([]),
      stdout: () => new PassThrough(),
      ...overrides,
    };
  }

  function run(action: 'seal' | 'unseal', args: string[], overrides: Partial<SealDeps> = {}): Promise<number> {
    return createSealCommand({ action, deps: deps(overrides) })({ args, io: fakeIo() });
  }

  beforeEach(async () => {
    env = await createSqliteTestDatabase();
    dir = await mkdtemp(path.join(tmpdir(), 'aman-seal-'));
    keyFile = path.join(dir, 'master.key');
    plain = path.join(dir, 'backup.tar');
    await writeFile(plain, original);
    const io = fakeIo();
    await runSecrets({ args: ['init', '--sqlite', env.databaseFile, '--key-file', keyFile], io, env: {} });
    recoveryKey = InitResultSchema.parse(JSON.parse(io.out.join(''))).recovery_key;
  }, 120_000);

  afterEach(async () => {
    await env.teardown();
    await rm(dir, { recursive: true, force: true });
  });

  async function sealBackup(): Promise<string> {
    const sealed = path.join(dir, 'backup.sealed');
    await run('seal', ['--in', plain, '--out', sealed, '--sqlite', env.databaseFile, '--key-file', keyFile]);
    return sealed;
  }

  it("seals a file so it holds none of the original, and opens it again with this computer's key", async () => {
    const sealed = await sealBackup();
    expect((await readFile(sealed)).includes(CANARY)).toBe(false);
    const opened = path.join(dir, 'opened.tar');
    await run('unseal', ['--in', sealed, '--out', opened, '--key-file', keyFile]);
    expect((await readFile(opened)).equals(original)).toBe(true);
  });

  it('opens on another computer with the recovery key alone', async () => {
    const sealed = await sealBackup();
    await rm(keyFile);
    const recoveryFile = path.join(dir, 'recovery.txt');
    await writeFile(recoveryFile, `${recoveryKey.replaceAll('-', ' ')}\n`);
    const opened = path.join(dir, 'opened.tar');
    await run('unseal', ['--in', sealed, '--out', opened, '--recovery-key-file', recoveryFile]);
    expect((await readFile(opened)).equals(original)).toBe(true);
  });

  it('streams through stdin and stdout', async () => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    await run('seal', ['--in', '-', '--out', '-', '--sqlite', env.databaseFile, '--key-file', keyFile], {
      stdin: () => Readable.from([original.subarray(0, 1000), original.subarray(1000)]),
      stdout: () => sink,
    });
    const sealed = Buffer.concat(chunks);
    expect(sealed.includes(CANARY)).toBe(false);

    const opened: Buffer[] = [];
    const out = new PassThrough();
    out.on('data', (chunk: Buffer) => opened.push(chunk));
    await run('unseal', ['--in', '-', '--out', '-', '--key-file', keyFile], {
      stdin: () => Readable.from([sealed]),
      stdout: () => out,
    });
    expect(Buffer.concat(opened).equals(original)).toBe(true);
  });

  it('refuses a wrong recovery key and a changed file, and leaves no output behind', async () => {
    const sealed = await sealBackup();
    const opened = path.join(dir, 'opened.tar');
    const wrong = path.join(dir, 'wrong.txt');
    await writeFile(wrong, '000000-000000-000000-000000-000000-000000-000000-000000');
    await expect(run('unseal', ['--in', sealed, '--out', opened, '--recovery-key-file', wrong])).rejects.toThrow(
      UsageError,
    );

    const bytes = await readFile(sealed);
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0x01;
    await writeFile(sealed, bytes);
    await expect(run('unseal', ['--in', sealed, '--out', opened, '--key-file', keyFile])).rejects.toThrow(
      /Nothing was restored/,
    );
    expect(existsSync(opened)).toBe(false);
    expect((await readdir(dir)).filter(name => name.endsWith('.part'))).toEqual([]);
  });

  it('refuses to seal for a database that was never set up, or with a key that is not its own', async () => {
    const fresh = await createSqliteTestDatabase();
    try {
      await expect(
        run('seal', [
          '--in',
          plain,
          '--out',
          path.join(dir, 'x'),
          '--sqlite',
          fresh.databaseFile,
          '--key-file',
          keyFile,
        ]),
      ).rejects.toThrow(/aman secrets init/);
      expect(existsSync(path.join(dir, 'x'))).toBe(false);
    } finally {
      await fresh.teardown();
    }
  });

  it("refuses a file sealed with another computer's key", async () => {
    const sealed = await sealBackup();
    const other = await createSqliteTestDatabase();
    try {
      const otherKey = path.join(dir, 'other.key');
      await runSecrets({
        args: ['init', '--sqlite', other.databaseFile, '--key-file', otherKey],
        io: fakeIo(),
        env: {},
      });
      await expect(
        run('unseal', ['--in', sealed, '--out', path.join(dir, 'y'), '--key-file', otherKey]),
      ).rejects.toThrow(/another computer/);
    } finally {
      await other.teardown();
    }
  });
});
