import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import {
  personaForVaultNamespace,
  readVaultSharing,
  readVaultTombstones,
  vaultFilesystemNamespace,
  writeVaultSharing,
} from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { MemoryVaultEntry } from '../../../../src/runtime/memory/memoryClient';

const TIMEOUT_MS = 5000;

async function makeClient(namespace = 'tenant-1'): Promise<{ client: MarkdownMemoryClient; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'vault-'));
  return { client: new MarkdownMemoryClient({ baseDir: dir, namespace }), dir };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function retainTwo(client: MarkdownMemoryClient): Promise<void> {
  const outcome = await client.retain({
    items: [
      { content: 'Prefers morning meetings', timestamp: '2026-09-26T10:00:00.000Z', document_id: 'doc-1' },
      { content: 'Uses metric units', timestamp: '2026-09-26T11:00:00.000Z', document_id: 'doc-2' },
    ],
    operationId: 'op-vault-1',
    timeoutMs: TIMEOUT_MS,
  });
  expect(outcome).toEqual({ ok: true });
}

function entriesOf(outcome: { ok: boolean; entries?: MemoryVaultEntry[] }): MemoryVaultEntry[] {
  expect(outcome.ok).toBe(true);
  expect(outcome.entries).toBeDefined();
  const entries = outcome.entries;
  if (entries === undefined) {
    throw new Error('expected entries on a successful vault outcome');
  }
  return entries;
}

