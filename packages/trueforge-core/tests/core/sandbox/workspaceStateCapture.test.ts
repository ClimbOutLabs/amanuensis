import { parseTrackedWorktreeListing } from '../../../src/core/sandbox/workspaceStateCapture';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function index(entries: readonly [mode: string, path: string][]): string {
  return entries.map(([mode, path]) => `${mode} ${SHA_A} 0\t${path}\0`).join('');
}

function conflictIndex(path: string): string {
  return ['1', '2', '3'].map(stage => `100644 ${SHA_A} ${stage}\t${path}\0`).join('');
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

  it('accepts a conflicted path listed once per index stage', () => {
    expect(
      parseTrackedWorktreeListing({
        listing: `f\0c.txt\0\0f\0c.txt\0\0f\0c.txt\0\0H\0${SHA_B}\n${SHA_B}\n${SHA_B}\n\0`,
        indexEntries: conflictIndex('c.txt'),
      }),
    ).toEqual([{ path: 'c.txt', kind: 'f', value: SHA_B }]);
  });

  it.each([
    [
      'an index path that lost bytes in decoding',
      { listing: `f\0x\uFFFD\0\0H\0${SHA_A}\n\0`, indexEntries: index([['100644', 'x\uFFFD']]) },
    ],
    [
      'a listed path that lost bytes in decoding',
      { listing: `f\0a\uFFFD\0\0H\0${SHA_A}\n\0`, indexEntries: index([['100644', 'a.txt']]) },
    ],
    [
      'two index entries that decode to one name',
      {
        listing: `f\0x\0\0f\0x\0\0H\0${SHA_A}\n${SHA_B}\n\0`,
        indexEntries: index([
          ['100644', 'x'],
          ['100644', 'x'],
        ]),
      },
    ],
    [
      'a path listed more often than the index holds it',
      { listing: `f\0x\0\0f\0x\0\0H\0${SHA_A}\n${SHA_B}\n\0`, indexEntries: index([['100644', 'x']]) },
    ],
  ])('rejects %s', (_name, input) => {
    expect(parseTrackedWorktreeListing(input)).toBeUndefined();
  });
});
