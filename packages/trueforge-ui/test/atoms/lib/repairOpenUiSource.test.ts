import { describe, expect, it } from 'vitest';

import { repairOpenUiSource } from '@/atoms/lib/repairOpenUiSource.js';

describe('repairOpenUiSource', () => {
  it('adds the missing round brackets and keeps key=value pairs inside', () => {
    expect(repairOpenUiSource('Stack[a, b], direction="column"')).toBe('Stack([a, b], direction="column")');
    expect(repairOpenUiSource('x = Stack[a, b], direction="column", gap="m"')).toBe(
      'x = Stack([a, b], direction="column", gap="m")',
    );
  });

  it('repairs a bracket list with no extra pairs and ignores brackets inside strings', () => {
    expect(repairOpenUiSource('x = Stack[a, b]')).toBe('x = Stack([a, b])');
    expect(repairOpenUiSource('x = Card[t, "a ] b"], gap="m"')).toBe('x = Card([t, "a ] b"], gap="m")');
  });

  it('leaves valid statements, lowercase names and unbalanced lines alone', () => {
    const valid = 'root = Stack([a, b], direction="column")\nx = items[0]\ny = Stack[a, b\nz = Foo[a] + 1';
    expect(repairOpenUiSource(valid)).toBe(valid);
  });

  it('repairs only the broken statements of a multi-line block', () => {
    expect(repairOpenUiSource('root = Stack([a, b])\nb = Stack[a], gap="m"\n')).toBe(
      'root = Stack([a, b])\nb = Stack([a], gap="m")\n',
    );
  });
});
