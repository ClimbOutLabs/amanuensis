import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allPackFileNames,
  createPacksPort,
  PACK_NAMES,
  PackError,
  parsePackList,
  toPackArch,
  type Download,
} from '../../../../scripts/sandbox-slots/packs';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('parsePackList and toPackArch', () => {
  test('reads a comma list once per name and reports unknown names', () => {
    expect(parsePackList('go, rust,go,')).toEqual({ packs: ['go', 'rust'], unknown: [] });
    expect(parsePackList('go,perl,Rust')).toEqual({ packs: ['go'], unknown: ['perl', 'Rust'] });
  });

  test('knows the two CPUs the packs are built for', () => {
    expect(toPackArch('x86_64\n')).toBe('x86_64');
    expect(toPackArch('aarch64')).toBe('aarch64');
    expect(toPackArch('riscv64')).toBeUndefined();
  });
});

describe('the pinned checksums', () => {
  test('cover every file of every pack for both CPUs, with well-formed digests', async () => {
    const lines = (await readFile(resolve(REPO_ROOT, 'ops/sandbox-slot/packs/SHA256SUMS'), 'utf8'))
      .split('\n')
      .filter(line => line.trim() !== '');
    const sums = new Map<string, string>();
    for (const line of lines) {
      const [sum = '', name = ''] = line.split(/\s+/);
      sums.set(name, sum);
    }
    for (const pack of PACK_NAMES) {
      for (const name of allPackFileNames(pack)) {
        expect(sums.get(name)).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(sums.size).toBe(PACK_NAMES.flatMap(pack => allPackFileNames(pack)).length);
  });
});

describe('createPacksPort', () => {
  let dir: string;
  let downloads: string[];
  const body = 'archive bytes';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'packs-'));
    downloads = [];
    const names = PACK_NAMES.flatMap(pack => allPackFileNames(pack));
    await writeFile(join(dir, 'SHA256SUMS'), names.map(name => `${sha256(body)}  ${name}`).join('\n'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function port(content = body) {
    const download: Download = async ({ url, destination }) => {
      downloads.push(url);
      await writeFile(destination, content);
    };
    return createPacksPort({ dir, download });
  }

  test('adds a pack: downloads each file once, checks it, and remembers the choice', async () => {
    const packs = port();
    expect(await packs.prepare({ add: ['go'], remove: [], arch: 'x86_64' })).toEqual(['go']);
    expect(downloads).toEqual(['https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go1.27.2.linux-amd64.zip']);
    expect(await readdir(join(dir, 'archives'))).toEqual(['go-1.27.2-linux-amd64.zip']);
    expect(await packs.selected()).toEqual(['go']);
    expect(await packs.prepare({ add: [], remove: [], arch: 'x86_64' })).toEqual(['go']);
    expect(downloads).toHaveLength(1);
  });

  test('rust needs its three components for the machine CPU', async () => {
    await port().prepare({ add: ['rust'], remove: [], arch: 'aarch64' });
    expect(downloads.map(url => url.split('/').pop())).toEqual([
      'rustc-1.99.0-aarch64-unknown-linux-gnu.tar.gz',
      'cargo-1.99.0-aarch64-unknown-linux-gnu.tar.gz',
      'rust-std-1.99.0-aarch64-unknown-linux-gnu.tar.gz',
    ]);
  });

  test('java needs no download', async () => {
    expect(await port().prepare({ add: ['java'], remove: [], arch: undefined })).toEqual(['java']);
    expect(downloads).toEqual([]);
  });

  test('a downloaded file that does not match the pinned checksum is thrown away', async () => {
    const error = await port('tampered')
      .prepare({ add: ['go'], remove: [], arch: 'x86_64' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PackError);
    expect(error instanceof Error && error.message).toContain('pinned checksum');
    expect(await readdir(join(dir, 'archives'))).toEqual([]);
    expect(await port().selected()).toEqual([]);
  });

  test('a damaged archive on disk is fetched again', async () => {
    const packs = port();
    await packs.prepare({ add: ['go'], remove: [], arch: 'x86_64' });
    await writeFile(join(dir, 'archives', 'go-1.27.2-linux-amd64.zip'), 'truncated');
    await packs.prepare({ add: [], remove: [], arch: 'x86_64' });
    expect(downloads).toHaveLength(2);
    expect(await readFile(join(dir, 'archives', 'go-1.27.2-linux-amd64.zip'), 'utf8')).toBe(body);
  });

  test('a failed download is reported with what to do, and leaves nothing half written', async () => {
    const failing = createPacksPort({
      dir,
      download: ({ destination }) => writeFile(destination, 'half').then(() => Promise.reject(new Error('HTTP 503'))),
    });
    const error = await failing.prepare({ add: ['rust'], remove: [], arch: 'x86_64' }).catch((e: unknown) => e);
    expect(error instanceof PackError && error.fix).toContain('reach the download site');
    expect(await readdir(join(dir, 'archives'))).toEqual([]);
  });

  test('removing a pack deletes its archives for both CPUs and its choice', async () => {
    const packs = port();
    await packs.prepare({ add: ['go', 'rust'], remove: [], arch: 'x86_64' });
    await writeFile(join(dir, 'archives', 'go-1.27.2-linux-arm64.zip'), body);
    expect(await packs.prepare({ add: [], remove: ['go'], arch: 'x86_64' })).toEqual(['rust']);
    expect((await readdir(join(dir, 'archives'))).sort()).toEqual([
      'cargo-1.99.0-x86_64-unknown-linux-gnu.tar.gz',
      'rust-std-1.99.0-x86_64-unknown-linux-gnu.tar.gz',
      'rustc-1.99.0-x86_64-unknown-linux-gnu.tar.gz',
    ]);
    expect(await packs.selected()).toEqual(['rust']);
  });

  test('a CPU without packs is refused for go and rust, with the way out', async () => {
    const error = await port()
      .prepare({ add: ['go'], remove: [], arch: undefined })
      .catch((e: unknown) => e);
    expect(error instanceof PackError && error.fix).toContain('--remove');
  });

  test('a missing pinned checksum stops the pack', async () => {
    await writeFile(join(dir, 'SHA256SUMS'), '');
    const error = await port()
      .prepare({ add: ['go'], remove: [], arch: 'x86_64' })
      .catch((e: unknown) => e);
    expect(error instanceof PackError && error.message).toContain('no pinned checksum');
  });
});
