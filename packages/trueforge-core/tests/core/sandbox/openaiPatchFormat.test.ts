import { convertOpenAIPatchToGitDiff, detectApplyPatchFormat } from '../../../src/core/sandbox/openaiPatchFormat';
import { extractStructuredEditPaths } from '../../../src/core/sandbox/structuredEditPaths';

const context = { repositoryRoot: '/repo', cwd: '/repo' };

function acceptsAsGitDiff(gitDiff: string): void {
  const resolution = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch: gitDiff });
  expect(resolution.status).toBe('valid');
}

describe('detectApplyPatchFormat', () => {
  it('recognizes a git-format diff', () => {
    expect(detectApplyPatchFormat('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n')).toEqual({
      status: 'git',
    });
  });

  it('recognizes an OpenAI-format envelope', () => {
    expect(detectApplyPatchFormat('*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n')).toEqual({
      status: 'openai',
    });
  });

  it('rejects a patch mixing both formats', () => {
    const result = detectApplyPatchFormat(
      '*** Begin Patch\n*** Update File: a.ts\n@@\ndiff --git a/a b/a\n-x\n+y\n*** End Patch\n',
    );
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toMatch(/mixes|embeds/i);
  });
});

describe('convertOpenAIPatchToGitDiff', () => {
  it('converts an update with one hunk, computing exact offsets from file content', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/util.ts',
      '@@',
      '-export function add(a: number, b: number): number {',
      '-  return a + b;',
      '-}',
      '+/** Adds two numbers. */',
      '+export function add(a: number, b: number): number {',
      '+  return a + b;',
      '+}',
      '*** End Patch',
      '',
    ].join('\n');
    const original = [
      '// header',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
    ].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['src/util.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.paths).toEqual(['src/util.ts']);
    expect(result.gitDiff).toContain('diff --git a/src/util.ts b/src/util.ts');
    expect(result.gitDiff).toContain('--- a/src/util.ts');
    expect(result.gitDiff).toContain('+++ b/src/util.ts');
    expect(result.gitDiff).toContain('@@ -2,3 +2,4 @@');
    expect(result.gitDiff).toContain('+/** Adds two numbers. */');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('converts an update with two hunks, offsetting the second by the first hunk delta', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      ' one',
      '-two',
      '+TWO',
      '+TWO_AND_A_HALF',
      ' three',
      '@@',
      ' five',
      '-six',
      '+SIX',
      ' seven',
      '*** End Patch',
      '',
    ].join('\n');
    const original = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.gitDiff).toContain('@@ -1,3 +1,4 @@');
    // The file gained one line from the first hunk, so the second hunk's new-side start shifts by 1.
    expect(result.gitDiff).toContain('@@ -5,3 +6,3 @@');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('converts an add file operation', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const x = 1;',
      '+export const y = 2;',
      '*** End Patch',
      '',
    ].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch);
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.paths).toEqual(['src/new.ts']);
    expect(result.gitDiff).toContain('new file mode 100644');
    expect(result.gitDiff).toContain('--- /dev/null');
    expect(result.gitDiff).toContain('+++ b/src/new.ts');
    expect(result.gitDiff).toContain('@@ -0,0 +1,2 @@');
    expect(result.gitDiff).toContain('+export const x = 1;\n+export const y = 2;');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('converts a delete file operation using the real file content when available', () => {
    const patch = ['*** Begin Patch', '*** Delete File: src/old.ts', '*** End Patch', ''].join('\n');
    const original = ['line one', 'line two', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['src/old.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.paths).toEqual(['src/old.ts']);
    expect(result.gitDiff).toContain('deleted file mode 100644');
    expect(result.gitDiff).toContain('+++ /dev/null');
    expect(result.gitDiff).toContain('@@ -1,2 +0,0 @@');
    expect(result.gitDiff).toContain('-line one\n-line two');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('converts a move (rename) with an edit', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/old.ts',
      '*** Move to: src/new.ts',
      '@@',
      '-old name',
      '+new name',
      '*** End Patch',
      '',
    ].join('\n');
    const original = ['old name', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['src/old.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.paths).toEqual(['src/old.ts', 'src/new.ts']);
    expect(result.gitDiff).toContain('rename from src/old.ts');
    expect(result.gitDiff).toContain('rename to src/new.ts');
    expect(result.gitDiff).toContain('--- a/src/old.ts');
    expect(result.gitDiff).toContain('+++ b/src/new.ts');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('honors the "*** End of File" marker without breaking the conversion', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      ' one',
      '-two',
      '+TWO',
      '*** End of File',
      '*** End Patch',
      '',
    ].join('\n');
    const original = ['one', 'two', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.gitDiff).toContain('@@ -1,2 +1,2 @@');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('falls back to a placeholder start of 1 without file content', () => {
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@', '-old', '+new', '*** End Patch', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch);
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.gitDiff).toContain('@@ -1,1 +1,1 @@');
    expect(result.contentPaths).toEqual(['a.ts']);
  });

  it('rejects malformed input', () => {
    expect(convertOpenAIPatchToGitDiff('*** Begin Patch\n*** Update File: a.ts\n')).toEqual(
      expect.objectContaining({ status: 'invalid' }),
    );
    expect(convertOpenAIPatchToGitDiff('not a patch at all')).toEqual(expect.objectContaining({ status: 'invalid' }));
    expect(
      convertOpenAIPatchToGitDiff('*** Begin Patch\n*** Update File: a.ts\n@@\nnot-a-valid-marker\n*** End Patch\n'),
    ).toEqual(expect.objectContaining({ status: 'invalid' }));
  });

  it('uses the "@@ " anchor to pick the named block when context repeats in the file', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@ function bar() {',
      '-  return 1;',
      '+  return 2;',
      '*** End Patch',
      '',
    ].join('\n');
    const original = ['function foo() {', '  return 1;', '}', 'function bar() {', '  return 1;', '}', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    // The anchor names bar(), so the second (matching) occurrence of "return 1;" is edited, not
    // the first, textually identical, occurrence inside foo().
    expect(result.gitDiff).toContain('@@ -5,1 +5,1 @@ function bar() {');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('rejects a hunk whose context matches more than one location with no anchor to disambiguate', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-  return 1;',
      '+  return 2;',
      '*** End Patch',
      '',
    ].join('\n');
    const original = ['function foo() {', '  return 1;', '}', 'function bar() {', '  return 1;', '}', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toMatch(/more than one|anchor/i);
  });

  it('honors "*** End of File" to select the terminal block among identical repeats', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-END',
      '+STOP',
      '*** End of File',
      '*** End Patch',
      '',
    ].join('\n');
    const original = ['first', 'END', 'first', 'END', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    // Only the second "END" is at the true end of the file; the first is textually identical but
    // not terminal, and must not be selected.
    expect(result.gitDiff).toContain('@@ -4,1 +4,1 @@');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('places a pure-insertion hunk using its "@@ " anchor instead of the start of the file', () => {
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@ target', '+inserted', '*** End Patch', ''].join(
      '\n',
    );
    const original = ['alpha', 'target', 'beta', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    // Inserted right after the anchored "target" line (line 2), not at the file start (line 0).
    expect(result.gitDiff).toContain('@@ -2,0 +2,1 @@ target');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('rejects a pure-insertion hunk with no context and no anchor', () => {
    const patch = ['*** Begin Patch', '*** Update File: a.ts', '@@', '+inserted', '*** End Patch', ''].join('\n');
    const original = ['alpha', 'target', 'beta', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['a.ts', original]]));
    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.reason).toMatch(/ambiguous|anchor/i);
  });

  it('converts an Add File operation for a genuinely empty file, with no hunk', () => {
    const patch = ['*** Begin Patch', '*** Add File: empty.txt', '*** End Patch', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch);
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.gitDiff).toContain('new file mode 100644');
    expect(result.gitDiff).not.toContain('@@');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('converts a Delete File operation for a known-empty file, with no fabricated removed line', () => {
    const patch = ['*** Begin Patch', '*** Delete File: empty.txt', '*** End Patch', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch, new Map([['empty.txt', '']]));
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.gitDiff).toContain('deleted file mode 100644');
    // No hunk: an empty file has nothing to remove, unlike the placeholder pass (no content
    // supplied yet), which still emits a single-line placeholder hunk for path extraction.
    expect(result.gitDiff).not.toContain('@@');
    acceptsAsGitDiff(result.gitDiff);
  });

  it('still emits a placeholder delete hunk when content is not yet available', () => {
    const patch = ['*** Begin Patch', '*** Delete File: maybe-empty.txt', '*** End Patch', ''].join('\n');
    const result = convertOpenAIPatchToGitDiff(patch);
    expect(result.status).toBe('converted');
    if (result.status !== 'converted') return;
    expect(result.gitDiff).toContain('@@ -1 +0,0 @@');
    expect(result.contentPaths).toEqual(['maybe-empty.txt']);
  });
});
