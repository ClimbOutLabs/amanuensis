import {
  missingPackageNextStep,
  skillFolderNamedInRunCode,
  skillScriptRealPathOperands,
  skillScriptRun,
  skillScriptStaysInFolder,
} from '../../../../src/core/sandbox/skills/skillScript';

const base = { skillsDir: '/workspace/.aman/skills', skillNames: ['ai-news'], skill: 'ai-news', args: [] };

describe('skillScriptRun', () => {
  test('a Python script runs with python3 from the skill folder, as separate arguments', () => {
    expect(skillScriptRun({ ...base, script: 'scripts/fetch.py', args: ['--days', '3'] })).toEqual({
      status: 'ok',
      skill_folder: '/workspace/.aman/skills/ai-news',
      script_path: '/workspace/.aman/skills/ai-news/scripts/fetch.py',
      argv: ['python3', 'scripts/fetch.py', '--days', '3'],
      command: "'python3' 'scripts/fetch.py' '--days' '3'",
    });
  });

  test('a JavaScript script runs with node', () => {
    const run = skillScriptRun({ ...base, script: 'run.mjs' });
    expect(run).toMatchObject({ status: 'ok', argv: ['node', 'run.mjs'] });
  });

  test('arguments pass through unchanged as their own items, never as shell text', () => {
    const args = ["x'; rm -rf / #", '$(id)', '`id`', 'a && b'];
    const run = skillScriptRun({ ...base, script: 'a.py', args });
    expect(run.status === 'ok' ? run.argv : []).toEqual(['python3', 'a.py', ...args]);
  });

  test('a skill not turned on in this chat is refused and the turned-on ones are named', () => {
    const run = skillScriptRun({ ...base, skill: 'other', script: 'a.py' });
    expect(run.status).toBe('invalid');
    expect(run.status === 'invalid' ? run.message : '').toContain('ai-news');
  });

  test.each([
    '/etc/passwd.py',
    '../other/a.py',
    'scripts/../../a.py',
    './a.py',
    '~/a.py',
    'a b.py',
    'a;b.py',
    '$(x).py',
    '-m.py',
    'scripts//a.py',
    '',
  ])('a script path outside the skill folder or with shell characters is refused: %s', script => {
    expect(skillScriptRun({ ...base, script }).status).toBe('invalid');
  });

  test.each(['run.sh', 'run', 'tool.rb', 'a.py.txt'])(
    'a file that is not Python or JavaScript is refused: %s',
    script => {
      expect(skillScriptRun({ ...base, script }).status).toBe('invalid');
    },
  );
});

describe('skillScriptStaysInFolder', () => {
  const skillsDir = '/workspace/.aman/skills';
  const check = (resolved: string, dir = skillsDir) =>
    skillScriptStaysInFolder({ skillsDir: dir, skill: 'ai-news', resolved });

  test('asks realpath about the skills folder, the skill folder and the script', () => {
    const run = skillScriptRun({ ...base, script: 'scripts/fetch.py' });
    expect(run.status === 'ok' ? skillScriptRealPathOperands({ skillsDir, run }) : []).toEqual([
      skillsDir,
      `${skillsDir}/ai-news`,
      `${skillsDir}/ai-news/scripts/fetch.py`,
    ]);
  });

  test('a script inside the folder passes', () => {
    expect(check(`${skillsDir}\n${skillsDir}/ai-news\n${skillsDir}/ai-news/scripts/fetch.py\n`)).toBe(true);
  });

  test.each([
    ['a script that links outside', `${skillsDir}\n${skillsDir}/ai-news\n/workspace/evil.py\n`],
    ['a link into a similarly named folder', `${skillsDir}\n${skillsDir}/ai-news\n${skillsDir}/ai-news-2/x.py\n`],
    ['a skill folder that is a link', `${skillsDir}\n/workspace/elsewhere\n/workspace/elsewhere/fetch.py\n`],
    ['a skills folder that is a link', `/tmp/s\n/tmp/s/ai-news\n/tmp/s/ai-news/fetch.py\n`],
    ['a missing line', `${skillsDir}\n${skillsDir}/ai-news\n`],
    ['an extra line', `${skillsDir}\n${skillsDir}/ai-news\n${skillsDir}/ai-news/a\nb\n`],
    ['nothing', ''],
  ])('%s fails', (_label, resolved) => {
    expect(check(resolved)).toBe(false);
  });

  test('a relative skills folder is judged by the real paths alone', () => {
    expect(check('/root/s1/skills\n/root/s1/skills/ai-news\n/root/s1/skills/ai-news/x.py\n', 'skills')).toBe(true);
    expect(check('/root/s1/skills\n/root/other\n/root/other/x.py\n', 'skills')).toBe(false);
  });
});

describe('skillFolderNamedInRunCode', () => {
  const skills = { skillsDir: '/workspace/.aman/skills', skillNames: ['ai-news', 'ai-news-digest'] };

  it('names the skill whose folder the code uses', () => {
    expect(
      skillFolderNamedInRunCode({ ...skills, text: 'root = "/workspace/.aman/skills/ai-news-digest"\nrun(root)' }),
    ).toBe('ai-news-digest');
    expect(skillFolderNamedInRunCode({ ...skills, text: "open('/workspace/.aman/skills/ai-news/data.csv')" })).toBe(
      'ai-news',
    );
  });

  it('works for a skills folder given relative to the sandbox root', () => {
    expect(
      skillFolderNamedInRunCode({ skillsDir: 'skills', skillNames: ['ai-news'], text: 'path = "skills/ai-news/x.py"' }),
    ).toBe('ai-news');
  });

  it('leaves code alone that names no turned-on skill', () => {
    expect(skillFolderNamedInRunCode({ ...skills, text: 'print("/workspace/.aman/skills/other/x.py")' })).toBe(
      undefined,
    );
    expect(skillFolderNamedInRunCode({ ...skills, text: 'print(1 + 1)' })).toBe(undefined);
  });
});

describe('missingPackageNextStep', () => {
  it('names the top Python module a script could not import', () => {
    const step = missingPackageNextStep(
      "Traceback (most recent call last):\nModuleNotFoundError: No module named 'madeup_feeds.parser'\n",
    );
    expect(step).toContain("Python module 'madeup_feeds'");
    expect(step).toContain('aman doctor sandbox --add-python');
  });

  it('names a Node package a script could not load', () => {
    expect(
      missingPackageNextStep("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'madeup-feed' imported"),
    ).toContain("Node package 'madeup-feed'");
    expect(missingPackageNextStep("Error: Cannot find module 'madeup-feed'")).toContain("Node package 'madeup-feed'");
  });

  it('says nothing for a missing local file or another failure', () => {
    expect(missingPackageNextStep("Error: Cannot find module './lib/helpers'")).toBe(undefined);
    expect(missingPackageNextStep('ValueError: bad date')).toBe(undefined);
  });
});
