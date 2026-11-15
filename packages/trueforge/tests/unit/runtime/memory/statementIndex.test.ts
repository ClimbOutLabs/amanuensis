import type { EmbeddingModel } from '../../../../src/runtime/memory/embeddingModel';
import { EmbeddingStore } from '../../../../src/runtime/memory/embeddingStore';
import { statementEmbedText, statementHits, StatementIndex } from '../../../../src/runtime/memory/statementIndex';
import { askAbout, gateFor, HandChosenModel, makeVault, ownBullet, writeStatementPage } from './statementTestKit';

const TODAY = '2026-11-10';

async function writeTopics({ vaultDir, topics }: { vaultDir: string; topics: number[] }): Promise<void> {
  await writeStatementPage({
    vaultDir,
    slug: 'nora',
    title: 'Nora',
    summary: 'My wife.',
    sections: {
      Now: topics.map(topic => ownBullet({ text: `Likes topic${String(topic)} a lot.`, id: `f_0${String(topic)}` })),
    },
  });
}

interface Searched {
  vaultDir: string;
  model: EmbeddingModel;
  index: StatementIndex;
}

async function find({ vaultDir, model, message }: Searched & { message: string }) {
  return statementHits({ gate: await gateFor({ vaultDir, model, message }), message, today: TODAY, skip: new Set() });
}

describe('statement index', () => {
  it('indexes statements and typed bullets in the five sections, and nothing else', async () => {
    const model = new HandChosenModel();
    const vaultDir = await makeVault();
    await writeStatementPage({
      vaultDir,
      slug: 'nora',
      title: 'Nora',
      summary: 'My wife.',
      sections: {
        'How you write to them': [ownBullet({ text: 'Short topic0.', id: 'f_00' })],
        Now: [
          ownBullet({ text: 'Likes topic1 tea.', id: 'f_01' }),
          '- Typed topic2',
          '- Broken topic3 <!-- fact: nonsense -->',
        ],
        Unconfirmed: ['- Maybe topic4 <!-- fact: id=f_04 src=read_content seen=2026-10-01 -->'],
        Earlier: [ownBullet({ text: 'Used topic5.', id: 'f_05', until: '2026-02-01' })],
        Notes: ['- Odd topic6'],
      },
    });
    const index = new StatementIndex(vaultDir, model);

    expect(await index.refresh()).toBe(true);

    expect([...model.passages].sort()).toEqual(
      [
        'Nora (My wife.): Likes topic1 tea.',
        'Nora (My wife.): Typed topic2',
        'Nora (My wife.): Maybe topic4',
        'Nora (My wife.): Used topic5.',
      ].sort(),
    );
    expect(index.size).toBe(4);
  });

  it('embeds an edited statement again and drops a removed one', async () => {
    const model = new HandChosenModel();
    const vaultDir = await makeVault();
    await writeTopics({ vaultDir, topics: [0, 1, 2, 3, 4, 5] });
    const index = new StatementIndex(vaultDir, model);
    await index.refresh();
    expect(model.passages).toHaveLength(6);

    await writeStatementPage({
      vaultDir,
      slug: 'nora',
      title: 'Nora',
      summary: 'My wife.',
      sections: {
        Now: [
          ownBullet({ text: 'Likes topic0 a lot.', id: 'f_00' }),
          ownBullet({ text: 'Dislikes topic1 now.', id: 'f_01' }),
          ...[2, 3, 4].map(topic =>
            ownBullet({ text: `Likes topic${String(topic)} a lot.`, id: `f_0${String(topic)}` }),
          ),
        ],
      },
    });
    await index.refresh();

    expect(model.passages.slice(6)).toEqual(['Nora (My wife.): Dislikes topic1 now.']);
    expect(index.size).toBe(5);
    const stored = await EmbeddingStore.load({ namespaceDir: vaultDir, fileName: '.statement-embeddings.json' });
    expect(stored.ids()).toHaveLength(5);
    expect(stored.ids()).not.toContain('person/nora#f_05');
  });

  it('embeds nothing the second time for the same vault, even in a new process', async () => {
    const model = new HandChosenModel();
    const vaultDir = await makeVault();
    await writeTopics({ vaultDir, topics: [0, 1, 2, 3, 4, 5] });
    await new StatementIndex(vaultDir, model).refresh();
    const embeddedOnce = model.passages.length;

    const again = new StatementIndex(vaultDir, model);
    await again.refresh();
    await again.refresh();

    expect(model.passages).toHaveLength(embeddedOnce);
    expect(again.size).toBe(6);
  });

  it('answers "not ready" while the model is not ready, and finds nothing', async () => {
    const model = new HandChosenModel();
    model.ready = false;
    const vaultDir = await makeVault();
    await writeTopics({ vaultDir, topics: [0, 1, 2, 3, 4, 5] });
    const index = new StatementIndex(vaultDir, model);

    expect(await index.refresh()).toBe(false);
    expect(await find({ vaultDir, model, index, message: askAbout({ topic: 2, closeness: 1 }) })).toEqual([]);
    expect(model.passages).toEqual([]);
  });

  it('embeds the title, the summary and the statement, or the title and statement when they are one', () => {
    expect(statementEmbedText({ title: 'Nora', summary: 'My wife.', statement: 'Likes tea.' })).toBe(
      'Nora (My wife.): Likes tea.',
    );
    expect(statementEmbedText({ title: 'Nora', summary: 'Likes tea.', statement: 'Likes tea.' })).toBe(
      'Nora: Likes tea.',
    );
    expect(statementEmbedText({ title: 'Nora', summary: undefined, statement: 'Likes tea.' })).toBe('Nora: Likes tea.');
  });
});

