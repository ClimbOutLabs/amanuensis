import winston from 'winston';
import { HindsightClient, type RetainOutcome } from '../../../../src/runtime/memory/hindsightClient';
import { buildRetainItem, retainOperationId, submitRetain } from '../../../../src/runtime/memory/memoryRetain';

describe('buildRetainItem', () => {
  it('builds the expected item shape', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'What is my wife’s name?',
      assistantText: 'Your wife’s name is Robin.',
      completedAt: '2026-08-30T12:00:00.000Z',
      sessionTitle: 'Family chat',
    });

    expect(item).toEqual({
      content: 'User: What is my wife’s name?\n\nAssistant: Your wife’s name is Robin.',
      timestamp: '2026-08-30T12:00:00.000Z',
      context: 'Family chat',
      document_id: 'aman-s1-t1',
      // Default provenance for a turn with no untrusted tool output: the user's own voice.
      metadata: { session_id: 's1', turn_id: 't1', source: 'aman-chat', origin: 'user_stated' },
    });
  });

  it('defaults origin to user_stated and stamps tool_ingested when told the turn ingested tool output', () => {
    const clean = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(clean?.metadata?.['origin']).toBe('user_stated');

    const tainted = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'summarize this email',
      assistantText: 'here is the summary',
      completedAt: '2026-08-30T12:00:00.000Z',
      origin: 'tool_ingested',
    });
    expect(tainted?.metadata?.['origin']).toBe('tool_ingested');
  });

  it('omits context when no session title is given', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(item?.context).toBeUndefined();
  });

  it('skips (returns undefined) when both sides are empty', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: '   ',
      assistantText: '',
      completedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(item).toBeUndefined();
  });

  it('keeps an item when only one side has text', () => {
    expect(
      buildRetainItem({
        sessionId: 's1',
        turnId: 't1',
        userText: 'hi',
        assistantText: '',
        completedAt: '2026-08-30T12:00:00.000Z',
      }),
    ).toBeDefined();
  });
});

describe('retainOperationId', () => {
  // Verified against Python's stdlib uuid.uuid5 with namespace
  // b6d6d9ad-6f92-5a2c-9d61-1c8e254f0d6b (an independent RFC 4122 implementation).
  it('matches known vectors for the fixed namespace', () => {
    expect(retainOperationId({ sessionId: 's1', turnId: 't1' })).toBe('c56e103c-ab28-5dde-ab26-a30d66375f88');
    expect(retainOperationId({ sessionId: 's1', turnId: 't2' })).toBe('c6b190ef-b03f-51cc-8515-37523b3439a4');
    expect(retainOperationId({ sessionId: 's2', turnId: 't1' })).toBe('92e443bc-f188-5563-87f1-6a8501276393');
  });

  it('is deterministic: same session/turn always yields the same id', () => {
    expect(retainOperationId({ sessionId: 'session-x', turnId: 'turn-y' })).toBe(
      retainOperationId({ sessionId: 'session-x', turnId: 'turn-y' }),
    );
  });

  it('differs for different turns in the same session', () => {
    expect(retainOperationId({ sessionId: 'session-x', turnId: 'turn-1' })).not.toBe(
      retainOperationId({ sessionId: 'session-x', turnId: 'turn-2' }),
    );
  });
});

describe('submitRetain', () => {
  function makeLogger() {
    return winston.createLogger({ silent: true });
  }

  type RetainSpy = jest.SpyInstance<Promise<RetainOutcome>, Parameters<HindsightClient['retain']>>;

  /**
   * A real client with `retain` scripted on the instance, mirroring profileLearning.test.ts: the
   * constructor and method signature are the client's own, so a change to either fails these tests
   * at compile time. Its fetch rejects so an unscripted call can never reach the network.
   */
  function retainingClient(): { client: HindsightClient; retain: RetainSpy } {
    const client = new HindsightClient({
      apiBase: 'https://hindsight.test.example',
      bank: 'aman',
      headers: {},
      fetchImpl: () => Promise.reject(new Error('retain tests must not reach the network')),
    });
    const retain = jest.spyOn(client, 'retain');
    return { client, retain };
  }

  it('calls client.retain with the deterministic operation id and built item', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
      sessionTitle: undefined,
      logger: makeLogger(),
    });

    expect(retain).toHaveBeenCalledTimes(1);
    const call = retain.mock.calls[0]?.[0];
    expect(call?.operationId).toBe(retainOperationId({ sessionId: 's1', turnId: 't1' }));
    expect(call?.items).toEqual([
      {
        content: 'User: hi\n\nAssistant: hello',
        timestamp: '2026-08-30T12:00:00.000Z',
        document_id: 'aman-s1-t1',
        metadata: { session_id: 's1', turn_id: 't1', source: 'aman-chat', origin: 'user_stated' },
      },
    ]);
  });

  it('threads a tool_ingested origin through to the retained metadata', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'summarize this email',
      assistantText: 'summary',
      completedAt: '2026-08-30T12:00:00.000Z',
      sessionTitle: undefined,
      origin: 'tool_ingested',
      logger: makeLogger(),
    });

    const call = retain.mock.calls[0]?.[0];
    expect(call?.items[0]?.metadata?.['origin']).toBe('tool_ingested');
  });

  it('is a no-op and never throws when both sides are empty', async () => {
    const { client, retain } = retainingClient();

    await expect(
      submitRetain({
        client,
        sessionId: 's1',
        turnId: 't1',
        userText: '',
        assistantText: '',
        completedAt: '2026-08-30T12:00:00.000Z',
        sessionTitle: undefined,
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();
    expect(retain).not.toHaveBeenCalled();
  });

  it('never throws when the client rejects', async () => {
    const { client, retain } = retainingClient();
    retain.mockRejectedValue(new Error('network down'));

    await expect(
      submitRetain({
        client,
        sessionId: 's1',
        turnId: 't1',
        userText: 'hi',
        assistantText: 'hello',
        completedAt: '2026-08-30T12:00:00.000Z',
        sessionTitle: undefined,
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();
  });
});
