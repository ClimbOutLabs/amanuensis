import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCallToolResponseResult } from '../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import type { ExecResult, SandboxExecParams, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { SANDBOX_EXEC_TOOL_NAME, Sandbox } from '../../../src/core/sandbox/Sandbox';
import { SandboxNotAvailableError } from '../../../src/core/sandbox/SandboxErrors';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

const GIT_IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    ...(input === undefined ? {} : { input }),
  });
}

interface Fixture {
  root: string;
  repo: string;
  marker: string;
  script: string;
  pinnedDir: string;
  cleanup: () => void;
}

/** A clean repo with one commit and an uncommitted same-size edit, so status must hash the file. */
function repoFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-git-'));
  const repo = join(root, 'repo');
  const marker = join(root, 'marker');
  const script = join(root, 'payload.sh');
  mkdirSync(repo);
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> '${marker}'\ncat\n`);
  chmodSync(script, 0o755);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  git(repo, ['add', 'f.txt']);
  git(repo, ['commit', '-q', '-m', 'one']);
  writeFileSync(join(repo, 'f.txt'), 'two\n');
  const pinnedDir = join(root, 'bin');
  mkdirSync(pinnedDir);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  symlinkSync(realGit, join(pinnedDir, 'git'));
  return { root, repo, marker, script, pinnedDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Rewrites HEAD as a commit carrying a (fake) gpgsig header so `log --show-signature` calls gpg.program. */
function addSignedCommit(repo: string): void {
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
  const parent = git(repo, ['rev-parse', 'HEAD']).trim();
  const body = [
    `tree ${tree}`,
    `parent ${parent}`,
    'author t <t@example.com> 1700000000 +0000',
    'committer t <t@example.com> 1700000000 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' AAAA',
    ' -----END PGP SIGNATURE-----',
    '',
    'signed',
    '',
  ].join('\n');
  const sha = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], body).trim();
  git(repo, ['update-ref', 'HEAD', sha]);
}

interface Variant {
  name: string;
  setup: (fixture: Fixture) => void;
  /** Commands that run the payload when git is invoked without hardening. */
  commands: string[];
  /** True when the plain-git control must create the marker (some keys only fire in specific flows). */
  controlFires: boolean;
}

const VARIANTS: Variant[] = [
  {
    name: 'core.fsmonitor',
    setup: f => git(f.repo, ['config', 'core.fsmonitor', f.script]),
    commands: ['git status'],
    controlFires: true,
  },
  {
    name: 'filter clean',
    setup: f => {
      writeFileSync(join(f.repo, '.gitattributes'), '*.txt filter=x\n');
      git(f.repo, ['config', 'filter.x.clean', f.script]);
    },
    commands: ['git status', 'git diff', 'git ls-files --modified'],
    controlFires: true,
  },
  {
    name: 'filter smudge',
    setup: f => {
      writeFileSync(join(f.repo, '.gitattributes'), '*.txt filter=x\n');
      git(f.repo, ['config', 'filter.x.smudge', f.script]);
    },
    commands: ['git status', 'git diff', 'git blame f.txt'],
    controlFires: false,
  },
  {
    name: 'filter process',
    setup: f => {
      writeFileSync(join(f.repo, '.gitattributes'), '*.txt filter=x\n');
      git(f.repo, ['config', 'filter.x.process', f.script]);
    },
    commands: ['git status', 'git diff'],
    controlFires: true,
  },
  {
    name: 'diff.external',
    setup: f => git(f.repo, ['config', 'diff.external', f.script]),
    commands: ['git diff'],
    controlFires: true,
  },
  {
    name: 'diff textconv',
    setup: f => {
      writeFileSync(join(f.repo, '.gitattributes'), '*.txt diff=evil\n');
      git(f.repo, ['config', 'diff.evil.textconv', f.script]);
    },
    commands: ['git diff', 'git show HEAD'],
    controlFires: true,
  },
  {
    name: 'gpg.program with log.showSignature',
    setup: f => {
      addSignedCommit(f.repo);
      git(f.repo, ['config', 'gpg.program', f.script]);
      git(f.repo, ['config', 'log.showSignature', 'true']);
    },
    commands: ['git log -n 1'],
    controlFires: true,
  },
  {
    name: 'core.alternateRefsCommand',
    setup: f => git(f.repo, ['config', 'core.alternateRefsCommand', f.script]),
    commands: ['git log -n 1', 'git status'],
    controlFires: false,
  },
  {
    name: 'include.path to a file holding fsmonitor',
    setup: f => {
      writeFileSync(join(f.root, 'extra.cfg'), `[core]\n\tfsmonitor = ${f.script}\n`);
      git(f.repo, ['config', 'include.path', join(f.root, 'extra.cfg')]);
    },
    commands: ['git status'],
    controlFires: true,
  },
  {
    name: 'core.pager and hooksPath',
    setup: f => {
      git(f.repo, ['config', 'core.pager', f.script]);
      git(f.repo, ['config', 'core.hooksPath', f.root]);
    },
    commands: ['git status'],
    controlFires: false,
  },
];

const ACTUAL_GIT_COMMAND = /'?git'? .* '?(status|log|diff|show|blame|ls-files|config)'?( |$)/u;

/** Runs the model-facing git command and the config probe for real; Sandbox bookkeeping calls are stubbed. */
function runForReal(params: SandboxExecParams, cwd: string | undefined): ExecResult {
  if (!ACTUAL_GIT_COMMAND.test(params.command)) {
    return { success: true, response: { exitCode: 0, result: '' } };
  }
  try {
    const out = execFileSync('sh', ['-c', params.command], {
      cwd,
      env: { ...process.env, ...params.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { success: true, response: { exitCode: 0, result: out } };
  } catch (error) {
    return { success: true, response: { exitCode: 1, result: String(error) } };
  }
}

function makeProvider(exec: (params: SandboxExecParams) => Promise<ExecResult>): SandboxProvider {
  return {
    type: 'local',
    createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-hardened-git' }),
    exec,
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/git_downloader.py`,
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(input: { provider: SandboxProvider; fixture: Fixture; existingSandboxId?: string }): Sandbox {
  return new Sandbox({
    provider: input.provider,
    existingSandboxId: input.existingSandboxId,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    sentinel: createSentinelHostContext({
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      workspace_cwd: input.fixture.repo,
      services: defaultSentinelServices({ pinned_path: input.fixture.pinnedDir }),
    }),
  });
}

