import { createLogger } from 'winston';
import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { MemoryProcessor } from '../../../../src/runtime/memory/memoryCapability';
import type { MemoryFailure } from '../../../../src/runtime/memory/memoryClient';
import { QuietMemoryClient } from '../../../fixtures/memory/quietMemoryClient';

const silentLogger = createLogger({ silent: true });

const mockConfig: MemoryConfig = {
  recallMaxTokens: 2000,
  recallTimeoutMs: 5000,
  recallQueryWindow: 10,
  recallMinScore: 0.5,
  recallMaxItems: 20,
  preRecallGateEnabled: false,
  retainTimeoutMs: 5000,
  sweepMaxPerTurn: 10,
  screen: {
    enabled: false,
    url: 'http://localhost:8080',
    authToken: 'test-token',
    threshold: 0.7,
    timeoutMs: 5000,
    maxConcurrency: 5,
  },
  pages: { maxCount: 6, maxTokens: 1500 },
};

describe('Memory sweep retain operations', () => {
  it('records unreachable entries and their failure code', async () => {
    const mockFailure: MemoryFailure = {
      ok: false,
      code: 'request_failed',
      reason: 'Connection timeout',
    };

    const mockClient = new QuietMemoryClient();
    jest.spyOn(mockClient, 'getOperation').mockResolvedValue(mockFailure);

    const processor = new MemoryProcessor({
      client: mockClient,
      config: mockConfig,
      logger: silentLogger,
      sessionId: 'test-session',
      previousTurnId: null,
    });

    const pendingOps = [
      {
        op: 'op-1',
        turn: 'turn-1',
        attempts: 0,
        submitted_at: new Date().toISOString(),
      },
      {
        op: 'op-2',
        turn: 'turn-2',
        attempts: 1,
        submitted_at: new Date().toISOString(),
      },
    ];

    processor['pending'] = pendingOps;
    processor['config'].sweepMaxPerTurn = 2;

    const result = await processor['sweepPending']();

    expect(result.summary.unreachable).toBe(2);
    expect(result.summary.unreachable_code).toBe('request_failed');
    expect(result.nextPending).toHaveLength(2);
    expect(result.nextPending[0]).toEqual(pendingOps[0]);
    expect(result.nextPending[1]).toEqual(pendingOps[1]);
  });

  it('does not record unreachable when all operations succeed', async () => {
    const mockClient = new QuietMemoryClient();
    jest.spyOn(mockClient, 'getOperation').mockResolvedValue({ ok: true, status: 'succeeded' });

    const processor = new MemoryProcessor({
      client: mockClient,
      config: mockConfig,
      logger: silentLogger,
      sessionId: 'test-session',
      previousTurnId: null,
    });

    const pendingOps = [
      {
        op: 'op-1',
        turn: 'turn-1',
        attempts: 0,
        submitted_at: new Date().toISOString(),
      },
    ];

    processor['pending'] = pendingOps;
    processor['config'].sweepMaxPerTurn = 1;

    const result = await processor['sweepPending']();

    expect(result.summary.unreachable).toBe(0);
    expect(result.summary.unreachable_code).toBeUndefined();
    expect(result.summary.verified).toBe(1);
  });
});
