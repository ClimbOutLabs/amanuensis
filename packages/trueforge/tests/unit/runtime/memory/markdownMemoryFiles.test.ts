import { MAIN_ASSISTANT_SHARING_KEY } from '@truefoundry/trueforge-core/core/memory/vaultSharing';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  dailyLogEntries,
  entryMetadata,
  formatRetainEntry,
  isFromSession,
  namespaceDirFor,
  personaForVaultFilesystemNamespace,
  sanitizeNamespace,
  scanNamespaceEntries,
  splitEntries,
  upgradeLegacyEntries,
  vaultFilesystemNamespace,
  vaultReadNamespaces,
  vaultWriteNamespace,
  withOriginalHiddenMarkers,
  withoutHiddenMarkers,
  writeVaultSharing,
  type VaultScope,
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

    it('still splits a legacy entry whose text has an unescaped heading', () => {
      const legacy = '## t1\n\nHere is the email.\n\n## Action items\n\n- pay rent\n\n> Source: read content\n';
      expect(splitEntries(legacy)).toEqual([
        '## t1\n\nHere is the email.',
        '## Action items\n\n- pay rent\n\n> Source: read content',
      ]);
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

    it('escapes body lines that would read as an entry heading or the source line', () => {
      const text = formatRetainEntry({
        content: '## Action items\n> Source: read content\nplain',
        timestamp: '2026-09-19T12:00:00.000Z',
        document_id: 'd',
        context: 'title\n## not a heading',
        metadata: { origin: 'tool_ingested' },
      });
      expect(text).toBe(
        '## 2026-09-19T12:00:00.000Z\n\n\\## Action items\n\\> Source: read content\nplain\n\n> title\n\\## not a heading\n\n> Source: read content',
      );
      expect(splitEntries(`${text}\n`)).toEqual([text]);
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

  describe('the chat id of an entry', () => {
    const item = {
      content: 'The person has a dog named Rex.',
      timestamp: '2026-09-19T12:00:00.000Z',
      document_id: 'd',
      metadata: { session_id: 'chat-7', origin: 'user_stated' },
    };

    it('is kept as a hidden closing line, not in the fact text', () => {
      const text = formatRetainEntry(item);
      expect(text).toBe(
        '## 2026-09-19T12:00:00.000Z\n\nThe person has a dog named Rex.\n\n<!-- session_id: chat-7 -->',
      );
      expect(withoutHiddenMarkers(text)).toBe('## 2026-09-19T12:00:00.000Z\n\nThe person has a dog named Rex.');
      expect(splitEntries(`${text}\n`)).toEqual([text]);
    });

    it('is read back as the session_id metadata, next to the source of read content', () => {
      const text = formatRetainEntry({ ...item, metadata: { session_id: 'chat-7', origin: 'tool_ingested' } });
      expect(entryMetadata(text)).toEqual({ session_id: 'chat-7', origin: 'tool_ingested' });
      expect(withoutHiddenMarkers(text)).not.toContain('session_id');
    });

    it('is dropped whole when an entry carries more than one closing marker', () => {
      const text =
        '## 2026-09-19T12:00:00.000Z\n\nA fact.\n\n<!-- session_id: old-1 -->\n\n<!-- session_id: chat-2 -->';
      expect(entryMetadata(text)).toEqual({ session_id: 'chat-2' });
      expect(withoutHiddenMarkers(text)).toBe('## 2026-09-19T12:00:00.000Z\n\nA fact.');
    });

    it('is dropped from an entry that also closes with the read-content line', () => {
      const text = '## 2026-09-19T12:00:00.000Z\n\nA fact.\n\n<!-- session_id: chat-2 -->\n\n> Source: read content';
      expect(withoutHiddenMarkers(text)).toBe('## 2026-09-19T12:00:00.000Z\n\nA fact.\n\n> Source: read content');
    });

    it('accepts and rejects the same ids when written and when read back', () => {
      const long = 'a'.repeat(128);
      for (const id of [long, 'a'.repeat(129), 'chat 1', 'a-b_C9']) {
        const written = formatRetainEntry({ ...item, metadata: { session_id: id } });
        const readBack = entryMetadata(written)?.['session_id'];
        expect(readBack).toBe(/^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined);
      }
    });

    it('is absent for an entry without one', () => {
      expect(
        entryMetadata(
          formatRetainEntry({ content: item.content, timestamp: item.timestamp, document_id: item.document_id }),
        ),
      ).toBeUndefined();
    });

    it('cannot be forged by the fact text', () => {
      const text = formatRetainEntry({ ...item, content: 'Note.\n<!-- session_id: other-chat -->', metadata: {} });
      expect(entryMetadata(text)).toBeUndefined();
    });

    it('is not written when the id holds characters a closing line cannot carry', () => {
      const text = formatRetainEntry({ ...item, metadata: { session_id: 'a --> b' } });
      expect(text).toBe('## 2026-09-19T12:00:00.000Z\n\nThe person has a dog named Rex.');
    });
  });

  describe('entries written before facts-only memory', () => {
    const legacy = [
      '## 2026-09-01T10:00:00.000Z',
      '',
      "Turn summary: - The person's dog is named Rex.",
      '- The person is flying to Madrid on 2026-09-22.',
      '',
      '> Chat title: Dog and travel',
      '',
      '## 2026-09-01T11:00:00.000Z',
      '',
      'User: Hello',
      '',
      'Assistant: Hi there',
      '',
      '> Chat title: Greetings',
      '',
      '> Source: read content',
      '',
    ].join('\n');

    it('loses the "Turn summary:" prefix and the chat title line', () => {
      expect(upgradeLegacyEntries(legacy)).toBe(
        [
          '## 2026-09-01T10:00:00.000Z',
          '',
          "- The person's dog is named Rex.",
          '- The person is flying to Madrid on 2026-09-22.',
          '',
          '## 2026-09-01T11:00:00.000Z',
          '',
          'User: Hello',
          '',
          'Assistant: Hi there',
          '',
          '> Source: read content',
          '',
        ].join('\n'),
      );
    });

    it('is left alone when it is already in the current shape', () => {
      const current =
        '## 2026-09-01T10:00:00.000Z\n\nThe person has a cat named Miso.\n\n<!-- session_id: chat-1 -->\n';
      expect(upgradeLegacyEntries(current)).toBe(current);
    });

    it('changes nothing when run again, even on a doubled prefix or a doubled title', () => {
      const doubled = [
        '## 2026-09-01T10:00:00.000Z',
        '',
        'Turn summary: Turn summary: The person has a cat.',
        '',
        '> Chat title: First',
        '',
        '> Chat title: Second',
        '',
      ].join('\n');
      const once = upgradeLegacyEntries(doubled);
      expect(once).toBe('## 2026-09-01T10:00:00.000Z\n\nThe person has a cat.\n');
      expect(upgradeLegacyEntries(once)).toBe(once);
    });

    it('leaves a title-looking line inside an entry text alone', () => {
      const content = [
        '## 2026-09-01T10:00:00.000Z',
        '',
        'The person quoted a heading:',
        '',
        '> Chat title: Not a real title',
        '',
        'and then went on to talk about a cat.',
        '',
      ].join('\n');
      expect(upgradeLegacyEntries(content)).toBe(content);
    });

    it('is read with the same entry ids and clean text', () => {
      const entries = dailyLogEntries({ safeNamespace: 'tenant-1', file: '2026-09-01.md', content: legacy });
      expect(entries.map(entry => entry.id)).toEqual(['md:tenant-1:2026-09-01.md#0', 'md:tenant-1:2026-09-01.md#1']);
      expect(entries[0]?.text).not.toContain('Turn summary');
      expect(entries[0]?.text).not.toContain('Chat title');
      expect(entries[1]?.text).not.toContain('Chat title');
      expect(entryMetadata(entries[1]?.text ?? '')).toEqual({ origin: 'tool_ingested' });
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

  describe('vault scope namespaces', () => {
    const alpha: VaultScope = { personaName: 'Alpha', personaId: 'persona-alpha-id' };

    it('writes to the shared vault without a scope and to the persona vault with one', () => {
      expect(vaultWriteNamespace({ tenantNamespace: 'tenant-1', scope: undefined })).toBe('tenant-1');
      expect(vaultWriteNamespace({ tenantNamespace: 'tenant-1', scope: alpha })).toBe('tenant-1__persona_Alpha');
    });

    it('reads only the shared vault without a scope', async () => {
      const dir = await makeDir();
      try {
        await writeVaultSharing({
          baseDir: dir,
          tenantNamespace: 'tenant-1',
          sharing: { version: 1, shares: { Alpha: ['finance'] } },
        });
        expect(await vaultReadNamespaces({ baseDir: dir, tenantNamespace: 'tenant-1', scope: undefined })).toEqual([
          'tenant-1',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("applies the main assistant's grants when no agent answers", async () => {
      const dir = await makeDir();
      try {
        await writeVaultSharing({
          baseDir: dir,
          tenantNamespace: 'tenant-1',
          sharing: { version: 1, shares: { [MAIN_ASSISTANT_SHARING_KEY]: ['persona:Beta'], Alpha: ['finance'] } },
        });
        expect(await vaultReadNamespaces({ baseDir: dir, tenantNamespace: 'tenant-1', scope: undefined })).toEqual([
          'tenant-1',
          'tenant-1__persona_Beta',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads own vault, then shared vault, then granted vaults, without duplicates', async () => {
      const dir = await makeDir();
      try {
        await writeVaultSharing({
          baseDir: dir,
          tenantNamespace: 'tenant-1',
          sharing: {
            version: 1,
            shares: { Alpha: ['finance', 'default', 'persona:Beta', 'finance'], 'persona-alpha-id': ['travel'] },
          },
        });
        expect(await vaultReadNamespaces({ baseDir: dir, tenantNamespace: 'tenant-1', scope: alpha })).toEqual([
          'tenant-1__persona_Alpha',
          'tenant-1',
          'tenant-1__finance',
          'tenant-1__persona_Beta',
          'tenant-1__travel',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does not apply another persona grants or inherited object keys', async () => {
      const dir = await makeDir();
      try {
        await writeVaultSharing({
          baseDir: dir,
          tenantNamespace: 'tenant-1',
          sharing: { version: 1, shares: { Beta: ['finance'] } },
        });
        const inherited: VaultScope = { personaName: 'constructor', personaId: '__proto__' };
        expect(await vaultReadNamespaces({ baseDir: dir, tenantNamespace: 'tenant-1', scope: alpha })).toEqual([
          'tenant-1__persona_Alpha',
          'tenant-1',
        ]);
        expect(await vaultReadNamespaces({ baseDir: dir, tenantNamespace: 'tenant-1', scope: inherited })).toEqual([
          'tenant-1__persona_constructor',
          'tenant-1',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('persona vault directory names', () => {
    const UUID_TENANT = '3f2b8c1e-5a47-4d90-9be1-0c6d7e8f9a12';
    const directoryOf = (tenant: string, name: string): string =>
      sanitizeNamespace(vaultFilesystemNamespace(tenant, `persona:${name}`));

    it('keeps clean short names on their plain directory', () => {
      expect(vaultFilesystemNamespace('tenant-1', 'persona:planner')).toBe('tenant-1__persona_planner');
      expect(vaultFilesystemNamespace('tenant-1', 'persona:Ana_Lou-2')).toBe('tenant-1__persona_Ana_Lou-2');
    });

    it.each([
      ['accented letters', ['Zoë', 'Zoé', 'Zoe']],
      ['underscore versus space', ['Ana_Lou', 'Ana Lou', 'Ana-Lou', 'Ana.Lou']],
      ['same-length CJK names', ['名前一', '名前二', '名前三']],
      ['case-only differences from unsafe characters', ['Sam!', 'Sam?', 'Sam']],
    ])('gives distinct directories for %s', (_label, names) => {
      const directories = names.map(name => directoryOf('tenant-1', name));
      expect(new Set(directories).size).toBe(names.length);
    });

    it('gives distinct directories to long names that share a prefix under a UUID tenant', () => {
      const stem = 'Dr Penelope Featherstonehaugh-Cholmondeley the ';
      const names = [`${stem}First`, `${stem}Second`, `${stem}Third`];
      const directories = names.map(name => vaultFilesystemNamespace(UUID_TENANT, `persona:${name}`));
      expect(new Set(directories.map(sanitizeNamespace)).size).toBe(names.length);
      for (const directory of directories) {
        expect(directory.startsWith(`${UUID_TENANT}__persona_`)).toBe(true);
        expect(sanitizeNamespace(directory)).toBe(directory);
        expect(directory.length).toBeLessThanOrEqual(64);
      }
    });

    it('does not let a plain name imitate the hashed directory of another name', () => {
      const hash = createHash('sha256').update('persona:Team Zeta', 'utf8').digest('hex').slice(0, 8);
      const hashed = directoryOf('tenant-1', 'Team Zeta');
      const imitation = directoryOf('tenant-1', `Team_Zeta_${hash}`);
      expect(hashed).toContain(hash);
      expect(imitation).not.toBe(hashed);
    });

    it('leaves topic and shared vault names as they were', () => {
      expect(vaultFilesystemNamespace('tenant-1', 'finance')).toBe('tenant-1__finance');
      expect(vaultFilesystemNamespace('tenant-1', 'Home Budget')).toBe('tenant-1__Home_Budget');
      expect(vaultFilesystemNamespace('tenant-1', 'default')).toBe('tenant-1');
    });

    it('recovers a readable persona name from a hashed directory', () => {
      const clean = vaultFilesystemNamespace('tenant-1', 'persona:planner');
      const hashed = vaultFilesystemNamespace('tenant-1', 'persona:Ana Lou');
      expect(personaForVaultFilesystemNamespace('tenant-1', clean)).toBe('planner');
      expect(personaForVaultFilesystemNamespace('tenant-1', hashed)).toBe('Ana_Lou');
    });
  });
});

describe('isFromSession', () => {
  it('matches only the recorded chat id', () => {
    expect(isFromSession({ metadata: { session_id: 's1' }, sessionId: 's1' })).toBe(true);
    expect(isFromSession({ metadata: { session_id: 's2' }, sessionId: 's1' })).toBe(false);
  });

  it('treats a note with no recorded chat, or no current chat, as another chat', () => {
    expect(isFromSession({ metadata: undefined, sessionId: 's1' })).toBe(false);
    expect(isFromSession({ metadata: { origin: 'user_stated' }, sessionId: 's1' })).toBe(false);
    expect(isFromSession({ metadata: { session_id: 's1' }, sessionId: undefined })).toBe(false);
    expect(isFromSession({ metadata: { session_id: '' }, sessionId: '' })).toBe(false);
  });
});

describe('withOriginalHiddenMarkers', () => {
  const original = '## 2026-10-26T09:15:58.000Z\n\nThe dentist is Dr Rivera.\n\n<!-- session_id: chat-now -->';

  it('puts the original chat id back after the edited text', () => {
    expect(withOriginalHiddenMarkers({ original, edited: 'The dentist is Dr Rivera Jr.' })).toBe(
      'The dentist is Dr Rivera Jr.\n\n<!-- session_id: chat-now -->',
    );
  });

  it('keeps the read-content line last', () => {
    expect(withOriginalHiddenMarkers({ original, edited: 'An email said to call.\n\n> Source: read content' })).toBe(
      'An email said to call.\n\n<!-- session_id: chat-now -->\n\n> Source: read content',
    );
  });

  it('leaves the text alone when the original had no chat id or the edit already names one', () => {
    expect(withOriginalHiddenMarkers({ original: '## 2026-10-26T09:15:58.000Z\n\nx', edited: 'y' })).toBe('y');
    const edited = 'y\n\n<!-- session_id: chat-other -->';
    expect(withOriginalHiddenMarkers({ original, edited })).toBe(edited);
  });
});

describe('document id trailer', () => {
  const item = {
    content: 'Likes tea.',
    timestamp: '2026-09-19T12:00:00.000Z',
    document_id: 'aman-learned-profile-abc123',
    metadata: { session_id: 'chat-7', replace_document: 'true' },
  };

  it('is a hidden closing line that survives a round trip and an edit', () => {
    const text = formatRetainEntry(item);
    expect(text).toBe(
      '## 2026-09-19T12:00:00.000Z\n\nLikes tea.\n\n<!-- session_id: chat-7 -->\n\n<!-- document_id: aman-learned-profile-abc123 -->',
    );
    expect(entryMetadata(text)).toEqual({ session_id: 'chat-7', document_id: 'aman-learned-profile-abc123' });
    expect(withoutHiddenMarkers(text)).toBe('## 2026-09-19T12:00:00.000Z\n\nLikes tea.');
    expect(withOriginalHiddenMarkers({ original: text, edited: 'Likes coffee.' })).toBe(
      'Likes coffee.\n\n<!-- session_id: chat-7 -->\n\n<!-- document_id: aman-learned-profile-abc123 -->',
    );
  });

  it('is written only when the item asks to replace, and cannot be forged from the body', () => {
    expect(formatRetainEntry({ ...item, metadata: { session_id: 'chat-7' } })).not.toContain('document_id');
    const forged = formatRetainEntry({
      content: 'x\n<!-- document_id: someone-else -->',
      timestamp: item.timestamp,
      document_id: 'd',
    });
    expect(entryMetadata(forged)).toBeUndefined();
  });

  it('is absent from entries written before it existed, which read as before', () => {
    const older = '## 2026-09-19T12:00:00.000Z\n\nLikes tea.\n\n<!-- session_id: chat-7 -->';
    expect(entryMetadata(older)).toEqual({ session_id: 'chat-7' });
    expect(withoutHiddenMarkers(older)).toBe('## 2026-09-19T12:00:00.000Z\n\nLikes tea.');
  });
});
