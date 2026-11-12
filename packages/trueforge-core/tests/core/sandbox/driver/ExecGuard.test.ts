import {
  classifyExecCommand,
  interpreterInvocationRefusal,
  type ExecGuardHost,
} from '../../../../src/core/sandbox/driver/ExecGuard';

function makeHost(overrides?: Partial<ExecGuardHost>): ExecGuardHost {
  return {
    resolveExecutable: () => undefined,
    readShebang: () => undefined,
    ...overrides,
  };
}

function verdictOf(command: string, host?: ExecGuardHost): 'allow' | 'reject' {
  return classifyExecCommand({ command, host: host ?? makeHost() }).verdict;
}

describe('classifyExecCommand', () => {
  describe('interpreter invocations are rejected', () => {
    const cases: [string, string][] = [
      ['python3 -c "print(1)"', '-c code string'],
      ['python3 -c"print(1)"', '-c glued to its argument'],
      ["node -e 'console.log(1)'", '-e code string'],
      ["node -e'console.log(1)'", '-e glued to its argument'],
      ['python3 - <<EOF\nprint(1)\nEOF', 'heredoc stdin'],
      ["python3 - <<'EOF'\nprint(1)\nEOF", 'quoted heredoc'],
      ['python3 script.py', 'script file operand'],
      ['python script.py --flag', 'script file with flags'],
      ['python3 -m', '-m without a module name'],
      ["python3 -m 'not a module'", '-m with something that is not a module name'],
      ['python3 -m pdb x.py', '-m pdb runs a script'],
      ['python3 -m cProfile x.py', '-m cProfile runs a script'],
      ['python3 -m runpy x', '-m runpy runs a module'],
      ['python3 -m timeit -s "import os" "os.system(1)"', '-m timeit runs code from its arguments'],
      ['python3 -m code', '-m code opens an interpreter'],
      ['python3 -m http.server 8000', '-m http.server serves the workspace'],
      ['python3 -mjson.tool data.json', 'a glued module that is not a build or test module'],
      ['python3 -m pytest_evil', 'a module whose name only starts with pytest'],
      ["python3 -cm 'print(1)'", '-c before -m in one cluster'],
      ["python3 -c 'print(1)' -m pytest", '-c before a later -m'],
      ['perl -e"print 1"', 'perl -e glued to its argument'],
      // Clustered short flags: the code letter executes from ANY position in
      // the cluster (all confirmed against live interpreters, Sep 2026).
      ["python3 -uc 'print(1)'", 'python -uc cluster'],
      ["python3 -xc 'print(1)'", 'python -xc cluster'],
      ["python3 -Suc 'print(1)'", 'python -Suc cluster'],
      ["python3 -Buc 'print(1)'", 'python -Buc cluster'],
      ["python3 -Wuc 'print(1)'", 'python -Wuc cluster (over-rejected: -W swallows the code letter, fail closed)'],
      ["node --eval 'console.log(1)'", 'node --eval long form'],
      ["node --eval='console.log(1)'", 'node --eval= long form'],
      ["node -p 'console.log(1)'", 'node -p print form'],
      ["node --print 'console.log(1)'", 'node --print long form'],
      ["node --print='console.log(1)'", 'node --print= long form'],
      ["node -pe 'console.log(1)'", 'node -pe cluster'],
      ["node --input-type=module --eval 'console.log(1)'", 'node --eval among long flags'],
      ["perl -E 'say 1'", 'perl -E feature form'],
      ["perl -ne 'print'", 'perl -ne cluster'],
      ["perl -pe 'print'", 'perl -pe cluster'],
      ["perl -pE 's/a/b/'", 'perl -pE cluster'],
      ["perl -lne 'print'", 'perl -lne cluster'],
      ["perl -Mstrict -pe 's/a/b/'", 'perl -pe after a module flag'],
      ["ruby -e 'puts 1'", 'ruby -e'],
      // Shell expansion in the command position defeats PATH resolution.
      ['X=python3 $X -c "print(1)"', 'env prefix stripped, $X in command position'],
      ['$PY -c "print(1)"', 'variable in command position'],
      ['`python3` -c "print(1)"', 'backtick-wrapped interpreter'],
      ['echo $(python3 -c "x")', 'command substitution whose inner command runs code'],
      ['echo hi | python3 -', 'stdin pipe'],
      ['python3', 'bare interpreter'],
      ['node server.js', 'node script file'],
      ['./analyze.py', 'direct script with python shebang'],
      ['sh -c \'python3 -c "x"\'', 'sh -c wrapper'],
      ['bash -lc "python3 --version; node -e 1"', 'bash -lc wrapper, second segment'],
      ['env FOO=1 python3 -c x', 'env wrapper'],
      ['FOO=1 BAR=2 python3 script.py', 'env-prefix assignments'],
      ['FOO=1 sh -c "python3 -c x"', 'env prefix before sh wrapper'],
      ['git status; python3 -c "x"', 'second pipeline segment'],
      ['git status && node -e "x"', '&& segment'],
    ];
    for (const [command, label] of cases) {
      it(`rejects: ${label}`, () => {
        const host = makeHost({
          readShebang: path => (path === './analyze.py' ? '#!/usr/bin/env python3' : undefined),
        });
        expect(verdictOf(command, host)).toBe('reject');
      });
    }
  });

  describe('repository commands are allowed', () => {
    const cases: [string, string][] = [
      ['git status', 'git'],
      ['pnpm test --filter foo', 'pnpm'],
      ['ls -la /tmp', 'ls'],
      ['python3 --version', 'interpreter flags only'],
      ['python3 -u', 'unbuffered flag alone stays allowed'],
      ['python3 -S', 'no-site flag alone stays allowed'],
      ['perl -w', 'warnings flag stays allowed'],
      ['node --version', 'node version flag stays allowed'],
      ['node --help', 'node flags only'],
      ['cat README.md | head -20', 'pipes of file tools'],
      ['npm run build', 'npm script'],
      ['FOO=1 git status', 'env prefix on a normal command'],
      ['sh -c "git status"', 'sh -c of a normal command'],
      // Installed modules run by name are how a Python project is built and tested.
      ['python3 -m pytest', '-m pytest'],
      ['python3 -m pytest tests/test_verify.py -q', '-m pytest with test paths after the module'],
      ['python3 -m pytest -c pytest.ini', "a -c after the module is the module's own argument"],
      ['python3 -m pip install -e .', '-m pip'],
      ['python3 -m venv .venv', '-m venv'],
      ['python3 -B -m pytest', '-m after another flag'],
      ['python3 -Bm pytest', '-m clustered with another flag'],
      ['python3 -mpytest -q', '-m glued to pytest'],
      ['python3 -m unittest discover', '-m unittest'],
      ['cd proj && python3 -m pytest', '-m pytest after cd'],
    ];
    for (const [command, label] of cases) {
      it(`allows: ${label}`, () => {
        expect(verdictOf(command)).toBe('allow');
      });
    }
  });

  it('resolves argv[0] through PATH before classifying', () => {
    const host = makeHost({ resolveExecutable: name => (name === 'py' ? '/usr/bin/python3' : undefined) });
    expect(verdictOf('py -c "x"', host)).toBe('reject');
    expect(verdictOf('py --version', host)).toBe('allow');
  });

  it('checks shebangs of directly-executed scripts', () => {
    const host = makeHost({
      readShebang: path => (path === '/repo/tool.py' ? '#!/usr/bin/env python3 -u' : '#!/bin/bash'),
    });
    expect(verdictOf('/repo/tool.py', host)).toBe('reject');
    expect(verdictOf('/repo/deploy.sh', host)).toBe('allow');
  });

  it('does not reject versioned interpreter names used with flags only', () => {
    expect(verdictOf('python3.13 --version')).toBe('allow');
    expect(verdictOf('python3.13 -c "x"')).toBe('reject');
  });
});

