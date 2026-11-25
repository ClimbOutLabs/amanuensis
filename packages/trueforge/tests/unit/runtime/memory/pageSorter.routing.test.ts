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

  it('refuses a fact about Riley filed on the page of the person who reported it', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Sam told Aman that Riley prefers written agendas.',
      model: modelReplying({
        decisions: [newDecision('sam-ortiz', 'person', 'Sam told Aman that Riley prefers written agendas.')],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('refuses a fact filed as a line about writing that does not name its page’s person', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Sam told Aman the community garden permit was approved for this season.',
      model: modelReplying({
        decisions: [
          {
            decision: 'new',
            about: 'sam-ortiz',
            page_kind: 'person',
            section: 'How you write to them',
            text: 'The community garden permit was approved for this season.',
            since: DAY,
            reason,
          },
        ],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('files a line about how the person writes when the line names the person it is about', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'I write to Sam in short, plain messages.',
      model: modelReplying({
        decisions: [
          {
            decision: 'new',
            about: 'sam-ortiz',
            page_kind: 'person',
            section: 'How you write to them',
            text: 'Writes to Sam in short, plain messages.',
            since: DAY,
            reason,
          },
        ],
      }),
    });

    expect(result).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    const sam = await read(vaultDir, 'person', 'sam-ortiz');
    expect(sam).toContain('Writes to Sam in short, plain messages.');
    expect(sam).toContain('src=you_said');
    expect(sam.indexOf('## How you write to them')).toBeLessThan(sam.indexOf('Writes to Sam in short'));
  });

  it('refuses a change whose new words are not about the page’s person', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'The community garden permit was approved for this season.',
      model: modelReplying({
        decisions: [
          {
            decision: 'changed',
            about: 'sam-ortiz',
            statement_id: 'f_s01',
            new_text: 'The community garden permit was approved for this season.',
            until_old: DAY,
            since_new: DAY,
            reason,
          },
        ],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'sam-ortiz')).toBe(SAM);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('refuses a change that copies a statement its page already holds, in the same words or nearly the same', async () => {
    const vaultDir = await makeVault();
    const change = (new_text: string) => ({
      decision: 'changed',
      about: 'community-garden-permit',
      statement_id: 'f_g02',
      new_text,
      until_old: DAY,
      since_new: DAY,
      reason,
    });
    const exact = await sortWith({
      vaultDir,
      text: 'The garden plot fee is 40 a year.',
      model: modelReplying({ decisions: [change('The garden plot fee is 40 a year.')] }),
    });
    const near = await sortWith({
      vaultDir,
      text: 'The garden plot fee is 40 a year.',
      model: modelReplying({ decisions: [change('The garden plot fee is 40 per year.')] }),
    });

    expect(exact.status).toBe('refused');
    expect(near.status).toBe('refused');
    expect(await read(vaultDir, 'matter', 'community-garden-permit')).toBe(GARDEN);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('lets a change that differs only in a number stand as a change, not a copy', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'The garden plot fee is now 45 a year.',
      model: modelReplying({
        decisions: [
          {
            decision: 'changed',
            about: 'community-garden-permit',
            statement_id: 'f_g01',
            new_text: 'The garden plot fee is 45 a year.',
            until_old: DAY,
            since_new: DAY,
            reason,
          },
        ],
      }),
    });

    expect(result).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    const garden = await read(vaultDir, 'matter', 'community-garden-permit');
    expect(garden).toContain('The garden plot fee is 45 a year.');
    expect(garden).toContain('The garden plot fee is 40 a year.');
    expect(garden.indexOf('The garden plot fee is 40 a year.')).toBeGreaterThan(garden.indexOf('## Earlier'));
  });

  it('refuses one reply that files a fact and changes another statement into the same fact on a second page', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Riley now leads the garden rota.',
      model: modelReplying({
        decisions: [
          newDecision('community-garden-permit', 'matter', 'Riley now leads the garden rota.'),
          {
            decision: 'changed',
            about: 'riley-chen',
            statement_id: 'f_t01',
            new_text: 'Riley now leads the garden rota.',
            until_old: DAY,
            since_new: DAY,
            reason,
          },
        ],
      }),
    });

    expect(result.status).toBe('refused');
    expect(await read(vaultDir, 'matter', 'community-garden-permit')).toBe(GARDEN);
    expect(await read(vaultDir, 'person', 'riley-chen')).toBe(RILEY);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });

  it('reads a new line that nearly repeats a statement as the same statement', async () => {
    const vaultDir = await makeVault();
    const result = await sortWith({
      vaultDir,
      text: 'Riley runs the quiz night at the hall.',
      model: modelReplying({
        decisions: [newDecision('riley-chen', 'person', 'Riley runs the quiz night at the hall.')],
      }),
    });

    expect(result).toMatchObject({
      status: 'sorted',
      decisions: [{ decision: 'same', about: 'riley-chen', statement_id: 'f_t01' }],
    });
    const riley = await read(vaultDir, 'person', 'riley-chen');
    expect(riley.split('quiz night')).toHaveLength(2);
  });

  it('refuses a new page named with the person’s given name alone', async () => {
    const vaultDir = await mkdtemp(path.join(tmpdir(), 'sorter-routing-given-name-'));
    const titled = await sortWith({
      vaultDir,
      text: 'Alex keeps the household accounts in order.',
      model: modelReplying({
        decisions: [{ ...newDecision('alex', 'person', 'Alex keeps the household accounts in order.'), title: 'Alex' }],
      }),
    });
    const slugOnly = await sortWith({
      vaultDir,
      text: 'Alex keeps the household accounts in order.',
      model: modelReplying({
        decisions: [newDecision('alex', 'person', 'Alex keeps the household accounts in order.')],
      }),
    });

    expect(titled.status).toBe('refused');
    expect(slugOnly.status).toBe('refused');
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());
  });
});

