import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  formatRetainEntry,
  namespaceDirFor,
  sanitizeNamespace,
  scanNamespaceEntries,
  splitEntries,
} from '../../../../src/runtime/memory/markdownMemoryFiles';

async function makeDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mdfiles-'));
}

describe('markdownMemoryFiles', () => {
  describe('sanitizeNamespace', () => {
    it('collapses traversal and unsafe characters to underscores', () => {
      expect(sanitizeNamespace('../../etc/passwd')).toBe('______etc_passwd');
      expect(sanitizeNamespace('tenant 1!')).toBe('tenant_1_');
    });

    it('keeps safe characters and falls back to default', () => {
      expect(sanitizeNamespace('tenant-1_ABC')).toBe('tenant-1_ABC');
      expect(sanitizeNamespace('')).toBe('default');
      expect(sanitizeNamespace('!!!')).toBe('___');
    });
  });

  describe('splitEntries', () => {
    it('splits on ## headings and trims', () => {
      const entries = splitEntries('## t1\n\nbody one\n\n## t2\n\nbody two\n');
      expect(entries).toEqual(['## t1\n\nbody one', '## t2\n\nbody two']);
    });

    it('treats unheaded content as one entry', () => {
      expect(splitEntries('just some notes\n')).toEqual(['just some notes']);
    });

    it('drops empty parts', () => {
      expect(splitEntries('')).toEqual([]);
    });
  });

  describe('formatRetainEntry', () => {
    it('round-trips byte-identically through splitEntries', async () => {
      const dir = await makeDir();
      try {
        const item = {
          content: 'Alex booked SFO→ORD→MAD for Sep 22',
          timestamp: '2026-09-19T12:00:00.000Z',
          document_id: 'doc-1',
          context: 'trip planning',
        };
        // Mirror MarkdownMemoryClient.retain's append format exactly.
        const block = formatRetainEntry(item);
        await writeFile(path.join(dir, 'log.md'), `${block}\n`, 'utf8');
        const entries = splitEntries(await readFile(path.join(dir, 'log.md'), 'utf8'));
        expect(entries).toEqual([block]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('omits the context line when there is none', () => {
      const text = formatRetainEntry({
        content: 'hello',
        timestamp: '2026-09-19T12:00:00.000Z',
        document_id: 'd',
      });
      expect(text).toBe('## 2026-09-19T12:00:00.000Z\n\nhello');
    });
  });

  describe('scanNamespaceEntries', () => {
    it('reads MEMORY.md and daily logs newest-first with stable ids', async () => {
      const dir = await makeDir();
      try {
        const nsDir = namespaceDirFor(dir, 'tenant-1');
        await mkdir(path.join(nsDir, 'memory'), { recursive: true });
        await writeFile(path.join(nsDir, 'MEMORY.md'), '# curated\n\nLong-term notes.\n', 'utf8');
        await writeFile(path.join(nsDir, 'memory', '2026-09-18.md'), '## 2026-09-18T10:00:00.000Z\n\nolder\n', 'utf8');
        await writeFile(
          path.join(nsDir, 'memory', '2026-09-19.md'),
          '## 2026-09-19T10:00:00.000Z\n\nnewer one\n\n## 2026-09-19T11:00:00.000Z\n\nnewer two\n',
          'utf8',
        );

        const scan = await scanNamespaceEntries({ baseDir: dir, namespace: 'tenant-1', maxDailyFiles: 14 });
        expect(scan.curated).toContain('Long-term notes.');
        expect(scan.entries.map(entry => entry.id)).toEqual([
          'md:tenant-1:2026-09-19.md#0',
          'md:tenant-1:2026-09-19.md#1',
          'md:tenant-1:2026-09-18.md#0',
        ]);
        expect(scan.entries[0]?.text).toContain('newer one');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns empty scan for a fresh namespace', async () => {
      const dir = await makeDir();
      try {
        const scan = await scanNamespaceEntries({ baseDir: dir, namespace: 'new', maxDailyFiles: 14 });
        expect(scan.curated).toBeUndefined();
        expect(scan.entries).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
