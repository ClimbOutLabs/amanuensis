import { TurnExecutionDeadline } from '../../../src/runtime/turnExecutionDeadline';

describe('TurnExecutionDeadline', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('extends a running turn for the full registered-command timeout', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const abortController = new AbortController();
    const deadline = new TurnExecutionDeadline({
      abortController,
      default_timeout_ms: 1_000,
      finalization_buffer_ms: 100,
    });
    deadline.arm();

    jest.advanceTimersByTime(900);
    deadline.extendForRegisteredCommand(2_000);
    jest.advanceTimersByTime(1_200);
    expect(abortController.signal.aborted).toBe(false);

    jest.advanceTimersByTime(901);
    expect(abortController.signal.aborted).toBe(true);
    deadline.dispose();
  });

  it('never shortens the existing turn deadline', () => {
    jest.useFakeTimers();
    const abortController = new AbortController();
    const deadline = new TurnExecutionDeadline({
      abortController,
      default_timeout_ms: 5_000,
      finalization_buffer_ms: 100,
    });
    deadline.arm();
    deadline.extendForRegisteredCommand(100);

    jest.advanceTimersByTime(1_000);
    expect(abortController.signal.aborted).toBe(false);
    deadline.dispose();
  });
});
