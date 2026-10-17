import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecResult } from '../../../../../src/core/sandbox/provider/Provider';
import type { BridgeGuest } from '../../../../../src/core/sandbox/slots/git/gitBridge';

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
};

/**
 * A stand-in sandbox that runs commands for real in a temporary directory standing in for /workspace. It
 * records every command and file it was given, so tests can check what reached the guest.
 */
export class LocalGuest implements BridgeGuest {
  readonly commands: string[] = [];
  readonly files: string[] = [];
  /** Lets a test replace what `getFile` returns, to play a hostile sandbox. */
  tamperGetFile: ((content: Buffer) => Buffer) | undefined;

  constructor(readonly root: string) {}

  private map(text: string): string {
    return text.split('/workspace').join(this.root);
  }

  exec(input: {
    command: string;
    env: Record<string, string> | undefined;
    cwd: string | undefined;
  }): Promise<ExecResult> {
    this.commands.push(input.command);
    return new Promise(resolve => {
      execFile(
        'bash',
        ['-c', this.map(input.command)],
        {
          cwd: this.map(input.cwd ?? '/workspace'),
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...GIT_IDENTITY, ...input.env },
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ success: true, response: { exitCode, result: `${stdout}${stderr}` } });
        },
      );
    });
  }

  async putFile(input: { path: string; content: Buffer }): Promise<void> {
    this.files.push(input.path);
    const target = this.map(input.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content);
  }

  async getFile(input: { path: string }): Promise<Buffer> {
    const content = await readFile(this.map(input.path));
    return this.tamperGetFile === undefined ? content : this.tamperGetFile(content);
  }

  path(relative: string): string {
    return join(this.root, relative);
  }
}
