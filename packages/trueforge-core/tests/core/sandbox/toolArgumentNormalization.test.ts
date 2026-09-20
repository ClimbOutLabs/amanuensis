import {
  normalizeStructuredEditArguments,
  resolveLineArrayField,
  stripLineNumberGutters,
} from '../../../src/core/sandbox/toolArgumentNormalization';

const cwd = '/repo';
const repositoryRoot = '/repo';

describe('normalizeStructuredEditArguments', () => {
  it('strips a leading BOM from patch', () => {
    const patch = '﻿diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n';
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toBe('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n');
    expect(result.notes).toContain('stripped a leading byte-order mark from patch');
  });

  it('strips a surrounding markdown code fence from patch, with a language tag', () => {
    // The single newline right before the closing fence marker doubles as the last content
    // line's own terminator and the fence's line separator, so it is consumed by the fence,
    // same as a well-formed fence around any other language always behaves.
    const innerLastLine = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y';
    const fenced = `\`\`\`diff\n${innerLastLine}\n\`\`\`\n`;
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch: fenced, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toBe(innerLastLine);
    expect(result.notes).toContain('stripped a surrounding markdown code fence from patch');
  });

  it('strips a surrounding markdown code fence with no language tag', () => {
    const innerLastLine = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y';
    const fenced = `\`\`\`\n${innerLastLine}\n\`\`\`\n`;
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch: fenced, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toBe(innerLastLine);
  });

  it('strips a surrounding code fence from old_text (it is only used to locate a passage)', () => {
    const result = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { old_text: '```\nfoo\n```', new_text: 'bar', cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['old_text']).toBe('foo');
  });

  it('does not strip a line-number gutter from old_text at normalisation time — that decision is deferred to match time in replaceTextDiagnostics.ts', () => {
    // See toolArgumentNormalization.ts's module docstring and stripLineNumberGutters's own
    // tests below: whether "212 | const value = 42;" is a display gutter over real content or a
    // literal byte sequence can only be told apart by trying both against the actual file, which
    // this pure, I/O-free normaliser cannot do.
    const result = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { old_text: '212 | const value = 42;', new_text: 'const value = 100;', cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['old_text']).toBe('212 | const value = 42;');
    expect(result.notes).toEqual([]);
  });

  it('does not strip a line-number gutter from new_text or patch', () => {
    const replaceResult = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { old_text: 'x', new_text: '212 | y', cwd },
      cwd,
      repositoryRoot,
    });
    expect(replaceResult.args['new_text']).toBe('212 | y');
  });

  describe('stripLineNumberGutters', () => {
    it('strips a single-line "NNN | " line-number gutter', () => {
      expect(stripLineNumberGutters('212 | const value = 42;')).toBe('const value = 42;');
    });

    it('strips a "NNN:" line-number gutter from every line of a multi-line, strictly-consecutive quote', () => {
      expect(stripLineNumberGutters('212: a\n213: b\n214: c')).toBe('a\nb\nc');
    });

    it('preserves a single trailing newline while stripping every line', () => {
      // Splitting a newline-terminated value on "\n" produces a trailing empty-string element,
      // which cannot itself carry a gutter — the strip must exclude it from the
      // every-line-must-match check rather than aborting the whole strip because of it.
      expect(stripLineNumberGutters('212: a\n213: b\n')).toBe('a\nb\n');
      expect(stripLineNumberGutters('212 | a\n213 | b\n')).toBe('a\nb\n');
    });

    it('does not strip a leading number when it is not followed by a ":" or "|" gutter delimiter', () => {
      // A line that legitimately starts with digits followed only by whitespace (e.g. an
      // arithmetic expression) must not have its leading digits mistaken for a line-number
      // gutter and silently deleted — the deterministic strip only fires on an unambiguous
      // ":"/"|" gutter.
      expect(stripLineNumberGutters('3600 * 24')).toBe('3600 * 24');
    });

    it('does not strip unless every line carries a gutter', () => {
      expect(stripLineNumberGutters('212 | const a = 1;\nconst b = 2;')).toBe('212 | const a = 1;\nconst b = 2;');
    });

    it('does not strip when line numbers are not strictly increasing consecutive integers', () => {
      // A numbered list or numbered-output-from-another-tool quote that is not a contiguous
      // "line N, N+1, N+2 of a file" gutter must be left alone — see finding "Numbered code can
      // redirect replacements": a match on the un-numbered text elsewhere in the file must not
      // silently steal the edit from the passage actually named.
      expect(stripLineNumberGutters('1: foo\n5: bar')).toBe('1: foo\n5: bar');
      expect(stripLineNumberGutters('2: foo\n1: bar')).toBe('2: foo\n1: bar');
      expect(stripLineNumberGutters('1: foo\n1: bar')).toBe('1: foo\n1: bar');
    });

    it('does not strip when the lines use different gutter delimiters', () => {
      expect(stripLineNumberGutters('212 | foo\n213: bar')).toBe('212 | foo\n213: bar');
    });
  });

  it('does not strip a surrounding code fence, BOM, or CRLF from new_text or content — they are written verbatim', () => {
    const replaceResult = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { old_text: 'x', new_text: '```\r\nbar\r\n```', cwd },
      cwd,
      repositoryRoot,
    });
    expect(replaceResult.args['new_text']).toBe('```\r\nbar\r\n```');
    expect(replaceResult.notes).toEqual([]);

    const writeResult = normalizeStructuredEditArguments({
      toolName: 'write_file',
      args: { path: 'a.ts', content: '﻿```\r\nfoo\r\n```', cwd },
      cwd,
      repositoryRoot,
    });
    expect(writeResult.args['content']).toBe('﻿```\r\nfoo\r\n```');
    expect(writeResult.notes).toEqual([]);
  });

  it('trims leading and trailing blank lines from patch, not from old_text or new_text', () => {
    const patch = '\n\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n\n\n';
    const oldText = '\n\nfoo\n\n';
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toBe('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n');

    const replaceResult = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { old_text: oldText, new_text: 'bar', cwd },
      cwd,
      repositoryRoot,
    });
    expect(replaceResult.args['old_text']).toBe(oldText);
  });

  it('normalizes CRLF to LF in patch', () => {
    const patch = 'diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n';
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).not.toContain('\r');
    expect(result.notes).toContain('normalized CRLF line endings to LF in patch');
  });

  it('rewrites an absolute path inside the effective root as cwd-relative', () => {
    const result = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { path: '/repo/src/a.ts', old_text: 'x', new_text: 'y', cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['path']).toBe('src/a.ts');
    expect(result.notes.some(note => note.includes('rewrote absolute path'))).toBe(true);
  });

  it('rewrites an absolute path against a nested cwd', () => {
    const result = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { path: '/repo/src/a.ts', old_text: 'x', new_text: 'y', cwd: '/repo/src' },
      cwd: '/repo/src',
      repositoryRoot,
    });
    expect(result.args['path']).toBe('a.ts');
  });

  it('leaves an absolute path outside the workspace unchanged for the downstream rejection', () => {
    const result = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { path: '/etc/passwd', old_text: 'x', new_text: 'y', cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['path']).toBe('/etc/passwd');
    expect(result.notes).toEqual([]);
  });

  it('leaves an already-relative path unchanged', () => {
    const result = normalizeStructuredEditArguments({
      toolName: 'write_file',
      args: { path: 'src/a.ts', content: 'x', cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['path']).toBe('src/a.ts');
    expect(result.notes).toEqual([]);
  });

  it('detects and converts the OpenAI apply_patch envelope, with an envelope', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch\n';
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toMatch(/^diff --git a\/a\.ts b\/a\.ts/u);
    expect(result.notes).toContain('converted OpenAI apply_patch envelope to a Git-format unified diff');
  });

  it('converts an envelope-less OpenAI apply_patch body starting at a file operation header', () => {
    const patch = '*** Update File: a.ts\n@@\n-x\n+y\n';
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toMatch(/^diff --git a\/a\.ts b\/a\.ts/u);
  });

  it('strips a surrounding code fence padded with blank lines outside it', () => {
    const innerLastLine = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y';
    const fenced = `\n\`\`\`diff\n${innerLastLine}\n\`\`\`\n\n`;
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch: fenced, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toBe(innerLastLine);
    expect(result.notes).toContain('stripped a surrounding markdown code fence from patch');
  });

  it('leaves an already Git-format diff unchanged (no dialect conversion note)', () => {
    const patch = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n';
    const result = normalizeStructuredEditArguments({
      toolName: 'apply_patch',
      args: { patch, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['patch']).toBe(patch);
    expect(result.notes).toEqual([]);
  });

  it('leaves Unicode hyphen and no-break-space variants in a path unchanged (no filesystem check available here)', () => {
    // A genuine Unicode filename and a model typo for the ASCII look-alike are indistinguishable
    // to this pure, I/O-free layer; silently rewriting one to the other risks retargeting the
    // call to a different file. See normalizePathField's doc comment.
    const result = normalizeStructuredEditArguments({
      toolName: 'write_file',
      args: { path: 'src/my‐file name.ts', content: 'a‐b', cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['path']).toBe('src/my‐file name.ts');
    expect(result.args['content']).toBe('a‐b');
    expect(result.notes).toEqual([]);
  });

  it('leaves non-string fields untouched and applies no normalisation when nothing to fix', () => {
    const result = normalizeStructuredEditArguments({
      toolName: 'replace_text',
      args: { path: 'a.ts', old_text: 'x', new_text: 'y', replace_all: true, cwd },
      cwd,
      repositoryRoot,
    });
    expect(result.args['replace_all']).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it('is pure: does not mutate the input args object', () => {
    const args = { patch: '﻿diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n', cwd };
    const frozen = Object.freeze({ ...args });
    expect(() =>
      normalizeStructuredEditArguments({ toolName: 'apply_patch', args: frozen, cwd, repositoryRoot }),
    ).not.toThrow();
  });

  it('preserves the exact key set and non-string field types of the input, even when every applicable rule fires', () => {
    // Regression for the shape-preservation invariant the final `hasSameShape` runtime check
    // guards: normalization must add, remove, or retype no key, no matter how many text/path
    // rules touch the object in one call. Every mutated field here (patch, old_text, path) is
    // rewritten by a different rule, while replace_all (boolean) and note_count (number) pass
    // through untouched.
    const patch = '\n```diff\ndiff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\r\n```\n';
    const args = {
      patch,
      old_text: '﻿foo\r\nbar',
      path: `${repositoryRoot}/nested/file.ts`,
      cwd,
      replace_all: true,
      note_count: 3,
    };
    const result = normalizeStructuredEditArguments({ toolName: 'apply_patch', args, cwd, repositoryRoot });
    expect(Object.keys(result.args).sort()).toEqual(Object.keys(args).sort());
    expect(result.notes.length).toBeGreaterThan(0);
    expect(typeof result.args['patch']).toBe('string');
    expect(typeof result.args['old_text']).toBe('string');
    expect(typeof result.args['path']).toBe('string');
    expect(result.args['replace_all']).toBe(true);
    expect(result.args['note_count']).toBe(3);
  });

  describe('line-array field pairs (content/content_lines, patch/patch_lines, old_text/old_text_lines, new_text/new_text_lines)', () => {
    it('joins content_lines into content for write_file', () => {
      const result = normalizeStructuredEditArguments<Record<string, unknown>>({
        toolName: 'write_file',
        args: { path: 'a.ts', content_lines: ['line one', '', 'line three'], cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args['content']).toBe('line one\n\nline three');
      expect(result.args).not.toHaveProperty('content_lines');
      expect(result.notes).toContain('joined content_lines into content');
    });

    it('joins patch_lines into patch for apply_patch, ahead of the cosmetic patch cleanup', () => {
      const result = normalizeStructuredEditArguments<Record<string, unknown>>({
        toolName: 'apply_patch',
        args: {
          patch_lines: ['diff --git a/a b/a', '--- a/a', '+++ b/a', '@@ -1 +1 @@', '-x', '+y'],
          cwd,
        },
        cwd,
        repositoryRoot,
      });
      expect(result.args['patch']).toBe('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y');
      expect(result.args).not.toHaveProperty('patch_lines');
      expect(result.notes).toContain('joined patch_lines into patch');
    });

    it('joins old_text_lines and new_text_lines into old_text and new_text independently for replace_text', () => {
      const result = normalizeStructuredEditArguments<Record<string, unknown>>({
        toolName: 'replace_text',
        args: { path: 'a.ts', old_text_lines: ['a', 'b'], new_text_lines: ['c', '', 'd'], cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args['old_text']).toBe('a\nb');
      expect(result.args['new_text']).toBe('c\n\nd');
      expect(result.args).not.toHaveProperty('old_text_lines');
      expect(result.args).not.toHaveProperty('new_text_lines');
      expect(result.notes).toEqual(
        expect.arrayContaining(['joined old_text_lines into old_text', 'joined new_text_lines into new_text']),
      );
    });

    it('joins one field of a replace_text pair while leaving a plain string sibling untouched', () => {
      const result = normalizeStructuredEditArguments<Record<string, unknown>>({
        toolName: 'replace_text',
        args: { path: 'a.ts', old_text: 'a\nb', new_text_lines: ['c', 'd'], cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args['old_text']).toBe('a\nb');
      expect(result.args['new_text']).toBe('c\nd');
      expect(result.notes).toEqual(['joined new_text_lines into new_text']);
    });

    it('leaves the string field untouched, and the array field in place, when both are supplied (a conflict for schema validation to reject)', () => {
      const result = normalizeStructuredEditArguments({
        toolName: 'write_file',
        args: { path: 'a.ts', content: 'kept', content_lines: ['a', 'b'], cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args['content']).toBe('kept');
      expect(result.args['content_lines']).toEqual(['a', 'b']);
      expect(result.notes).toEqual([]);
    });

    it('leaves the arguments untouched when neither the string field nor its array sibling is supplied', () => {
      const result = normalizeStructuredEditArguments({
        toolName: 'write_file',
        args: { path: 'a.ts', cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args).not.toHaveProperty('content');
      expect(result.args).not.toHaveProperty('content_lines');
      expect(result.notes).toEqual([]);
    });

    it('does not join an array field whose elements are not all strings, leaving it for schema validation to reject', () => {
      const result = normalizeStructuredEditArguments({
        toolName: 'write_file',
        args: { path: 'a.ts', content_lines: ['a', 1, 'c'], cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args).not.toHaveProperty('content');
      expect(result.args['content_lines']).toEqual(['a', 1, 'c']);
      expect(result.notes).toEqual([]);
    });

    it('applies the cosmetic BOM/fence/CRLF cleanup to old_text after joining old_text_lines', () => {
      const result = normalizeStructuredEditArguments<Record<string, unknown>>({
        toolName: 'replace_text',
        args: { path: 'a.ts', old_text_lines: ['```', 'foo', '```'], new_text: 'bar', cwd },
        cwd,
        repositoryRoot,
      });
      expect(result.args['old_text']).toBe('foo');
      expect(result.notes).toContain('joined old_text_lines into old_text');
      expect(result.notes).toContain('stripped a surrounding markdown code fence from old_text');
    });
  });
});

describe('resolveLineArrayField', () => {
  it('returns the string value unchanged when only the string field is supplied', () => {
    const result = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: 'a\nb',
      arrayValue: undefined,
    });
    expect(result).toEqual({ status: 'ok', value: 'a\nb' });
  });

  it('joins the array value with "\\n" when only the array field is supplied', () => {
    const result = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: undefined,
      arrayValue: ['a', '', 'b'],
    });
    expect(result).toEqual({ status: 'ok', value: 'a\n\nb' });
  });

  it('joins a single-element array to that one line, with no trailing newline added', () => {
    const result = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: undefined,
      arrayValue: ['only line'],
    });
    expect(result).toEqual({ status: 'ok', value: 'only line' });
  });

  it('rejects when both the string field and the array field are supplied', () => {
    const result = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: 'a',
      arrayValue: ['a'],
    });
    expect(result.status).toBe('conflict');
    expect(result).toMatchObject({
      message: 'provide exactly one of content or content_lines, not both',
    });
  });

  it('rejects when neither the string field nor the array field is supplied', () => {
    const result = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: undefined,
      arrayValue: undefined,
    });
    expect(result.status).toBe('missing');
    expect(result).toMatchObject({
      message:
        'content is required; provide it as a string, or as content_lines ' +
        '(an array of lines, one element per line, blank lines as empty strings)',
    });
  });

  it('rejects a resolved value shorter than minLength, from either form', () => {
    const fromString = resolveLineArrayField({
      stringField: 'patch',
      arrayField: 'patch_lines',
      stringValue: '',
      arrayValue: undefined,
      minLength: 1,
    });
    expect(fromString).toEqual({ status: 'too_short', message: 'patch must not be empty' });

    const fromArray = resolveLineArrayField({
      stringField: 'patch',
      arrayField: 'patch_lines',
      stringValue: undefined,
      arrayValue: [],
      minLength: 1,
    });
    expect(fromArray).toEqual({ status: 'too_short', message: 'patch must not be empty' });
  });

  it('rejects a resolved value longer than maxLength, from either form', () => {
    const fromString = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: 'abcdef',
      arrayValue: undefined,
      maxLength: 5,
    });
    expect(fromString).toEqual({ status: 'too_long', message: 'content must be at most 5 characters' });

    const fromArray = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: undefined,
      arrayValue: ['abc', 'def'],
      maxLength: 5,
    });
    // "abc\ndef" is 7 characters once joined, over the 5-character maxLength.
    expect(fromArray).toEqual({ status: 'too_long', message: 'content must be at most 5 characters' });
  });

  it('accepts an empty array as the array form, joining to an empty string', () => {
    const result = resolveLineArrayField({
      stringField: 'content',
      arrayField: 'content_lines',
      stringValue: undefined,
      arrayValue: [],
    });
    expect(result).toEqual({ status: 'ok', value: '' });
  });
});
