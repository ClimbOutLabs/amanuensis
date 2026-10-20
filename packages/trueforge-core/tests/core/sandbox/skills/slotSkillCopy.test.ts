import { execFileSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '../../../../src/core/sandbox/skills/SkillMounter';
import {
  copySkillsIntoSandbox,
  fetchRegistryArchive,
  skillCopyFailedNotice,
  SkillDownloadError,
  SkillTooLargeError,
  type SkillCopyDeps,
} from '../../../../src/core/sandbox/skills/slotSkillCopy';
import { execFileRunner, type HostCommandRunner } from '../../../../src/core/sandbox/slots/git/hostCommand';

const SKILLS_DIR = '/workspace/.aman/skills';
const ARCHIVE_DIR = '/workspace/.aman/transfer';
const TAR = '/usr/bin/tar';

function registry(input: { name: string; presignedUrl: string }): Skill {
  const { name, presignedUrl } = input;
  return {
    type: 'registry',
    name,
    description: name,
    fqn: `agent-skill:acme/team/${name}:1`,
    preload: false,
    skillMdContent: null,
    presignedUrl,
  };
}

/** A tarball built by the host's tar from whatever `build` puts in its folder. */
function archiveOf(build: (folder: string) => void): Buffer {
  const work = mkdtempSync(join(tmpdir(), 'skill-archive-test-'));
  try {
    const folder = join(work, 'src');
    mkdirSync(folder);
    build(folder);
    const archive = join(work, 'out.tar');
    execFileSync(TAR, ['-cf', archive, '-C', folder, '.']);
    return readFileSync(archive);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const SKILL_TAR = archiveOf(folder => writeFileSync(join(folder, 'SKILL.md'), '# alpha\n'));

// The real host git, pointed at local file:// repositories. Only the test widens the protocol list.
const fileGit: HostCommandRunner = {
  run: input =>
    execFileRunner.run({
      ...input,
      env: { ...input.env, GIT_ALLOW_PROTOCOL: 'file' },
      limits: undefined,
    }),
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();
}

/** The names a staged tar archive holds, listed by the host's tar. */
function archiveNames(archive: Buffer): string[] {
  const work = mkdtempSync(join(tmpdir(), 'skill-list-test-'));
  try {
    const file = join(work, 'a.tar');
    writeFileSync(file, archive);
    return execFileSync(TAR, ['-tf', file], { encoding: 'utf-8' })
      .split('\n')
      .filter(line => line !== '');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The text of one file inside a staged tar archive. */
function archiveText(archive: Buffer, name: string): string {
  const work = mkdtempSync(join(tmpdir(), 'skill-read-test-'));
  try {
    const file = join(work, 'a.tar');
    writeFileSync(file, archive);
    // Tar records the members under `./`.
    return execFileSync(TAR, ['-xOf', file, `./${name}`], { encoding: 'utf-8' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe('copySkillsIntoSandbox for registry skills', () => {
  test('stages each tarball in its own folder with its own move step', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive: () => Promise.resolve(SKILL_TAR) },
    });

    expect(result.failed.size).toBe(0);
    expect(result.staged).toHaveLength(1);
    const [alpha] = result.staged;
    expect(alpha?.name).toBe('alpha');
    expect(alpha?.objectId).toBeNull();
    expect(alpha?.archive).toEqual({ remotePath: `${ARCHIVE_DIR}/.tfy-skill-alpha.tar`, content: SKILL_TAR });
    expect(alpha?.command).toContain('tar --no-same-owner --no-same-permissions -xf');
    expect(alpha?.command).toContain(`mv -- '${SKILLS_DIR}/.tfy-staging/alpha' '${SKILLS_DIR}/alpha'`);
    expect(alpha?.command).toContain(`rmdir -- '${SKILLS_DIR}/.tfy-staging'`);
  });

  test('leaves out a skill whose download fails, as a download problem, and still stages the others', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [
        registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' }),
        registry({ name: 'beta', presignedUrl: 'https://dl.example/beta.tar' }),
      ],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: {
        fetchArchive: url =>
          url.endsWith('beta.tar')
            ? Promise.reject(new SkillDownloadError('answered 403'))
            : Promise.resolve(SKILL_TAR),
      },
    });

    expect(result.staged.map(({ name }) => name)).toEqual(['alpha']);
    expect(result.failed.get('beta')).toEqual({ cause: 'download' });
  });

  test('leaves out a body that is not a tar, and still stages the others', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [
        registry({ name: 'broken', presignedUrl: 'https://dl.example/broken.tar' }),
        registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' }),
      ],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: {
        fetchArchive: url =>
          Promise.resolve(url.endsWith('broken.tar') ? Buffer.from('<html>not a tar</html>') : SKILL_TAR),
      },
    });

    expect(result.staged.map(({ name }) => name)).toEqual(['alpha']);
    expect(result.failed.get('broken')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a tarball that holds a symlink', async () => {
    const linked = archiveOf(folder => symlinkSync('/etc/passwd', join(folder, 'SKILL.md')));
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'linked', presignedUrl: 'https://dl.example/linked.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive: () => Promise.resolve(linked) },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('linked')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a tarball that holds a hard link', async () => {
    const hardlinked = archiveOf(folder => {
      writeFileSync(join(folder, 'SKILL.md'), '# alpha\n');
      linkSync(join(folder, 'SKILL.md'), join(folder, 'copy.md'));
    });
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'hardlinked', presignedUrl: 'https://dl.example/hardlinked.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive: () => Promise.resolve(hardlinked) },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('hardlinked')).toEqual({ cause: 'damaged' });
  });

  test('leaves out an archive with no entries, as having no files', async () => {
    const empty = archiveOf(() => undefined);
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'empty', presignedUrl: 'https://dl.example/empty.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive: () => Promise.resolve(empty) },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('empty')).toEqual({ cause: 'no_files' });
  });

  test('leaves out an archive that holds only folders, as having no files', async () => {
    const folders = archiveOf(folder => mkdirSync(join(folder, 'empty-folder')));
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'folders', presignedUrl: 'https://dl.example/folders.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive: () => Promise.resolve(folders) },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('folders')).toEqual({ cause: 'no_files' });
  });

  test('reports a download that is too large as too large', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'huge', presignedUrl: 'https://dl.example/huge.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive: () => Promise.reject(new SkillTooLargeError('too big')) },
    });

    expect(result.failed.get('huge')).toEqual({ cause: 'too_large' });
  });

  test('refuses a skill name that could reach the downloader state files', async () => {
    const fetchArchive = jest.fn(() => Promise.resolve(SKILL_TAR));
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: '.tfy-requested-skills.json', presignedUrl: 'https://dl.example/x.tar' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { fetchArchive },
    });

    expect(fetchArchive).not.toHaveBeenCalled();
    expect(result.failed.get('.tfy-requested-skills.json')).toEqual({ cause: 'damaged' });
  });

  test('rethrows an abort instead of recording the skill as left out', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps: SkillCopyDeps = {
      signal: controller.signal,
      fetchArchive: () => Promise.reject(new Error('aborted')),
    };
    await expect(
      copySkillsIntoSandbox({
        skills: [registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' })],
        skillsDir: SKILLS_DIR,
        archiveDir: ARCHIVE_DIR,
        deps,
      }),
    ).rejects.toThrow('aborted');
  });
});

