import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SandboxFileNotFoundError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '../../../../src/core/sandbox/SandboxErrors';
import { chatCapacity, SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { makeSilentLogger } from '../../harnessMocks';
import { attestation, bodyOf, errorBody, FakeAgent, type FakeHandler } from './fakeAgent';

function execResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { exit_code: 0, output: 'ok\n', terminated_by: 'completed', internal_error: '', duration_ms: 3, ...overrides };
}

const healthy: FakeHandler = request =>
  request.path === '/v1/health'
    ? { status: 200, body: { busy: false, sessions: 0, attestation: attestation() } }
    : { status: 200, body: execResponse() };

describe('SlotSandboxProvider', () => {
  const agents: FakeAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map(agent => agent.stop()));
  });

  async function providerFor(handlers: FakeHandler[]): Promise<{ provider: SlotSandboxProvider; agents: FakeAgent[] }> {
    const started = handlers.map(handler => new FakeAgent(handler));
    agents.push(...started);
    const socketPaths = await Promise.all(started.map(agent => agent.start()));
    return {
      provider: new SlotSandboxProvider({
        socketPaths,
        defaultExecTimeoutSeconds: 60,
        treeDiskMb: 2048,
        fileMaxBytesForDownload: 1024,
        logger: makeSilentLogger(),
        sleepMs: () => Promise.resolve(),
        gitBridge: undefined,
      }),
      agents: started,
    };
  }

  test('createSandbox places a chat on the slot with the fewest chats, and spreads them', async () => {
    const withSessions =
      (sessions: number): FakeHandler =>
      () => ({
        status: 200,
        body: { busy: false, sessions, attestation: attestation() },
      });
    const { provider } = await providerFor([withSessions(3), withSessions(0), withSessions(5)]);
    expect((await provider.createSandbox()).sandboxId).toMatch(/^s2-/);

    const level = await providerFor([withSessions(1), withSessions(1), withSessions(1), withSessions(1)]);
    const picked = new Set<string>();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      picked.add((await level.provider.createSandbox()).sandboxId.slice(0, 2));
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  test('a slot that is busy with a long command does not stop other slots from taking new chats', async () => {
    const busySlot: FakeHandler = () => ({
      status: 200,
      body: { busy: true, sessions: 0, attestation: attestation() },
    });
    const { provider } = await providerFor([
      busySlot,
      () => ({ status: 200, body: { busy: false, sessions: 4, attestation: attestation() } }),
    ]);
    // Both are placeable: busy is about the current call, load is about chats.
    expect((await provider.createSandbox()).sandboxId).toMatch(/^s1-/);
  });

  test('createSandbox skips a slot that fails its checks', async () => {
    const refusing: FakeHandler = () => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation({ failing: ['seccomp'] }) },
    });
    const { provider } = await providerFor([refusing, healthy]);
    const { sandboxId } = await provider.createSandbox();
    expect(sandboxId).toMatch(/^s2-[0-9a-f]{32}$/);
  });

  test('createSandbox fails with the repair command when no slot attests', async () => {
    const provider = new SlotSandboxProvider({
      socketPaths: [join(tmpdir(), 'no-such', 'agent.sock')],
      defaultExecTimeoutSeconds: 60,
      treeDiskMb: 2048,
      fileMaxBytesForDownload: 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    await expect(provider.createSandbox()).rejects.toThrow('aman doctor sandbox --fix');
    expect((await provider.getImageBuildStatus()).status).toBe('failed');
  });

  test('exec runs a shell command in the pinned slot and returns the merged output', async () => {
    const { provider, agents: started } = await providerFor([healthy, healthy]);
    const sandboxId = `s2-${'d'.repeat(32)}`;
    const result = await provider.exec({
      sandboxId,
      command: 'echo ok',
      cwd: 'sub',
      env: { FOO: 'bar' },
      timeoutSeconds: 10,
    });
    expect(result).toEqual({ success: true, response: { exitCode: 0, result: 'ok\n' } });
    expect(started[0]?.requests).toHaveLength(0);
    expect(started[1]?.requests[0]?.body).toEqual({
      session_id: 'd'.repeat(32),
      argv: ['bash', '-c', 'echo ok'],
      cwd: '/workspace/sub',
      env: { FOO: 'bar' },
      timeout_ms: 9_250,
      disk_mb: 2048,
    });
  });

  test('a non-zero exit is still a successful call', async () => {
    const { provider } = await providerFor([
      () => ({ status: 200, body: execResponse({ exit_code: 3, output: 'bad' }) }),
    ]);
    expect(await provider.exec({ sandboxId: `s1-${'e'.repeat(32)}`, command: 'false' })).toEqual({
      success: true,
      response: { exitCode: 3, result: 'bad' },
    });
  });

  test('timeouts, memory, disk and internal failures are infrastructure errors with a plain message', async () => {
    for (const [terminated, expected] of [
      ['timeout', 'timed out after 5s'],
      ['oom', 'ran out of memory'],
      ['disk_exceeded', 'disk limit'],
      ['internal', 'failed to run the command'],
    ] as const) {
      const { provider } = await providerFor([
        () => ({ status: 200, body: execResponse({ terminated_by: terminated, output: 'partial' }) }),
      ]);
      const result = await provider.exec({ sandboxId: `s1-${'e'.repeat(32)}`, command: 'x', timeoutSeconds: 5 });
      expect(result.success).toBe(false);
      expect(!result.success && result.error).toContain(expected);
    }
  });

  test('a busy slot is retried until it is free', async () => {
    let calls = 0;
    const flaky: FakeHandler = () => {
      calls += 1;
      return calls < 3 ? { status: 429, body: errorBody('busy', 'busy') } : { status: 200, body: execResponse() };
    };
    const { provider } = await providerFor([flaky]);
    const result = await provider.exec({ sandboxId: `s1-${'e'.repeat(32)}`, command: 'x' });
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
  });

  test('an isolation refusal is reported with the repair command and nothing runs', async () => {
    const { provider } = await providerFor([
      () => ({ status: 412, body: errorBody('isolation_refused', 'apparmor: wrong') }),
    ]);
    const result = await provider.exec({ sandboxId: `s1-${'e'.repeat(32)}`, command: 'x' });
    expect(!result.success && result.error).toContain('aman doctor sandbox --fix');
  });

  test('an id that is not a slot sandbox is not available', async () => {
    const { provider } = await providerFor([healthy]);
    await expect(provider.exec({ sandboxId: 'tenant.123', command: 'x' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    await expect(provider.exec({ sandboxId: `s9-${'e'.repeat(32)}`, command: 'x' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
  });

  test('downloadFile maps agent errors onto sandbox errors', async () => {
    const id = `s1-${'f'.repeat(32)}`;
    const missing = await providerFor([() => ({ status: 404, body: errorBody('not_found', 'no such file') })]);
    await expect(missing.provider.downloadFile({ sandboxId: id, path: '/workspace/x' })).rejects.toBeInstanceOf(
      SandboxFileNotFoundError,
    );
    const directory = await providerFor([
      () => ({ status: 400, body: errorBody('invalid_request', 'tree: path is a directory') }),
    ]);
    await expect(directory.provider.downloadFile({ sandboxId: id, path: '/workspace' })).rejects.toBeInstanceOf(
      SandboxPathIsDirectoryError,
    );
    const ok = await providerFor([
      () => ({ status: 200, body: { content_base64: Buffer.from('data').toString('base64'), size_bytes: 4 } }),
    ]);
    expect((await ok.provider.downloadFile({ sandboxId: id, path: '/workspace/x' })).toString()).toBe('data');
  });

  test('uploadFile writes under /workspace', async () => {
    const { provider, agents: started } = await providerFor([() => ({ status: 204, body: undefined })]);
    await provider.uploadFile({
      sandboxId: `s1-${'f'.repeat(32)}`,
      remotePath: '.aman/uploads/a.txt',
      content: Buffer.from('x'),
    });
    expect(bodyOf(started[0]?.requests[0], z.object({ path: z.string() })).path).toBe('/workspace/.aman/uploads/a.txt');
  });

  test('file transfers wait while a command holds the same chat, then go through', async () => {
    let calls = 0;
    const { provider, agents: started } = await providerFor([
      () => {
        calls += 1;
        return calls < 3
          ? { status: 429, body: errorBody('busy', 'this session is in use by another call') }
          : { status: 204, body: undefined };
      },
    ]);
    await provider.uploadFile({ sandboxId: `s1-${'f'.repeat(32)}`, remotePath: 'a.txt', content: Buffer.from('x') });
    expect(started[0]?.requests).toHaveLength(3);
  });

  test('destroySandbox removes the chat workspace on its slot and reports a refusal', async () => {
    const { provider, agents: started } = await providerFor([() => ({ status: 204, body: undefined })]);
    await provider.destroySandbox({ sandboxId: `s1-${'a'.repeat(32)}` });
    expect(started[0]?.requests[0]?.path).toBe('/v1/destroy_session');
    expect(bodyOf(started[0]?.requests[0], z.object({ session_id: z.string() })).session_id).toBe('a'.repeat(32));

    const failing = await providerFor([
      () => ({ status: 500, body: errorBody('internal', 'the session tree could not be removed') }),
    ]);
    await expect(failing.provider.destroySandbox({ sandboxId: `s1-${'a'.repeat(32)}` })).rejects.toThrow(
      'Failed to remove the sandbox workspace',
    );
    await expect(provider.destroySandbox({ sandboxId: 'tenant.1' })).rejects.toBeInstanceOf(SandboxNotAvailableError);
  });

  test('files the slot deleted to stay within the limit are reported in the command output', async () => {
    const { provider } = await providerFor([
      () => ({
        status: 200,
        body: execResponse({
          output: 'built\n',
          notices: ['The workspace went over its 2048 MB limit, so 1 file (3000 MB) were deleted: big.bin.'],
        }),
      }),
    ]);
    const result = await provider.exec({ sandboxId: `s1-${'f'.repeat(32)}`, command: 'make' });
    expect(result).toEqual({
      success: true,
      response: {
        exitCode: 0,
        result:
          'built\n\n[sandbox] The workspace went over its 2048 MB limit, so 1 file (3000 MB) were deleted: big.bin.\n',
      },
    });
  });

  describe('chats per slot with a disk of its own', () => {
    const GIB = 1024 ** 3;
    const hard =
      (sessions: number, gib = 5): FakeHandler =>
      () => ({
        status: 200,
        body: { busy: false, sessions, attestation: attestation({ diskMode: 'hard', workspaceBytes: gib * GIB }) },
      });

    test('a slot stops taking new chats when their quotas would no longer fit its disk', async () => {
      // 5 GiB disk, 1 GiB kept free, 2 GiB per chat: two chats fit.
      const { provider } = await providerFor([hard(2), hard(1)]);
      expect((await provider.createSandbox()).sandboxId).toMatch(/^s2-/);
    });

    test('when every slot is at capacity the answer says to delete chats, not to run the doctor command', async () => {
      const { provider } = await providerFor([hard(2), hard(2)]);
      await expect(provider.createSandbox()).rejects.toThrow(/sandbox is full.*Delete old chats/);
    });

    test('a shared disk (Docker VM or none) is not capped by chats', async () => {
      const shared =
        (diskMode: 'vm' | 'none'): FakeHandler =>
        () => ({
          status: 200,
          body: { busy: false, sessions: 50, attestation: attestation({ diskMode, workspaceBytes: 250 * GIB }) },
        });
      const { provider } = await providerFor([shared('vm'), shared('none')]);
      await expect(provider.createSandbox()).resolves.toMatchObject({ sandboxId: expect.stringMatching(/^s[12]-/) });
    });

    test('capacity keeps 1 GiB free and never drops below one chat', () => {
      expect(chatCapacity({ facts: { disk_mode: 'hard', workspace_bytes: 17 * GIB }, treeDiskMb: 2048 })).toBe(8);
      expect(chatCapacity({ facts: { disk_mode: 'hard', workspace_bytes: 1 * GIB }, treeDiskMb: 2048 })).toBe(1);
      expect(chatCapacity({ facts: { disk_mode: 'vm', workspace_bytes: 17 * GIB }, treeDiskMb: 2048 })).toBeUndefined();
    });
  });

  test('Code Mode is refused', async () => {
    const { provider } = await providerFor([healthy]);
    expect(() => provider.createCodeModeTransport()).toThrow('Code Mode is not available');
  });
});
