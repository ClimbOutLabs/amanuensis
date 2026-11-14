import path from 'node:path';

import { MarkdownMemoryClient } from '../../../../src/runtime/memory/markdownMemoryClient';
import { askAbout, HandChosenModel, makeVault, warmLog, writeKitNotes, type KitNote } from './statementTestKit';

const NOTES = 5000;
const NOTES_PER_DAY = 10;

function dayOf(index: number): string {
  return new Date(Date.UTC(2024, 0, 1) + Math.floor(index / NOTES_PER_DAY) * 86_400_000).toISOString().slice(0, 10);
}

describe('one recall over a log of 5,000 notes', () => {
  it('reports how long the first and the second recall take', async () => {
    const model = new HandChosenModel();
    const vaultDir = await makeVault();
    const notes: KitNote[] = Array.from({ length: NOTES }, (_, index) => ({
      day: dayOf(index),
      text: `Note ${String(index)} about topic${String(index % 6)}`,
    }));
    await writeKitNotes({ vaultDir, notes });
    const embeddings = await warmLog({ vaultDir, model });
    const client = new MarkdownMemoryClient({
      baseDir: path.dirname(vaultDir),
      namespace: path.basename(vaultDir),
      embeddings: () => embeddings,
    });
    const timings: string[] = [];
    let shown = 0;
    for (const call of ['first', 'second']) {
      const startedAt = performance.now();
      const outcome = await client.recall({
        query: askAbout({ topic: 2, closeness: 1 }),
        maxTokens: 4000,
        timeoutMs: 30_000,
      });
      timings.push(`${call} recall ${String(Math.round(performance.now() - startedAt))} ms`);
      shown = outcome.ok ? outcome.results.length : -1;
    }

    // Timings are reported, not asserted: they depend on the machine.
    console.info(`Log of ${String(NOTES)} notes: ${timings.join(', ')}; ${String(shown)} notes shown`);
    expect(shown).toBe(6);
  }, 120_000);
});
