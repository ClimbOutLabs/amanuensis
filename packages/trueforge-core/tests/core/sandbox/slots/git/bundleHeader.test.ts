import { parseBundleHeader } from '../../../../../src/core/sandbox/slots/git/bundleHeader';
import { pushDiffProblem } from '../../../../../src/core/sandbox/slots/git/pushChecks';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function bundle(lines: string[]): Buffer {
  return Buffer.from(`${lines.join('\n')}\n\nPACKDATA`, 'latin1');
}

describe('parseBundleHeader', () => {
  test('reads prerequisites and refs', () => {
    const result = parseBundleHeader(bundle(['# v2 git bundle', `-${A} comment`, `${B} refs/heads/main`]));
    expect(result).toEqual({
      ok: true,
      header: { prerequisites: [A], refs: [{ name: 'refs/heads/main', oid: B }] },
    });
  });

  test('accepts the sha1 object format capability of a v3 bundle and nothing else', () => {
    expect(parseBundleHeader(bundle(['# v3 git bundle', '@object-format=sha1', `${B} refs/heads/main`])).ok).toBe(true);
    expect(parseBundleHeader(bundle(['# v3 git bundle', '@object-format=sha256', `${B} refs/heads/main`])).ok).toBe(
      false,
    );
    expect(parseBundleHeader(bundle(['# v3 git bundle', '@filter=blob:none', `${B} refs/heads/main`])).ok).toBe(false);
  });

  test.each([
    ['not a bundle', ['hello', `${B} refs/heads/main`]],
    ['a malformed prerequisite', ['# v2 git bundle', '-zzz comment', `${B} refs/heads/main`]],
    ['a malformed ref', ['# v2 git bundle', 'refs/heads/main']],
    ['a control character in a ref name', ['# v2 git bundle', `${B} refs/heads/ma\u0001in`]],
  ])('refuses %s', (_name, lines) => {
    expect(parseBundleHeader(bundle(lines)).ok).toBe(false);
  });

  test('refuses a header with no end', () => {
    expect(parseBundleHeader(Buffer.from('# v2 git bundle\nno blank line', 'latin1')).ok).toBe(false);
  });
});

describe('pushDiffProblem', () => {
  const entry = (oldMode: string, newMode: string, path: string): string =>
    `:${oldMode} ${newMode} ${'0'.repeat(40)} ${A} M\0${path}\0`;

  test('passes ordinary changes', () => {
    expect(
      pushDiffProblem(`\u0001${B}\0\n${entry('100644', '100644', 'src/a.ts')}${entry('000000', '100755', 'run.sh')}`),
    ).toBeUndefined();
  });

  test('refuses a gitlink in either direction', () => {
    expect(pushDiffProblem(`\u0001${B}\0\n${entry('000000', '160000', 'vendor/lib')}`)).toContain('submodule');
    expect(pushDiffProblem(`\u0001${B}\0\n${entry('160000', '000000', 'vendor/lib')}`)).toContain('submodule');
  });

  test('refuses .gitmodules at the root or in a subdirectory', () => {
    expect(pushDiffProblem(`\u0001${B}\0\n${entry('100644', '100644', '.gitmodules')}`)).toContain('.gitmodules');
    expect(pushDiffProblem(`\u0001${B}\0\n${entry('100644', '100644', 'x/.gitmodules')}`)).toContain('.gitmodules');
  });

  test('a file name that looks like an entry is not read as one', () => {
    const decoy = entry('100644', '100644', ':160000 160000 x y M');
    expect(pushDiffProblem(`\u0001${B}\0\n${decoy}`)).toBeUndefined();
  });

  test('finds the problem in a later commit', () => {
    const log = `\u0001${B}\0\n${entry('100644', '100644', 'a')}\u0001${A}\0\n${entry('000000', '160000', 'sub')}`;
    expect(pushDiffProblem(log)).toContain('submodule');
  });
});
