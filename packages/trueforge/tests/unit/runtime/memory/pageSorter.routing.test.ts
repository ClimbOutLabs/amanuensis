import { execFileRunner } from '@truefoundry/trueforge-core/core';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from 'winston';

import { readHandledNotes } from '../../../../src/runtime/memory/handledNotes';
import { pagePath } from '../../../../src/runtime/memory/memoryPages';
import { sortNote, type SortModel, type SortNote, type SortResult } from '../../../../src/runtime/memory/pageSorter';
import { writePageFile } from './pageFixtures';

/**
 * Routing: a note's facts belong to the page of what they are about. These cases pin what the host itself
 * refuses, whoever the model answers as: the person's own page and the assistant's page are not destinations,
 * a statement filed on a page must name that page's subject, and one statement gets one home.
 */
const DAY = '2026-11-06';
const NOTE_ID = 'md:vault:2026-11-06.md#0';
const OWN: SortNote['metadata'] = { origin: 'user_stated' };

const IDENTITY = { personName: 'Alex Marlow', assistantName: 'Aman' };

const ALEX = `---
kind: person
title: Alex Marlow
aliases: [Alex, Alex Marlow]
household: true
---
# Alex Marlow

The person who owns this vault.

## Now
- Alex runs a small design studio with two staff. <!-- fact: id=f_a01 src=you_said since=2026-09-02 -->
- Alex drinks tea in the morning, not coffee. <!-- fact: id=f_a02 src=you_said since=2026-08-15 -->
`;

const AMAN = `---
kind: person
title: Aman
aliases: [Aman, the assistant]
household: false
---
# Aman

The assistant itself.

## Now
- Aman keeps the household calendar up to date. <!-- fact: id=f_m01 src=read_content seen=2026-09-30 -->
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
- Sam fixed the leak under the sink. <!-- fact: id=f_s01 src=you_said since=2026-08-20 -->
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
- The plot is number 12, by the south fence. <!-- fact: id=f_g02 src=you_said since=2026-03-01 -->
`;

async function makeVault(): Promise<string> {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'sorter-routing-'));
  await writePageFile({ vaultDir, kind: 'person', slug: 'alex-marlow', content: ALEX });
  await writePageFile({ vaultDir, kind: 'person', slug: 'aman', content: AMAN });
  await writePageFile({ vaultDir, kind: 'person', slug: 'sam-ortiz', content: SAM });
  await writePageFile({ vaultDir, kind: 'person', slug: 'riley-chen', content: RILEY });
  await writePageFile({ vaultDir, kind: 'matter', slug: 'community-garden-permit', content: GARDEN });
  return vaultDir;
}

function modelReplying(reply: unknown): SortModel {
  return () => Promise.resolve({ ok: true, reply: typeof reply === 'string' ? reply : JSON.stringify(reply) });
}

function sortWith({
  vaultDir,
  model,
  text,
  identity = IDENTITY,
}: {
  vaultDir: string;
  model: SortModel;
  text: string;
  identity?: { personName?: string; assistantName?: string } | undefined;
}): Promise<SortResult> {
  return sortNote({
    mode: 'on',
    note: { id: NOTE_ID, text, day: DAY, metadata: OWN },
    askModel: model,
    options: { vaultDir, runner: execFileRunner, today: DAY, logger: createLogger({ silent: true }) },
    identity,
  });
}

const read = (vaultDir: string, kind: 'person' | 'matter', slug: string) =>
  readFile(pagePath({ vaultDir, kind, slug }), 'utf8');

const reason = 'Because.';

function newDecision(about: string, pageKind: 'person' | 'matter', text: string) {
  return {
    decision: 'new',
    about,
    page_kind: pageKind,
    section: 'Now',
    text,
    since: DAY,
    reason,
  };
}

