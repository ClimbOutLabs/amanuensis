import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ERASED_ENTRY } from '../../../../src/runtime/memory/markdownMemoryFiles';
import type { MeaningGate } from '../../../../src/runtime/memory/meaningGate';
import { statementHits } from '../../../../src/runtime/memory/statementIndex';
import {
  askAbout,
  askAboutBoth,
  gateFor,
  HandChosenModel,
  makeVault,
  markHandled,
  ownBullet,
  writeKitNotes,
  writeStatementPage,
  type KitNote,
} from './statementTestKit';

const TODAY = '2026-11-10';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** A person's own note about topic `topic`, saved `age` days ago. */
function ownNote({ topic, age, extra = '' }: { topic: number; age: number; extra?: string }): KitNote {
  return { day: daysAgo(age), text: `Remember topic${String(topic)} ${extra}`.trim() };
}

async function writeStatements({ vaultDir, topics }: { vaultDir: string; topics: number[] }): Promise<void> {
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

function judged(gate: MeaningGate) {
  if (gate.state !== 'judged') {
    throw new Error(`The gate was ${gate.state}, not judged.`);
  }
  return gate;
}

function hitTexts({ gate, message }: { gate: MeaningGate; message: string }): string[] {
  return statementHits({ gate, message, today: TODAY, skip: new Set() }).map(hit => hit.text);
}

describe('the meaning gate', () => {
  describe('rule 1 for a note', () => {
    it('shows a note whose standing is above 3 and not one below it', async () => {
      const vaultDir = await makeVault();
      const model = new HandChosenModel();
      const ids = await writeKitNotes({
        vaultDir,
        notes: [0, 1, 2, 3, 4, 5].map(topic => ownNote({ topic, age: topic + 1 })),
      });

      const near = judged(await gateFor({ vaultDir, model, message: askAbout({ topic: 2, closeness: 0.5 }) }));
      expect(near.notes.map(note => note.id)).toEqual([ids[2]]);
      expect(near.notes[0]?.standing).toBeGreaterThan(3);

      // Standing 2.3 stands out from ordinary messages as a whole but is not above 3.
      const far = judged(await gateFor({ vaultDir, model, message: askAbout({ topic: 2, closeness: 0.3 }) }));
      expect(far.notes).toEqual([]);
    });
  });

  describe('one gate for statements and notes together', () => {
    async function mixedVault(): Promise<{ vaultDir: string; model: HandChosenModel }> {
      const vaultDir = await makeVault();
      await writeStatements({ vaultDir, topics: [0, 1, 2] });
      await writeKitNotes({ vaultDir, notes: [3, 4, 5].map(topic => ownNote({ topic, age: topic })) });
      return { vaultDir, model: new HandChosenModel(46) };
    }

    it('opens the gate for statements when the best match is a note', async () => {
      const { vaultDir, model } = await mixedVault();
      // The note about topic 4 is above the bar; the statement about topic 2 is above 3 but under the bar on its own.
      const message = askAboutBoth({ first: [4, 0.85], second: [2, 0.52] });

      const gate = judged(await gateFor({ vaultDir, model, message }));

      expect(gate.open).toBe(true);
      expect(gate.notes).toHaveLength(1);
      expect(hitTexts({ gate, message })).toEqual(['Likes topic2 a lot.']);
    });

    it('opens the gate for notes when the best match is a statement', async () => {
      const { vaultDir, model } = await mixedVault();
      const message = askAboutBoth({ first: [2, 0.86], second: [4, 0.52] });

      const gate = judged(await gateFor({ vaultDir, model, message }));

      expect(gate.open).toBe(true);
      expect(hitTexts({ gate, message })).toEqual(['Likes topic2 a lot.']);
      expect(gate.notes).toHaveLength(1);
    });

    it('gives neither when the message is under the bar for both', async () => {
      const { vaultDir, model } = await mixedVault();
      const message = askAboutBoth({ first: [4, 0.6], second: [2, 0.6] });

      const gate = judged(await gateFor({ vaultDir, model, message }));

      expect(gate.open).toBe(false);
      expect(gate.notes).toEqual([]);
      expect(hitTexts({ gate, message })).toEqual([]);
    });

    it('counts the notes in the bar: a note topic that ordinary messages come close to raises it', async () => {
      const vaultDir = await makeVault();
      await writeStatements({ vaultDir, topics: [0, 1, 2, 3, 4] });
      const model = new HandChosenModel(46);
      const message = askAbout({ topic: 2, closeness: 0.9 });
      const withoutNote = judged(await gateFor({ vaultDir, model, message }));

      await writeKitNotes({ vaultDir, notes: [ownNote({ topic: 5, age: 1 })] });
      const withNote = judged(await gateFor({ vaultDir, model, message }));

      expect(withNote.bar).toBeGreaterThan(withoutNote.bar);
    });
  });

  describe('which notes are eligible', () => {
    const ask = askAbout({ topic: 2, closeness: 0.6 });

    async function vaultWith(notes: KitNote[]): Promise<{ vaultDir: string; ids: string[]; model: HandChosenModel }> {
      const vaultDir = await makeVault();
      const fillers = [0, 1, 3, 4, 5].map(topic => ownNote({ topic, age: topic + 20 }));
      const ids = await writeKitNotes({ vaultDir, notes: [...fillers, ...notes] });
      return { vaultDir, ids: ids.slice(fillers.length), model: new HandChosenModel() };
    }

    it('shows a note the sorter has not handled, whoever wrote it', async () => {
      const { vaultDir, ids, model } = await vaultWith([
        ownNote({ topic: 2, age: 1 }),
        { day: daysAgo(2), text: 'Mail says topic2 too.', source: 'email' },
      ]);

      const gate = judged(await gateFor({ vaultDir, model, message: ask }));

      expect(gate.notes.map(note => note.id).sort()).toEqual([...ids].sort());
    });

    it('leaves out a note the sorter put on a page, whoever wrote it', async () => {
      const { vaultDir, ids, model } = await vaultWith([
        { day: daysAgo(2), text: 'Mail says topic2.', source: 'email' },
        ownNote({ topic: 2, age: 1 }),
      ]);
      await markHandled({ vaultDir, ids, outcome: 'page' });

      const gate = judged(await gateFor({ vaultDir, model, message: ask }));

      expect(gate.notes).toEqual([]);
    });

    it('shows a note of a reply that wrote to the pages itself, whoever wrote it, as a note not sorted yet', async () => {
      const { vaultDir, ids, model } = await vaultWith([
        ownNote({ topic: 2, age: 1 }),
        { day: daysAgo(2), text: 'Mail says topic2 too.', source: 'email' },
      ]);
      await markHandled({ vaultDir, ids, outcome: 'chat' });

      const gate = judged(await gateFor({ vaultDir, model, message: ask }));

      expect(gate.notes.map(note => note.id).sort()).toEqual([...ids].sort());
    });

    it("shows a note the sorter put on no page when it is the person's own words", async () => {
      const { vaultDir, ids, model } = await vaultWith([ownNote({ topic: 2, age: 1 })]);
      await markHandled({ vaultDir, ids, outcome: 'none' });

      const gate = judged(await gateFor({ vaultDir, model, message: ask }));

      expect(gate.notes.map(note => note.id)).toEqual(ids);
    });

    it('leaves out a note the sorter put on no page when it is read content', async () => {
      const { vaultDir, ids, model } = await vaultWith([
        { day: daysAgo(2), text: 'Mail says topic2.', source: 'email' },
      ]);
      await markHandled({ vaultDir, ids, outcome: 'none' });

      const gate = judged(await gateFor({ vaultDir, model, message: ask }));

      expect(gate.notes).toEqual([]);
    });

    it('does not let a handled read note open the gate or count toward the five', async () => {
      const vaultDir = await makeVault();
      const ids = await writeKitNotes({
        vaultDir,
        notes: [0, 1, 2, 3, 4].map(topic => ({
          day: daysAgo(topic + 1),
          text: `Mail says topic${String(topic)}.`,
          source: 'email',
        })),
      });
      await markHandled({ vaultDir, ids: ids.slice(0, 2), outcome: 'page' });

      const gate = await gateFor({ vaultDir, model: new HandChosenModel(), message: ask });

      expect(gate.state).toBe('too_little');
    });
  });

  describe('how many notes are shown', () => {
    async function manyNotes(): Promise<string> {
      const vaultDir = await makeVault();
      await writeKitNotes({
        vaultDir,
        notes: [
          ...[0, 1, 3, 4, 5].map(topic => ownNote({ topic, age: topic + 20 })),
          ...Array.from({ length: 9 }, (_, n) => ownNote({ topic: 2, age: n + 1, extra: `number ${String(n)}` })),
        ],
      });
      return vaultDir;
    }

    it('shows at most 4 when the vault has page statements', async () => {
      const vaultDir = await manyNotes();
      await writeStatements({ vaultDir, topics: [0] });

      const gate = judged(
        await gateFor({ vaultDir, model: new HandChosenModel(), message: askAbout({ topic: 2, closeness: 1 }) }),
      );

      expect(gate.notes).toHaveLength(4);
      expect(gate.notes.map(note => note.standing)).toEqual(
        [...gate.notes.map(note => note.standing)].sort((a, b) => b - a),
      );
    });

    it('shows at most 6 when the vault has no page statements at all', async () => {
      const vaultDir = await manyNotes();

      const gate = judged(
        await gateFor({ vaultDir, model: new HandChosenModel(), message: askAbout({ topic: 2, closeness: 1 }) }),
      );

      expect(gate.notes).toHaveLength(6);
    });
  });

  describe('when the numbers say too little', () => {
    it('answers too little with fewer than 5 statements and notes together', async () => {
      const vaultDir = await makeVault();
      await writeStatements({ vaultDir, topics: [0, 1] });
      await writeKitNotes({ vaultDir, notes: [ownNote({ topic: 2, age: 1 }), ownNote({ topic: 3, age: 2 })] });

      const gate = await gateFor({
        vaultDir,
        model: new HandChosenModel(),
        message: askAbout({ topic: 2, closeness: 1 }),
      });

      expect(gate.state).toBe('too_little');
      expect(hitTexts({ gate, message: '' })).toEqual([]);
    });

    it('judges once statements and notes together reach 5', async () => {
      const vaultDir = await makeVault();
      await writeStatements({ vaultDir, topics: [0, 1] });
      await writeKitNotes({ vaultDir, notes: [2, 3, 4].map(topic => ownNote({ topic, age: topic })) });

      const gate = await gateFor({
        vaultDir,
        model: new HandChosenModel(),
        message: askAbout({ topic: 2, closeness: 1 }),
      });

      expect(gate.state).toBe('judged');
    });
  });

  it('answers unavailable while the meaning model is not ready, and finds nothing', async () => {
    const vaultDir = await makeVault();
    await writeStatements({ vaultDir, topics: [0, 1, 2, 3, 4, 5] });
    await writeKitNotes({ vaultDir, notes: [0, 1, 2, 3, 4, 5].map(topic => ownNote({ topic, age: topic + 1 })) });
    const model = new HandChosenModel();
    model.ready = false;
    const message = askAbout({ topic: 2, closeness: 1 });

    const gate = await gateFor({ vaultDir, model, message });

    expect(gate).toEqual({ state: 'unavailable' });
    expect(hitTexts({ gate, message })).toEqual([]);
  });

  describe('keeping the comparison numbers right', () => {
    const probes = [0, 1, 2, 3, 4, 5].flatMap(topic => [
      askAbout({ topic, closeness: 0.9 }),
      askAbout({ topic, closeness: 0.6 }),
    ]);

    async function numbersOf({ vaultDir, model }: { vaultDir: string; model: HandChosenModel }): Promise<unknown[]> {
      const gates = [];
      for (const message of probes) {
        const gate = judged(await gateFor({ vaultDir, model, message }));
        gates.push([gate.bar, gate.messageBest, gate.notes.map(note => note.standing)]);
      }
      return gates;
    }

    async function freshNumbers(notes: KitNote[]): Promise<unknown[]> {
      const vaultDir = await makeVault();
      await writeKitNotes({ vaultDir, notes });
      return numbersOf({ vaultDir, model: new HandChosenModel(46) });
    }

    it('follows a note that is added, changed and removed', async () => {
      const model = new HandChosenModel(46);
      const vaultDir = await makeVault();
      const [n0, n1, n2, n3, n4] = [0, 1, 2, 3, 4].map(topic => ownNote({ topic, age: topic + 1 }));
      const added = ownNote({ topic: 5, age: 7 });
      if (n0 === undefined || n1 === undefined || n2 === undefined || n3 === undefined || n4 === undefined) {
        throw new Error('The notes were not made.');
      }
      await writeKitNotes({ vaultDir, notes: [n0, n1, n2, n3, n4] });
      await numbersOf({ vaultDir, model });

      await writeKitNotes({ vaultDir, notes: [added] });
      expect(await numbersOf({ vaultDir, model })).toEqual(await freshNumbers([n0, n1, n2, n3, n4, added]));

      // The note about topic 3 is rewritten to be about topic 5.
      const rewritten = { ...n3, text: n3.text.replace('topic3', 'topic5') };
      const changedFile = path.join(vaultDir, 'memory', `${n3.day}.md`);
      await writeFile(changedFile, (await readFile(changedFile, 'utf8')).replace('topic3', 'topic5'), 'utf8');
      const afterChange = await numbersOf({ vaultDir, model });
      expect(afterChange).toEqual(await freshNumbers([n0, n1, n2, rewritten, n4, added]));

      // The note about topic 2 is erased the way a delete leaves it: a placeholder that keeps its place.
      await writeFile(path.join(vaultDir, 'memory', `${n2.day}.md`), `${ERASED_ENTRY}\n`, 'utf8');
      const afterErase = await numbersOf({ vaultDir, model });
      expect(afterErase).toEqual(await freshNumbers([n0, n1, rewritten, n4, added]));
      expect(afterErase).not.toEqual(afterChange);
    });
  });
});
