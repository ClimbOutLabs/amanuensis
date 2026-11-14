import { execFileRunner } from '@truefoundry/trueforge-core/core';
import path from 'node:path';
import { createLogger } from 'winston';

import {
  entryMetadata,
  entryRecallText,
  scanNamespaceEntries,
} from '../../../../src/runtime/memory/markdownMemoryFiles';
import { sortNote, type SortModel } from '../../../../src/runtime/memory/pageSorter';
import { statementHits } from '../../../../src/runtime/memory/statementIndex';
import { askAbout, gateFor, HandChosenModel, makeVault, writeKitNotes, type KitNote } from './statementTestKit';

const DAY = '2026-11-06';
const MAIL_TEXT = 'Mail says topic2 mail';
const OWN_TEXT = 'Remember topic2 own';

function saying(decisions: unknown[]): SortModel {
  return () => Promise.resolve({ ok: true, reply: JSON.stringify({ decisions }) });
}

describe('recall after the sorter has handled a note', () => {
  async function setup() {
    const vaultDir = await makeVault();
    const notes: KitNote[] = [
      ...[0, 1, 3, 4, 5].map(topic => ({
        day: `2026-10-${String(10 + topic)}`,
        text: `Remember topic${String(topic)}`,
      })),
      { day: DAY, text: MAIL_TEXT, source: 'email' },
      { day: DAY, text: OWN_TEXT },
    ];
    const ids = await writeKitNotes({ vaultDir, notes });
    const scan = await scanNamespaceEntries({
      baseDir: path.dirname(vaultDir),
      namespace: path.basename(vaultDir),
      maxDailyFiles: Number.POSITIVE_INFINITY,
    });
    const sort = async ({ id, model }: { id: string; model: SortModel }) => {
      const entry = scan.entries.find(candidate => candidate.id === id);
      if (entry === undefined) {
        throw new Error('The note was not written.');
      }
      await sortNote({
        mode: 'on',
        note: { id, text: entryRecallText(entry.text), day: DAY, metadata: entryMetadata(entry.text) },
        askModel: model,
        options: { vaultDir, runner: execFileRunner, today: DAY, logger: createLogger({ silent: true }) },
      });
    };
    const ask = async () => {
      const message = askAbout({ topic: 2, closeness: 1 });
      const gate = await gateFor({ vaultDir, model: new HandChosenModel(), message });
      if (gate.state !== 'judged') {
        throw new Error(`The gate did not judge the message: ${gate.state}`);
      }
      return { gate, hits: statementHits({ gate, today: DAY, message, skip: new Set() }).map(hit => hit.text) };
    };
    return { ids, sort, ask };
  }

  it('shows the page statement and no longer the note from the log', async () => {
    const { ids, sort, ask } = await setup();
    const [mailId, ownId] = ids.slice(5);
    if (mailId === undefined || ownId === undefined) {
      throw new Error('The notes were not written.');
    }
    expect((await ask()).gate.notes.map(note => note.id).sort()).toEqual([mailId, ownId].sort());

    await sort({
      id: mailId,
      model: saying([
        {
          decision: 'unconfirmed',
          about: 'nora',
          page_kind: 'person',
          title: 'Nora',
          text: MAIL_TEXT,
          seen: DAY,
          reason: 'Read in mail.',
        },
      ]),
    });

    const after = await ask();
    expect(after.hits).toEqual([MAIL_TEXT]);
    expect(after.gate.notes.map(note => note.id)).toEqual([ownId]);
  });

  it('still shows the person’s own note when the sorter found no page for it', async () => {
    const { ids, sort, ask } = await setup();
    const ownId = ids[6];
    if (ownId === undefined) {
      throw new Error('The note was not written.');
    }

    await sort({ id: ownId, model: saying([{ decision: 'ignore', reason: 'Nothing for a page.' }]) });

    expect((await ask()).gate.notes.map(note => note.id)).toContain(ownId);
  });
});
