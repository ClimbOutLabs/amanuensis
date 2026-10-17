import { execFile } from 'node:child_process';
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
});
