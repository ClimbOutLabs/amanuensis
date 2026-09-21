import {
  admitToolCallsForBudget,
  createTaskState,
  isTaskStateActive,
  isToolBudgetExhausted,
  matchesBudgetedTool,
  MAX_TASK_FINDINGS,
  noteExecutedToolCalls,
  recordTaskFinding,
  renderTaskStateBlock,
  syncTaskPhase,
  TASK_STATE_TOOL_NAME,
  taskStateFromSnapshot,
  toTaskStateSnapshot,
  type TaskFinding,
} from '../../../src/core/runtime/taskState';

function makeFinding(overrides: Partial<TaskFinding> = {}): TaskFinding {
  return {
    label: 'Spain/Madrid',
    headline: 'Average student-room rent hits 689 €/month.',
    why_it_matters: 'Sets the budget baseline for the Madrid move.',
    url: 'https://example.com/madrid-rent',
    ...overrides,
  };
}

describe('taskState', () => {
  it('round-trips through a snapshot', () => {
    const state = createTaskState();
    recordTaskFinding(state, makeFinding());
    state.tool_calls_used = 3;
    const restored = taskStateFromSnapshot(toTaskStateSnapshot(state));
    expect(restored).toEqual(state);
  });

  it('falls back to an empty state for undefined or corrupt snapshots', () => {
    expect(taskStateFromSnapshot(undefined)).toEqual(createTaskState());
    expect(taskStateFromSnapshot({ findings: 'nope', tool_calls_used: -1 } as never)).toEqual(createTaskState());
  });

  it('is inactive without a budget and renders no block', () => {
    expect(isTaskStateActive(undefined)).toBe(false);
    expect(isTaskStateActive(10)).toBe(true);
    expect(renderTaskStateBlock({ state: createTaskState(), budget: undefined })).toBeNull();
    expect(isToolBudgetExhausted(createTaskState(), undefined)).toBe(false);
  });

  it('renders the budget, the recording instruction, and the findings', () => {
    const state = createTaskState();
    recordTaskFinding(state, makeFinding());
    const block = renderTaskStateBlock({ state, budget: 15 });
    expect(block).toContain('<task_state>');
    expect(block).toContain('0 of 15 used');
    expect(block).toContain('record_finding');
    expect(block).toContain('689 €/month');
    expect(block).toContain('</task_state>');
  });

  it('renders the force-answer variant once the budget is exhausted', () => {
    const state = createTaskState();
    state.tool_calls_used = 15;
    syncTaskPhase(state, 15);
    const block = renderTaskStateBlock({ state, budget: 15 });
    expect(block).toContain('budget exhausted');
    expect(block).toContain('Write your final answer now');
  });

  it('caps findings at MAX_TASK_FINDINGS', () => {
    const state = createTaskState();
    for (let i = 0; i < MAX_TASK_FINDINGS; i++) {
      expect(recordTaskFinding(state, makeFinding({ label: `beat-${String(i)}` })).recorded).toBe(true);
    }
    expect(recordTaskFinding(state, makeFinding({ label: 'one-too-many' })).recorded).toBe(false);
    expect(state.findings).toHaveLength(MAX_TASK_FINDINGS);
  });

  it('charges only configured budgeted tools; record_finding is always exempt', () => {
    const state = createTaskState();
    noteExecutedToolCalls(state, ['tavily_search', TASK_STATE_TOOL_NAME, 'tavily_extract'], ['tavily_*']);
    expect(state.tool_calls_used).toBe(2);
    expect(isToolBudgetExhausted(state, 2)).toBe(true);
    expect(isToolBudgetExhausted(state, 3)).toBe(false);
  });

  it('leaves non-budgeted tools uncharged', () => {
    const state = createTaskState();
    noteExecutedToolCalls(state, ['tavily_search', 'ask_user_question', 'get_current_datetime'], ['tavily_*']);
    expect(state.tool_calls_used).toBe(1);
  });

  describe('matchesBudgetedTool', () => {
    it('matches exact names and wildcards, and never matches record_finding', () => {
      expect(matchesBudgetedTool('tavily_search', ['tavily_search'])).toBe(true);
      expect(matchesBudgetedTool('tavily_search', ['tavily_*'])).toBe(true);
      expect(matchesBudgetedTool('tavily_search', ['*_search'])).toBe(true);
      expect(matchesBudgetedTool('tavily_search', ['*'])).toBe(true);
      expect(matchesBudgetedTool('tavily_search', ['other_*'])).toBe(false);
      expect(matchesBudgetedTool('tavily_search', [])).toBe(false);
      // record_finding is exempt even under a catch-all pattern.
      expect(matchesBudgetedTool(TASK_STATE_TOOL_NAME, ['*'])).toBe(false);
      expect(matchesBudgetedTool(TASK_STATE_TOOL_NAME, [TASK_STATE_TOOL_NAME])).toBe(false);
    });

    it('treats non-wildcard pattern text literally', () => {
      expect(matchesBudgetedTool('tavily_search', ['tavily.search'])).toBe(false);
      expect(matchesBudgetedTool('tavily.search', ['tavily.search'])).toBe(true);
    });
  });

  describe('admitToolCallsForBudget', () => {
    const budgeted = ['tavily_*'];

    it('admits non-budgeted tools even when the budget is spent', () => {
      const state = createTaskState();
      state.tool_calls_used = 2;
      syncTaskPhase(state, 2);
      const admitted = admitToolCallsForBudget({
        state,
        budget: 2,
        budgetedTools: budgeted,
        calls: [
          { id: 'a', originalToolName: 'tavily_search' },
          { id: 'b', originalToolName: 'ask_user_question' },
          { id: 'c', originalToolName: TASK_STATE_TOOL_NAME },
        ],
      });
      // Budgeted search is withheld in the final-answer phase; the control
      // tool and record_finding are admitted.
      expect([...admitted].sort()).toEqual(['b', 'c']);
    });

    it('admits budgeted calls in emission order up to the remaining budget', () => {
      const state = createTaskState();
      state.tool_calls_used = 1;
      const admitted = admitToolCallsForBudget({
        state,
        budget: 2,
        budgetedTools: budgeted,
        calls: [
          { id: 'a', originalToolName: 'tavily_search' },
          { id: 'b', originalToolName: 'tavily_extract' },
          { id: 'c', originalToolName: 'ask_user_question' },
        ],
      });
      expect([...admitted].sort()).toEqual(['a', 'c']);
    });

    it('admits everything when the feature is off', () => {
      const admitted = admitToolCallsForBudget({
        state: createTaskState(),
        budget: undefined,
        budgetedTools: budgeted,
        calls: [{ id: 'a', originalToolName: 'tavily_search' }],
      });
      expect([...admitted]).toEqual(['a']);
    });
  });
});
