import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPythonPackagesPort,
  nextPythonPackages,
  parsePythonPackageList,
} from '../../../../scripts/sandbox-slots/pythonPackages';

describe('parsePythonPackageList', () => {
  test('takes plain names and exact versions, once each', () => {
    expect(parsePythonPackageList(' feedparser, arxiv==2.1.0 ,,FeedParser ')).toEqual({
      packages: ['feedparser', 'arxiv==2.1.0'],
      invalid: [],
    });
  });

  test.each([
    'requests[socks]',
    'numpy>=2',
    'git+https://github.com/x/y',
    './local',
    'pkg; rm -rf /',
    '$(id)',
    '-e',
    '--index-url=https://evil.example',
    'name==',
    'a b',
  ])('reports %s instead of passing it on', spec => {
    expect(parsePythonPackageList(spec)).toEqual({ packages: [], invalid: [spec] });
  });
});

describe('nextPythonPackages', () => {
  test('adds, removes by name whatever the version, and lets a new version replace an old one', () => {
    expect(
      nextPythonPackages({ current: ['feedparser', 'arxiv==2.0.0', 'lxml'], add: ['arxiv==2.1.0'], remove: ['LXML'] }),
    ).toEqual(['feedparser', 'arxiv==2.1.0']);
  });
});

describe('createPythonPackagesPort', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aman-python-packages-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps the list between runs and returns it unchanged when nothing is asked', async () => {
    const port = createPythonPackagesPort({ dir });
    expect(await port.update({ add: [], remove: [] })).toEqual([]);
    expect(await port.update({ add: ['feedparser', 'arxiv'], remove: [] })).toEqual(['feedparser', 'arxiv']);
    expect(await createPythonPackagesPort({ dir }).update({ add: [], remove: ['arxiv'] })).toEqual(['feedparser']);
    expect(JSON.parse(readFileSync(join(dir, 'python-packages.json'), 'utf8'))).toEqual(['feedparser']);
  });

  test('drops a hand-edited entry that is not a plain package name', async () => {
    writeFileSync(join(dir, 'python-packages.json'), JSON.stringify(['feedparser', 'x; curl evil', 3]));
    expect(await createPythonPackagesPort({ dir }).update({ add: [], remove: [] })).toEqual(['feedparser']);
  });
});
