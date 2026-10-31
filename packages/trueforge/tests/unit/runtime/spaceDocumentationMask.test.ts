import { codeFenceRoles, maskDocumentationRegions } from '../../../src/runtime/spaceDocumentationMask';

describe('code fence roles', () => {
  it('marks the opening, inside and closing lines of a fence', () => {
    expect(codeFenceRoles(['text', '```ts', '| a |', '```', 'after'])).toEqual([
      'outside',
      'open',
      'inside',
      'close',
      'outside',
    ]);
  });

  it('closes only on the same fence character, at least as long', () => {
    expect(codeFenceRoles(['````', '```', '~~~~', '````'])).toEqual(['open', 'inside', 'inside', 'close']);
  });

  it('runs an unclosed fence to the end and ignores a fence indented four spaces', () => {
    expect(codeFenceRoles(['    ```', '~~~', 'x'])).toEqual(['outside', 'open', 'inside']);
  });

  it('masks fenced lines and keeps the rest', () => {
    expect(maskDocumentationRegions('a\n```\nb\n```\nc')).toBe('a\n   \n \n   \nc');
  });
});
