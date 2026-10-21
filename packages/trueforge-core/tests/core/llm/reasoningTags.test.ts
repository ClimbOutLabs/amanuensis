/**
 * Think-tag splitting in answer text: a `<think>...</think>` pair is reasoning, and a bare closing
 * tag whose opener sat in the prompt makes the text before it reasoning. A plain answer with no
 * think tags must come back unchanged in both modes.
 */
import type { ThinkSegment } from '../../../src/core/llm/reasoningTags';
import { ThinkTagSplitter } from '../../../src/core/llm/reasoningTags';

function split({ bareClose, pieces }: { bareClose: boolean; pieces: string[] }): {
  answer: string;
  reasoning: string;
} {
  const splitter = new ThinkTagSplitter({ bareClose });
  const segments: ThinkSegment[] = [];
  for (const piece of pieces) {
    segments.push(...splitter.push(piece));
  }
  segments.push(...splitter.flush());
  const textOf = (kind: ThinkSegment['kind']): string =>
    segments
      .filter(segment => segment.kind === kind)
      .map(segment => segment.text)
      .join('');
  return { answer: textOf('answer'), reasoning: textOf('reasoning') };
}

describe('ThinkTagSplitter bare closing tag', () => {
  it('makes the text before a bare closing tag reasoning, and keeps the answer after it', () => {
    const result = split({
      bareClose: true,
      pieces: ['Wait, the ID is missing. Let us list spaces again.</think>', '\n\nThe space is ready.'],
    });
    expect(result.reasoning).toBe('Wait, the ID is missing. Let us list spaces again.');
    expect(result.answer).toBe('The space is ready.');
    expect(result.answer).not.toContain('</think>');
  });

  it('recognises a bare closing tag split across pieces', () => {
    const result = split({ bareClose: true, pieces: ['Reasoning here.</th', 'ink>Answer.'] });
    expect(result.reasoning).toBe('Reasoning here.');
    expect(result.answer).toBe('Answer.');
  });

  it('leaves a bare closing tag as a stray marker when reasoning was never requested', () => {
    const result = split({ bareClose: false, pieces: ['Answer.</think> More.'] });
    expect(result.answer).toBe('Answer. More.');
    expect(result.reasoning).toBe('');
  });
});

describe('ThinkTagSplitter paired tags', () => {
  it.each([true, false])('turns a paired think block into reasoning (bareClose %s)', bareClose => {
    const result = split({ bareClose, pieces: ['<think>Plan it.</think>Done.'] });
    expect(result.reasoning).toBe('Plan it.');
    expect(result.answer).toBe('Done.');
  });

  it('keeps a think block whose tags are split across pieces intact', () => {
    const result = split({ bareClose: false, pieces: ['<thi', 'nk>Plan', ' it.</thi', 'nk>Done.'] });
    expect(result.reasoning).toBe('Plan it.');
    expect(result.answer).toBe('Done.');
  });
});

describe('ThinkTagSplitter plain answers', () => {
  it.each([true, false])('keeps a plain answer unchanged (bareClose %s)', bareClose => {
    const result = split({ bareClose, pieces: ['Here is ', 'the answer.'] });
    expect(result.answer).toBe('Here is the answer.');
    expect(result.reasoning).toBe('');
  });

  it.each([true, false])('keeps a less-than sign and ordinary tags as answer text (bareClose %s)', bareClose => {
    const text = 'a < b and <b>bold</b> stay put.';
    const result = split({ bareClose, pieces: ['a < b and <b>bo', 'ld</b> stay put.'] });
    expect(result.answer).toBe(text);
    expect(result.reasoning).toBe('');
  });

  it('releases a reply that ends in a partial tag as the text it was', () => {
    const result = split({ bareClose: false, pieces: ['Ends with <'] });
    expect(result.answer).toBe('Ends with <');
  });
});