async function runExec(input: { sandbox: Sandbox; fixture: Fixture; command: string; cwd?: string }): Promise<{
  isError: boolean;
  text: string;
}> {
  const result = await input.sandbox.callTool({
    name: SANDBOX_EXEC_TOOL_NAME,
    arguments: {
      intent: 'inspect',
      purpose: 'inspect',
      command: input.command,
      cwd: input.cwd ?? input.fixture.repo,
    },
  });
  if (!isCallToolResponseResult(result)) {
    throw new Error('expected a tool result, not an approval request');
  }
  const content = result.result.content[0];
  return { isError: result.result.isError === true, text: content?.type === 'text' ? content.text : '' };
}

function realShellSandbox(fixture: Fixture): Sandbox {
  return makeSandbox({
    fixture,
    provider: makeProvider(params => Promise.resolve(runForReal(params, params.cwd))),
  });
}

describe('allowlisted git execution under repository config', () => {
  test.each(VARIANTS.filter(variant => variant.controlFires))(
    'control: plain git runs the payload for $name',
    ({ setup, commands }) => {
      const fixture = repoFixture();
      try {
        setup(fixture);
        for (const command of commands) {
          execFileSync('sh', ['-c', command], { cwd: fixture.repo, stdio: 'ignore', env: { ...process.env } });
        }
        expect(existsSync(fixture.marker)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    },
  );

  test.each(
    VARIANTS.flatMap(variant =>
      variant.commands.map(command => ({ name: variant.name, setup: variant.setup, command })),
    ),
  )('refuses `$command` and never runs the payload for $name', async ({ setup, command }) => {
    const fixture = repoFixture();
    try {
      setup(fixture);
      const result = await runExec({ sandbox: realShellSandbox(fixture), fixture, command });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('needs your approval');
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test.each(['git status', 'git log --oneline', 'git diff', 'git show HEAD', 'git ls-files', 'git blame f.txt'])(
    'runs `%s` in a repo with only safe config keys',
    async command => {
      const fixture = repoFixture();
      try {
        git(fixture.repo, ['config', 'remote.origin.url', 'https://example.com/r.git']);
        git(fixture.repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        git(fixture.repo, ['config', 'branch.main.remote', 'origin']);
        const result = await runExec({ sandbox: realShellSandbox(fixture), fixture, command });
        expect(result.isError).toBe(false);
        expect(result.text).toContain('exit_code');
        expect(existsSync(fixture.marker)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
  );

  test('runs the command with system and global git config isolated', async () => {
    const fixture = repoFixture();
    try {
      const seen: SandboxExecParams[] = [];
      const provider = makeProvider(params => {
        seen.push(params);
        return Promise.resolve(runForReal(params, params.cwd));
      });
      const result = await runExec({ sandbox: makeSandbox({ provider, fixture }), fixture, command: 'git status' });
      expect(result.isError).toBe(false);
      const ran = seen.filter(params => ACTUAL_GIT_COMMAND.test(params.command));
      expect(ran).toHaveLength(2);
      for (const params of ran) {
        expect(params.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
        expect(params.command).toContain(`safe.directory=${fixture.repo}`);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

/** An outer repo whose gitlink points at a nested repo with a filter payload and an uncommitted edit. */
function nestedRepoFixture(): Fixture {
  const fixture = repoFixture();
  git(fixture.repo, ['checkout', '-q', '--', 'f.txt']);
  const sub = join(fixture.repo, 'sub');
  mkdirSync(sub);
  git(sub, ['init', '-q']);
  writeFileSync(join(sub, '.gitattributes'), '* filter=x\n');
  writeFileSync(join(sub, 'f'), 'one\n');
  git(sub, ['add', '-A']);
  git(sub, ['commit', '-q', '-m', 'sub']);
  git(sub, ['config', 'filter.x.clean', fixture.script]);
  writeFileSync(join(sub, 'f'), 'two\n');
  git(fixture.repo, ['add', 'sub']);
  git(fixture.repo, ['commit', '-q', '-m', 'top']);
  writeFileSync(join(sub, 'f'), 'tri\n');
  rmSync(fixture.marker, { force: true });
  return fixture;
}

describe('allowlisted git execution with a nested repository', () => {
  test.each(['git status --short', 'git diff --stat'])('control: plain `%s` runs the nested payload', command => {
    const fixture = nestedRepoFixture();
    try {
      execFileSync('sh', ['-c', command], { cwd: fixture.repo, stdio: 'ignore' });
      expect(existsSync(fixture.marker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test.each([
    'git status',
    'git status --short',
    'git diff --stat',
    'git diff --name-only',
    'git diff --cached',
    'git log --stat',
    'git show HEAD',
    'git ls-files --modified',
    'git ls-files --stage',
    'git blame f.txt',
  ])('`%s` never runs the nested repository payload', async command => {
    const fixture = nestedRepoFixture();
    try {
      const result = await runExec({ sandbox: realShellSandbox(fixture), fixture, command });
      expect(result.isError).toBe(false);
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

/** The workspace repo with a nested repo whose own config names a program for core.fsmonitor. */
function nestedFsmonitorFixture(): Fixture & { nested: string } {
  const fixture = repoFixture();
  const nested = join(fixture.repo, 'nested');
  mkdirSync(nested);
  git(nested, ['init', '-q']);
  writeFileSync(join(nested, 'f.txt'), 'one\n');
  git(nested, ['add', 'f.txt']);
  git(nested, ['commit', '-q', '-m', 'nested']);
  writeFileSync(join(nested, 'f.txt'), 'two\n');
  git(nested, ['config', 'core.fsmonitor', fixture.script]);
  rmSync(fixture.marker, { force: true });
  return { ...fixture, nested };
}

describe('silent (Tier 1) git in a nested repository whose config names a program', () => {
  test('control: plain git status in the nested repository runs the fsmonitor program', () => {
    const fixture = nestedFsmonitorFixture();
    try {
      execFileSync('sh', ['-c', 'git status'], { cwd: fixture.nested, stdio: 'ignore' });
      expect(existsSync(fixture.marker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('git status is classified Tier 1 but still refuses and never runs the program', async () => {
    const fixture = nestedFsmonitorFixture();
    try {
      const sandbox = realShellSandbox(fixture);
      const info = await sandbox.toolCallInfo({
        name: SANDBOX_EXEC_TOOL_NAME,
        arguments: { intent: 'inspect', purpose: 'inspect', command: 'git status', cwd: fixture.nested },
      });
      expect(info.tier).toBe(1);
      expect(info.is_approval_required).toBe(false);

      const result = await runExec({ sandbox, fixture, command: 'git status', cwd: fixture.nested });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('needs your approval');
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('allowlisted git execution with inherited git env config', () => {
  const INHERITED = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'filter.x.clean',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_PARAMETERS: '',
  };

  test('ignores GIT_CONFIG_COUNT pairs and GIT_CONFIG_PARAMETERS from the environment', async () => {
    const fixture = repoFixture();
    const saved = Object.fromEntries(
      [...Object.keys(INHERITED), 'GIT_CONFIG_VALUE_0'].map(key => [key, process.env[key]]),
    );
    try {
      writeFileSync(join(fixture.repo, '.gitattributes'), '*.txt filter=x\n');
      Object.assign(process.env, {
        ...INHERITED,
        GIT_CONFIG_VALUE_0: fixture.script,
        GIT_CONFIG_PARAMETERS: `'filter.x.smudge=${fixture.script}'`,
      });
      execFileSync('git', ['status'], { cwd: fixture.repo, stdio: 'ignore', env: { ...process.env } });
      expect(existsSync(fixture.marker)).toBe(true);
      rmSync(fixture.marker);
      const result = await runExec({ sandbox: realShellSandbox(fixture), fixture, command: 'git status' });
      expect(result.isError).toBe(false);
      expect(result.text).toContain('exit_code');
      expect(existsSync(fixture.marker)).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fixture.cleanup();
    }
  });
});

describe('allowlisted git refusal messages', () => {
  test('an unsafe repository config asks for approval', async () => {
    const fixture = repoFixture();
    try {
      git(fixture.repo, ['config', 'filter.x.clean', fixture.script]);
      const result = await runExec({ sandbox: realShellSandbox(fixture), fixture, command: 'git status' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(
        "This repository's git settings could run programs, so this command needs your approval.",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('a directory that is not a git repository says so', async () => {
    const fixture = repoFixture();
    try {
      const plain = join(fixture.root, 'plain');
      mkdirSync(plain);
      const result = await runExec({
        sandbox: realShellSandbox({ ...fixture, repo: plain }),
        fixture: { ...fixture, repo: plain },
        command: 'git status',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not a git repository');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('allowlisted git execution after the sandbox is recreated', () => {
  /** The first sandbox is lost on dispatch; the recreated one serves `retryRepo`. */
  async function runWithRecreate(input: { first: Fixture; retry: Fixture }): Promise<{
    result: { isError: boolean; text: string };
    retryCommands: string[];
  }> {
    const retryCommands: string[] = [];
    let lost = false;
    const provider = makeProvider(params => {
      const onRetrySandbox = params.sandboxId === '/tmp/raw-hardened-git';
      if (!onRetrySandbox && ACTUAL_GIT_COMMAND.test(params.command) && !params.command.includes("'config'")) {
        lost = true;
        throw new SandboxNotAvailableError(params.sandboxId);
      }
      if (onRetrySandbox && ACTUAL_GIT_COMMAND.test(params.command)) {
        retryCommands.push(params.command);
      }
      return Promise.resolve(runForReal(params, onRetrySandbox ? input.retry.repo : input.first.repo));
    });
    const sandbox = makeSandbox({ provider, fixture: input.first, existingSandboxId: '/tmp/raw-existing' });
    const result = await runExec({ sandbox, fixture: input.first, command: 'git status' });
    expect(lost).toBe(true);
    return { result, retryCommands };
  }

  test('applies the hardened argv and isolation env in the recreated sandbox', async () => {
    const first = repoFixture();
    const retry = repoFixture();
    try {
      const { result, retryCommands } = await runWithRecreate({ first, retry });
      expect(result.isError).toBe(false);
      expect(retryCommands).toHaveLength(2);
      expect(retryCommands.at(-1)).toContain('core.fsmonitor=false');
    } finally {
      first.cleanup();
      retry.cleanup();
    }
  });

  test('re-checks the repository config in the recreated sandbox', async () => {
    const first = repoFixture();
    const retry = repoFixture();
    try {
      git(retry.repo, ['config', 'core.fsmonitor', retry.script]);
      const { result, retryCommands } = await runWithRecreate({ first, retry });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('needs your approval');
      expect(retryCommands).toHaveLength(1);
      expect(existsSync(retry.marker)).toBe(false);
    } finally {
      first.cleanup();
      retry.cleanup();
    }
  });
});
