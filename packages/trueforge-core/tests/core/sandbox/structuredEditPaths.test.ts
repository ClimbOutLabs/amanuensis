import {
  extractStructuredEditPaths,
  structuredEditCwdRelativePath,
} from '../../../src/core/sandbox/structuredEditPaths';

const context = { repositoryRoot: '/repo', cwd: '/repo' };

function patchFor(input: { path: string; body?: string | undefined }): string {
  const body = input.body ?? '-before\n+after';
  return [
    `diff --git a/${input.path} b/${input.path}`,
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    '@@ -1 +1 @@',
    body,
  ].join('\n');
}

describe('structured edit paths', () => {
  it('normalizes replace_text, write_file, and nested-cwd patch targets against the repository root', () => {
    expect(
      extractStructuredEditPaths({
        kind: 'replace_text',
        repositoryRoot: '/repo',
        cwd: '/repo/packages/app',
        path: 'src/x.ts',
      }),
    ).toEqual({ status: 'valid', paths: ['packages/app/src/x.ts'], normalized_patch: undefined });
    expect(
      extractStructuredEditPaths({
        kind: 'write_file',
        repositoryRoot: '/repo',
        cwd: '/repo/packages/app',
        path: 'src/new.ts',
      }),
    ).toEqual({ status: 'valid', paths: ['packages/app/src/new.ts'], normalized_patch: undefined });
    expect(
      extractStructuredEditPaths({
        kind: 'apply_patch',
        repositoryRoot: '/repo',
        cwd: '/repo/packages/app',
        patch: patchFor({ path: 'src/x.ts' }),
      }),
    ).toMatchObject({ status: 'valid', paths: ['packages/app/src/x.ts'] });
  });

  it('treats counted hunk lines beginning with literal --- and +++ as content', () => {
    const patch = patchFor({
      path: 'docs/options.txt',
      body: '--- literal deleted content\n+++ literal added content',
    });

    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch })).toMatchObject({
      status: 'valid',
      paths: ['docs/options.txt'],
    });
  });

  it('decodes Git C-quoted octal UTF-8 paths exactly', () => {
    const patch = [
      'diff --git "a/docs/space file-\\303\\251.txt" "b/docs/space file-\\303\\251.txt"',
      '--- "a/docs/space file-\\303\\251.txt"',
      '+++ "b/docs/space file-\\303\\251.txt"',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n');

    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch })).toMatchObject({
      status: 'valid',
      paths: ['docs/space file-é.txt'],
    });
  });

  it('rejects a Git C-quoted path whose decoded bytes contain a path separator', () => {
    const patch = [
      'diff --git "a/src\\134outside.ts" "b/src\\134outside.ts"',
      '--- "a/src\\134outside.ts"',
      '+++ "b/src\\134outside.ts"',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n');

    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
  });

  it('rejects a placeholder hunk with a concrete retry hint', () => {
    const patch = ['diff --git a/src/App.tsx b/src/App.tsx', '--- a/src/App.tsx', '+++ b/src/App.tsx', '@@…'].join(
      '\n',
    );
    const resolution = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
    expect(resolution.status).toBe('invalid');
    if (resolution.status !== 'invalid') throw new Error('expected an invalid resolution');
    expect(resolution.failure).toContain('expected an unambiguous Git-format unified diff');
    expect(resolution.failure).toContain('@@ -1,2 +1,2 @@');
    expect(resolution.failure).toContain('Placeholder hunks like "@@…" are not valid');
  });

  it.each([
    {
      kind: 'rename',
      paths: ['src/old-é.ts', 'src/new-é.ts'],
      patch: [
        'diff --git "a/src/old-\\303\\251.ts" "b/src/new-\\303\\251.ts"',
        'similarity index 100%',
        'rename from "src/old-\\303\\251.ts"',
        'rename to "src/new-\\303\\251.ts"',
      ].join('\n'),
    },
    {
      kind: 'copy',
      paths: ['src/source file.ts', 'src/copied file.ts'],
      patch: [
        'diff --git "a/src/source file.ts" "b/src/copied file.ts"',
        'similarity index 100%',
        'copy from src/source file.ts',
        'copy to src/copied file.ts',
      ].join('\n'),
    },
  ])('returns both effective paths for a complete Git $kind section', ({ patch, paths }) => {
    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch })).toMatchObject({
      status: 'valid',
      paths: expect.arrayContaining(paths),
    });
  });

  it.each([
    'diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\nrename from src/other.ts\nrename to src/new.ts',
    'diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\ncopy from src/old.ts',
  ])('rejects incomplete or mismatched rename/copy metadata', patch => {
    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
  });

  it('repairs stale low hunk counts while rejecting incomplete high counts', () => {
    const staleLow = patchFor({ path: 'src/value.ts', body: ' first\n+second\n third' });
    const repaired = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch: staleLow });
    expect(repaired).toMatchObject({ status: 'valid', paths: ['src/value.ts'] });
    if (repaired.status !== 'valid') throw new Error(repaired.failure);
    expect(repaired.normalized_patch).toContain('@@ -1,2 +1,3 @@');

    const incomplete = patchFor({ path: 'src/value.ts' }).replace('@@ -1 +1 @@', '@@ -1,2 +1,2 @@');
    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch: incomplete }).status).toBe('invalid');
  });

  it.each([
    patchFor({ path: '../outside.ts' }),
    'diff --git /etc/passwd b/safe.txt\n--- /etc/passwd\n+++ b/safe.txt\n@@ -1 +1 @@\n-old\n+new',
    patchFor({ path: 'bad\u0000path.ts' }),
    'diff --git a/safe.ts b/safe.ts\n--- a/safe.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-old\n+new',
    'diff --git a/safe.ts b/safe.ts\n--- a/safe.ts\n+++ b/safe.ts',
    'diff --git a/image.bin b/image.bin\nGIT binary patch\nliteral 1\nA',
    `${patchFor({ path: 'safe.ts' })}\n--- a/private.ts\n+++ b/private.ts\n@@ -1 +1 @@\n-private\n+exposed`,
  ])('rejects unsafe, incomplete, unsupported, or undeclared patch sections', patch => {
    expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
  });

  describe('absolute apply_patch header paths inside the workspace', () => {
    it('accepts an absolute diff --git header inside cwd and rewrites the normalized patch to a/ b/ relative headers', () => {
      const patch =
        'diff --git /repo/src/x.ts /repo/src/x.ts\n--- /repo/src/x.ts\n+++ /repo/src/x.ts\n@@ -1 +1 @@\n-old\n+new';

      const result = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
      expect(result).toMatchObject({ status: 'valid', paths: ['src/x.ts'] });
      if (result.status !== 'valid') throw new Error(result.failure);
      expect(result.normalized_patch).toContain('diff --git a/src/x.ts b/src/x.ts');
      expect(result.normalized_patch).toContain('--- a/src/x.ts');
      expect(result.normalized_patch).toContain('+++ b/src/x.ts');
    });

    it('rewrites an absolute header inside a nested cwd to the same cwd-relative form a relative header would use', () => {
      const patch =
        'diff --git /repo/packages/app/src/x.ts /repo/packages/app/src/x.ts\n' +
        '--- /repo/packages/app/src/x.ts\n+++ /repo/packages/app/src/x.ts\n@@ -1 +1 @@\n-old\n+new';

      const result = extractStructuredEditPaths({
        kind: 'apply_patch',
        repositoryRoot: '/repo',
        cwd: '/repo/packages/app',
        patch,
      });
      expect(result).toMatchObject({ status: 'valid', paths: ['packages/app/src/x.ts'] });
      if (result.status !== 'valid') throw new Error(result.failure);
      expect(result.normalized_patch).toContain('diff --git a/src/x.ts b/src/x.ts');
      expect(result.normalized_patch).toContain('--- a/src/x.ts');
      expect(result.normalized_patch).toContain('+++ b/src/x.ts');
    });

    it('rejects an absolute diff --git header outside the effective root', () => {
      const patch = 'diff --git /etc/passwd /etc/passwd\n--- /etc/passwd\n+++ /etc/passwd\n@@ -1 +1 @@\n-old\n+new';

      expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
    });

    it('handles a patch mixing one absolute-header file with one relative-header file', () => {
      const patch = [
        'diff --git a/rel.ts b/rel.ts',
        '--- a/rel.ts',
        '+++ b/rel.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git /repo/abs.ts /repo/abs.ts',
        '--- /repo/abs.ts',
        '+++ /repo/abs.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n');

      const result = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
      expect(result).toMatchObject({ status: 'valid', paths: expect.arrayContaining(['rel.ts', 'abs.ts']) });
      if (result.status !== 'valid') throw new Error(result.failure);
      expect(result.normalized_patch).toContain('diff --git a/rel.ts b/rel.ts');
      expect(result.normalized_patch).toContain('diff --git a/abs.ts b/abs.ts');
      expect(result.normalized_patch).toContain('+++ b/abs.ts');
    });

    it('preserves a /dev/null side of a create with an absolute header on the created file', () => {
      const patch = [
        'diff --git /repo/new.ts /repo/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ /repo/new.ts',
        '@@ -0,0 +1 @@',
        '+new',
      ].join('\n');

      const result = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
      expect(result).toMatchObject({ status: 'valid', paths: ['new.ts'] });
      if (result.status !== 'valid') throw new Error(result.failure);
      expect(result.normalized_patch).toContain('diff --git a/new.ts b/new.ts');
      expect(result.normalized_patch).toContain('--- /dev/null');
      expect(result.normalized_patch).toContain('+++ b/new.ts');
    });

    it('preserves a /dev/null side of a delete with an absolute header on the deleted file', () => {
      const patch = [
        'diff --git /repo/gone.ts /repo/gone.ts',
        'deleted file mode 100644',
        '--- /repo/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-old',
      ].join('\n');

      const result = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
      expect(result).toMatchObject({ status: 'valid', paths: ['gone.ts'] });
      if (result.status !== 'valid') throw new Error(result.failure);
      expect(result.normalized_patch).toContain('diff --git a/gone.ts b/gone.ts');
      expect(result.normalized_patch).toContain('--- a/gone.ts');
      expect(result.normalized_patch).toContain('+++ /dev/null');
    });

    it('accepts a metadata-only create of a genuinely empty file, with no hunk', () => {
      const patch = [
        'diff --git a/empty.txt b/empty.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/empty.txt',
      ].join('\n');

      const result = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
      expect(result).toMatchObject({ status: 'valid', paths: ['empty.txt'] });
    });

    it('accepts a metadata-only delete of a genuinely empty file, with no hunk', () => {
      const patch = [
        'diff --git a/empty.txt b/empty.txt',
        'deleted file mode 100644',
        '--- a/empty.txt',
        '+++ /dev/null',
      ].join('\n');

      const result = extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch });
      expect(result).toMatchObject({ status: 'valid', paths: ['empty.txt'] });
    });

    it('still rejects a non-empty-file section with no hunk', () => {
      // No "new file mode"/"deleted file mode" metadata line: a hunk-less section is only valid
      // for the genuinely-empty-file create/delete case above.
      const patch = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts'].join('\n');

      expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
    });

    it('rejects a metadata-only section declaring both new file mode and deleted file mode', () => {
      const patch = [
        'diff --git a/empty.txt b/empty.txt',
        'new file mode 100644',
        'deleted file mode 100644',
        '--- /dev/null',
        '+++ b/empty.txt',
      ].join('\n');

      expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
    });

    it('rejects a metadata-only section declaring deleted file mode then new file mode', () => {
      const patch = [
        'diff --git a/empty.txt b/empty.txt',
        'deleted file mode 100644',
        'new file mode 100644',
        '--- a/empty.txt',
        '+++ /dev/null',
      ].join('\n');

      expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
    });

    it('rejects a metadata-only section that repeats the same mode declaration', () => {
      const patch = [
        'diff --git a/empty.txt b/empty.txt',
        'new file mode 100644',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/empty.txt',
      ].join('\n');

      expect(extractStructuredEditPaths({ kind: 'apply_patch', ...context, patch }).status).toBe('invalid');
    });
  });

  it.each(['../outside.ts', '/etc/passwd', 'C:\\outside.ts', 'src\\ambiguous.ts', 'bad\u0000path'])(
    'rejects unsafe raw path-tool target %s before admission',
    path => {
      expect(extractStructuredEditPaths({ kind: 'replace_text', ...context, path }).status).toBe('invalid');
    },
  );

  it('rejects an overlong path-tool target before admission', () => {
    expect(
      extractStructuredEditPaths({ kind: 'write_file', ...context, path: `src/${'x'.repeat(1_021)}` }).status,
    ).toBe('invalid');
  });

  describe('absolute path-tool targets inside the workspace', () => {
    it('accepts and normalizes an absolute path inside cwd', () => {
      expect(
        extractStructuredEditPaths({
          kind: 'write_file',
          repositoryRoot: '/repo',
          cwd: '/repo/packages/app',
          path: '/repo/packages/app/src/new.ts',
        }),
      ).toEqual({ status: 'valid', paths: ['packages/app/src/new.ts'], normalized_patch: undefined });
      expect(
        extractStructuredEditPaths({
          kind: 'replace_text',
          repositoryRoot: '/repo',
          cwd: '/repo/packages/app',
          path: '/repo/packages/app/src/x.ts',
        }),
      ).toEqual({ status: 'valid', paths: ['packages/app/src/x.ts'], normalized_patch: undefined });
    });

    it('rewrites an absolute path inside cwd to the same cwd-relative form a relative path would use', () => {
      expect(
        structuredEditCwdRelativePath({
          repositoryRoot: '/repo',
          cwd: '/repo/packages/app',
          path: '/repo/packages/app/src/new.ts',
        }),
      ).toBe('src/new.ts');
      expect(structuredEditCwdRelativePath({ repositoryRoot: '/repo', cwd: '/repo', path: 'src/new.ts' })).toBe(
        'src/new.ts',
      );
    });

    it('rejects an absolute path inside the repository root but above cwd, the same as a relative "../x"', () => {
      const aboveCwd = extractStructuredEditPaths({
        kind: 'write_file',
        repositoryRoot: '/repo',
        cwd: '/repo/packages/app',
        path: '/repo/other/file.ts',
      });
      const relativeTraversal = extractStructuredEditPaths({
        kind: 'write_file',
        repositoryRoot: '/repo',
        cwd: '/repo/packages/app',
        path: '../other/file.ts',
      });
      expect(aboveCwd.status).toBe('invalid');
      expect(relativeTraversal.status).toBe('invalid');
    });

    it('rejects an absolute path outside the effective root', () => {
      expect(
        extractStructuredEditPaths({
          kind: 'write_file',
          repositoryRoot: '/repo',
          cwd: '/repo',
          path: '/etc/passwd',
        }).status,
      ).toBe('invalid');
      expect(
        structuredEditCwdRelativePath({ repositoryRoot: '/repo', cwd: '/repo', path: '/etc/passwd' }),
      ).toBeUndefined();
    });

    it('leaves Windows-style paths unaffected against a POSIX-style workspace', () => {
      expect(
        extractStructuredEditPaths({
          kind: 'write_file',
          repositoryRoot: '/repo',
          cwd: '/repo',
          path: 'C:\\outside.ts',
        }).status,
      ).toBe('invalid');
      expect(
        extractStructuredEditPaths({
          kind: 'write_file',
          repositoryRoot: '/repo',
          cwd: '/repo',
          path: 'src\\ambiguous.ts',
        }).status,
      ).toBe('invalid');
    });

    it('accepts an absolute Windows-style path inside a Windows-style workspace', () => {
      expect(
        extractStructuredEditPaths({
          kind: 'write_file',
          repositoryRoot: 'C:\\repo',
          cwd: 'C:\\repo\\packages\\app',
          path: 'C:\\repo\\packages\\app\\src\\new.ts',
        }),
      ).toEqual({ status: 'valid', paths: ['packages/app/src/new.ts'], normalized_patch: undefined });
    });
  });
});
