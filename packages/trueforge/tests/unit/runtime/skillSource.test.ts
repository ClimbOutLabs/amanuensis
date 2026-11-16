import { Response as UndiciResponse } from 'undici';

import {
  MAX_SKILL_FILE_BYTES,
  parseSkillAddress,
  parseSkillFile,
  readPublishedSkill,
  SkillSourceError,
  type SkillLookupDeps,
  type SkillSourceProblem,
} from '../../../src/runtime/skillSource';

const COMMIT = 'a'.repeat(40);
const SKILL_FILE = '---\nname: Release Notes\ndescription: Writes release notes.\n---\n\n# Steps\n\nRead the log.\n';

type Reply = { status: number; body: string; headers?: Record<string, string> };

const resolveAddresses = (): Promise<string[]> => Promise.resolve(['140.82.112.6']);

/** A GitHub stand-in that answers by path and records what was asked. */
function github(replies: Record<string, Reply>) {
  const asked: string[] = [];
  const deps: SkillLookupDeps = {
    fetchImpl: url => {
      asked.push(String(url));
      const reply = replies[String(url).replace('https://api.github.com', '')] ?? { status: 404, body: '{}' };
      return Promise.resolve(new UndiciResponse(reply.body, { status: reply.status, headers: reply.headers ?? {} }));
    },
    resolveAddresses,
  };
  return { deps, asked };
}

async function problemOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return error instanceof SkillSourceError ? error.problem : `other: ${String(error)}`;
  }
  return undefined;
}

describe('parseSkillAddress', () => {
  it('reads a plain repository address', () => {
    expect(parseSkillAddress('https://github.com/acme/skills.git')).toEqual({
      owner: 'acme',
      repo: 'skills',
      path: undefined,
      ref: undefined,
    });
  });

  it('reads the address of a folder or of the SKILL.md file as the browser shows it', () => {
    expect(parseSkillAddress('https://github.com/acme/skills/tree/main/skills/release-notes')).toEqual({
      owner: 'acme',
      repo: 'skills',
      path: 'skills/release-notes',
      ref: 'main',
    });
    expect(parseSkillAddress('https://github.com/acme/skills/blob/v2/skills/release-notes/SKILL.md')).toEqual({
      owner: 'acme',
      repo: 'skills',
      path: 'skills/release-notes',
      ref: 'v2',
    });
  });

  it.each([
    'http://github.com/acme/skills',
    'https://gitlab.com/acme/skills',
    'https://github.com.evil.example/acme/skills',
    'https://user:secret@github.com/acme/skills',
    'https://github.com/acme',
    'https://github.com/acme/skills/issues/3',
    'not an address',
  ])('refuses %s', address => {
    expect(parseSkillAddress(address)).toBeUndefined();
  });
});

describe('parseSkillFile', () => {
  it('splits the name and description from the instructions', () => {
    expect(parseSkillFile(SKILL_FILE)).toEqual({
      name: 'Release Notes',
      description: 'Writes release notes.',
      instructions: '# Steps\n\nRead the log.',
    });
  });

  it.each(['# No opening block', '---\nname: x\n---\nbody', '---\n- a list\n---\nbody', '---\n: : :\n---\n'])(
    'refuses a file without a description: %j',
    text => {
      expect(() => parseSkillFile(text)).toThrow(SkillSourceError);
    },
  );
});

