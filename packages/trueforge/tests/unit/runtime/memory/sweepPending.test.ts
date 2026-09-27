import { createLogger } from 'winston';
import type { HindsightClient, MemoryFailure } from '../../../../src/runtime/memory/hindsightClient';
import type { MemoryConfig } from '../../../../src/runtime/memory/memoryCapability';
import { HindsightMemoryProcessor } from '../../../../src/runtime/memory/memoryCapability';

const silentLogger = createLogger({ silent: true });

const mockConfig: MemoryConfig = {
  recallMaxTokens: 2000,
  recallEntityTokens: 500,
  recallTimeoutMs: 5000,
  recallQueryWindow: 10,
  recallMinScore: 0.5,
  recallMaxItems: 20,
  recallMaxEntities: 5,
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
  curated: {
    enabled: false,
    maxModels: 5,
    maxTokens: 500,
  },
  reflect: {
    enabled: false,
    budget: 'low',
    maxTokens: 500,
    timeoutMs: 5000,
  },
};

describe('Memory sweep retain operations', () => {
  it('records unreachable entries and their failure code', async () => {
    const mockFailure: MemoryFailure = {
      ok: false,
      code: 'request_failed',
      reason: 'Connection timeout',
    };

    const mockClient = {
      getOperation: jest.fn().mockResolvedValue(mockFailure),
      retryOperation: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as HindsightClient;

    const processor = new HindsightMemoryProcessor({
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

  it('includes HTTP status in failure code when available', async () => {
    const mockFailure: MemoryFailure = {
      ok: false,
      code: 'http_error',
      reason: 'Service unavailable',
      httpStatus: 503,
    };

    const mockClient = {
      getOperation: jest.fn().mockResolvedValue(mockFailure),
      retryOperation: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as HindsightClient;

    const processor = new HindsightMemoryProcessor({
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

    expect(result.summary.unreachable).toBe(1);
    expect(result.summary.unreachable_code).toBe('http_error_503');
  });

  it('does not record unreachable when all operations succeed', async () => {
    const mockClient = {
      getOperation: jest.fn().mockResolvedValue({ ok: true, status: 'succeeded' }),
      retryOperation: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as HindsightClient;

    const processor = new HindsightMemoryProcessor({
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
