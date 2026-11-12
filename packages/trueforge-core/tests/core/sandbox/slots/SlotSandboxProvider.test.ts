import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  SandboxFileNotFoundError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '../../../../src/core/sandbox/SandboxErrors';
import { SLOT_NOT_READY_MESSAGE } from '../../../../src/core/sandbox/slots/SlotDriver';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { makeSilentLogger } from '../../harnessMocks';
import { attestation, bodyOf, errorBody, FakeAgent, type FakeHandler } from './fakeAgent';

function execResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { exit_code: 0, output: 'ok\n', terminated_by: 'completed', internal_error: '', duration_ms: 3, ...overrides };
}

const healthy: FakeHandler = request =>
  request.path === '/v1/health'
    ? { status: 200, body: { busy: false, sessions: 0, attestation: attestation() } }
    : request.path === '/v1/create_session'
      ? { status: 204, body: undefined }
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
      request =>
        request.path === '/v1/create_session'
          ? { status: 204, body: undefined }
          : { status: 200, body: { busy: false, sessions, attestation: attestation() } };
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
    const busySlot: FakeHandler = request =>
      request.path === '/v1/create_session'
        ? { status: 204, body: undefined }
        : { status: 200, body: { busy: true, sessions: 0, attestation: attestation() } };
    const { provider } = await providerFor([
      busySlot,
      request =>
        request.path === '/v1/create_session'
          ? { status: 204, body: undefined }
          : { status: 200, body: { busy: false, sessions: 4, attestation: attestation() } },
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

  test('createSandbox fails with the one plain message when no slot attests', async () => {
    const provider = new SlotSandboxProvider({
      socketPaths: [join(tmpdir(), 'no-such', 'agent.sock')],
      defaultExecTimeoutSeconds: 60,
      treeDiskMb: 2048,
      fileMaxBytesForDownload: 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    });
    await expect(provider.createSandbox()).rejects.toThrow(SLOT_NOT_READY_MESSAGE);
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

  test('exec carries the skill network token to the agent only when one was granted', async () => {
    const { provider, agents: started } = await providerFor([healthy]);
    const sandboxId = `s1-${'d'.repeat(32)}`;
    const token = 'b'.repeat(32);
    await provider.exec({ sandboxId, command: 'curl https://github.com', skillNetworkToken: token });
    await provider.exec({ sandboxId, command: 'ls' });
    const [granted, plain] = started[0]?.requests.map(request => request.body) ?? [];
    expect(granted).toMatchObject({ skill_network_token: token });
    expect(plain).not.toHaveProperty('skill_network_token');
  });

  test('ids of the retired slots 3 and 4 resolve to slots 1 and 2 with the same session', async () => {
    const { provider, agents: started } = await providerFor([healthy, healthy]);
    const fromSlot3 = await provider.exec({ sandboxId: `s3-${'a'.repeat(32)}`, command: 'echo ok' });
    expect(fromSlot3.success).toBe(true);
    expect(started[0]?.requests).toHaveLength(1);
    expect(started[0]?.requests[0]?.body).toMatchObject({ session_id: 'a'.repeat(32) });
    expect(started[1]?.requests).toHaveLength(0);
    const fromSlot4 = await provider.exec({ sandboxId: `s4-${'b'.repeat(32)}`, command: 'echo ok' });
    expect(fromSlot4.success).toBe(true);
    expect(started[1]?.requests).toHaveLength(1);
    expect(started[1]?.requests[0]?.body).toMatchObject({ session_id: 'b'.repeat(32) });
    // Slots past the four an install ever had do not resolve.
    await expect(provider.exec({ sandboxId: `s5-${'c'.repeat(32)}`, command: 'x' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
  });

  test('with one slot in use, only slot 3 ids resolve, to slot 1; slot 2 and slot 4 ids do not', async () => {
    const { provider, agents: started } = await providerFor([healthy]);
    const fromSlot3 = await provider.exec({ sandboxId: `s3-${'a'.repeat(32)}`, command: 'echo ok' });
    expect(fromSlot3.success).toBe(true);
    expect(started[0]?.requests).toHaveLength(1);
    expect(started[0]?.requests[0]?.body).toMatchObject({ session_id: 'a'.repeat(32) });
    // Slot 2 was a working slot, not a retired one, and slot 4's chats were moved to slot 2, which is
    // not in use here: neither id's files are on slot 1, so neither resolves to it.
    await expect(provider.exec({ sandboxId: `s2-${'b'.repeat(32)}`, command: 'x' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    await expect(provider.exec({ sandboxId: `s4-${'c'.repeat(32)}`, command: 'x' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    expect(started[0]?.requests).toHaveLength(1);
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

  describe('creation is answered by the slot agents from real free space', () => {
    const GIB = 1024 ** 3;
    /** A slot reporting the given health, whose agent accepts creation or refuses it as storage full. */
    const slot =
      (input: {
        sessions: number;
        diskMode?: 'hard' | 'vm' | 'none';
        workspaceBytes?: number;
        create?: 'ok' | 'full';
      }): FakeHandler =>
      request => {
        if (request.path === '/v1/create_session') {
          return input.create === 'full'
            ? { status: 507, body: errorBody('storage_full', 'the slot storage is almost full') }
            : { status: 204, body: undefined };
        }
        return {
          status: 200,
          body: {
            busy: false,
            sessions: input.sessions,
            attestation: attestation({ diskMode: input.diskMode ?? 'none', workspaceBytes: input.workspaceBytes ?? 0 }),
          },
        };
      };

    test('slots holding more chats than the old per-disk count still take new chats', async () => {
      // A 16 GiB disk of its own once fit 7 chats of 2 GiB each; both slots already hold more than that.
      const { provider, agents: started } = await providerFor([
        slot({ sessions: 10, diskMode: 'hard', workspaceBytes: 16 * GIB }),
        slot({ sessions: 8, diskMode: 'hard', workspaceBytes: 16 * GIB }),
      ]);
      const { sandboxId } = await provider.createSandbox();
      expect(sandboxId).toMatch(/^s2-[0-9a-f]{32}$/);
      const create = started[1]?.requests.find(request => request.path === '/v1/create_session');
      expect(bodyOf(create, z.object({ session_id: z.string(), disk_mb: z.number() }))).toEqual({
        session_id: sandboxId.slice(3),
        disk_mb: 2048,
      });
      // Chats that already hold a workspace are unaffected: the sandbox still reports ready.
      expect((await provider.getImageBuildStatus()).status).toBe('ready');
    });

    test('a slot whose storage is full does not refuse a chat another slot has room for', async () => {
      const { provider } = await providerFor([slot({ sessions: 0, create: 'full' }), slot({ sessions: 3 })]);
      expect((await provider.createSandbox()).sandboxId).toMatch(/^s2-/);
    });

    test('when every slot answers storage full, creation refuses in plain words and readiness is unchanged', async () => {
      const { provider } = await providerFor([
        slot({ sessions: 0, create: 'full' }),
        slot({ sessions: 1, create: 'full' }),
      ]);
      await expect(provider.createSandbox()).rejects.toThrow(
        'The sandbox storage is almost full, so a new workspace could not be created. Delete old chats you no longer need, or free some disk space on this machine, then try again.',
      );
      expect((await provider.getImageBuildStatus()).status).toBe('ready');
    });

    test('when every slot on its own disk answers storage full, the refusal says only to delete old chats', async () => {
      const { provider } = await providerFor([
        slot({ sessions: 0, diskMode: 'hard', workspaceBytes: 16 * GIB, create: 'full' }),
        slot({ sessions: 1, diskMode: 'hard', workspaceBytes: 16 * GIB, create: 'full' }),
      ]);
      await expect(provider.createSandbox()).rejects.toThrow(
        'The sandbox storage is almost full, so a new workspace could not be created. Delete old chats you no longer need, then try again.',
      );
    });

    test('creation waits while the slot is busy, then goes through', async () => {
      let calls = 0;
      const flaky: FakeHandler = request => {
        if (request.path !== '/v1/create_session') {
          return { status: 200, body: { busy: false, sessions: 0, attestation: attestation() } };
        }
        calls += 1;
        return calls < 3 ? { status: 429, body: errorBody('busy', 'busy') } : { status: 204, body: undefined };
      };
      const { provider } = await providerFor([flaky]);
      await expect(provider.createSandbox()).resolves.toMatchObject({
        sandboxId: expect.stringMatching(/^s1-[0-9a-f]{32}$/),
      });
      expect(calls).toBe(3);
    });

    test('a shared disk (Docker VM or none) takes chats however many it already holds', async () => {
      const { provider } = await providerFor([
        slot({ sessions: 50, diskMode: 'vm', workspaceBytes: 250 * GIB }),
        slot({ sessions: 50, diskMode: 'none', workspaceBytes: 250 * GIB }),
      ]);
      await expect(provider.createSandbox()).resolves.toMatchObject({ sandboxId: expect.stringMatching(/^s[12]-/) });
    });
  });

  test('Code Mode is refused', async () => {
    const { provider } = await providerFor([healthy]);
    expect(() => provider.createCodeModeTransport()).toThrow('Code Mode is not available');
  });
});
