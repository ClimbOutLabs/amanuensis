import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifiedWorkspaceCommitCommand } from '../../../../src/core/sandbox/provider/Provider';

const execFileAsync = promisify(execFile);

const STALE_RECEIPT = {
  branch: 'x',
  head: 'x',
  refsSha256: 'x',
  indexSha256: 'x',
  trackedWorktreeSha256: 'x',
  untrackedSha256: 'x',
};

describe('verifiedWorkspaceCommitCommand', () => {
  let parent: string;
  let repo: string;
  let toolFolder: string;
  let marker: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tfy-verified-commit-'));
    repo = join(parent, 'repo');
    toolFolder = join(parent, 'tools');
    marker = join(parent, 'planted-ran');
    await mkdir(repo);
    await mkdir(toolFolder);
    expect((await lstat(toolFolder)).isSymbolicLink()).toBe(false);
    await execFileAsync('git', ['-C', repo, 'init', '-q']);
    await execFileAsync('git', [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    await writeFile(marker, '');
    // Pass-through stand-ins that log each run, on a caller PATH that leads with a writable folder.
    for (const name of ['python3', 'git']) {
      const target = join(toolFolder, name);
      await writeFile(
        target,
        `#!/bin/sh\necho "${name} $*" >> '${marker}'\nfor d in /usr/bin /bin; do [ -x "$d/${name}" ] && exec "$d/${name}" "$@"; done\nexit 127\n`,
      );
      await chmod(target, 0o755);
    }
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  it('checks the receipt with programs from the trusted PATH, never the caller PATH', async () => {
    const command = verifiedWorkspaceCommitCommand({ command: 'true', workspaceRoot: repo, receipt: STALE_RECEIPT });
    const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
      cwd: repo,
      env: { PATH: `${toolFolder}:/usr/bin:/bin` },
    });
    expect(JSON.parse(stdout)).toEqual(expect.objectContaining({ status: 'blocked' }));
    expect(await readFile(marker, 'utf8')).toBe('');
  });

  /** Runs git in the fixture repo and returns its raw output. */
  async function gitBuffer(args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'buffer' });
    return stdout;
  }

  /** The receipt a capture of this repo would record, computed with the refs read this git accepts. */
  async function currentReceipt(): Promise<typeof STALE_RECEIPT> {
    const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
    let refs: Buffer;
    try {
      refs = await gitBuffer([
        'for-each-ref',
        '--include-root-refs',
        '--sort=refname',
        '--format=%(refname)%00%(objectname)%00%(symref)%00',
      ]);
    } catch {
      // Git before 2.48 rejects the flag; its refs read is the same list without it.
      refs = await gitBuffer(['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(symref)%00']);
    }
    return {
      branch: (await gitBuffer(['rev-parse', '--abbrev-ref', 'HEAD'])).toString('utf8').trim(),
      head: (await gitBuffer(['rev-parse', 'HEAD'])).toString('utf8').trim(),
      refsSha256: digest(refs),
      indexSha256: digest(
        await gitBuffer(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--']),
      ),
      trackedWorktreeSha256: digest(
        await gitBuffer(['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--']),
      ),
      untrackedSha256: digest(Buffer.from('[]', 'utf8')),
    };
  }

  async function runCommitCheck(receipt: typeof STALE_RECEIPT): Promise<{ status: string }> {
    const command = verifiedWorkspaceCommitCommand({ command: 'true', workspaceRoot: repo, receipt });
    const { stdout } = await execFileAsync('/bin/sh', ['-c', command], {
      cwd: repo,
      env: { PATH: `${toolFolder}:/usr/bin:/bin` },
    });
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== 'object' || parsed === null || !('status' in parsed) || typeof parsed.status !== 'string') {
      throw new Error('the commit check did not answer with a status');
    }
    return { status: parsed.status };
  }

  it('accepts a matching receipt on a git without the root refs flag', async () => {
    // The git on this machine is older than 2.48, so the check can only pass if
    // its refs read falls back to the same read without the flag.
    const result = await runCommitCheck(await currentReceipt());
    expect(result.status).toBe('completed');
  });

  it('sends the refs read with the root refs flag before any fallback', () => {
    const command = verifiedWorkspaceCommitCommand({ command: 'true', workspaceRoot: repo, receipt: STALE_RECEIPT });
    const withFlag = command.indexOf('"for-each-ref", "--include-root-refs"');
    const withoutFlag = command.indexOf('"for-each-ref", "--sort=refname"');
    expect(withFlag).toBeGreaterThan(-1);
    expect(withoutFlag).toBeGreaterThan(withFlag);
  });

  it('still blocks when the refs read fails for another reason', async () => {
    const receipt = await currentReceipt();
    // A damaged packed-refs file makes the refs read fail with a different error.
    await writeFile(join(repo, '.git', 'packed-refs'), 'garbage-not-a-pack\n');
    const result = await runCommitCheck(receipt);
    expect(result.status).toBe('blocked');
  });
});
