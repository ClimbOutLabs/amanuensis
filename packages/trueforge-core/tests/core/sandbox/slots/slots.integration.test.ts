/**
 * Live tests against real slot agents. Set AMAN_SLOTS_TEST_DIR to a directory holding one control
 * directory per slot (`<dir>/1/agent.sock`, ...), for example after `pnpm sandbox:slots`. Without it every
 * test returns early, so the suite stays green on machines without slots.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InternalEnrichedAssistantMessage } from '../../../../src/core/llm/LLMTypes';
import { createToolCallMemoState, executeToolCalls } from '../../../../src/core/mcp/executeToolCalls';
import { RunCodeService } from '../../../../src/core/sandbox/driver/RunCodeService';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, SANDBOX_RUN_CODE_TOOL_NAME } from '../../../../src/core/sandbox/Sandbox';
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
});
