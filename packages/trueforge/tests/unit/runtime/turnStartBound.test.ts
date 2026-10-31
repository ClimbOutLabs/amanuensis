import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';
import { raceTurnSetup, TurnStartBound } from '../../../src/runtime/turnStartBound';

const logger = createLogger({ silent: true });

function bound(abortController: AbortController): TurnStartBound {
  return new TurnStartBound({ abortController, timeoutMs: 1_000, logger, sessionId: 'session-1' });
}

describe('TurnStartBound', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts setup when the limit passes before the turn exists, then ends the turn once it does', async () => {
    jest.useFakeTimers();
    const abortController = new AbortController();
    const startBound = bound(abortController);
    startBound.arm();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(abortController.signal.reason).toBe(CancellationReason.ServerExecutionTimeout);

    const end = jest.fn(() => Promise.resolve());
    await startBound.whenExpired(end);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('ends a created turn that shows no work in time, without aborting it first', async () => {
    jest.useFakeTimers();
    const abortController = new AbortController();
    const startBound = bound(abortController);
    startBound.arm();
    const end = jest.fn(() => Promise.resolve());
    await startBound.whenExpired(end);
    expect(end).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(end).toHaveBeenCalledTimes(1);
    // The end step records the error before it aborts, so the bound leaves the signal to it.
    expect(abortController.signal.aborted).toBe(false);
  });

  it('does nothing once the turn has started', async () => {
    jest.useFakeTimers();
    const abortController = new AbortController();
    const startBound = bound(abortController);
    startBound.arm();
    const end = jest.fn(() => Promise.resolve());
    await startBound.whenExpired(end);
    startBound.markStarted();

    await jest.advanceTimersByTimeAsync(5_000);
    expect(end).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
  });
});

describe('raceTurnSetup', () => {
  it('answers could_not_start as soon as the signal fires, and cleans up a setup that finishes later', async () => {
    const abortController = new AbortController();
    const finished = Promise.withResolvers<string>();
    const discarded = Promise.withResolvers<string>();
    const outcome = raceTurnSetup({
      signal: abortController.signal,
      // A setup step that ignores the abort.
      setup: () => finished.promise,
      discard: value => {
        discarded.resolve(value);
        return Promise.resolve();
      },
      logger,
      sessionId: 'session-1',
    });
    abortController.abort(CancellationReason.ServerExecutionTimeout);
    await expect(outcome).resolves.toEqual({ status: 'could_not_start' });

    finished.resolve('created turn');
    await expect(discarded.promise).resolves.toBe('created turn');
  });

  it('hands back the setup when it finishes first, and never discards it', async () => {
    const abortController = new AbortController();
    const discard = jest.fn(() => Promise.resolve());
    await expect(
      raceTurnSetup({
        signal: abortController.signal,
        setup: () => Promise.resolve('created turn'),
        discard,
        logger,
        sessionId: 'session-1',
      }),
    ).resolves.toEqual({ status: 'ready', value: 'created turn' });
    abortController.abort(CancellationReason.ServerExecutionTimeout);
    await Promise.resolve();
    expect(discard).not.toHaveBeenCalled();
  });

  it('passes a setup failure through while time remains', async () => {
    await expect(
      raceTurnSetup({
        signal: new AbortController().signal,
        setup: () => Promise.reject(new Error('Session not found')),
        discard: () => Promise.resolve(),
        logger,
        sessionId: 'session-1',
      }),
    ).rejects.toThrow('Session not found');
  });
});
