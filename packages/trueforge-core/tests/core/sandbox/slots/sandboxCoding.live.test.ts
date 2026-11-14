/**
 * Live checks that the sandbox can be used for real coding work, against real slot agents and with no
 * model. Set AMAN_SLOTS_TEST_DIR as for the other live slot tests; without it every case returns early.
 * `pnpm test:sandbox-coding-live` runs these against an installed instance's slots, with no setup.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResponse } from '../../../../src/core/mcp/IMCPServer';
import { createSentinelHostContext, defaultSentinelServices } from '../../../../src/core/permissions/context';
import { stageAttachment } from '../../../../src/core/runtime/attachmentStaging';
import { RunCodeService } from '../../../../src/core/sandbox/driver/RunCodeService';
import type { GitCommitIdentity } from '../../../../src/core/sandbox/gitCommitIdentity';
import { gitProbeRunner, observeGitRemotes } from '../../../../src/core/sandbox/gitRemoteObservation';
import { planHostAuthenticatedGit } from '../../../../src/core/sandbox/hostAuthenticatedGit';
import type { ExecResult } from '../../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../../src/core/sandbox/Sandbox';
import { SLOT_AGENT_SOCKET_NAME, SLOT_MIRROR_GUEST_PORT } from '../../../../src/core/sandbox/slots/slotContract';
import { SlotDriver } from '../../../../src/core/sandbox/slots/SlotDriver';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../../harnessMocks';

const SLOTS_DIR = process.env['AMAN_SLOTS_TEST_DIR'];
const WORKSPACE = '/workspace';
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function slotProvider(input: { diskMb: number; defaultTimeoutSeconds: number }): SlotSandboxProvider {
  return new SlotSandboxProvider({
    socketPaths: [join(SLOTS_DIR ?? '', '1', SLOT_AGENT_SOCKET_NAME)],
    defaultExecTimeoutSeconds: input.defaultTimeoutSeconds,
    treeDiskMb: input.diskMb,
    fileMaxBytesForDownload: 1024 * 1024,
    logger: makeSilentLogger(),
    sleepMs: undefined,
    gitBridge: undefined,
  });
}

/** The Sandbox tools on a real slot, as a chat has them. `switchOn` is the owner's Sandbox switch. */
function slotSandbox(input: {
  provider: SlotSandboxProvider;
  switchOn: boolean;
  gitCommitIdentity?: GitCommitIdentity;
  runCodeService?: RunCodeService;
  existingSandboxId?: string | undefined;
}): Sandbox {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.sandboxWithoutAsking = () => Promise.resolve(input.switchOn);
  return new Sandbox({
    provider: input.provider,
    workspaceVerificationCoordinator: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
    gitCommitIdentity: input.gitCommitIdentity,
    runCodeService: input.runCodeService,
    existingSandboxId: input.existingSandboxId,
    sentinel: createSentinelHostContext({
      tenant_id: 'live',
      created_by: 'live',
      conversation_id: 'live',
      workspace_cwd: WORKSPACE,
      services,
    }),
  });
}

/** What a command printed, or the reason it could not finish. */
function textOf(result: ExecResult): string {
  return result.success ? result.response.result : result.error;
}

/** The text of a tool result once the person has allowed the call. */
async function allowed(sandbox: Sandbox, call: { name: string; arguments: Record<string, unknown> }): Promise<string> {
  const response = await sandbox.callTool(call, { status: 'allow' });
  return 'result' in response ? JSON.stringify(response.result.content) : 'the call did not run';
}

function shell(
  command: string,
  extra: Record<string, unknown> = {},
): { name: string; arguments: Record<string, unknown> } {
  return { name: 'exec', arguments: { intent: 'live check', purpose: 'execute', command, ...extra } };
}

/** The approval tier the call was given: 1 runs without a card. */
function tierOf(response: CallToolResponse): number | undefined {
  return 'approvalRequired' in response ? response.approvalRequired.tool_info.tier : undefined;
}