describe('the two rules', () => {
  async function indexOf({ hot, topics }: { hot: number; topics: number[] }): Promise<Searched> {
    const vaultDir = await makeVault();
    await writeTopics({ vaultDir, topics });
    const model = new HandChosenModel(hot);
    return { vaultDir, model, index: new StatementIndex(vaultDir, model) };
  }

  it('finds a statement whose standing is above 3 and not one below it', async () => {
    const searched = await indexOf({ hot: 0, topics: [0, 1, 2, 3, 4, 5] });

    const found = await find({ ...searched, message: askAbout({ topic: 2, closeness: 0.5 }) });
    expect(found.map(hit => hit.text)).toEqual(['Likes topic2 a lot.']);
    expect(found[0]?.standing).toBeGreaterThan(3);

    // Standing 2.3 stands out from ordinary messages as a whole but is not above 3.
    expect(await find({ ...searched, message: askAbout({ topic: 2, closeness: 0.3 }) })).toEqual([]);
  });

  it('finds nothing for a message that does not beat the 95th percentile, even above 3', async () => {
    const searched = await indexOf({ hot: 46, topics: [0, 1, 2, 3, 4, 5] });

    // Standing 4.9 is above 3, but 46 ordinary messages come as close, so the bar is about 6.
    expect(await find({ ...searched, message: askAbout({ topic: 2, closeness: 0.7 }) })).toEqual([]);
    expect(await find({ ...searched, message: askAbout({ topic: 2, closeness: 1 }) })).toHaveLength(1);
  });

  it('finds nothing with fewer than 5 statements', async () => {
    const searched = await indexOf({ hot: 0, topics: [0, 1, 2, 3] });

    expect(await find({ ...searched, message: askAbout({ topic: 2, closeness: 1 }) })).toEqual([]);
  });

  it('keeps the comparison numbers right after a statement is added and after one is removed', async () => {
    const model = new HandChosenModel(46);
    const vaultDir = await makeVault();
    await writeTopics({ vaultDir, topics: [0, 1, 2, 3, 4] });
    const index = new StatementIndex(vaultDir, model);
    await index.refresh();

    async function fresh(topics: number[]): Promise<number[]> {
      const other = await makeVault();
      await writeTopics({ vaultDir: other, topics });
      const copy = new StatementIndex(other, model);
      await copy.refresh();
      return [...copy.comparisonBest];
    }

    await writeTopics({ vaultDir, topics: [0, 1, 2, 3, 4, 5] });
    await index.refresh();
    expect([...index.comparisonBest]).toEqual(await fresh([0, 1, 2, 3, 4, 5]));

    await writeTopics({ vaultDir, topics: [0, 1, 3, 4, 5] });
    await index.refresh();
    expect([...index.comparisonBest]).toEqual(await fresh([0, 1, 3, 4, 5]));
    expect([...index.comparisonBest]).not.toEqual(await fresh([0, 1, 2, 3, 4, 5]));
  });
});
