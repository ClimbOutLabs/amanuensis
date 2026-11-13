import { skillScriptRun } from '../../../../src/core/sandbox/skills/skillScript';

const base = { skillsDir: '/workspace/.aman/skills', skillNames: ['ai-news'], skill: 'ai-news', args: [] };

describe('skillScriptRun', () => {
  test('a Python script runs with python3 from the skill folder', () => {
    expect(skillScriptRun({ ...base, script: 'scripts/fetch.py', args: ['--days', '3'] })).toEqual({
      status: 'ok',
      skill_folder: '/workspace/.aman/skills/ai-news',
      command: "python3 'scripts/fetch.py' '--days' '3'",
    });
  });

  test('a JavaScript script runs with node', () => {
    const run = skillScriptRun({ ...base, script: 'run.mjs' });
    expect(run).toMatchObject({ status: 'ok', command: "node 'run.mjs'" });
  });

  test('arguments are quoted, so shell text in them is never run', () => {
    const run = skillScriptRun({ ...base, script: 'a.py', args: ["x'; rm -rf / #", '$(id)', '`id`', 'a && b'] });
    expect(run).toEqual({
      status: 'ok',
      skill_folder: '/workspace/.aman/skills/ai-news',
      command: `python3 'a.py' 'x'\\''; rm -rf / #' '$(id)' '\`id\`' 'a && b'`,
    });
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
