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
    const result = computeAgentStepsSplit(parts, true);
    expect(result.runs).toEqual([]);
    expect(result.hasFinal).toBe(true);
    expect(result.toolCount).toBe(0);
  });

  it('holds back short trailing text while running when tools precede it', () => {
    const parts = [tool(), text('hi')];
    const result = computeAgentStepsSplit(parts, true);
    expect(result.hasFinal).toBe(false);
    expect(result.runs).toEqual([run(0, 2, { tools: 1 })]);
  });

  it('confirms final text once trailing content is long enough', () => {
    const parts = [tool(), reasoning(), text('x'.repeat(500))];
    const result = computeAgentStepsSplit(parts, true);
    expect(result.hasFinal).toBe(true);
    expect(result.runs).toEqual([run(0, 2, { tools: 1, thinking: 1 })]);
    expect(result.toolCount).toBe(1);
    expect(result.thinkingCount).toBe(1);
  });

  it('confirms final when not running', () => {
    const parts = [tool(), text('done')];
    const result = computeAgentStepsSplit(parts, false);
    expect(result.hasFinal).toBe(true);
    expect(result.runs).toEqual([run(0, 1, { tools: 1 })]);
  });

  it('promotes substantive text before a tool call into the main flow', () => {
    const parts = [text(LONG_TEXT), tool(), text('Checked, all good.')];
    const result = computeAgentStepsSplit(parts, false);
    expect(result.runs).toEqual([run(1, 2, { tools: 1 })]);
    expect(result.hasFinal).toBe(true);
  });

  it('promotes multi-line text even when it is short', () => {
    const parts = [text('Findings:\n- one\n- two'), tool(), text('Done.')];
    expect(computeAgentStepsSplit(parts, false).runs).toEqual([run(1, 2, { tools: 1 })]);
  });

  it('keeps short narration folded with the tool call that follows it', () => {
    const parts = [text('Let me search for that.'), tool(), text('Here is the answer.')];
    const result = computeAgentStepsSplit(parts, false);
    expect(result.runs).toEqual([run(0, 2, { tools: 1 })]);
  });

  it('keeps text visible when it has no step to fold into', () => {
    const parts = [text(LONG_TEXT), text('Okay, one more thing.'), text(LONG_TEXT), tool(), text('Final.')];
    expect(computeAgentStepsSplit(parts, false).runs).toEqual([run(3, 4, { tools: 1 })]);
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
    const result = computeAgentStepsSplit(parts, false);
    expect(result.runs).toEqual([
      run(0, 2, { tools: 1, thinking: 1 }),
      run(3, 6, { tools: 2 }),
      run(7, 8, { tools: 1 }),
    ]);
    expect(result.toolCount).toBe(4);
    expect(result.thinkingCount).toBe(1);
  });

  it('applies the streaming holdback to the trailing run only', () => {
    const parts = [text(LONG_TEXT), tool(), text('Short follow-up.')];
    const streaming = computeAgentStepsSplit(parts, true);
    expect(streaming.hasFinal).toBe(false);
    expect(streaming.runs).toEqual([run(1, 3, { tools: 1 })]);

    const longTrailing = computeAgentStepsSplit([text(LONG_TEXT), tool(), text('y'.repeat(500))], true);
    expect(longTrailing.hasFinal).toBe(true);
    expect(longTrailing.runs).toEqual([run(1, 2, { tools: 1 })]);
  });

  it('never folds a maps call, and splits the steps around it into separate runs', () => {
    const parts = [tool(), mapsTool(), reasoning(), tool(), text('x'.repeat(500))];
    const result = computeAgentStepsSplit(parts, false);
    expect(result.runs).toEqual([run(0, 1, { tools: 1 }), run(2, 4, { tools: 1, thinking: 1 })]);
  });

  it('streams text after a lone maps call directly instead of holding it back', () => {
    const result = computeAgentStepsSplit([mapsTool(), text('Here is the route.')], true);
    expect(result.runs).toEqual([]);
    expect(result.hasFinal).toBe(true);
  });

  it('keeps a part the caller asks for in the main flow, and does not count it as a step', () => {
    const parts = [tool(), { type: 'tool-call' as const, toolCallId: 'send-1' }, text('Done.')];
    const result = computeAgentStepsSplit(parts, false, part => part.toolCallId === 'send-1');
    expect(result.runs).toEqual([run(0, 1, { tools: 1 })]);
  });

  it('folds the same part when the caller keeps nothing', () => {
    const parts = [tool(), { type: 'tool-call' as const, toolCallId: 'send-1' }, text('Done.')];
    expect(computeAgentStepsSplit(parts, false, () => false).runs).toEqual([run(0, 2, { tools: 2 })]);
  });
});
