import {
  addAgentThreadMetrics,
  addReasoningEffortStep,
  createEmptyAgentThreadMetrics,
} from '../../../src/core/runtime/metrics';

describe('reasoning effort step counts', () => {
  it('counts requests per effort and leaves earlier snapshots unchanged', () => {
    const metrics = createEmptyAgentThreadMetrics();
    addReasoningEffortStep(metrics, 'high');
    const snapshot = { ...metrics };
    addReasoningEffortStep(metrics, 'high');
    addReasoningEffortStep(metrics, 'low');

    expect(metrics.step_reasoning_efforts).toEqual({ high: 2, low: 1 });
    expect(snapshot.step_reasoning_efforts).toEqual({ high: 1 });
  });

  it('merges sub-agent counts into the parent', () => {
    const parent = createEmptyAgentThreadMetrics();
    addReasoningEffortStep(parent, 'high');
    const child = createEmptyAgentThreadMetrics();
    addReasoningEffortStep(child, 'low');
    addReasoningEffortStep(child, 'low');

    addAgentThreadMetrics(parent, child);
    expect(parent.step_reasoning_efforts).toEqual({ high: 1, low: 2 });
  });

  it('stays absent when no request was counted', () => {
    const parent = createEmptyAgentThreadMetrics();
    addAgentThreadMetrics(parent, createEmptyAgentThreadMetrics());
    expect(parent.step_reasoning_efforts).toBeUndefined();
  });
});