describe('readPublishedSkill', () => {
  const address = { owner: 'acme', repo: 'skills', path: 'skills/release-notes', ref: 'main' };

  it('settles the branch to a commit, then reads the file at that commit', async () => {
    const { deps, asked } = github({
      '/repos/acme/skills/commits/main': { status: 200, body: JSON.stringify({ sha: COMMIT }) },
      [`/repos/acme/skills/contents/skills/release-notes/SKILL.md?ref=${COMMIT}`]: { status: 200, body: SKILL_FILE },
    });
    await expect(readPublishedSkill({ address, deps })).resolves.toEqual({
      commit: COMMIT,
      name: 'Release Notes',
      description: 'Writes release notes.',
      instructions: '# Steps\n\nRead the log.',
    });
    expect(asked).toHaveLength(2);
  });

  it('uses the main branch when none is named, and a full commit as it is', async () => {
    const top = github({
      '/repos/acme/skills/commits/HEAD': { status: 200, body: JSON.stringify({ sha: COMMIT }) },
      [`/repos/acme/skills/contents/SKILL.md?ref=${COMMIT}`]: { status: 200, body: SKILL_FILE },
    });
    const read = await readPublishedSkill({
      address: { owner: 'acme', repo: 'skills', path: undefined, ref: undefined },
      deps: top.deps,
    });
    expect(read.commit).toBe(COMMIT);

    const pinned = github({
      [`/repos/acme/skills/contents/skills/release-notes/SKILL.md?ref=${COMMIT}`]: { status: 200, body: SKILL_FILE },
    });
    await readPublishedSkill({ address: { ...address, ref: COMMIT }, deps: pinned.deps });
    expect(pinned.asked).toHaveLength(1);
  });

  it('says which thing is wrong, each with the one thing to do next', async () => {
    expect(await problemOf(readPublishedSkill({ address, deps: github({}).deps }))).toBe('not_found');
    const noFile = github({
      '/repos/acme/skills/commits/main': { status: 200, body: JSON.stringify({ sha: COMMIT }) },
    });
    expect(await problemOf(readPublishedSkill({ address, deps: noFile.deps }))).toBe('no_skill_file');
    const limited = github({ '/repos/acme/skills/commits/main': { status: 403, body: '{}' } });
    expect(await problemOf(readPublishedSkill({ address, deps: limited.deps }))).toBe('rate_limited');
    const moved = github({ '/repos/acme/skills/commits/main': { status: 301, body: '' } });
    expect(await problemOf(readPublishedSkill({ address, deps: moved.deps }))).toBe('not_found');
    const down: SkillLookupDeps = { fetchImpl: () => Promise.reject(new Error('offline')), resolveAddresses };
    expect(await problemOf(readPublishedSkill({ address, deps: down }))).toBe('unavailable');
    const problems: SkillSourceProblem[] = ['not_found', 'no_skill_file', 'rate_limited', 'unavailable'];
    for (const problem of problems) {
      expect(new SkillSourceError(problem).message).toMatch(/^Nothing was added because .+\. .+\.$/);
    }
  });

  it('never follows a redirect, and never reaches an address that is not on the public internet', async () => {
    const moved = github({
      '/repos/acme/skills/commits/main': {
        status: 301,
        body: '',
        headers: { location: 'https://api.github.com/repositories/1/commits/main' },
      },
    });
    expect(await problemOf(readPublishedSkill({ address, deps: moved.deps }))).toBe('not_found');
    expect(moved.asked).toHaveLength(1);

    const inside = github({
      '/repos/acme/skills/commits/main': { status: 200, body: JSON.stringify({ sha: COMMIT }) },
    });
    const deps: SkillLookupDeps = { ...inside.deps, resolveAddresses: () => Promise.resolve(['127.0.0.1']) };
    expect(await problemOf(readPublishedSkill({ address, deps }))).toBe('unavailable');
    expect(inside.asked).toHaveLength(0);
  });

  it('refuses a file too large to show in full', async () => {
    const huge = github({
      '/repos/acme/skills/commits/main': { status: 200, body: JSON.stringify({ sha: COMMIT }) },
      [`/repos/acme/skills/contents/skills/release-notes/SKILL.md?ref=${COMMIT}`]: {
        status: 200,
        body: `${SKILL_FILE}${'x'.repeat(MAX_SKILL_FILE_BYTES)}`,
      },
    });
    expect(await problemOf(readPublishedSkill({ address, deps: huge.deps }))).toBe('too_large');
  });
});
