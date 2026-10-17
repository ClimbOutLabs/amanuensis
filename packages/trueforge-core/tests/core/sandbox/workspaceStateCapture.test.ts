import { parseTrackedWorktreeListing } from '../../../src/core/sandbox/workspaceStateCapture';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function index(entries: readonly [mode: string, path: string][]): string {
  return entries.map(([mode, path]) => `${mode} ${SHA_A} 0\t${path}\0`).join('');
}

describe('parseTrackedWorktreeListing', () => {
  it('pairs each regular file with its batch hash and keeps symlink targets and missing paths', () => {
    const listing = `f\0a.txt\0\0l\0link\0a.txt\n\0m\0gone.txt\0\0x\0run.sh\0\0H\0${SHA_A}\n${SHA_B}\n\0`;
    expect(
      parseTrackedWorktreeListing({
        listing,
        indexEntries: index([
          ['100644', 'a.txt'],
          ['120000', 'link'],
          ['100644', 'gone.txt'],
          ['100755', 'run.sh'],
        ]),
      }),
    ).toEqual([
      { path: 'a.txt', kind: 'f', value: SHA_A },
      { path: 'link', kind: 'l', value: 'a.txt\n' },
      { path: 'gone.txt', kind: 'm', value: '' },
      { path: 'run.sh', kind: 'x', value: SHA_B },
    ]);
  });

  it('leaves submodules out, as the capture ignores them', () => {
    expect(
      parseTrackedWorktreeListing({
        listing: 'd\0vendor/lib\0\0',
        indexEntries: index([['160000', 'vendor/lib']]),
      }),
    ).toEqual([]);
  });

  it.each([
    ['a hash count that does not match the batch', `f\0a.txt\0\0H\0\0`],
    ['a listing that misses an index path', ''],
    ['a truncated listing', `f\0a.txt\0`],
    ['output that is not a listing', 'ok'],
  ])('rejects %s', (_name, listing) => {
    expect(parseTrackedWorktreeListing({ listing, indexEntries: index([['100644', 'a.txt']]) })).toBeUndefined();
  });
});
