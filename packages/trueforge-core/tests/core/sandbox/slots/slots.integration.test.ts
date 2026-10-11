/**
 * Live tests against real slot agents. Set AMAN_SLOTS_TEST_DIR to a directory holding one control
 * directory per slot (`<dir>/1/agent.sock`, ...), for example after `pnpm sandbox:slots`. Without it every
 * test returns early, so the suite stays green on machines without slots.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InternalEnrichedAssistantMessage } from '../../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../../src/core/mcp/executeToolCalls';
import { gitLocalImportHardeningConfigEntries } from '../../../../src/core/permissions/gitHardening';
import { RunCodeService } from '../../../../src/core/sandbox/driver/RunCodeService';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, SANDBOX_RUN_CODE_TOOL_NAME } from '../../../../src/core/sandbox/Sandbox';
import { GitBridge } from '../../../../src/core/sandbox/slots/git/gitBridge';
import { execFileRunner } from '../../../../src/core/sandbox/slots/git/hostCommand';
import { SLOT_AGENT_SOCKET_NAME } from '../../../../src/core/sandbox/slots/slotContract';
import { SlotDriver } from '../../../../src/core/sandbox/slots/SlotDriver';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../../harnessMocks';

const SLOTS_DIR = process.env['AMAN_SLOTS_TEST_DIR'];
const SLOT_COUNT = Number.parseInt(process.env['AMAN_SLOTS_TEST_COUNT'] ?? '1', 10);

function socketPaths(): string[] {
  return Array.from({ length: SLOT_COUNT }, (_, index) =>
    join(SLOTS_DIR ?? '', String(index + 1), SLOT_AGENT_SOCKET_NAME),
  );
}

describe('sandbox slots (live agents)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'slots-live-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function service(): RunCodeService {
    return new RunCodeService({
      driver: new SlotDriver({
        socketPaths: socketPaths(),
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
  }

  test('run_code runs Python and Node.js in a guest and returns result files', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const runs = service();
    expect(await runs.ensureReady()).toEqual({ ready: true });

    const python = await runs.runCode(
      {
        language: 'python',
        code: [
          'import sys, socket',
          'from reportlab.pdfgen import canvas',
          "c = canvas.Canvas('/egress/hello.pdf'); c.drawString(72, 720, 'hi'); c.save()",
          "print('py', sys.version_info[0])",
          'try:',
          "    socket.create_connection(('1.1.1.1', 80), timeout=3)",
          "    print('NETWORK OPEN')",
          'except OSError:',
          "    print('no network')",
        ].join('\n'),
      },
      undefined,
    );
    expect(python.status).toBe('ok');
    expect(python.stdout).toContain('py 3');
    expect(python.stdout).toContain('no network');
    expect(python.files_out.map(file => file.name)).toEqual(['hello.pdf']);

    const node = await runs.runCode(
      {
        language: 'node',
        code: "import { writeFileSync } from 'node:fs';\nconsole.log('node', typeof process.version);\nwriteFileSync('/egress/n.txt', 'x');",
      },
      undefined,
    );
    expect(node).toMatchObject({ status: 'ok', exit_code: 0 });
    expect(node.stdout).toContain('node string');
    expect(node.files_out.map(file => file.name)).toEqual(['n.txt']);
  });

  test('run_code reports timeouts and keeps a non-zero exit as the program result', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const runs = service();
    const slow = await runs.runCode(
      { language: 'python', code: 'import time; time.sleep(60)', timeout_seconds: 3 },
      undefined,
    );
    expect(slow.status === 'failed' && slow.error_code).toBe('timeout');
    const failing = await runs.runCode({ language: 'python', code: 'raise SystemExit(7)' }, undefined);
    expect(failing).toMatchObject({ status: 'ok', exit_code: 7 });
  });

  test('a sandbox keeps its files between commands and cannot reach outside its tree', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = new SlotSandboxProvider({
      socketPaths: socketPaths(),
      defaultExecTimeoutSeconds: 30,
      treeDiskMb: 100,
      fileMaxBytesForDownload: 1024 * 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    const { sandboxId } = await provider.createSandbox();
    const written = await provider.exec({ sandboxId, command: 'echo kept > note.txt && pwd' });
    expect(written).toEqual({ success: true, response: { exitCode: 0, result: '/workspace\n' } });
    const read = await provider.exec({ sandboxId, command: 'cat note.txt; id -u; ls /ingress 2>&1 | head -1' });
    expect(read.success && read.response.result.startsWith('kept\n')).toBe(true);

    await provider.uploadFile({ sandboxId, remotePath: '/workspace/up/data.bin', content: Buffer.from('abc') });
    expect((await provider.downloadFile({ sandboxId, path: '/workspace/up/data.bin' })).toString()).toBe('abc');

    await provider.exec({ sandboxId, command: 'ln -s /etc/passwd evil' });
    await expect(provider.downloadFile({ sandboxId, path: '/workspace/evil' })).rejects.toThrow();
    await expect(provider.downloadFile({ sandboxId, path: '/workspace/../etc/passwd' })).rejects.toThrow();

    const tools = await provider.exec({
      sandboxId,
      command: 'git --version && gcc --version | head -1 && node --version && python3 --version',
    });
    expect(tools.success && tools.response.exitCode).toBe(0);
  });

  test('a fork bomb is stopped by the process cap and the slot keeps working', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const runs = service();
    const bomb = await runs.runCode(
      {
        language: 'python',
        code: [
          'import os, time',
          'n = 0',
          'try:',
          '    while n < 5000:',
          '        if os.fork() == 0:',
          '            time.sleep(30); os._exit(0)',
          '        n += 1',
          'except OSError as error:',
          "    print('stopped', type(error).__name__)",
        ].join('\n'),
        timeout_seconds: 30,
      },
      undefined,
    );
    expect(bomb).toMatchObject({ status: 'ok', exit_code: 0 });
    expect(bomb.stdout).toContain('stopped BlockingIOError');
    expect(await runs.runCode({ language: 'python', code: "print('still fine')" }, undefined)).toMatchObject({
      status: 'ok',
      stdout: expect.stringContaining('still fine'),
    });
  });

  test('environment names outside the allowlist are refused, and listed ones reach the command', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = new SlotSandboxProvider({
      socketPaths: socketPaths(),
      defaultExecTimeoutSeconds: 30,
      treeDiskMb: 100,
      fileMaxBytesForDownload: 1024 * 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    const { sandboxId } = await provider.createSandbox();
    const refused = await provider.exec({ sandboxId, command: 'env', env: { LD_PRELOAD: '/x.so' } });
    expect(refused.success).toBe(false);
    expect(!refused.success && refused.error).toContain('env names are not allowed: LD_PRELOAD');
    const allowed = await provider.exec({ sandboxId, command: 'echo $NODE_ENV', env: { NODE_ENV: 'test' } });
    expect(allowed).toEqual({ success: true, response: { exitCode: 0, result: 'test\n' } });
  });

  test('the Sandbox tools run on slots: exec keeps files, run_code returns output, no provider is needed', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = new SlotSandboxProvider({
      socketPaths: socketPaths(),
      defaultExecTimeoutSeconds: 30,
      treeDiskMb: 100,
      fileMaxBytesForDownload: 1024 * 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    const sandbox = new Sandbox({
      provider,
      workspaceVerificationCoordinator: undefined,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
      runCodeService: service(),
    });
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const toolInfo = await sandbox.toolCallInfo({ name, arguments: args });
      const message: InternalEnrichedAssistantMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) }, tool_info: toolInfo },
        ],
      };
      const outcome = await executeToolCalls({
        assistantMessage: message,
        toolMapping: new Map([[name, { toolSet: sandbox, originalToolName: name }]]),
        threadId: 'main',
        approvalDecisions: new Map([['c1', { status: 'allow', scope: 'once' }]]),
        memoState: createToolCallMemoState(),
      });
      return outcome.toolCallResults[0]?.rawContent ?? '';
    };
    expect(
      await call(SANDBOX_EXEC_TOOL_NAME, {
        command: 'mkdir remembered-dir && echo done',
        purpose: 'execute',
        intent: 'write a note',
      }),
    ).toContain('done');
    expect(
      await call(SANDBOX_EXEC_TOOL_NAME, {
        command: 'ls -d remembered-dir',
        purpose: 'inspect',
        intent: 'read the note',
      }),
    ).toContain('remembered-dir');
    expect(await call(SANDBOX_RUN_CODE_TOOL_NAME, { language: 'python', code: 'print(6 * 7)' })).toContain('42');
  });

  test('a guest cannot push the workspace volume past its quota, even through deleted open files', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const provider = new SlotSandboxProvider({
      socketPaths: socketPaths(),
      defaultExecTimeoutSeconds: 60,
      treeDiskMb: 64,
      fileMaxBytesForDownload: 1024 * 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    const { sandboxId } = await provider.createSandbox();
    // Writes to many files that are deleted while still open, so no directory walk can see them.
    const attack = [
      'import os',
      'fds = []',
      'for i in range(200):',
      '    fd = os.open("/workspace/f%d" % i, os.O_CREAT | os.O_WRONLY)',
      '    os.unlink("/workspace/f%d" % i)',
      '    fds.append(fd)',
      '    try:',
      '        for _ in range(60):',
      '            os.write(fd, b"x" * (1 << 20))',
      '    except OSError:',
      '        pass',
      'print("finished")',
    ].join('\n');
    await provider.uploadFile({ sandboxId, remotePath: '/workspace/attack.py', content: Buffer.from(attack) });
    const result = await provider.exec({ sandboxId, command: 'python3 /workspace/attack.py', timeoutSeconds: 60 });
    expect(result.success).toBe(false);
    expect(!result.success && result.error).toContain('disk limit');

    const after = await provider.exec({ sandboxId, command: 'du -sk /workspace | cut -f1' });
    expect(after.success && Number.parseInt(after.response.result, 10)).toBeLessThan(64 * 1024 + 1024);
  });

  test('git through the host: clone, commit, review, push and fetch with a sandbox that has no network', async () => {
    if (SLOTS_DIR === undefined) {
      return;
    }
    const base = await mkdtemp(join(tmpdir(), 'slots-git-'));
    try {
      const remote = join(base, 'remote.git');
      const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
      execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
      const seed = join(base, 'seed');
      execFileSync('git', ['init', '-b', 'main', seed]);
      execFileSync('git', [...identity, '-C', seed, 'commit', '--allow-empty', '-m', 'seed']);
      execFileSync('git', ['-C', seed, 'push', remote, 'main']);

      const provider = new SlotSandboxProvider({
        socketPaths: socketPaths(),
        defaultExecTimeoutSeconds: 60,
        treeDiskMb: 200,
        fileMaxBytesForDownload: 1024 * 1024,
        logger: makeSilentLogger(),
        sleepMs: undefined,
        gitBridge: new GitBridge({
          scratchRoot: join(base, 'scratch'),
          runner: execFileRunner,
          logger: makeSilentLogger(),
          remoteUrl: () => `file://${remote}`,
          networkEntries: gitLocalImportHardeningConfigEntries(),
          now: undefined,
        }),
      });
      provider.hostGit?.setToken('fake-host-token');
      const { sandboxId } = await provider.createSandbox();
      const run = async (command: string, cwd?: string): Promise<string> => {
        const result = await provider.exec({ sandboxId, command, ...(cwd === undefined ? {} : { cwd }) });
        if (!result.success) {
          throw new Error(result.error);
        }
        return result.response.result;
      };

      expect(await run('git clone https://github.com/acme/widgets')).toContain('widgets');
      await run(
        'echo hello > hello.txt && git add hello.txt && git -c user.name=t -c user.email=t@e.x commit -qm "add hello"',
        'widgets',
      );
      const preview = await provider.hostGit?.previewPush({
        sandboxId,
        command: 'git push origin main',
        cwd: 'widgets',
        signal: undefined,
      });
      expect(preview).toMatchObject({ status: 'ok', preview: { commit_count: 1, repository: 'acme/widgets' } });
      expect(await run('git push origin main', 'widgets')).toContain('main -> main');
      expect(execFileSync('git', ['-C', remote, 'log', '--format=%s', '-1', 'main'], { encoding: 'utf8' }).trim()).toBe(
        'add hello',
      );

      const offline = await run('git ls-remote https://example.com/a/b 2>&1 | head -2 || true');
      expect(offline).not.toContain('refs/');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
