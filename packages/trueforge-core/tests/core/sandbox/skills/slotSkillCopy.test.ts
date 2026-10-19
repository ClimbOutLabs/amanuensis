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
  type SkillCopyDeps,
} from '../../../../src/core/sandbox/skills/slotSkillCopy';
import { execFileRunner, type HostCommandRunner } from '../../../../src/core/sandbox/slots/git/hostCommand';

const SKILLS_DIR = '/workspace/.aman/skills';
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

describe('copySkillsIntoSandbox for registry skills', () => {
  test('uploads each tarball and lists an unpack step that drops ownership from the archive', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' })],
      skillsDir: SKILLS_DIR,
      deps: { fetchArchive: () => Promise.resolve(SKILL_TAR) },
    });

    expect(result.uploads).toEqual([{ remotePath: `${SKILLS_DIR}/.tfy-archive-alpha.tar`, content: SKILL_TAR }]);
    expect(result.unpackCommands).toHaveLength(1);
    expect(result.unpackCommands[0]).toContain('tar --no-same-owner --no-same-permissions -xf');
    expect(result.copied).toEqual([
      { skill: registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' }), objectId: null },
    ]);
    expect(result.failed.size).toBe(0);
  });

  test('leaves out a skill whose download fails and still copies the others', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [
        registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' }),
        registry({ name: 'beta', presignedUrl: 'https://dl.example/beta.tar' }),
      ],
      skillsDir: SKILLS_DIR,
      deps: {
        fetchArchive: url =>
          url.endsWith('beta.tar')
            ? Promise.reject(new SkillDownloadError('answered 403'))
            : Promise.resolve(SKILL_TAR),
      },
    });

    expect(result.copied.map(({ skill }) => skill.name)).toEqual(['alpha']);
    expect(result.failed.get('beta')).toEqual({ cause: 'download' });
    expect(result.uploads.map(upload => upload.remotePath)).toEqual([`${SKILLS_DIR}/.tfy-archive-alpha.tar`]);
  });

  test('leaves out a body that is not a tar, and still copies the others', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [
        registry({ name: 'broken', presignedUrl: 'https://dl.example/broken.tar' }),
        registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' }),
      ],
      skillsDir: SKILLS_DIR,
      deps: {
        fetchArchive: url =>
          Promise.resolve(url.endsWith('broken.tar') ? Buffer.from('<html>not a tar</html>') : SKILL_TAR),
      },
    });

    expect(result.copied.map(({ skill }) => skill.name)).toEqual(['alpha']);
    expect(result.failed.get('broken')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a tarball that holds a symlink', async () => {
    const linked = archiveOf(folder => symlinkSync('/etc/passwd', join(folder, 'SKILL.md')));
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: 'linked', presignedUrl: 'https://dl.example/linked.tar' })],
      skillsDir: SKILLS_DIR,
      deps: { fetchArchive: () => Promise.resolve(linked) },
    });

    expect(result.copied).toEqual([]);
    expect(result.uploads).toEqual([]);
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
      deps: { fetchArchive: () => Promise.resolve(hardlinked) },
    });

    expect(result.copied).toEqual([]);
    expect(result.failed.get('hardlinked')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a tarball that puts a path under a file, and still copies the others', async () => {
    // Listed in this order, `x` is a file and `x/y` needs `x` to be a folder. Unpacking fails on it.
    const parts = mkdtempSync(join(tmpdir(), 'skill-archive-parts-'));
    try {
      mkdirSync(join(parts, 'a'));
      mkdirSync(join(parts, 'b'));
      writeFileSync(join(parts, 'a', 'x'), 'a file\n');
      mkdirSync(join(parts, 'b', 'x'));
      writeFileSync(join(parts, 'b', 'x', 'y'), 'under the file\n');
      const conflicting = join(parts, 'conflict.tar');
      execFileSync(TAR, ['-cf', conflicting, '-C', join(parts, 'a'), 'x', '-C', join(parts, 'b'), 'x/y']);
      const result = await copySkillsIntoSandbox({
        skills: [
          registry({ name: 'conflict', presignedUrl: 'https://dl.example/conflict.tar' }),
          registry({ name: 'alpha', presignedUrl: 'https://dl.example/alpha.tar' }),
        ],
        skillsDir: SKILLS_DIR,
        deps: {
          fetchArchive: url => Promise.resolve(url.endsWith('conflict.tar') ? readFileSync(conflicting) : SKILL_TAR),
        },
      });

      expect(result.copied.map(({ skill }) => skill.name)).toEqual(['alpha']);
      expect(result.failed.get('conflict')).toEqual({ cause: 'damaged' });
    } finally {
      rmSync(parts, { recursive: true, force: true });
    }
  });

  test('leaves out a tarball that repeats a path', async () => {
    const parts = mkdtempSync(join(tmpdir(), 'skill-archive-parts-'));
    try {
      mkdirSync(join(parts, 'a'));
      mkdirSync(join(parts, 'b'));
      writeFileSync(join(parts, 'a', 'SKILL.md'), '# first\n');
      writeFileSync(join(parts, 'b', 'SKILL.md'), '# second\n');
      const repeated = join(parts, 'repeat.tar');
      execFileSync(TAR, ['-cf', repeated, '-C', join(parts, 'a'), 'SKILL.md', '-C', join(parts, 'b'), 'SKILL.md']);
      const result = await copySkillsIntoSandbox({
        skills: [registry({ name: 'repeat', presignedUrl: 'https://dl.example/repeat.tar' })],
        skillsDir: SKILLS_DIR,
        deps: { fetchArchive: () => Promise.resolve(readFileSync(repeated)) },
      });

      expect(result.copied).toEqual([]);
      expect(result.failed.get('repeat')).toEqual({ cause: 'damaged' });
    } finally {
      rmSync(parts, { recursive: true, force: true });
    }
  });

  test('refuses a skill name that could reach the downloader state files', async () => {
    const fetchArchive = jest.fn(() => Promise.resolve(SKILL_TAR));
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: '.tfy-requested-skills.json', presignedUrl: 'https://dl.example/x.tar' })],
      skillsDir: SKILLS_DIR,
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
        deps,
      }),
    ).rejects.toThrow('aborted');
  });
});

