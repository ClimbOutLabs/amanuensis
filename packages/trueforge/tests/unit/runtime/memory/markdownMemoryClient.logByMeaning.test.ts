import { readdir, utimes } from 'node:fs/promises';
import path from 'node:path';

import { EmbeddingStore, LOG_VECTORS_FILE } from '../../../../src/runtime/memory/embeddingStore';
import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import {
  askAbout,
  HandChosenModel,
  makeVault,
  markHandled,
  warmLog,
  writeKitNotes,
  type KitNote,
} from './statementTestKit';

const TIMEOUT_MS = 5000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function note({ topic, age, extra = '' }: { topic: number; age: number; extra?: string }): KitNote {
  return { day: daysAgo(age), text: `Remember topic${String(topic)} ${extra}`.trim() };
}

/** A client over a vault, with the log's meaning search warm. */
async function open({ model, notes }: { model: HandChosenModel; notes: KitNote[] }) {
  const vaultDir = await makeVault();
  const ids = await writeKitNotes({ vaultDir, notes });
  // A file changed in the last two seconds is always read again; backdating makes the scan cache do its work.
  const longAgo = new Date(Date.now() - 3_600_000);
  for (const file of await readdir(path.join(vaultDir, 'memory'))) {
    await utimes(path.join(vaultDir, 'memory', file), longAgo, longAgo);
  }
  const embeddings = await warmLog({ vaultDir, model });
  const client = new MarkdownMemoryClient({
    baseDir: path.dirname(vaultDir),
    namespace: path.basename(vaultDir),
    embeddings: () => embeddings,
  });
  return { vaultDir, ids, client };
}

async function recallTexts({ client, query }: { client: MarkdownMemoryClient; query: string }): Promise<string[]> {
  const outcome = await client.recall({
    query,
    maxTokens: 4000,
    timeoutMs: TIMEOUT_MS,
  });
  if (!outcome.ok) {
    throw new Error(outcome.reason);
  }
  return outcome.results.map(item => item.text);
}

