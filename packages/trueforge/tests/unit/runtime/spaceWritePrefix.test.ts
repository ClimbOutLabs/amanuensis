import { prefixWithinCap } from '../../../src/runtime/spaceWritePrefix';

const HEADER = '| Breed | Group |\n| --- | --- |';

function rows(from: number, to: number): string {
  const lines: string[] = [];
  for (let index = from; index <= to; index += 1) {
    lines.push(`| Breed ${String(index).padStart(2, '0')} | Group ${String(index)} |`);
  }
  return lines.join('\n');
}

describe('prefixWithinCap', () => {
  it('keeps whole lines up to the cap and names where the rest starts', () => {
    const content = `${HEADER}\n${rows(1, 40)}`;
    const cut = prefixWithinCap({ content, cap: 300 });
    expect(cut).not.toBeNull();
    expect(cut?.kept.length ?? 0).toBeLessThanOrEqual(300);
    expect(content.startsWith(cut?.kept ?? 'x')).toBe(true);
    const savedRows = (cut?.saved_lines ?? 0) - 2;
    expect(cut?.unsaved_from).toBe(
      `| Breed ${String(savedRows + 1).padStart(2, '0')} | Group ${String(savedRows + 1)} |`,
    );
    expect(cut?.unsaved_lines).toBe(40 - savedRows);
  });

  it('truncates the unsaved preview to 80 characters', () => {
    const long = `| ${'a'.repeat(120)} |`;
    const cut = prefixWithinCap({ content: `one\ntwo\n${long}`, cap: 10 });
    expect(cut).toBeNull();
    const cutAt = prefixWithinCap({ content: `one\ntwo\n${long}`, cap: 130 });
    expect(cutAt?.unsaved_from).toBe(long.slice(0, 80));
  });

  it('never keeps a table header without a data row', () => {
    const content = `intro\nmore intro\n${HEADER}\n${rows(1, 3)}`;
    const cut = prefixWithinCap({ content, cap: 'intro\nmore intro\n| Breed | Group |\n| --- | --- |'.length + 3 });
    expect(cut?.kept).toBe('intro\nmore intro');
    expect(cut?.unsaved_from).toBe('| Breed | Group |');
  });

  it('drops a header whose separator row does not fit', () => {
    const content = `intro\nmore intro\n${HEADER}\n${rows(1, 3)}`;
    const cut = prefixWithinCap({ content, cap: 'intro\nmore intro\n| Breed | Group |'.length });
    expect(cut?.kept).toBe('intro\nmore intro');
  });

  it('never keeps a header and a short-dash separator without a data row', () => {
    const content = 'intro\nmore intro\n| A | B |\n|-|-|\n| 1 | 2 |';
    const cut = prefixWithinCap({ content, cap: 'intro\nmore intro\n| A | B |\n|-|-|'.length });
    expect(cut?.kept).toBe('intro\nmore intro');
    expect(cut?.unsaved_from).toBe('| A | B |');
  });

  it('steps back to before a code fence the cut would leave open', () => {
    const content = 'intro\nmore intro\n```\ncode one\ncode two\n```\nafter';
    const cut = prefixWithinCap({ content, cap: 'intro\nmore intro\n```\ncode one'.length });
    expect(cut?.kept).toBe('intro\nmore intro');
    expect(cut?.unsaved_from).toBe('```');
  });

  it('keeps a code fence that the cut leaves closed', () => {
    const content = 'intro\n```\ncode\n```\nafter one\nafter two';
    const cut = prefixWithinCap({ content, cap: 'intro\n```\ncode\n```\nafter one'.length });
    expect(cut?.kept).toBe('intro\n```\ncode\n```\nafter one');
  });

  it('steps back to before an html block the cut would leave open', () => {
    const content = 'intro\nmore intro\n<div>\ninside\n</div>\nafter';
    const cut = prefixWithinCap({ content, cap: 'intro\nmore intro\n<div>\ninside'.length });
    expect(cut?.kept).toBe('intro\nmore intro');
  });

  it('returns null when fewer than two lines fit', () => {
    expect(prefixWithinCap({ content: `${'a'.repeat(50)}\nb`, cap: 55 })).toBeNull();
  });

  it('returns null when a single line is longer than the cap', () => {
    expect(prefixWithinCap({ content: `short\nshort\n${'x'.repeat(5_000)}`, cap: 3_600 })).toBeNull();
  });
});
