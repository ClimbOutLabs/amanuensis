import winston from 'winston';
import {
  type GetOperationOutcome,
  type RetainOutcome,
  type RetryOperationOutcome,
} from '../../../../src/runtime/memory/memoryClient';
import {
  buildRetainItem,
  retainOperationId,
  submitRetain,
  submitRetainWithVerification,
  type SubmitRetainParams,
} from '../../../../src/runtime/memory/memoryRetain';
import { QuietMemoryClient } from '../../../fixtures/memory/quietMemoryClient';

describe('buildRetainItem', () => {
  it("builds the item for the person's words alone, never the reply", () => {
    const item = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: 'What is my wife’s name?',
      completedAt: '2026-08-30T12:00:00.000Z',
    });

    expect(item).toEqual({
      content: 'User: What is my wife’s name?',
      timestamp: '2026-08-30T12:00:00.000Z',
      document_id: 'aman-s1-t1',
      // The origin the caller gives is the one stamped.
      metadata: { session_id: 's1', turn_id: 't1', source: 'aman-chat', origin: 'user_stated' },
    });
  });

  it('stamps the origin it is given, whether user_stated or tool_ingested', () => {
    const clean = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      completedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(clean?.metadata?.['origin']).toBe('user_stated');

    const tainted = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'summarize this email',
      completedAt: '2026-08-30T12:00:00.000Z',
      origin: 'tool_ingested',
    });
    expect(tainted?.metadata?.['origin']).toBe('tool_ingested');
  });

  it('skips (returns undefined) when the person wrote nothing', () => {
    const item = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: '   ',
      completedAt: '2026-08-30T12:00:00.000Z',
    });
    expect(item).toBeUndefined();
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

  type RetainSpy = jest.SpyInstance<Promise<RetainOutcome>, Parameters<QuietMemoryClient['retain']>>;

  /**
   * A real client with `retain` scripted on the instance, mirroring profileLearning.test.ts: the
   * constructor and method signature are the client's own, so a change to either fails these tests
   * at compile time. Its fetch rejects so an unscripted call can never reach the network.
   */
  function retainingClient(): { client: QuietMemoryClient; retain: RetainSpy } {
    const client = new QuietMemoryClient();
    const retain = jest.spyOn(client, 'retain');
    return { client, retain };
  }

  it('calls client.retain with the deterministic operation id and built item', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      origin: 'user_stated',
      session: { is_incognito: false },
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
      logger: makeLogger(),
    });

    expect(retain).toHaveBeenCalledTimes(1);
    const call = retain.mock.calls[0]?.[0];
    expect(call?.operationId).toBe(retainOperationId({ sessionId: 's1', turnId: 't1' }));
    expect(call?.items).toEqual([
      {
        content: 'User: hi',
        timestamp: '2026-08-30T12:00:00.000Z',
        document_id: 'aman-s1-t1',
        metadata: { session_id: 's1', turn_id: 't1', source: 'aman-chat', origin: 'user_stated' },
      },
      {
        content: "From the assistant's reply, Aug 30: hello\n\n<!-- note: assistant_response 2026-08-30 -->",
        timestamp: '2026-08-30T12:00:00.000Z',
        document_id: 'aman-s1-t1-note-0',
        metadata: {
          session_id: 's1',
          turn_id: 't1',
          source: 'aman-chat',
          origin: 'tool_ingested',
          note_source: 'assistant_response',
          note_date: '2026-08-30',
        },
      },
    ]);
  });

  it("saves the reply as a note of its own, so an address only the reply named is never the person's", async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      origin: 'user_stated',
      session: { is_incognito: false },
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'who takes print orders',
      assistantText: 'Orders go to bookings@harbour-prints.example.',
      completedAt: '2026-08-30T12:00:00.000Z',
      logger: makeLogger(),
    });

    const items = retain.mock.calls[0]?.[0]?.items ?? [];
    const own = items.filter(item => item.metadata['origin'] === 'user_stated');
    expect(own.map(item => item.content)).toEqual(['User: who takes print orders']);
    const named = items.filter(item => item.content.includes('bookings@harbour-prints.example'));
    expect(named.map(item => item.metadata['origin'])).toEqual(['tool_ingested']);
  });

  it("saves only the person's words when the reply only said what the assistant cannot do", async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      origin: 'user_stated',
      session: { is_incognito: false },
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please read my new email.',
      assistantText: "I can't read email.",
      completedAt: '2026-08-30T12:00:00.000Z',
      logger: makeLogger(),
    });

    expect(retain.mock.calls[0]?.[0]?.items.map(item => item.content)).toEqual(['User: Please read my new email.']);
  });

  it('saves only the reply note when the person wrote nothing', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      origin: 'user_stated',
      session: { is_incognito: false },
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: '',
      assistantText: 'Your dentist appointment is on Friday at 10.',
      completedAt: '2026-08-30T12:00:00.000Z',
      logger: makeLogger(),
    });

    expect(retain.mock.calls[0]?.[0]?.items.map(item => item.metadata['origin'])).toEqual(['tool_ingested']);
  });

  it('threads a tool_ingested origin through to the retained metadata', async () => {
    const { client, retain } = retainingClient();
    retain.mockResolvedValue({ ok: true });

    await submitRetain({
      session: { is_incognito: false },
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'summarize this email',
      assistantText: 'summary',
      completedAt: '2026-08-30T12:00:00.000Z',
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
        origin: 'user_stated',
        session: { is_incognito: false },
        client,
        sessionId: 's1',
        turnId: 't1',
        userText: '',
        assistantText: '',
        completedAt: '2026-08-30T12:00:00.000Z',
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
        origin: 'user_stated',
        session: { is_incognito: false },
        client,
        sessionId: 's1',
        turnId: 't1',
        userText: 'hi',
        assistantText: 'hello',
        completedAt: '2026-08-30T12:00:00.000Z',
        logger: makeLogger(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('submitRetainWithVerification', () => {
  function makeLogger() {
    return winston.createLogger({ silent: true });
  }

  type GetOperationSpy = jest.SpyInstance<Promise<GetOperationOutcome>, Parameters<QuietMemoryClient['getOperation']>>;
  type RetryOperationSpy = jest.SpyInstance<
    Promise<RetryOperationOutcome>,
    Parameters<QuietMemoryClient['retryOperation']>
  >;

  /**
   * A real client with `retain`, `getOperation`, and `retryOperation` scripted on the instance,
   * mirroring the `submitRetain` harness above. Its fetch rejects so an unscripted call can never
   * reach the network.
   */
  function verifyingClient(): {
    client: QuietMemoryClient;
    retain: jest.SpyInstance<Promise<RetainOutcome>, Parameters<QuietMemoryClient['retain']>>;
    getOperation: GetOperationSpy;
    retryOperation: RetryOperationSpy;
  } {
    const client = new QuietMemoryClient();
    return {
      client,
      retain: jest.spyOn(client, 'retain'),
      getOperation: jest.spyOn(client, 'getOperation'),
      retryOperation: jest.spyOn(client, 'retryOperation'),
    };
  }

  function submitParams(client: QuietMemoryClient): SubmitRetainParams {
    return {
      origin: 'user_stated',
      session: { is_incognito: false },
      client,
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      assistantText: 'hello',
      completedAt: '2026-08-30T12:00:00.000Z',
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

describe('buildRetainItem with memoryText', () => {
  it('stores the text as it is, without a prefix and without the transcript', () => {
    const item = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: 'Please remember that my synthetic test robot is named Bleep-Bloop.',
      completedAt: '2026-09-19T12:00:00.000Z',
      memoryText: 'The person has a synthetic test robot named Bleep-Bloop.',
    });

    expect(item?.content).toBe('The person has a synthetic test robot named Bleep-Bloop.');
    expect(item?.content).not.toContain('Turn summary');
    expect(item?.content).not.toContain('Assistant:');
  });

  it('stores nothing when memoryText is blank, never the transcript', () => {
    const item = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      completedAt: '2026-09-19T12:00:00.000Z',
      memoryText: '   ',
    });

    expect(item).toBeUndefined();
  });

  it("uses the person's words when memoryText is absent (summarization off)", () => {
    const item = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: 'hi',
      completedAt: '2026-09-19T12:00:00.000Z',
    });

    expect(item?.content).toBe('User: hi');
  });

  it('keeps a tool_ingested origin (summarization is not a trust upgrade)', () => {
    const item = buildRetainItem({
      sessionId: 's1',
      turnId: 't1',
      userText: 'tool output here',
      completedAt: '2026-09-19T12:00:00.000Z',
      origin: 'tool_ingested',
      memoryText: 'The person received a tool report.',
    });

    expect(item?.content).toBe('The person received a tool report.');
    expect(item?.metadata?.['origin']).toBe('tool_ingested');
  });

  it('names the chat in metadata so recall can tell which chat a fact came from', () => {
    const item = buildRetainItem({
      origin: 'user_stated',
      sessionId: 's1',
      turnId: 't1',
      userText: 'a',
      completedAt: '2026-09-19T12:00:00.000Z',
      memoryText: 'The person has a cat.',
    });

    expect(item?.metadata?.['session_id']).toBe('s1');
  });
});
