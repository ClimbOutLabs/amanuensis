import winston from 'winston';
import {
  HindsightClient,
  type GetOperationOutcome,
  type RetainOutcome,
  type RetryOperationOutcome,
} from '../../../../src/runtime/memory/hindsightClient';
import {
  buildRetainItem,
  retainOperationId,
  submitRetain,
  submitRetainWithVerification,
  type SubmitRetainParams,
} from '../../../../src/runtime/memory/memoryRetain';

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

describe('submitRetainWithVerification', () => {
  function makeLogger() {
    return winston.createLogger({ silent: true });
  }

  type GetOperationSpy = jest.SpyInstance<Promise<GetOperationOutcome>, Parameters<HindsightClient['getOperation']>>;
  type RetryOperationSpy = jest.SpyInstance<
    Promise<RetryOperationOutcome>,
    Parameters<HindsightClient['retryOperation']>
  >;

  /**
   * A real client with `retain`, `getOperation`, and `retryOperation` scripted on the instance,
   * mirroring the `submitRetain` harness above. Its fetch rejects so an unscripted call can never
   * reach the network.
   */
  function verifyingClient(): {
    client: HindsightClient;
    retain: jest.SpyInstance<Promise<RetainOutcome>, Parameters<HindsightClient['retain']>>;
    getOperation: GetOperationSpy;
    retryOperation: RetryOperationSpy;
  } {
    const client = new HindsightClient({
      apiBase: 'https://hindsight.test.example',
      bank: 'aman',
      headers: {},
      fetchImpl: () => Promise.reject(new Error('retain tests must not reach the network')),
    });
    return {
      client,
      retain: jest.spyOn(client, 'retain'),
      getOperation: jest.spyOn(client, 'getOperation'),
      retryOperation: jest.spyOn(client, 'retryOperation'),
    };
  }

  function submitParams(client: HindsightClient): SubmitRetainParams {
    return {
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
      sessionTitle: undefined,
      logger: makeLogger(),
    };
  }

  it('verifies an accepted submission with one status check and does not resubmit', async () => {
    const { client, retain, getOperation, retryOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: true });
    getOperation.mockResolvedValue({ ok: true, status: 'completed' });

    await submitRetainWithVerification(submitParams(client));

    expect(retain).toHaveBeenCalledTimes(1);
    expect(getOperation).toHaveBeenCalledTimes(1);
    expect(getOperation.mock.calls[0]?.[0]).toBe(retainOperationId({ sessionId: 's1', turnId: 't1' }));
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it('retries once via retryOperation when the operation failed', async () => {
    const { client, retain, getOperation, retryOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: true });
    getOperation.mockResolvedValue({ ok: true, status: 'failed' });
    retryOperation.mockResolvedValue({ ok: true });

    await submitRetainWithVerification(submitParams(client));

    expect(retain).toHaveBeenCalledTimes(1);
    expect(retryOperation).toHaveBeenCalledTimes(1);
    expect(retryOperation.mock.calls[0]?.[0]).toBe(retainOperationId({ sessionId: 's1', turnId: 't1' }));
  });

  it('resubmits the exact exchange once when the operation is unknown', async () => {
    const { client, retain, getOperation, retryOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: true });
    getOperation.mockResolvedValue({ ok: true, status: 'unknown' });

    await submitRetainWithVerification(submitParams(client));

    expect(retain).toHaveBeenCalledTimes(2);
    expect(retain.mock.calls[1]?.[0]?.operationId).toBe(retainOperationId({ sessionId: 's1', turnId: 't1' }));
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it('resubmits once when the initial submission failed and the operation is unknown', async () => {
    const { client, retain, getOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: false, reason: 'timeout' });
    getOperation.mockResolvedValue({ ok: true, status: 'unknown' });

    await submitRetainWithVerification(submitParams(client));

    expect(retain).toHaveBeenCalledTimes(2);
  });

  it('does not resubmit when a failed submission actually landed', async () => {
    const { client, retain, getOperation, retryOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: false, reason: 'timeout' });
    getOperation.mockResolvedValue({ ok: true, status: 'completed' });

    await submitRetainWithVerification(submitParams(client));

    expect(retain).toHaveBeenCalledTimes(1);
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it('leaves a still-running operation alone without retrying', async () => {
    const { client, retain, getOperation, retryOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: true });
    getOperation.mockResolvedValue({ ok: true, status: 'running' });

    await submitRetainWithVerification(submitParams(client));

    expect(retain).toHaveBeenCalledTimes(1);
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it('never throws when every step fails', async () => {
    const { client, retain, getOperation, retryOperation } = verifyingClient();
    retain.mockRejectedValue(new Error('network down'));
    getOperation.mockResolvedValue({ ok: false, code: 'timeout', reason: 'timeout' });
    retryOperation.mockRejectedValue(new Error('network down'));

    // Nothing was stored, so the caller must not claim a save.
    await expect(submitRetainWithVerification(submitParams(client))).resolves.toBe(false);
    // Initial submission plus the one deterministic resubmission for an unreadable status.
    expect(retain).toHaveBeenCalledTimes(2);
  });

  it('resolves true once the provider holds the exchange', async () => {
    const { client, retain, getOperation } = verifyingClient();
    retain.mockResolvedValue({ ok: true });
    getOperation.mockResolvedValue({ ok: true, status: 'completed' });

    await expect(submitRetainWithVerification(submitParams(client))).resolves.toBe(true);
  });

  it('is a no-op when there is nothing to retain', async () => {
    const { client, retain, getOperation } = verifyingClient();

    await expect(
      submitRetainWithVerification({ ...submitParams(client), userText: '', assistantText: '' }),
    ).resolves.toBe(false);
    expect(retain).not.toHaveBeenCalled();
    expect(getOperation).not.toHaveBeenCalled();
  });
});

describe('buildRetainItem with summarizedContent', () => {
  it('uses the summary instead of the verbatim transcript when provided', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
      assistantText: 'Got it — Bleep-Bloop is your synthetic test robot.',
      completedAt: '2026-09-19T12:00:00.000Z',
      summarizedContent: '- User has a synthetic test robot named Bleep-Bloop.',
    });

    expect(item?.content).toBe('Turn summary: - User has a synthetic test robot named Bleep-Bloop.');
    // The verbatim transcript is not stored when a summary is present.
    expect(item?.content).not.toContain('User: Please remember');
  });

  it('falls back to verbatim when summarizedContent is blank', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-09-19T12:00:00.000Z',
      summarizedContent: '   ',
    });

    expect(item?.content).toBe('User: hi\n\nAssistant: hello');
  });

  it('uses verbatim when summarizedContent is absent (default behavior)', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-09-19T12:00:00.000Z',
    });

    expect(item?.content).toBe('User: hi\n\nAssistant: hello');
  });

  it('keeps a tool_ingested origin on the summarized path (summarization is not a trust upgrade)', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'tool output here',
      assistantText: 'processed the tool output',
      completedAt: '2026-09-19T12:00:00.000Z',
      origin: 'tool_ingested',
      summarizedContent: '- Processed tool output.',
    });

    expect(item?.content).toBe('Turn summary: - Processed tool output.');
    expect(item?.metadata?.['origin']).toBe('tool_ingested');
  });
});
