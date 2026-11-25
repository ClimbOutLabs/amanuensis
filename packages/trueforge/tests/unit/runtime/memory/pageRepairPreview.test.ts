import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pagePath } from '../../../../src/runtime/memory/memoryPages';
import { previewPageRepair } from '../../../../src/runtime/memory/pageRepairPreview';
import { writePageFile } from './pageFixtures';

/**
 * The repair preview: machine-written lines that stand on the wrong page are proposed as moves, a line standing
 * on two pages as one consolidation, and everything else is left alone with a reason. The person's own lines are
 * never proposed for a change, and the preview writes nothing and reads the same twice.
 */
const ALEX = `---
kind: person
title: Alex Marlow
aliases: [Alex, Alex Marlow]
household: true
---
# Alex Marlow

The person who owns this vault.

## Now
- Alex likes rice with separate grains. <!-- fact: id=f_a01 src=you_said since=2026-08-15 -->
- The community garden permit was approved for this season. <!-- fact: id=f_a02 src=read_content seen=2026-11-04 -->
- Sam is the emergency contact for the house. <!-- fact: id=f_a03 src=read_content seen=2026-10-02 -->

## Unconfirmed
- Alex might sell the studio's spare plot of land. <!-- fact: id=f_a04 src=inferred seen=2026-10-11 -->
`;

const SAM = `---
kind: person
title: Sam Ortiz
aliases: [Sam]
household: false
---
# Sam Ortiz

A neighbour who helps with the house and the garden.

## Now
- Sam is the emergency contact for the house. <!-- fact: id=f_s01 src=you_said since=2026-08-20 -->
- Sam walks the neighbour's dog on Fridays. <!-- fact: id=f_s02 src=read_content seen=2026-09-19 -->
`;

const ROBIN = `---
kind: person
title: Robin Marlow
aliases: [Robin, my wife]
household: true
---
# Robin Marlow

Alex's wife.

## Unconfirmed
- Riley and Sam both help at the community garden. <!-- fact: id=f_r01 src=read_content seen=2026-10-21 -->
`;

const RILEY = `---
kind: person
title: Riley Chen
aliases: [Riley]
household: false
---
# Riley Chen

A friend from the allotment society.

## Now
- Riley runs the Thursday quiz night at the hall. <!-- fact: id=f_t01 src=you_said since=2026-09-15 -->
`;

const GARDEN = `---
kind: matter
title: Community garden permit
aliases: [garden permit, the garden]
status: active
---
# Community garden permit

The permit for the allotment plot.

## Now
- The garden plot fee is 40 a year. <!-- fact: id=f_g01 src=you_said since=2026-03-01 -->
`;

async function makeVault(): Promise<string> {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'repair-preview-'));
  await writePageFile({ vaultDir, kind: 'person', slug: 'alex-marlow', content: ALEX });
  await writePageFile({ vaultDir, kind: 'person', slug: 'sam-ortiz', content: SAM });
  await writePageFile({ vaultDir, kind: 'person', slug: 'robin-marlow', content: ROBIN });
  await writePageFile({ vaultDir, kind: 'person', slug: 'riley-chen', content: RILEY });
  await writePageFile({ vaultDir, kind: 'matter', slug: 'community-garden-permit', content: GARDEN });
  return vaultDir;
}

describe('the repair preview for pages as they stand', () => {
  it('proposes a move for a machine-written line about a matter that stands on a person page', async () => {
    const preview = await previewPageRepair({ vaultDir: await makeVault() });
    expect(preview.moves).toEqual([
      {
        from: { kind: 'person', slug: 'alex-marlow' },
        to: { kind: 'matter', slug: 'community-garden-permit' },
        text: 'The community garden permit was approved for this season.',
      },
    ]);
  });

  it('proposes one consolidation for a line standing on two pages', async () => {
    const preview = await previewPageRepair({ vaultDir: await makeVault() });
    expect(preview.consolidations).toEqual([
      {
        text: 'Sam is the emergency contact for the house.',
        pages: [
          { kind: 'person', slug: 'alex-marlow' },
          { kind: 'person', slug: 'sam-ortiz' },
        ],
      },
    ]);
  });

  it('leaves ambiguous and correctly placed machine-written lines alone, with reasons', async () => {
    const preview = await previewPageRepair({ vaultDir: await makeVault() });
    expect(preview.leftAlone).toEqual(
      expect.arrayContaining([
        {
          page: { kind: 'person', slug: 'robin-marlow' },
          text: 'Riley and Sam both help at the community garden.',
          why: 'it names more than one other page',
        },
        {
          page: { kind: 'person', slug: 'sam-ortiz' },
          text: "Sam walks the neighbour's dog on Fridays.",
          why: 'it names no other page',
        },
        {
          page: { kind: 'person', slug: 'alex-marlow' },
          text: "Alex might sell the studio's spare plot of land.",
          why: 'it names no other page',
        },
      ]),
    );
  });

  it('never proposes a change to a line in the person’s own words, and writes nothing', async () => {
    const vaultDir = await makeVault();
    const before = await readFile(pagePath({ vaultDir, kind: 'person', slug: 'alex-marlow' }), 'utf8');
    const preview = await previewPageRepair({ vaultDir });
    expect(preview.ownLines).toBe(4);
    const proposed = [...preview.moves.map(move => move.text), ...preview.leftAlone.map(line => line.text)];
    expect(proposed).not.toContain('Alex likes rice with separate grains.');
    expect(proposed).not.toContain('The garden plot fee is 40 a year.');
    expect(await readFile(pagePath({ vaultDir, kind: 'person', slug: 'alex-marlow' }), 'utf8')).toBe(before);
  });

  it('reads the same preview twice on the same vault', async () => {
    const vaultDir = await makeVault();
    const first = await previewPageRepair({ vaultDir });
    const second = await previewPageRepair({ vaultDir });
    expect(second).toEqual(first);
  });
});
