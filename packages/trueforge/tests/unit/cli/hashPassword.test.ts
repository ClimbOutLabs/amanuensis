import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { hashPassword } from '../../../src/cli/hashPassword';
import { UsageError } from '../../../src/cli/io';
import { fakeIo } from './fakeIo';

const OutputSchema = z.object({ hash: z.string() });

async function run(stdin: string, args: string[] = []): Promise<{ hash: string; stdout: string }> {
  const io = fakeIo({ stdin });
  const code = await hashPassword({ args, io });
  expect(code).toBe(0);
  const stdout = io.out.join('');
  return { hash: OutputSchema.parse(JSON.parse(stdout)).hash, stdout };
}

describe('hash-password', () => {
  it('prints a $2a$ bcrypt hash that verifies against the password', async () => {
    const { hash } = await run('correct horse battery staple');
    expect(hash).toMatch(/^\$2a\$10\$[./A-Za-z0-9]{53}$/);
    expect(await bcrypt.compare('correct horse battery staple', hash)).toBe(true);
    expect(await bcrypt.compare('another password', hash)).toBe(false);
  });

  it('strips one trailing newline but keeps other whitespace', async () => {
    const { hash } = await run('secret \n');
    expect(await bcrypt.compare('secret ', hash)).toBe(true);
    const crlf = await run('secret\r\n');
    expect(await bcrypt.compare('secret', crlf.hash)).toBe(true);
  });

  it('never echoes the password and salts each hash', async () => {
    const first = await run('SENTINEL-pass-123');
    const second = await run('SENTINEL-pass-123');
    expect(first.stdout).not.toContain('SENTINEL-pass-123');
    expect(first.hash).not.toBe(second.hash);
  });

  it('rejects an empty password as a usage error', async () => {
    await expect(hashPassword({ args: [], io: fakeIo({ stdin: '\n' }) })).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects a password bcrypt would truncate', async () => {
    await expect(hashPassword({ args: [], io: fakeIo({ stdin: 'a'.repeat(73) }) })).rejects.toBeInstanceOf(UsageError);
    await expect(hashPassword({ args: [], io: fakeIo({ stdin: 'é'.repeat(37) }) })).rejects.toBeInstanceOf(UsageError);
    await run('a'.repeat(72));
  });

  it('refuses arguments so a password cannot arrive in argv', async () => {
    await expect(hashPassword({ args: ['hunter2'], io: fakeIo({ stdin: 'x' }) })).rejects.toBeInstanceOf(UsageError);
  });
});