describe('skillCopyFailedNotice', () => {
  test('gives one action for each cause', () => {
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'download' })).toBe(
      "The skill echo couldn't be downloaded, so Aman is working without it. Check your internet connection.",
    );
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'missing_version' })).toBe(
      "The skill echo couldn't be loaded because the version you picked wasn't found, so Aman is working without it. Pick another version.",
    );
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'too_large' })).toBe(
      'The skill echo is larger than 100 MB, so Aman is working without it. Make it smaller.',
    );
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'damaged' })).toBe(
      "The skill echo couldn't be loaded because its files are damaged, so Aman is working without it. Remove it from your skills.",
    );
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'no_files' })).toBe(
      'The skill echo has no files to load, so Aman is working without it. Add its files to the skill.',
    );
  });
});

describe('fetchRegistryArchive', () => {
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: `${origin}/body` }).end();
        return;
      }
      response.writeHead(200).end(SKILL_TAR);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    origin = `http://127.0.0.1:${String(port)}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test('returns the bytes of a plain download', async () => {
    const bytes = await fetchRegistryArchive({ url: `${origin}/body`, signal: new AbortController().signal });
    expect(bytes.equals(SKILL_TAR)).toBe(true);
  });

  test('refuses a redirect, so the bytes come only from the presigned host', async () => {
    await expect(
      fetchRegistryArchive({ url: `${origin}/redirect`, signal: new AbortController().signal }),
    ).rejects.toThrow(SkillDownloadError);
  });

  test('stops reading once the body passes the size cap', async () => {
    await expect(
      fetchRegistryArchive({ url: `${origin}/body`, signal: new AbortController().signal, maxBytes: 16 }),
    ).rejects.toThrow(SkillTooLargeError);
  });
});

describe('copySkillsIntoSandbox for git skills', () => {
  let root: string;
  let repo: string;
  let commit: string;

  /** Commits whatever is in the repository now and records its commit id. */
  function commitAll(message: string): void {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
    commit = git(repo, ['rev-parse', 'HEAD']);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-copy-test-'));
    repo = join(root, 'source');
    mkdirSync(join(repo, 'skills', 'echo'), { recursive: true });
    mkdirSync(join(repo, 'other', 'echo'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'echo', 'SKILL.md'), '# echo\n');
    writeFileSync(join(repo, 'other', 'echo', 'SKILL.md'), '# other echo\n');
    writeFileSync(join(repo, 'other', 'NOTES.md'), 'not part of the skill\n');
    git(root, ['init', '-q', '-b', 'main', repo]);
    git(repo, ['config', 'uploadpack.allowFilter', 'true']);
    git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    commitAll('skill');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function gitSkill(input: { ref: string; path: string }): Skill {
    return {
      type: 'git',
      name: 'echo',
      description: 'Echo',
      url: `file://${repo}`,
      path: input.path,
      ref: input.ref,
    };
  }

  test('stages the skill folder at the commit the branch named, and pins that commit', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.failed.size).toBe(0);
    const [echo] = result.staged;
    expect(echo?.objectId).toBe(commit);
    const archive = echo?.archive.content ?? Buffer.alloc(0);
    expect(echo?.archive.remotePath).toBe(`${ARCHIVE_DIR}/.tfy-skill-echo.tar`);
    expect(archiveText(archive, 'SKILL.md')).toBe('# echo\n');
    expect(archiveNames(archive)).not.toContain('NOTES.md');
    expect(await readFile(join(repo, 'skills', 'echo', 'SKILL.md'), 'utf-8')).toBe('# echo\n');
  });

  test('uses a full commit id as the ref without asking the remote', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: commit, path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged.map(({ objectId }) => objectId)).toEqual([commit]);
  });

  test('reports a branch or tag the repository does not have as a missing version', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'no-such-branch', path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'missing_version' });
  });

  test('leaves out a skill whose folder path tries to leave the repository', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: '../other' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a skill whose folder is missing, as having no files', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'skills/not-there' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'no_files' });
  });

  test('leaves out a skill with a symlinked directory in its path, and stages nothing from the link target', async () => {
    // The link sends `linked/echo` to the other folder, which holds a different skill.
    symlinkSync(join(repo, 'other'), join(repo, 'linked'));
    commitAll('link a folder');
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'linked/echo' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a skill that holds a symlinked file, and stages nothing from the link target', async () => {
    symlinkSync(join(repo, 'other', 'NOTES.md'), join(repo, 'skills', 'echo', 'notes.md'));
    commitAll('link a file');
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a folder with nothing to copy, such as one holding only a submodule entry', async () => {
    git(repo, ['rm', '-q', 'skills/echo/SKILL.md']);
    git(repo, ['update-index', '--add', '--cacheinfo', `160000,${commit},skills/echo/sub`]);
    commitAll('submodule only');
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      archiveDir: ARCHIVE_DIR,
      deps: { host: fileGit },
    });

    expect(result.staged).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'no_files' });
  });
});
