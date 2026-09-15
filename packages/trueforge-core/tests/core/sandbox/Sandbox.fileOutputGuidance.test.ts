import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import type { ExecResult, SandboxProvider } from '../../../src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';

function readyExec(): Promise<ExecResult> {
  return Promise.resolve({ success: true, response: { exitCode: 0, result: 'ok' } });
}

function makeProvider(): SandboxProvider {
  return {
    type: 'local',
    buildImage: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    getImageBuildStatus: () => Promise.resolve({ status: 'ready', reason: null, metadata: null }),
    createSandbox: () => Promise.resolve({ sandboxId: '/tmp/raw-1' }),
    exec: readyExec,
    acknowledgeWorkspaceTermination: () => Promise.resolve(),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: sandboxId => `${sandboxId}/tool-results`,
    getGitCredentialsPath: sandboxId => `${sandboxId}/.git-credentials`,
    getFileUploadsDir: sandboxId => `${sandboxId}/uploads`,
    getSkillsDir: sandboxId => `${sandboxId}/skills`,
    getSkillDownloaderPath: sandboxId => `${sandboxId}/skill_downloader.py`,
    downloadFile: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue(undefined),
    createCodeModeTransport: jest.fn(),
  };
}

function makeSandbox(fileDownloadEnabled: boolean): Sandbox {
  return new Sandbox({
    provider: makeProvider(),
    fileDownloadEnabled,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

describe('Sandbox file-output guidance', () => {
  it('states the exact sandbox_artifacts line format with an example, and that it is the only way the user gets a download', () => {
    const sandbox = makeSandbox(true);
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();

    expect(prompt).toContain('[display name](/absolute/path)');
    expect(prompt).toContain('```sandbox_artifacts');
    expect(prompt).toContain('[Lily James tribute video](/opt/tf/workspace/tribute.mp4)');
    expect(prompt).toContain('the only way the user gets a download');
  });

  it('omits the file-output section when file downloads are disabled', () => {
    const sandbox = makeSandbox(false);
    const builder = new InstructionBuilder('root');
    sandbox.buildInstruction(builder);
    const prompt = builder.build();

    expect(prompt).not.toContain('sandbox_artifacts');
  });
});
