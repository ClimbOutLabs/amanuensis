import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { runCli } from '../../../src/cli/dispatch';
import { fakeIo } from './fakeIo';

// The dispatcher must run without the server config, which throws on missing env.
jest.mock('../../../src/config', () => {
  throw new Error('server config was loaded by the CLI');
});

describe('aman dispatcher', () => {
  it('loads and runs hash-password without the server config', async () => {
    const io = fakeIo({ stdin: 'pw\n' });
    expect(await runCli({ argv: ['hash-password'], io })).toBe(0);
    expect(z.object({ hash: z.string() }).parse(JSON.parse(io.out.join(''))).hash).toMatch(/^\$2a\$/);
    expect(io.err).toEqual([]);
  });

  it('exits 2 with usage on stderr when no command is given', async () => {
    const io = fakeIo();
    expect(await runCli({ argv: [], io })).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toContain('Usage: aman <command>');
  });

  it('exits 2 for an unknown command, including inherited object keys', async () => {
    for (const name of ['nope', 'constructor', 'toString']) {
      const io = fakeIo();
      expect(await runCli({ argv: [name], io })).toBe(2);
      expect(io.err.join('')).toContain(`Unknown command "${name}"`);
    }
  });

  it('prints help on stderr and exits 0', async () => {
    const io = fakeIo();
    expect(await runCli({ argv: ['--help'], io })).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.err.join('')).toContain('hash-password');
  });

  it('maps a usage error to exit 2 and any other error to exit 1, message on stderr', async () => {
    const usage = fakeIo({ stdin: '\n' });
    expect(await runCli({ argv: ['hash-password'], io: usage })).toBe(2);
    expect(usage.err.join('')).toContain('empty');

    const scratch = await mkdtemp(path.join(tmpdir(), 'aman-dispatch-'));
    const failure = fakeIo();
    const argv = ['backup', '--target', path.join(scratch, 'out'), '--sqlite', path.join(scratch, 'missing.db')];
    expect(
      await runCli({
        argv: [...argv, '--memory-dir', path.join(scratch, 'mem'), '--persona-dir', path.join(scratch, 'persona')],
        io: failure,
      }),
    ).toBe(1);
    await rm(scratch, { recursive: true, force: true });
    expect(failure.out).toEqual([]);
    expect(failure.err.join('')).not.toBe('');
  });

  it('routes export-data and answers its usage without loading the server config', async () => {
    const io = fakeIo();
    expect(await runCli({ argv: ['export-data', '--help'], io })).toBe(0);
    expect(io.err.join('')).toContain('aman export-data --list-users');
    const bad = fakeIo();
    expect(await runCli({ argv: ['export-data'], io: bad })).toBe(2);
    expect(bad.err.join('')).toContain('--list-users');
  });

  it('routes doctor to its own parser', async () => {
    const io = fakeIo();
    expect(await runCli({ argv: ['doctor', '--only', 'nope'], io })).toBe(2);
    expect(io.err.join('')).toContain('Unknown check "nope"');
  });
});
