import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(readFileSync(join(dir, 'python-packages.txt'), 'utf8')).toBe('feedparser\n');
  });

  test('rewrites a hand-edited file so only plain package names reach the image build', async () => {
    const file = join(dir, 'python-packages.txt');
    writeFileSync(file, 'feedparser\n--index-url https://evil.example/simple\n-e git+https://x/y\nx; curl evil\n');
    expect(await createPythonPackagesPort({ dir }).update({ add: [], remove: [] })).toEqual(['feedparser']);
    expect(readFileSync(file, 'utf8')).toBe('feedparser\n');
  });

  test('writes nothing when there is no list and nothing is asked', async () => {
    expect(await createPythonPackagesPort({ dir }).update({ add: [], remove: [] })).toEqual([]);
    expect(existsSync(join(dir, 'python-packages.txt'))).toBe(false);
  });
});