describe("a skill's own scripts run with exec", () => {
  const skills = { skills_dir: '/workspace/.aman/skills', cwd: '/workspace' };
  const verdictWithSkills = (command: string, cwd = skills.cwd, host = makeHost()): 'allow' | 'reject' =>
    classifyExecCommand({ command, host, skills: { ...skills, cwd } }).verdict;

  it.each([
    'python3 /workspace/.aman/skills/ai-news/scripts/fetch.py',
    'python3 /workspace/.aman/skills/ai-news/scripts/fetch.py --limit 10 --hours 24',
    'python3 -u /workspace/.aman/skills/ai-news/scripts/fetch.py',
    'node /workspace/.aman/skills/tool/index.js --help',
    'cd /workspace/.aman/skills/ai-news && python3 scripts/fetch.py',
    'cd .aman/skills/ai-news && python3 scripts/fetch.py | head -50',
    'python3 .aman/skills/ai-news/scripts/fetch.py',
  ])('allows %s', command => {
    expect(verdictWithSkills(command)).toBe('allow');
  });

  it('allows a relative script when the call itself starts in the skill folder', () => {
    expect(verdictWithSkills('python3 scripts/fetch.py', '/workspace/.aman/skills/ai-news')).toBe('allow');
  });

  it('allows a skill script run by its shebang', () => {
    const host = makeHost({ readShebang: () => '/usr/bin/env python3' });
    expect(verdictWithSkills('/workspace/.aman/skills/ai-news/scripts/fetch.py', skills.cwd, host)).toBe('allow');
    expect(verdictWithSkills('/workspace/tool.py', skills.cwd, host)).toBe('reject');
  });

  it.each([
    ['python3 /workspace/analysis.py', 'a script outside the skills folder'],
    ['python3 /workspace/.aman/skills/../analysis.py', 'a path that climbs out of the skills folder'],
    ['python3 /workspace/.aman/skills', 'the skills folder itself'],
    ['python3 /workspace/.aman/skills-evil/x.py', 'a folder that only starts with the same name'],
    ['cd /workspace/.aman/skills/ai-news && cd /tmp && python3 x.py', 'a later cd that leaves the folder'],
    ['python3 -c "print(1)" /workspace/.aman/skills/ai-news/scripts/fetch.py', 'inline code beside a skill script'],
    ["python3 - <<'EOF'\nprint(1)\nEOF", 'heredoc input'],
    ['python3 /workspace/.aman/skills/ai-news/scripts/fetch.py; python3 /workspace/x.py', 'a second script outside'],
  ])('still rejects %s (%s)', command => {
    expect(verdictWithSkills(command)).toBe('reject');
  });

  it('rejects a skill-folder script when no skill is mounted', () => {
    expect(verdictOf('python3 /workspace/.aman/skills/ai-news/scripts/fetch.py')).toBe('reject');
  });
});

describe('interpreterInvocationRefusal', () => {
  it('points at run_code and restates the anti-workaround rule', () => {
    const text = interpreterInvocationRefusal('exec must not run python3 -c/-e code strings');
    expect(text).toContain('run_code');
    expect(text).toContain('Do not work around');
  });
});