describe('skillCopyFailedNotice', () => {
  test('blames the connection only for a download failure', () => {
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'download' })).toBe(
      "The skill echo couldn't be loaded, so Aman is working without it. Check your internet connection, then start a new chat.",
    );
  });

  test('names damaged files, not the connection, when the archive itself is bad', () => {
    expect(skillCopyFailedNotice({ name: 'echo', cause: 'damaged' })).toBe(
      "The skill echo couldn't be loaded because its files are damaged, so Aman is working without it. Remove it from your skills or try a different version.",
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
    ).rejects.toThrow();
  });

  test('stops reading once the body passes the size cap', async () => {
    await expect(
      fetchRegistryArchive({ url: `${origin}/body`, signal: new AbortController().signal, maxBytes: 16 }),
    ).rejects.toThrow('too large');
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

  test('copies the skill folder at the commit the branch named, and pins that commit', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      deps: { host: fileGit },
    });

    expect(result.failed.size).toBe(0);
    expect(result.copied).toEqual([{ skill: gitSkill({ ref: 'main', path: 'skills/echo' }), objectId: commit }]);
    const skillMd = result.uploads.find(upload => upload.remotePath === `${SKILLS_DIR}/echo/SKILL.md`);
    expect(skillMd?.content.toString('utf-8')).toBe('# echo\n');
    expect(result.uploads.some(upload => upload.remotePath.includes('/other/'))).toBe(false);
    expect(await readFile(join(repo, 'skills', 'echo', 'SKILL.md'), 'utf-8')).toBe('# echo\n');
  });

  test('uses a full commit id as the ref without asking the remote', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: commit, path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      deps: { host: fileGit },
    });

    expect(result.copied).toEqual([{ skill: gitSkill({ ref: commit, path: 'skills/echo' }), objectId: commit }]);
  });

  test('leaves out a skill whose folder path tries to leave the repository', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: '../other' })],
      skillsDir: SKILLS_DIR,
      deps: { host: fileGit },
    });

    expect(result.copied).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a skill with a symlinked directory in its path, and uploads nothing from the link target', async () => {
    // The link sends `linked/echo` to the other folder, which holds a different skill.
    symlinkSync(join(repo, 'other'), join(repo, 'linked'));
    commitAll('link a folder');
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'linked/echo' })],
      skillsDir: SKILLS_DIR,
      deps: { host: fileGit },
    });

    expect(result.copied).toEqual([]);
    expect(result.uploads).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'damaged' });
  });

  test('leaves out a skill that holds a symlinked file, and uploads nothing from the link target', async () => {
    symlinkSync(join(repo, 'other', 'NOTES.md'), join(repo, 'skills', 'echo', 'notes.md'));
    commitAll('link a file');
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      deps: { host: fileGit },
    });

    expect(result.copied).toEqual([]);
    expect(result.uploads).toEqual([]);
    expect(result.failed.get('echo')).toEqual({ cause: 'damaged' });
  });
});
