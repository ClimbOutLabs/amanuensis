import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlotClient } from '../../../../src/core/sandbox/slots/SlotClient';
import { attestation, errorBody, FakeAgent } from './fakeAgent';

describe('SlotClient', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function clientFor(handler: ConstructorParameters<typeof FakeAgent>[0]): Promise<SlotClient> {
    agent = new FakeAgent(handler);
    return new SlotClient(await agent.start());
  }

  test('health parses a valid attestation', async () => {
    const client = await clientFor(() => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation() },
    }));
    const result = await client.health({ signal: undefined, timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.attestation.ok).toBe(true);
  });

  test('health carries the store free space fact', async () => {
    const client = await clientFor(() => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation({ storeFreeBytes: 12345 }) },
    }));
    const result = await client.health({ signal: undefined, timeoutMs: 2000 });
    expect(result.ok && result.value.attestation.facts.store_free_bytes).toBe(12345);
  });

  test('sessions parses a valid listing', async () => {
    const client = await clientFor(() => ({
      status: 200,
      body: {
        sessions: [
          { session_id: 'a'.repeat(32), bytes: 4096, entries: 3, last_used: '2026-11-03T12:00:00Z' },
          { session_id: 'b'.repeat(32), bytes: 0, entries: 1, last_used: '2026-10-01T08:30:00Z' },
        ],
      },
    }));
    const result = await client.sessions({ signal: undefined, timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.sessions.map(s => s.session_id)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    expect(agent?.requests.map(r => `${r.method} ${r.path}`)).toEqual(['GET /v1/sessions']);
  });

  test('a sessions reply that does not match the contract is a protocol error', async () => {
    const client = await clientFor(() => ({
      status: 200,
      body: { sessions: [{ session_id: 'not-a-session-id', bytes: 0, entries: 0, last_used: '' }] },
    }));
    const result = await client.sessions({ signal: undefined, timeoutMs: 2000 });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'protocol', message: 'reply does not match the slot contract' },
    });
  });

  test('a reply that does not match the contract is a protocol error', async () => {
    const client = await clientFor(() => ({ status: 200, body: { busy: false } }));
    const result = await client.health({ signal: undefined, timeoutMs: 2000 });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'protocol', message: 'reply does not match the slot contract' },
    });
  });

  test('an agent error body keeps its code and message', async () => {
    const client = await clientFor(() => ({
      status: 429,
      body: errorBody('busy', 'this slot is running another call'),
    }));
    const result = await client.exec({
      request: {
        session_id: 'a'.repeat(32),
        argv: ['true'],
        cwd: '/workspace',
        env: {},
        timeout_ms: 1000,
        disk_mb: 10,
      },
      signal: undefined,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'agent', code: 'busy', message: 'this slot is running another call' },
    });
  });

  test('an unknown error shape becomes a protocol error naming the status', async () => {
    const client = await clientFor(() => ({ status: 502, body: { nope: true } }));
    const result = await client.health({ signal: undefined, timeoutMs: 2000 });
    expect(result).toEqual({ ok: false, error: { kind: 'protocol', message: 'slot answered HTTP 502' } });
  });

  test('a missing socket is unreachable', async () => {
    const client = new SlotClient(join(tmpdir(), 'no-such-slot', 'agent.sock'));
    const result = await client.health({ signal: undefined, timeoutMs: 2000 });
    expect(result.ok === false && result.error.kind).toBe('unreachable');
  });

  test('an aborted call reports aborted', async () => {
    const client = await clientFor(() => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation() },
      delayMs: 2000,
    }));
    const controller = new AbortController();
    const pending = client.health({ signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.ok === false && result.error.kind).toBe('aborted');
  });

  test('a slow agent hits the health timeout', async () => {
    const client = await clientFor(() => ({
      status: 200,
      body: { busy: false, sessions: 0, attestation: attestation() },
      delayMs: 1500,
    }));
    const result = await client.health({ signal: undefined, timeoutMs: 100 });
    expect(result.ok).toBe(false);
  });

  test('a call that outlives its limit plus the grace is treated as lost', async () => {
    const client = await clientFor(() => ({ status: 200, body: {}, delayMs: 3000 }));
    const result = await client.runCode({
      request: { run_id: 'a'.repeat(32), argv: ['x'], files_in: [], timeout_ms: -29_950, disk_mb: 1 },
      signal: undefined,
    });
    expect(result.ok).toBe(false);
  });

  test('fsWrite succeeds on 204 and sends base64 content', async () => {
    const client = await clientFor(() => ({ status: 204, body: undefined }));
    const result = await client.fsWrite({
      sessionId: 'b'.repeat(32),
      path: '/workspace/a.txt',
      content: Buffer.from('hi'),
      mode: 0o644,
      signal: undefined,
    });
    expect(result.ok).toBe(true);
    expect(agent?.requests[0]?.body).toEqual({
      session_id: 'b'.repeat(32),
      path: '/workspace/a.txt',
      content_base64: Buffer.from('hi').toString('base64'),
      mode: 0o644,
    });
  });
});