describe('memory vault', () => {
  describe('namespace resolution', () => {
    it('maps the shared vault to the tenant namespace', () => {
      expect(vaultFilesystemNamespace('tenant-1', '')).toBe('tenant-1');
      expect(vaultFilesystemNamespace('tenant-1', 'default')).toBe('tenant-1');
      expect(vaultFilesystemNamespace('tenant-1', undefined)).toBe('tenant-1');
    });

    it('scopes topic and persona vaults under the tenant namespace', () => {
      expect(vaultFilesystemNamespace('tenant-1', 'finance')).toBe('tenant-1__finance');
      expect(vaultFilesystemNamespace('tenant-1', 'persona:planner')).toBe('tenant-1__persona_planner');
    });

    it('derives the owning persona from persona vaults only', () => {
      expect(personaForVaultNamespace('persona:planner')).toBe('planner');
      expect(personaForVaultNamespace('finance')).toBeNull();
      expect(personaForVaultNamespace('')).toBeNull();
      expect(personaForVaultNamespace(undefined)).toBeNull();
    });
  });

  describe('listEntries', () => {
    it('lists retained entries with ids, timestamps, and null persona', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const entries = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(entries).toHaveLength(2);
        expect(entries[0]?.id).toBe('md:tenant-1:2026-09-26.md#0');
        expect(entries[0]?.text).toContain('Prefers morning meetings');
        expect(entries[0]?.timestamp).toBe('2026-09-26T10:00:00.000Z');
        expect(entries[0]?.persona).toBeNull();
      } finally {
        await cleanup(dir);
      }
    });

    it('lists persona vaults with the persona set', async () => {
      const { client, dir } = await makeClient();
      try {
        const personaClient = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-1__persona_planner' });
        await retainTwo(personaClient);
        const entries = entriesOf(await client.listEntries({ namespace: 'persona:planner', timeoutMs: TIMEOUT_MS }));
        expect(entries).toHaveLength(2);
        expect(entries[0]?.persona).toBe('planner');
        expect(entries[0]?.id).toBe('md:tenant-1__persona_planner:2026-09-26.md#0');
      } finally {
        await cleanup(dir);
      }
    });

    it('returns an empty list for a fresh namespace', async () => {
      const { client, dir } = await makeClient();
      try {
        const entries = entriesOf(await client.listEntries({ namespace: 'finance', timeoutMs: TIMEOUT_MS }));
        expect(entries).toEqual([]);
      } finally {
        await cleanup(dir);
      }
    });
  });

  describe('updateEntry', () => {
    it('replaces the text while keeping the id and leaving the daily log untouched', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const before = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        const id = before[0]?.id ?? '';
        const logPath = path.join(dir, 'tenant-1', 'memory', '2026-09-26.md');
        const logBefore = await readFile(logPath, 'utf8');

        const updated = await client.updateEntry({ entryId: id, text: 'Lives in Barcelona', timeoutMs: TIMEOUT_MS });
        expect(updated.ok).toBe(true);
        if (updated.ok) {
          expect(updated.entry.id).toBe(id);
          expect(updated.entry.text).toBe('Lives in Barcelona');
        }

        // The daily log is append-only: no marker inside it.
        expect(await readFile(logPath, 'utf8')).toBe(logBefore);
        // The marker lives in the append-only marker file.
        const markers = await readVaultTombstones({ baseDir: dir, namespace: 'tenant-1' });
        expect(markers).toHaveLength(1);
        expect(markers[0]).toMatchObject({ entryId: id, action: 'updated', text: 'Lives in Barcelona' });

        const after = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(after).toHaveLength(2);
        expect(after.find(entry => entry.id === id)?.text).toBe('Lives in Barcelona');
        // The untouched entry keeps its original text and timestamp.
        expect(after.find(entry => entry.id !== id)?.text).toContain('Uses metric units');
      } finally {
        await cleanup(dir);
      }
    });

    it('keeps indices stable: a later retain still appends at the next index', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const before = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        await client.updateEntry({ entryId: before[0]?.id ?? '', text: 'edited', timeoutMs: TIMEOUT_MS });
        await client.retain({
          items: [{ content: 'Third fact', timestamp: '2026-09-26T12:00:00.000Z', document_id: 'doc-3' }],
          operationId: 'op-vault-2',
          timeoutMs: TIMEOUT_MS,
        });
        const after = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(after.map(entry => entry.id)).toEqual([
          'md:tenant-1:2026-09-26.md#0',
          'md:tenant-1:2026-09-26.md#1',
          'md:tenant-1:2026-09-26.md#2',
        ]);
      } finally {
        await cleanup(dir);
      }
    });

    it('round-trips replacement text containing markdown headings', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const before = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        const id = before[0]?.id ?? '';
        const tricky = 'Line one\n\n## not a real heading\n\nLine two';
        const updated = await client.updateEntry({ entryId: id, text: tricky, timeoutMs: TIMEOUT_MS });
        expect(updated.ok).toBe(true);
        const after = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(after.find(entry => entry.id === id)?.text).toBe(tricky);
      } finally {
        await cleanup(dir);
      }
    });

    it('round-trips replacement text containing fenced code blocks', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const before = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        const id = before[0]?.id ?? '';
        const hostile =
          '```\nplain triple backticks\n```\n\n```vault-text\nnot a real fence\n```\n\n> vault-entry 0 deleted\n\n## and a heading';
        const updated = await client.updateEntry({ entryId: id, text: hostile, timeoutMs: TIMEOUT_MS });
        expect(updated.ok).toBe(true);
        const after = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(after.find(entry => entry.id === id)?.text).toBe(hostile);
      } finally {
        await cleanup(dir);
      }
    });

    it('rejects empty text and unknown ids', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const before = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        const empty = await client.updateEntry({ entryId: before[0]?.id ?? '', text: '   ', timeoutMs: TIMEOUT_MS });
        expect(empty).toMatchObject({ ok: false, code: 'request_failed' });

        const missing = await client.updateEntry({
          entryId: 'md:tenant-1:2026-09-26.md#99',
          text: 'nope',
          timeoutMs: TIMEOUT_MS,
        });
        expect(missing).toMatchObject({ ok: false, code: 'not_found' });
      } finally {
        await cleanup(dir);
      }
    });

    it('refuses entry ids outside the tenant scope', async () => {
      const { client, dir } = await makeClient('tenant-1');
      const other = new MarkdownMemoryClient({ baseDir: dir, namespace: 'tenant-2' });
      try {
        await retainTwo(other);
        const outcome = await client.updateEntry({
          entryId: 'md:tenant-2:2026-09-26.md#0',
          text: 'hijack',
          timeoutMs: TIMEOUT_MS,
        });
        expect(outcome).toMatchObject({ ok: false, code: 'not_found' });
        const entries = entriesOf(await other.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(entries[0]?.text).toContain('Prefers morning meetings');
      } finally {
        await cleanup(dir);
      }
    });
  });

  describe('deleteEntry', () => {
    it('hides the entry from listings and recall, and is idempotent', async () => {
      const { client, dir } = await makeClient();
      try {
        await retainTwo(client);
        const before = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        const id = before[0]?.id ?? '';

        expect(await client.deleteEntry({ entryId: id, timeoutMs: TIMEOUT_MS })).toEqual({ ok: true });
        // Second delete still succeeds.
        expect(await client.deleteEntry({ entryId: id, timeoutMs: TIMEOUT_MS })).toEqual({ ok: true });

        const after = entriesOf(await client.listEntries({ namespace: '', timeoutMs: TIMEOUT_MS }));
        expect(after).toHaveLength(1);
        expect(after[0]?.text).toContain('Uses metric units');

        // Recall no longer surfaces the deleted fact.
        const recall = await client.recall({
          query: 'meetings',
          maxTokens: 1000,
          queryTimestamp: new Date().toISOString(),
          entityTokens: 0,
          timeoutMs: TIMEOUT_MS,
        });
        expect(recall.ok).toBe(true);
        if (recall.ok) {
          expect(recall.results.some(item => item.id === id)).toBe(false);
        }

        // Updating a deleted entry fails as not found.
        const updated = await client.updateEntry({ entryId: id, text: 'resurrect', timeoutMs: TIMEOUT_MS });
        expect(updated).toMatchObject({ ok: false, code: 'not_found' });
      } finally {
        await cleanup(dir);
      }
    });

    it('returns not_found for unknown ids', async () => {
      const { client, dir } = await makeClient();
      try {
        const outcome = await client.deleteEntry({
          entryId: 'md:tenant-1:2026-09-26.md#42',
          timeoutMs: TIMEOUT_MS,
        });
        expect(outcome).toMatchObject({ ok: false, code: 'not_found' });
      } finally {
        await cleanup(dir);
      }
    });
  });

  describe('vault sharing', () => {
    it('round-trips the sharing config and defaults to empty', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'vault-share-'));
      try {
        expect(await readVaultSharing({ baseDir: dir, tenantNamespace: 'tenant-1' })).toEqual({
          version: 1,
          shares: {},
        });
        await writeVaultSharing({
          baseDir: dir,
          tenantNamespace: 'tenant-1',
          sharing: { version: 1, shares: { planner: ['work'], coach: ['health'] } },
        });
        expect(await readVaultSharing({ baseDir: dir, tenantNamespace: 'tenant-1' })).toEqual({
          version: 1,
          shares: { planner: ['work'], coach: ['health'] },
        });
      } finally {
        await cleanup(dir);
      }
    });
  });
});