const ROBIN = `---
kind: person
title: Robin Hale
aliases: [Robin, Robin Hale]
household: true
---
# Robin Hale

The person who owns this vault.

## Now
- Robin keeps the household accounts. <!-- fact: id=f_r01 src=you_said since=2026-09-02 -->
`;

const ALEX_FERRIS = `---
kind: person
title: Alex Ferris
aliases: [Alex, Alex Ferris]
household: false
---
# Alex Ferris

A friend who fires pottery in a shared studio.

## Now
- Alex fires pottery at the Ferry Street studio. <!-- fact: id=f_x01 src=you_said since=2026-09-10 -->
`;

const KILN = `---
kind: matter
title: Kiln repair
aliases: [the kiln]
status: active
---
# Kiln repair

The repair of the studio kiln.

## Now
- The kiln needs a new element before winter. <!-- fact: id=f_k01 src=you_said since=2026-10-01 -->
`;

async function makeAlexVault(): Promise<string> {
  const vaultDir = await mkdtemp(path.join(tmpdir(), 'sorter-routing-alex-'));
  await writePageFile({ vaultDir, kind: 'person', slug: 'robin-hale', content: ROBIN });
  await writePageFile({ vaultDir, kind: 'person', slug: 'alex-ferris', content: ALEX_FERRIS });
  await writePageFile({ vaultDir, kind: 'person', slug: 'aman', content: AMAN });
  await writePageFile({ vaultDir, kind: 'matter', slug: 'kiln-repair', content: KILN });
  return vaultDir;
}

describe('a fact a person only passed on', () => {
  it('does not file a document Alex passed on onto Alex’s page, and files a genuine fact about Alex', async () => {
    const vaultDir = await makeAlexVault();
    const identity = { personName: 'Robin Hale', assistantName: 'Aman' };

    const passedOn = await sortWith({
      vaultDir,
      identity,
      text: 'Alex forwarded the kiln repair estimate.',
      model: modelReplying({
        decisions: [newDecision('alex-ferris', 'person', 'Alex forwarded the kiln repair estimate.')],
      }),
    });
    expect(passedOn.status).toBe('refused');
    expect(await read(vaultDir, 'person', 'alex-ferris')).toBe(ALEX_FERRIS);
    expect(await readHandledNotes(vaultDir)).toEqual(new Map());

    const genuine = await sortWith({
      vaultDir,
      identity,
      text: 'Alex is training for a spring marathon.',
      model: modelReplying({
        decisions: [newDecision('alex-ferris', 'person', 'Alex is training for a spring marathon.')],
      }),
    });
    expect(genuine).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    const alex = await read(vaultDir, 'person', 'alex-ferris');
    expect(alex).toContain('Alex is training for a spring marathon.');
    expect(alex).toContain('src=you_said');

    const withTheMatter = await sortWith({
      vaultDir,
      identity,
      text: 'Alex forwarded the kiln repair estimate.',
      model: modelReplying({
        decisions: [newDecision('kiln-repair', 'matter', 'Alex forwarded the kiln repair estimate.')],
      }),
    });
    expect(withTheMatter).toMatchObject({ status: 'sorted', written: true, outcome: 'page' });
    expect(await read(vaultDir, 'matter', 'kiln-repair')).toContain('Alex forwarded the kiln repair estimate.');
    expect(await read(vaultDir, 'person', 'alex-ferris')).not.toContain('Alex forwarded the kiln repair estimate.');
  });
});