describe('the daily log, searched by meaning', () => {
  it('finds a note older than 14 daily files', async () => {
    const notes = [
      note({ topic: 2, age: 40, extra: 'oldest' }),
      ...Array.from({ length: 20 }, (_, n) => note({ topic: [0, 1, 3, 4, 5][n % 5] ?? 0, age: n + 1 })),
    ];
    const { client } = await open({ model: new HandChosenModel(), notes });

    expect(await recallTexts({ client, query: askAbout({ topic: 2, closeness: 1 }) })).toEqual([
      'Remember topic2 oldest',
    ]);
  });

  it('does not show a note for shared words alone when there are 5 or more to judge', async () => {
    const { client } = await open({
      model: new HandChosenModel(),
      notes: [0, 1, 2, 3, 4, 5].map(topic => note({ topic, age: topic + 1 })),
    });

    expect(await recallTexts({ client, query: 'Please remember what I said' })).toEqual([]);
  });

  it('searches by words as before when there are fewer than 5 to judge', async () => {
    const { client } = await open({
      model: new HandChosenModel(),
      notes: [note({ topic: 0, age: 1, extra: 'plumber' }), note({ topic: 1, age: 2 })],
    });

    expect(await recallTexts({ client, query: 'Which plumber did I mention?' })).toEqual(['Remember topic0 plumber']);
  });

  it('searches by words when the meaning model is not ready', async () => {
    const model = new HandChosenModel();
    model.ready = false;
    const { client } = await open({
      model,
      notes: [0, 1, 2, 3, 4, 5].map(topic => note({ topic, age: topic + 1, extra: topic === 3 ? 'plumber' : '' })),
    });

    const texts = await recallTexts({ client, query: 'Please remember the plumber' });

    expect(texts[0]).toBe('Remember topic3 plumber');
    expect(texts.length).toBeGreaterThan(1);
  });

  describe('moving a note that names a person to the front', () => {
    const notes = [
      note({ topic: 0, age: 1 }),
      note({ topic: 1, age: 2 }),
      note({ topic: 3, age: 3 }),
      note({ topic: 4, age: 4 }),
      note({ topic: 5, age: 5, extra: 'for Nora' }),
      note({ topic: 2, age: 6, extra: 'plain' }),
      note({ topic: 2, age: 7, extra: 'about Nora' }),
    ];

    it('puts a chosen note that names the person first', async () => {
      const { client } = await open({ model: new HandChosenModel(), notes });

      expect(await recallTexts({ client, query: `${askAbout({ topic: 2, closeness: 1 })} and Nora` })).toEqual([
        'Remember topic2 about Nora',
        'Remember topic2 plain',
      ]);
    });

    it('never adds a note that names the person but is not about the message', async () => {
      const { client } = await open({ model: new HandChosenModel(), notes });

      const texts = await recallTexts({ client, query: `${askAbout({ topic: 2, closeness: 1 })} and Nora` });

      expect(texts).not.toContain('Remember topic5 for Nora');
    });
  });

  describe('a note the sorter handled', () => {
    it("is left out of the log when its facts are on a page, and kept only when it is the person's own words and on no page", async () => {
      const notes: KitNote[] = [
        ...[0, 1, 3, 4, 5].map(topic => note({ topic, age: topic + 20 })),
        { day: daysAgo(1), text: 'Mail says topic2 mail', source: 'email' },
        { day: daysAgo(2), text: 'Remember topic2 own' },
      ];
      const { client, vaultDir, ids } = await open({ model: new HandChosenModel(), notes });
      const query = askAbout({ topic: 2, closeness: 1 });
      expect((await recallTexts({ client, query })).sort()).toEqual(['Mail says topic2 mail', 'Remember topic2 own']);

      await markHandled({ vaultDir, ids: ids.slice(5), outcome: 'page' });
      expect(await recallTexts({ client, query })).toEqual([]);

      await markHandled({ vaultDir, ids: ids.slice(5), outcome: 'none' });
      expect(await recallTexts({ client, query })).toEqual(['Remember topic2 own']);
    });
  });

  describe('a note that is deleted', () => {
    it('is not recalled again by meaning or by words, and its vector goes at the next index pass', async () => {
      const model = new HandChosenModel();
      const { client, vaultDir, ids } = await open({
        model,
        notes: [
          ...[0, 1, 3, 4, 5].map(topic => note({ topic, age: topic + 20 })),
          note({ topic: 2, age: 1, extra: 'plumber' }),
        ],
      });
      const byMeaning = askAbout({ topic: 2, closeness: 1 });
      const byWords = 'Which plumber did I mention?';
      expect(await recallTexts({ client, query: byMeaning })).toEqual(['Remember topic2 plumber']);
      const targetId = ids[5];
      if (targetId === undefined) {
        throw new Error('The note was not written.');
      }
      const stored = await EmbeddingStore.load({ namespaceDir: vaultDir, fileName: LOG_VECTORS_FILE });
      expect(stored.ids()).toContain(targetId);

      const deleted = await client.deleteEntry({ entryId: targetId, timeoutMs: TIMEOUT_MS });
      expect(deleted).toEqual({ ok: true });

      expect(await recallTexts({ client, query: byMeaning })).toEqual([]);
      expect(await recallTexts({ client, query: byWords })).not.toContain('Remember topic2 plumber');
      const textsByWords = await recallTexts({
        client: new MarkdownMemoryClient({ baseDir: path.dirname(vaultDir), namespace: path.basename(vaultDir) }),
        query: byWords,
      });
      expect(textsByWords).not.toContain('Remember topic2 plumber');

      await warmLog({ vaultDir, model });
      const after = await EmbeddingStore.load({ namespaceDir: vaultDir, fileName: LOG_VECTORS_FILE });
      expect(after.ids()).not.toContain(targetId);
    });
  });
});
