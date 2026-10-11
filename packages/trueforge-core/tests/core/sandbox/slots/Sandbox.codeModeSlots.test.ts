import { Sandbox, SANDBOX_EXEC_TOOL_NAME } from '../../../../src/core/sandbox/Sandbox';
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