describe('coding in the sandbox (live agents)', () => {
  test('a command that fills the disk loses its own files, not the project history', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 40, defaultTimeoutSeconds: 60 });
    const { sandboxId } = await provider.createSandbox();
    const author = '-c user.name=live -c user.email=live@example.invalid';
    const made = await provider.exec({
      sandboxId,
      command: `git init -q repo && cd repo && head -c 12000000 /dev/urandom > data.bin && git add data.bin && git ${author} commit -q -m first && git gc -q && echo committed`,
    });
    expect(textOf(made)).toContain('committed');
    // Long enough that the history is plainly older than the command that follows.
    await provider.exec({ sandboxId, command: 'sleep 1' });
    const overshoot = await provider.exec({
      sandboxId,
      cwd: 'repo',
      command: 'for n in 1 2 3 4; do head -c 15000000 /dev/urandom > build-$n.o; done; echo wrote',
    });
    expect(textOf(overshoot)).toContain('that this command wrote');
    const after = await provider.exec({
      sandboxId,
      cwd: 'repo',
      command:
        'git fsck --full >/dev/null 2>&1; echo fsck=$?; git log --oneline | wc -l; test -s data.bin && echo data-kept',
    });
    expect(textOf(after)).toContain('fsck=0');
    expect(textOf(after)).toContain('data-kept');
  }, 180_000);

  test('the shell has a home folder it can write to, and npm install works', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 200, defaultTimeoutSeconds: 120 });
    const { sandboxId } = await provider.createSandbox();
    const home = await provider.exec({ sandboxId, command: 'touch "$HOME/probe" && echo home-ok' });
    expect(textOf(home)).toContain('home-ok');
    const npm = await provider.exec({
      sandboxId,
      command: 'mkdir app && cd app && npm init -y >/dev/null && npm install; echo npm=$?',
    });
    expect(textOf(npm)).toContain('npm=0');
    const ignored = await provider.exec({
      sandboxId,
      command: 'cd app && git init -q && git status --porcelain --untracked-files=all | grep -c npm-cache; true',
    });
    expect(textOf(ignored).trim()).toBe('0');
  }, 180_000);

  test('a command can ask for more time than the default', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const sandbox = slotSandbox({ provider: slotProvider({ diskMb: 100, defaultTimeoutSeconds: 3 }), switchOn: false });
    const cutOff = await allowed(sandbox, shell('sleep 6 && echo finished-late'));
    expect(cutOff).toContain('timed out');
    expect(cutOff).toContain('timeout_seconds');
    const givenTime = await allowed(sandbox, shell('sleep 6 && echo finished-in-time', { timeout_seconds: 30 }));
    expect(givenTime).toContain('finished-in-time');
  }, 120_000);

  test('with the Sandbox switch on, a new file needs no card and a file that is already there still asks', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 100, defaultTimeoutSeconds: 30 });
    const sandbox = slotSandbox({ provider, switchOn: true });
    const write = (path: string): { name: string; arguments: Record<string, unknown> } => ({
      name: 'write_file',
      arguments: { intent: 'live check', path, content: 'print(1)\n' },
    });
    const edit = (path: string): { name: string; arguments: Record<string, unknown> } => ({
      name: 'replace_text',
      arguments: { intent: 'live check', cwd: WORKSPACE, path, old_text: 'print(1)', new_text: 'print(2)' },
    });
    expect(tierOf(await sandbox.callTool(write('src/app.py')))).toBe(1);
    expect(await allowed(sandbox, write('src/app.py'))).toContain('src/app.py');
    expect(tierOf(await sandbox.callTool(edit('src/app.py')))).toBe(1);

    expect(await allowed(sandbox, shell('cp src/app.py theirs.py && ln -s theirs.py link.py && echo made'))).toContain(
      'made',
    );
    expect(tierOf(await sandbox.callTool(edit('theirs.py')))).toBe(2);
    expect(tierOf(await sandbox.callTool(write('link.py')))).toBe(2);
  }, 120_000);

  test('a command with a download grant can reach the package mirror, and one without cannot', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 100, defaultTimeoutSeconds: 30 });
    const { sandboxId } = await provider.createSandbox();
    const probe = [
      'import socket',
      'def reach(host, port):',
      '    try:',
      '        socket.create_connection((host, port), timeout=3).close()',
      "        return 'open'",
      '    except OSError as error:',
      "        return 'closed: %s' % error",
      `print('mirror', reach('127.0.0.1', ${String(SLOT_MIRROR_GUEST_PORT)}))`,
      "print('outside', reach('1.1.1.1', 443))",
    ].join('\n');
    await provider.uploadFile({ sandboxId, remotePath: `${WORKSPACE}/probe.py`, content: Buffer.from(probe) });
    const granted = await provider.exec({
      sandboxId,
      command: 'python3 probe.py',
      packageMirrorToken: 'b'.repeat(32),
    });
    expect(textOf(granted)).toContain('mirror open');
    expect(textOf(granted)).toContain('outside closed');
    const plain = await provider.exec({ sandboxId, command: 'python3 probe.py' });
    expect(textOf(plain)).toContain('mirror closed');
    expect(textOf(plain)).toContain('outside closed');
  }, 120_000);

  test('the remote of a Git folder can be read, as fetch and pull need', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 100, defaultTimeoutSeconds: 30 });
    const { sandboxId } = await provider.createSandbox();
    const url = 'https://github.com/octocat/Hello-World.git';
    await provider.exec({ sandboxId, command: `git init -q repo && git -C repo remote add origin ${url}` });
    const plan = planHostAuthenticatedGit({ command: 'git fetch origin' });
    if (plan === undefined) {
      throw new Error('git fetch origin was not recognised as a network git command');
    }
    const seen = await observeGitRemotes({
      plan,
      run: gitProbeRunner(probe =>
        provider.exec({ sandboxId, command: probe.command, cwd: `${WORKSPACE}/repo`, env: probe.env }),
      ),
      workspaceRoot: `${WORKSPACE}/repo`,
    });
    expect(seen?.remotes).toEqual([{ name: 'origin', url }]);
  }, 120_000);

  test('a project of several files runs from the shell, and code that is not a file is still refused', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 100, defaultTimeoutSeconds: 30 });
    const sandbox = slotSandbox({ provider, switchOn: false });
    const file = (path: string, content: string): { name: string; arguments: Record<string, unknown> } => ({
      name: 'write_file',
      arguments: { intent: 'live check', path, content },
    });
    await allowed(sandbox, file('app/helper.py', 'def greet(name):\n    return f"hello {name}"\n'));
    await allowed(sandbox, file('app/main.py', 'import sys\nfrom helper import greet\nprint(greet(sys.argv[1]))\n'));
    await allowed(sandbox, file('app/lib.js', 'module.exports = n => n * 2;\n'));
    await allowed(sandbox, file('app/index.js', 'console.log("double", require("./lib")(21));\n'));
    expect(await allowed(sandbox, shell('python3 main.py world', { cwd: `${WORKSPACE}/app` }))).toContain(
      'hello world',
    );
    expect(await allowed(sandbox, shell('node index.js', { cwd: `${WORKSPACE}/app` }))).toContain('double 42');
    expect(await allowed(sandbox, shell('python3 -c "print(1)"'))).toContain('run_code');
  }, 120_000);

  test('a project environment for Python packages can be made', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = slotProvider({ diskMb: 300, defaultTimeoutSeconds: 120 });
    const { sandboxId } = await provider.createSandbox();
    const made = await provider.exec({
      sandboxId,
      command:
        'python3 -m venv --system-site-packages .venv; echo venv=$?; .venv/bin/python -c "import sys; print(sys.prefix)"',
    });
    expect(textOf(made)).toContain('venv=0');
    expect(textOf(made)).toContain(`${WORKSPACE}/.venv`);
  }, 180_000);

  test('a plain commit works and carries the name the person chose', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const sandbox = slotSandbox({
      provider: slotProvider({ diskMb: 100, defaultTimeoutSeconds: 30 }),
      switchOn: false,
      gitCommitIdentity: { name: 'Sam Rivera', email: 'sam@example.com' },
    });
    await allowed(sandbox, {
      name: 'write_file',
      arguments: { intent: 'live check', path: 'notes/a.txt', content: 'one\n' },
    });
    const committed = await allowed(
      sandbox,
      shell('git init -q . && git add a.txt && git commit -q -m first && git log -1 --format="%an <%ae> / %cn <%ce>"', {
        cwd: `${WORKSPACE}/notes`,
      }),
    );
    expect(committed).toContain('Sam Rivera <sam@example.com> / Sam Rivera <sam@example.com>');
  }, 120_000);

  test('an image attached in an earlier message can still be opened by code run later', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const dataDir = await mkdtemp(join(tmpdir(), 'coding-live-'));
    try {
      const runCodeService = new RunCodeService({
        driver: new SlotDriver({
          socketPaths: [join(SLOTS_DIR, '1', SLOT_AGENT_SOCKET_NAME)],
          logger: makeSilentLogger(),
          now: undefined,
          sleepMs: undefined,
        }),
        dataDir,
        defaultTimeoutSeconds: 30,
        maxTimeoutSeconds: 120,
        memoryMb: 2048,
        diskMb: 200,
        outputCapKb: 256,
        maxConcurrentRuns: 4,
        imagePullTimeoutSeconds: 10,
        harvestGraceMs: 0,
        logger: makeSilentLogger(),
        now: undefined,
        sleepMs: undefined,
      });
      const provider = slotProvider({ diskMb: 100, defaultTimeoutSeconds: 30 });
      const firstMessage = slotSandbox({ provider, switchOn: false, runCodeService });
      const staged = await stageAttachment({
        sandbox: firstMessage,
        filename: 'image.png',
        bytes: Buffer.from(ONE_PIXEL_PNG, 'base64'),
        mime: 'image/png',
        ordinal: 1,
      });
      const laterMessage = slotSandbox({
        provider,
        switchOn: false,
        runCodeService,
        existingSandboxId: staged.sandboxCreated?.sandbox_id,
      });
      const opened = await allowed(laterMessage, {
        name: 'run_code',
        arguments: {
          language: 'python',
          code: `from PIL import Image\nprint('size', Image.open('/ingress/${staged.stagedName}').size)`,
        },
      });
      expect(opened).toContain('size (1, 1)');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
