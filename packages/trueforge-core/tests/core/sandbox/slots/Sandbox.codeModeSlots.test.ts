import { createSentinelHostContext, defaultSentinelServices } from '../../../../src/core/permissions';
import { Sandbox, SANDBOX_EXEC_TOOL_NAME, SANDBOX_WRITE_FILE_TOOL_NAME } from '../../../../src/core/sandbox/Sandbox';
import { SlotExecRequestSchema } from '../../../../src/core/sandbox/slots/slotContract';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer, makeSilentLogger } from '../../harnessMocks';
import { attestation, FakeAgent, type FakeHandler } from './fakeAgent';

describe('a session with connectors on the sandbox slots', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
  });

  test('keeps the connectors as ordinary tools and runs commands without a Code Mode bridge', async () => {
    const handler: FakeHandler = request =>
      request.path === '/v1/health'
        ? { status: 200, body: { busy: false, sessions: 0, attestation: attestation() } }
        : {
            status: 200,
            body: { exit_code: 0, output: 'hi\n', terminated_by: 'completed', internal_error: '', duration_ms: 1 },
          };
    agent = new FakeAgent(handler);
    const socketPath = await agent.start();
    const provider = new SlotSandboxProvider({
      socketPaths: [socketPath],
      defaultExecTimeoutSeconds: 30,
      treeDiskMb: 100,
      fileMaxBytesForDownload: 1024,
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
    });

    expect(() => {
      sandbox.configureCodeMode([makeMockIMCPServer({ name: 'github', preload: true })]);
    }).not.toThrow();

    await sandbox.callTool(
      { name: SANDBOX_EXEC_TOOL_NAME, arguments: { intent: 'Say hi', purpose: 'execute', command: 'echo hi' } },
      { status: 'allow', scope: 'once' },
    );
    const execCall = agent.requests.find(request => request.path === '/v1/exec');
    const env = SlotExecRequestSchema.parse(execCall?.body).env;
    expect(Object.keys(env).filter(name => name.startsWith('TFY_'))).toEqual([]);
  });
});

describe('Sentinel on the sandbox slots', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
  });

  async function slotSandbox(): Promise<Sandbox> {
    agent = new FakeAgent(() => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation() },
    }));
    const provider = new SlotSandboxProvider({
      socketPaths: [await agent.start()],
      defaultExecTimeoutSeconds: 30,
      treeDiskMb: 100,
      fileMaxBytesForDownload: 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    return new Sandbox({
      provider,
      workspaceVerificationCoordinator: undefined,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
      sentinel: createSentinelHostContext({
        tenant_id: 't1',
        created_by: 'u1',
        conversation_id: 'conv-1',
        workspace_cwd: null,
        services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      }),
    });
  }

  test('checks workspace containment on the names, so ordinary work in /workspace is not escalated', async () => {
    const sandbox = await slotSandbox();
    const read = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'List files', purpose: 'inspect', command: 'ls -l' },
    });
    expect(read).toMatchObject({ tier: 1, path_resolution: 'remote' });
    const write = await sandbox.toolCallInfo({
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Save notes', path: '/workspace/notes.md', content: 'x' },
    });
    expect(write).toMatchObject({ tier: 2, path_resolution: 'remote' });
  });

  test('still asks about anything that leaves /workspace', async () => {
    const sandbox = await slotSandbox();
    const outside = await sandbox.toolCallInfo({
      name: SANDBOX_WRITE_FILE_TOOL_NAME,
      arguments: { intent: 'Save notes', path: '/workspace/../etc/cron.d/x', content: 'x' },
    });
    expect(outside.tier).toBe(3);
    const cwdOutside = await sandbox.toolCallInfo({
      name: SANDBOX_EXEC_TOOL_NAME,
      arguments: { intent: 'List files', purpose: 'inspect', command: 'ls -l', cwd: '/etc' },
    });
    expect(cwdOutside.tier).toBe(3);
  });
});
