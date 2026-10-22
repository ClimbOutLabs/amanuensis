import { describe, expect, it } from 'vitest';

import { computeAgentStepsSplit, type AgentStepPart } from '@/index.js';

function text(content: string): AgentStepPart {
  return { type: 'text', text: content };
}

function tool(): AgentStepPart {
  return { type: 'tool-call' };
}

function mapsTool(): AgentStepPart {
  return { type: 'tool-call', toolName: 'render_route' };
}

function reasoning(): AgentStepPart {
  return { type: 'reasoning', text: 'thinking' };
}

const LONG_TEXT = 'A substantive summary of the document that runs well past the narration limit. '.repeat(2);

function run(start: number, end: number, counts: { tools?: number; thinking?: number } = {}) {
  return { start, end, toolCount: counts.tools ?? 0, thinkingCount: counts.thinking ?? 0 };
}

describe('computeAgentStepsSplit', () => {
  it('treats pure text as final immediately while running', () => {
    const parts = [text('hello world')];
    const result = computeAgentStepsSplit(parts);
    expect(result.runs).toEqual([]);
    expect(result.hasFinal).toBe(true);
    expect(result.toolCount).toBe(0);
  });

  it('shows trailing text as final while running, even right after a tool call', () => {
    const result = computeAgentStepsSplit([tool(), text('hi')]);
    expect(result.hasFinal).toBe(true);
    expect(result.runs).toEqual([run(0, 1, { tools: 1 })]);
  });

  it('keeps the steps before a trailing answer folded and counted', () => {
    const result = computeAgentStepsSplit([tool(), reasoning(), text('x'.repeat(500))]);
    expect(result.hasFinal).toBe(true);
    expect(result.runs).toEqual([run(0, 2, { tools: 1, thinking: 1 })]);
    expect(result.toolCount).toBe(1);
    expect(result.thinkingCount).toBe(1);
  });

  it('has no final answer while the trailing text is blank', () => {
    const result = computeAgentStepsSplit([tool(), text('  \n')]);
    expect(result.hasFinal).toBe(false);
    expect(result.runs).toEqual([run(0, 2, { tools: 1 })]);
  });

  it('keeps substantive text before a tool call in the main flow', () => {
    const result = computeAgentStepsSplit([text(LONG_TEXT), tool(), text('Checked, all good.')]);
    expect(result.runs).toEqual([run(1, 2, { tools: 1 })]);
    expect(result.hasFinal).toBe(true);
  });

  it('keeps multi-line text before a tool call in the main flow', () => {
    const parts = [text('Findings:\n- one\n- two'), tool(), text('Done.')];
    expect(computeAgentStepsSplit(parts).runs).toEqual([run(1, 2, { tools: 1 })]);
  });

  it('keeps short text before a tool call visible instead of folding it with the call', () => {
    const parts = [text('Let me search for that.'), tool(), text('Here is the answer.')];
    expect(computeAgentStepsSplit(parts).runs).toEqual([run(1, 2, { tools: 1 })]);
  });

  it('keeps a sentence written before a tool call visible when the result follows', () => {
    const parts = [text("I'll run that calculation for you."), tool(), text('The result is **20**.')];
    const result = computeAgentStepsSplit(parts);
    expect(result.runs).toEqual([run(1, 2, { tools: 1 })]);
    expect(result.hasFinal).toBe(true);
  });

  it('marks visible text before a later folded step as in-between, never the trailing answer', () => {
    const parts = [text('Let me look.'), tool(), text('Now the details.'), reasoning(), tool(), text('Answer.')];
    expect(computeAgentStepsSplit(parts).interimTextIndices).toEqual([0, 2]);
  });

  it('does not mark text before a map call as in-between, since the map is the answer', () => {
    expect(computeAgentStepsSplit([text('Here is the route.'), mapsTool()]).interimTextIndices).toEqual([]);
  });

  it('folds whitespace-only text into the surrounding steps', () => {
    const parts = [tool(), text('\n'), tool(), text('Final.')];
    expect(computeAgentStepsSplit(parts).runs).toEqual([run(0, 3, { tools: 2 })]);
  });

  it('returns one run per contiguous folded stretch with per-run counts', () => {
    const parts = [
      reasoning(),
      tool(),
      text(LONG_TEXT),
      text('Now the second lookup.'),
      tool(),
      tool(),
      text(LONG_TEXT),
      tool(),
      text('All done.'),
    ];
    const result = computeAgentStepsSplit(parts);
    expect(result.runs).toEqual([
      run(0, 2, { tools: 1, thinking: 1 }),
      run(4, 6, { tools: 2 }),
      run(7, 8, { tools: 1 }),
    ]);
    expect(result.toolCount).toBe(4);
    expect(result.thinkingCount).toBe(1);
  });

  it('never folds a maps call, and splits the steps around it into separate runs', () => {
    const parts = [tool(), mapsTool(), reasoning(), tool(), text('x'.repeat(500))];
    const result = computeAgentStepsSplit(parts);
    expect(result.runs).toEqual([run(0, 1, { tools: 1 }), run(2, 4, { tools: 1, thinking: 1 })]);
  });

  it('treats text after a lone maps call as the final answer', () => {
    const result = computeAgentStepsSplit([mapsTool(), text('Here is the route.')]);
    expect(result.runs).toEqual([]);
    expect(result.hasFinal).toBe(true);
  });
});
