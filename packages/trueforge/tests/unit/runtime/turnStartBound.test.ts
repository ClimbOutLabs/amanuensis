import { CancellationReason } from '@truefoundry/trueforge-core/agent-session';
import { createLogger } from 'winston';
import { TurnStartBound } from '../../../src/runtime/turnStartBound';

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
    expect(startBound.expired).toBe(true);
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
    expect(startBound.expired).toBe(false);
    expect(end).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(false);
  });
});
