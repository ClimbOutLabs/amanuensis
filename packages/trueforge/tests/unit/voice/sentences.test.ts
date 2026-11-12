import { SentenceSplitter } from '../../../src/voice/sentences';

function split(...pieces: string[]): string[] {
  const splitter = new SentenceSplitter();
  return [...pieces.flatMap(piece => splitter.push(piece)), ...splitter.flush()];
}

describe('SentenceSplitter', () => {
  it('gives each sentence once the next character shows it is over', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('It is nine.')).toEqual([]);
    expect(splitter.push(' Then lunch. ')).toEqual(['It is nine.', 'Then lunch.']);
  });

  it('does not cut after an abbreviation', () => {
    expect(split('Ask Dr. Lee about it.')).toEqual(['Ask Dr. Lee about it.']);
  });

  it('cuts after "No." when it is an answer, and keeps "No. 5" whole', () => {
    expect(split('No. I will not.')).toEqual(['No.', 'I will not.']);
    expect(split('See item No. 5 today.')).toEqual(['See item No. 5 today.']);
  });

  it('does not cut a numbered list item after its number', () => {
    expect(split('1. Buy milk\n2. Call Sam\n')).toEqual(['Buy milk', 'Call Sam']);
  });

  it('never reads fenced code aloud', () => {
    expect(split('Run this.\n```\nrm -rf x\n```\nDone.')).toEqual(['Run this.', 'Done.']);
  });

  it('cuts a long run of words with no stop at a space, so no sentence is too long to speak', () => {
    const words = Array.from({ length: 200 }, (_, index) => `word${String(index)}`).join(' ');
    const sentences = split(words);
    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.every(sentence => sentence.length <= 300)).toBe(true);
    expect(sentences.join(' ')).toBe(words);
  });

  it('waits to see whether a number follows "No." when the number arrives in the next piece', () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push('Yes and No. ')).toEqual([]);
    expect(splitter.push('5 is the answer.')).toEqual([]);
    expect(splitter.flush()).toEqual(['Yes and No. 5 is the answer.']);
    const answer = new SentenceSplitter();
    expect(answer.push('No. ')).toEqual([]);
    expect(answer.flush()).toEqual(['No.']);
  });

  it('takes list and heading marks out only where a line starts', () => {
    expect(split('Plan:\n- apples\n2. pears\n## Done\n')).toEqual(['Plan:', 'apples', 'pears', 'Done']);
  });

  it('leaves a number or a sign inside a line alone, so nothing a person is told goes missing', () => {
    expect(split('The amount is. 5000. Dollars. + 40 more. - 3 left.')).toEqual([
      'The amount is.',
      '5000. Dollars.',
      '+ 40 more.',
      '- 3 left.',
    ]);
  });
});