describe('routing a note to the page of its subject', () => {
  it('refuses a fact filed on the assistant’s page, though the assistant took part in the conversation', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Sam told Aman the community garden permit was approved for this season.',
      model: modelReplying({
        decisions: [newDecision('aman', 'person', 'The community garden permit was approved for this season.')],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'aman')).toBe(AMAN);
    expect(await read(vaultDir, 'matter', 'community-garden-permit')).toBe(GARDEN);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('refuses a fact about the person filed on the person’s own page', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'I like rice with separate grains.',
      model: modelReplying({
        decisions: [newDecision('alex-marlow', 'person', 'Alex likes rice with separate grains.')],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'alex-marlow')).toBe(ALEX);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('refuses a fact filed on a person page the statement does not name as its subject', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Sam told Aman the community garden permit was approved for this season.',
      model: modelReplying({
        decisions: [newDecision('sam-ortiz', 'person', 'The community garden permit was approved for this season.')],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('files the permit approval on the garden page, which the statement names', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Sam told Aman the community garden permit was approved for this season.',
      model: modelReplying({
        decisions: [
          newDecision('community-garden-permit', 'matter', 'The community garden permit was approved for this season.'),
        ],
      }),
    });

    expect(result).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    const garden = await read(vaultDir, 'matter', 'community-garden-permit');
    expect(garden).toContain('The community garden permit was approved for this season.');
    expect(garden).toContain('src=you_said');
    expect(await read(vaultDir, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await read(vaultDir, 'person', 'aman')).toBe(AMAN);
  });

  it('keeps the garden contact with the garden matter, not on the contact’s own page', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Riley is the contact for the community garden permit.',
      model: modelReplying({
        decisions: [
          newDecision('community-garden-permit', 'matter', 'Riley is the contact for the community garden permit.'),
        ],
      }),
    });

    expect(result).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    expect(await read(vaultDir, 'matter', 'community-garden-permit')).toContain(
      'Riley is the contact for the community garden permit.',
    );
    expect(await read(vaultDir, 'person', 'riley-chen')).toBe(RILEY);
  });

  it('still files a durable fact about a person on that person’s page', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Riley prefers written agendas before meetings.',
      model: modelReplying({
        decisions: [newDecision('riley-chen', 'person', 'Riley prefers written agendas before meetings.')],
      }),
    });

    expect(result).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    const riley = await read(vaultDir, 'person', 'riley-chen');
    expect(riley).toContain('Riley prefers written agendas before meetings.');
    expect(riley).toContain('src=you_said');
  });

  it('refuses the same statement filed on two pages at once', async () => {
    const vaultDir = await makeVault();
    const text = 'Riley is the contact for the community garden permit.';
    const result = await sortWith({
      vaultDir,
      text,
      model: modelReplying({
        decisions: [newDecision('community-garden-permit', 'matter', text), newDecision('riley-chen', 'person', text)],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'matter', 'community-garden-permit')).toBe(GARDEN);
    expect(await read(vaultDir, 'person', 'riley-chen')).toBe(RILEY);
  });

  it('refuses to copy a statement onto a second page when a page already says it', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'The garden plot fee is 40 a year.',
      model: modelReplying({
        decisions: [newDecision('riley-chen', 'person', 'The garden plot fee is 40 a year.')],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'riley-chen')).toBe(RILEY);
  });

  it('files the same fact by its subject when the speaker and the subject change places', async () => {
    const samSays = await makeVault();
    const first = await sortWith({
      vaultDir: samSays,
      text: 'Sam said Riley now leads the garden rota.',
      model: modelReplying({
        decisions: [newDecision('community-garden-permit', 'matter', 'Riley now leads the garden rota.')],
      }),
    });
    expect(first).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    expect(await read(samSays, 'matter', 'community-garden-permit')).toContain('Riley now leads the garden rota.');
    expect(await read(samSays, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await read(samSays, 'person', 'riley-chen')).toBe(RILEY);

    const rileySays = await makeVault();
    const second = await sortWith({
      vaultDir: rileySays,
      text: 'Riley said Sam now leads the garden rota.',
      model: modelReplying({
        decisions: [newDecision('community-garden-permit', 'matter', 'Sam now leads the garden rota.')],
      }),
    });
    expect(second).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    expect(await read(rileySays, 'matter', 'community-garden-permit')).toContain('Sam now leads the garden rota.');
    expect(await read(rileySays, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await read(rileySays, 'person', 'riley-chen')).toBe(RILEY);
  });

  it('refuses a new page named for the assistant or the person', async () => {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'sorter-routing-empty-'));
    const result = await sortWith({
      vaultDir,
      text: 'Aman keeps the household calendar up to date.',
      model: modelReplying({
        decisions: [
          { ...newDecision('aman', 'person', 'Aman keeps the household calendar up to date.'), title: 'Aman' },
        ],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('creates a new matter page for a matter no page covers yet', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'The harbour festival entry opens next month.',
      model: modelReplying({
        decisions: [
          {
            ...newDecision('harbour-festival', 'matter', 'The harbour festival entry opens next month.'),
            title: 'Harbour festival',
          },
        ],
      }),
    });

    expect(result).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    expect(await read(vaultDir, 'matter', 'harbour-festival')).toContain(
      'The harbour festival entry opens next month.',
    );
  });
});
