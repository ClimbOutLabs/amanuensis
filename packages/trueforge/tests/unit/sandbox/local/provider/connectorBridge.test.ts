import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from 'winston';
import type { SandboxProvider } from '../../../../../../trueforge-core/src/core/sandbox/provider/Provider';
import { Sandbox } from '../../../../../../trueforge-core/src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../../../../../trueforge-core/src/core/tracing/NoopAgentTracing';
import { makeMockIMCPServer } from '../../../../../../trueforge-core/tests/core/harnessMocks';
import { LocalSandboxProvider } from '../../../../../src/sandbox/local/provider/LocalSandboxProvider';

// The provider's socket folder needs POSIX file modes, which Windows does not keep.
const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('the sandbox on a computer without Docker', () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'tfy-local-bridge-'));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function makeProvider(): Promise<LocalSandboxProvider> {
    const codeModeSocketParentPath = join(tmpdir(), 'cm');
    await mkdir(codeModeSocketParentPath, { recursive: true, mode: 0o700 });
    return new LocalSandboxProvider({
      sandboxRootPathParent: parent,
      codeModeSocketParentPath,
      support: { supported: true, platform: 'darwin', shell: '/bin/bash', python: '/usr/bin/python3' },
      logger: createLogger({ silent: true }),
    });
  }

  it('opens no bridge from sandbox code to connector tools', async () => {
    const provider = await makeProvider();
    const bridge = jest.spyOn(provider, 'createCodeModeTransport');
    const sandbox = new Sandbox({
      provider,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: createLogger({ silent: true }),
      tracing: NOOP_AGENT_TRACING,
    });

    sandbox.configureCodeMode([makeMockIMCPServer({ name: 'github', preload: true })]);

    expect(provider.supportsCodeMode).toBe(false);
    expect(bridge).not.toHaveBeenCalled();
  });

  it('does not say it is cut off from the network, so code there asks before each run', async () => {
    const provider: SandboxProvider = await makeProvider();
    expect(provider.network).toBeUndefined();
  });

  it('refuses to build a bridge when asked for one directly', async () => {
    const provider = await makeProvider();
    expect(() => provider.createCodeModeTransport()).toThrow('Code Mode is not available');
  });
});
