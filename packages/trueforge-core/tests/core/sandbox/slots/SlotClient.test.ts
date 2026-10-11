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
    const client = await clientFor(() => ({ status: 200, body: { busy: false, attestation: attestation() } }));
    const result = await client.health({ signal: undefined, timeoutMs: 2000 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.attestation.ok).toBe(true);
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
      body: { busy: false, attestation: attestation() },
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
      body: { busy: false, attestation: attestation() },
      delayMs: 1500,
    }));
    const result = await client.health({ signal: undefined, timeoutMs: 100 });
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
