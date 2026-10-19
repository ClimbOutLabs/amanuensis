import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '../../../../src/core/sandbox/skills/SkillMounter';
import {
  copySkillsIntoSandbox,
  SKILL_COPY_FAILED_REASON,
  type SkillCopyDeps,
} from '../../../../src/core/sandbox/skills/slotSkillCopy';
import { execFileRunner, type HostCommandRunner } from '../../../../src/core/sandbox/slots/git/hostCommand';

const SKILLS_DIR = '/workspace/.aman/skills';

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
      deps: { fetchArchive: () => Promise.resolve(Buffer.from('tar-bytes')) },
    });

    expect(result.uploads).toEqual([
      { remotePath: `${SKILLS_DIR}/.tfy-archive-alpha.tar`, content: Buffer.from('tar-bytes') },
    ]);
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
          url.endsWith('beta.tar') ? Promise.reject(new Error('answered 403')) : Promise.resolve(Buffer.from('a')),
      },
    });

    expect(result.copied.map(({ skill }) => skill.name)).toEqual(['alpha']);
    expect(result.failed.get('beta')).toBe(SKILL_COPY_FAILED_REASON);
    expect(result.uploads.map(upload => upload.remotePath)).toEqual([`${SKILLS_DIR}/.tfy-archive-alpha.tar`]);
  });

  test('refuses a skill name that could reach the downloader state files', async () => {
    const fetchArchive = jest.fn(() => Promise.resolve(Buffer.from('a')));
    const result = await copySkillsIntoSandbox({
      skills: [registry({ name: '.tfy-requested-skills.json', presignedUrl: 'https://dl.example/x.tar' })],
      skillsDir: SKILLS_DIR,
      deps: { fetchArchive },
    });

    expect(fetchArchive).not.toHaveBeenCalled();
    expect(result.failed.get('.tfy-requested-skills.json')).toBe(SKILL_COPY_FAILED_REASON);
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

describe('copySkillsIntoSandbox for git skills', () => {
  let root: string;
  let repo: string;
  let commit: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-copy-test-'));
    repo = join(root, 'source');
    mkdirSync(join(repo, 'skills', 'echo'), { recursive: true });
    mkdirSync(join(repo, 'other'), { recursive: true });
    writeFileSync(join(repo, 'skills', 'echo', 'SKILL.md'), '# echo\n');
    writeFileSync(join(repo, 'other', 'NOTES.md'), 'not part of the skill\n');
    // A link inside the skill must not be copied: it could point at a host file.
    symlinkSync('/etc/passwd', join(repo, 'skills', 'echo', 'escape'));
    git(root, ['init', '-q', '-b', 'main', repo]);
    git(repo, ['config', 'uploadpack.allowFilter', 'true']);
    git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'skill']);
    commit = git(repo, ['rev-parse', 'HEAD']);
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
      deps: { git: fileGit },
    });

    expect(result.failed.size).toBe(0);
    expect(result.copied).toEqual([{ skill: gitSkill({ ref: 'main', path: 'skills/echo' }), objectId: commit }]);
    const skillMd = result.uploads.find(upload => upload.remotePath === `${SKILLS_DIR}/echo/SKILL.md`);
    expect(skillMd?.content.toString('utf-8')).toBe('# echo\n');
    expect(result.uploads.map(upload => upload.remotePath)).not.toContain(`${SKILLS_DIR}/echo/escape`);
    expect(result.uploads.some(upload => upload.remotePath.includes('/other/'))).toBe(false);
    expect(await readFile(join(repo, 'skills', 'echo', 'SKILL.md'), 'utf-8')).toBe('# echo\n');
  });

  test('uses a full commit id as the ref without asking the remote', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: commit, path: 'skills/echo' })],
      skillsDir: SKILLS_DIR,
      deps: { git: fileGit },
    });

    expect(result.copied).toEqual([{ skill: gitSkill({ ref: commit, path: 'skills/echo' }), objectId: commit }]);
  });

  test('leaves out a skill whose folder path tries to leave the repository', async () => {
    const result = await copySkillsIntoSandbox({
      skills: [gitSkill({ ref: 'main', path: '../other' })],
      skillsDir: SKILLS_DIR,
      deps: { git: fileGit },
    });

    expect(result.copied).toEqual([]);
    expect(result.failed.get('echo')).toBe(SKILL_COPY_FAILED_REASON);
  });
});
