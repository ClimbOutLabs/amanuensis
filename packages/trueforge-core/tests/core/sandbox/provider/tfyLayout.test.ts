import { absolutizeRelativeExecEnv } from '../../../../src/core/sandbox/provider/execEnv';
import { withTrustedPath } from '../../../../src/core/sandbox/provider/Provider';
import { TFYSandboxProvider, withMcpClientOnPath } from '../../../../src/core/sandbox/provider/TFYSandboxProvider';
import { makeSilentLogger } from '../../harnessMocks';

describe('TFYSandboxProvider layout', () => {
  it('keeps exec writes cwd-relative (no extra FS jail)', () => {
    const provider = new TFYSandboxProvider({
      serverUrl: 'http://sandbox.example',
      natsBridgeUrl: 'ws://nats.example',
      tenantName: 'acme',
      fileMaxBytesForDownload: 1024,
      logger: makeSilentLogger(),
    });
    const sandboxId = 'acme.00000000-0000-0000-0000-000000000001';
    const layout = [
      provider.getToolResultDumpDir(),
      provider.getGitCredentialsPath(),
      provider.getFileUploadsDir(),
      provider.getSkillsDir(),
      provider.getSkillDownloaderPath(),
    ];
    for (const path of layout) {
      expect(path.startsWith('/')).toBe(false);
    }
    const install = provider.createCodeModeTransport().getClientInstall({ sandboxId });
    expect(install.remotePath.startsWith('/')).toBe(false);
    expect(install.pathBinSymlink).toBeUndefined();
    const instructions = provider.getAdditionalInstructions();
    expect(instructions).toContain(
      "The Agent's first sandbox command should be `pwd` to discover the working directory.",
    );
    expect(instructions).toContain('uploads, skills, and tool-results live in that working directory');
    expect(instructions).not.toContain('/data/sandboxes');
  });

  it('absolutizes PATH and skills paths for git/mcp-client after cd', () => {
    const env = absolutizeRelativeExecEnv({
      root: '/discovered/root',
      env: {
        PATH: 'mcp-client/bin:/usr/bin',
        PYTHONPATH: 'mcp-client',
        TFY_SKILLS_DIR: 'skills',
        TFY_NATS_URL: 'ws://localhost',
      },
    });
    expect(env['PATH']).toBe('/discovered/root/mcp-client/bin:/usr/bin');
    expect(env['PYTHONPATH']).toBe('/discovered/root/mcp-client');
    expect(env['TFY_SKILLS_DIR']).toBe('/discovered/root/skills');
    expect(env['TFY_NATS_URL']).toBe('ws://localhost');
  });

  it('puts mcp-client/bin first on PATH without duplicating it', () => {
    expect(withMcpClientOnPath('')).toBe('mcp-client/bin');
    expect(withMcpClientOnPath('/usr/bin:/bin')).toBe('mcp-client/bin:/usr/bin:/bin');
    expect(withMcpClientOnPath('mcp-client/bin:/usr/bin')).toBe('mcp-client/bin:/usr/bin');
  });

  it('reads and writes files with programs from the trusted PATH', async () => {
    const commands: string[] = [];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const command =
        typeof body === 'object' && body !== null && 'command' in body && typeof body.command === 'string'
          ? body.command
          : '';
      commands.push(command);
      const result = command.startsWith('printf')
        ? '/root\n/usr/bin:/bin\n'
        : command.includes('stat -L')
          ? '{"size":2,"type":"regular file"}'
          : command.includes('base64 -w0')
            ? Buffer.from('hi').toString('base64')
            : '';
      return Promise.resolve(new Response(JSON.stringify({ success: true, response: { exitCode: 0, result } })));
    });
    try {
      const provider = new TFYSandboxProvider({
        serverUrl: 'http://sandbox.example',
        natsBridgeUrl: 'ws://nats.example',
        tenantName: 'acme',
        fileMaxBytesForDownload: 1024,
        logger: makeSilentLogger(),
      });
      const sandboxId = 'acme.00000000-0000-0000-0000-000000000001';
      expect((await provider.downloadFile({ sandboxId, path: 'a.txt' })).toString()).toBe('hi');
      await provider.uploadFile({ sandboxId, remotePath: 'b.txt', content: Buffer.from('x') });
      const fileCommands = commands.filter(command => !command.startsWith('printf'));
      expect(fileCommands).toHaveLength(3);
      for (const command of fileCommands) {
        expect(command.startsWith(withTrustedPath(''))).toBe(true);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns only the status when the sandbox server rejects a command', async () => {
    const planted = 'plantedGitToken0000000000';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const command =
        typeof body === 'object' && body !== null && 'command' in body && typeof body.command === 'string'
          ? body.command
          : '';
      if (command.startsWith('printf')) {
        return Promise.resolve(
          new Response(JSON.stringify({ success: true, response: { exitCode: 0, result: '/root\n/usr/bin\n' } })),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ detail: [{ input: { env: { GIT_TOKEN: planted } } }] }), { status: 422 }),
      );
    });
    try {
      const provider = new TFYSandboxProvider({
        serverUrl: 'http://sandbox.example',
        natsBridgeUrl: 'ws://nats.example',
        tenantName: 'acme',
        fileMaxBytesForDownload: 1024,
        logger: makeSilentLogger(),
      });
      const result = await provider.exec({
        sandboxId: 'acme.00000000-0000-0000-0000-000000000001',
        command: 'git fetch',
        env: { GIT_TOKEN: planted },
        signal: undefined,
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain(planted);
      expect(JSON.stringify(result)).toContain('422');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
