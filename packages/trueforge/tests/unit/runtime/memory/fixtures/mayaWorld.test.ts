import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scanNamespaceEntries } from '../../../../../src/runtime/memory/markdownMemoryFiles';
import { SENT_MAIL_SOURCE } from '../../../../../src/runtime/memory/memoryNotes';
import { TOOL_INGESTED_ORIGIN } from '../../../../../src/runtime/memory/memoryOrigin';
import { readMemoryPage } from '../../../../../src/runtime/memory/memoryPages';
import type { ExpectedDecision } from '../../../../fixtures/memory/decisionSchema';
import { buildMayaVault, MAYA_NAMESPACE } from '../../../../fixtures/memory/mayaWorld/buildVault';
import { MAYA_ENTRIES, MAYA_STORY_IDS } from '../../../../fixtures/memory/mayaWorld/entries';
import { MAYA_EVENTS } from '../../../../fixtures/memory/mayaWorld/events';
import { MAYA_PAGES, mayaDate, mayaPageBySlug, mayaPageSlug } from '../../../../fixtures/memory/mayaWorld/pages';
import { MAYA_WORLD_DAYS } from '../../../../fixtures/memory/mayaWorld/schema';

const LAST_DAY = mayaDate(MAYA_WORLD_DAYS);

function decisions(kind: ExpectedDecision['decision']): ExpectedDecision[] {
  return MAYA_ENTRIES.flatMap(entry => entry.expected).filter(decision => decision.decision === kind);
}

async function vaultHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  // The lock folder holds who saved when, which differs between two builds of the same vault.
  const names = (await readdir(dir, { recursive: true })).filter(name => !name.includes('.memory-state')).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const content = await readFile(file).catch(() => undefined);
    if (content !== undefined) {
      hash.update(name).update(content);
    }
  }
  return hash.digest('hex');
}

describe("Maya's world", () => {
  it('covers sixty days with a realistic number of entries a day', () => {
    expect(new Set(MAYA_ENTRIES.map(entry => entry.id)).size).toBe(MAYA_ENTRIES.length);
    expect(MAYA_ENTRIES.length).toBeGreaterThanOrEqual(500);
    expect(MAYA_ENTRIES.length).toBeLessThanOrEqual(700);
    for (let day = 1; day <= MAYA_WORLD_DAYS; day += 1) {
      const ofDay = MAYA_ENTRIES.filter(entry => entry.day === day);
      expect(ofDay.length).toBeGreaterThanOrEqual(5);
      expect(ofDay.length).toBeLessThanOrEqual(15);
      // Places run 1, 2, 3 with no gap, so an id names exactly one entry of its day.
      expect(ofDay.map(entry => entry.id)).toEqual(
        ofDay.map((_, index) => `d${String(day).padStart(2, '0')}_e${String(index + 1).padStart(2, '0')}`),
      );
      expect(ofDay.every(entry => entry.timestamp.startsWith(mayaDate(day)))).toBe(true);
    }
  });

  it('holds the people, matters and ways of naming them that the tests rely on', () => {
    const titles = Object.values(MAYA_PAGES);
    expect(titles.filter(page => page.kind === 'person').length).toBeGreaterThanOrEqual(8);
    expect(titles.filter(page => page.kind === 'matter').length).toBeGreaterThanOrEqual(3);
    expect(titles.filter(page => /[^\u0000-ɏ]/.test(page.title)).length).toBeGreaterThanOrEqual(2);
    expect(new Set(titles.map(page => page.title.split(' ')[0])).size).toBeLessThan(titles.length);

    const story = MAYA_ENTRIES.filter(entry => MAYA_STORY_IDS.has(entry.id)).map(entry => entry.content);
    for (const way of ["Maya's wife", 'Nora', 'W.', 'nora@example.com']) {
      expect(story.some(content => content.includes(way))).toBe(true);
    }
  });

  it('never lets read content write what only the person may write', () => {
    for (const entry of MAYA_ENTRIES) {
      if (entry.origin !== TOOL_INGESTED_ORIGIN) {
        continue;
      }
      for (const decision of entry.expected) {
        expect(['changed', 'ended']).not.toContain(decision.decision);
        if (decision.decision === 'new') {
          // Only a message the person sent may teach how they write; nothing read lands as a plain fact.
          expect(decision.section).toBe('How you write to them');
          expect(entry.note_source).toBe(SENT_MAIL_SOURCE);
        }
      }
    }
  });

  it('names only pages that exist, of the right kind', () => {
    for (const decision of MAYA_ENTRIES.flatMap(entry => entry.expected)) {
      if (decision.decision === 'ignore') {
        continue;
      }
      const page = mayaPageBySlug(decision.about);
      expect(page).toBeDefined();
      if (decision.decision === 'new' || decision.decision === 'unconfirmed') {
        expect(decision.page_kind).toBe(page?.kind);
      }
      if (decision.decision === 'new' && decision.section === 'How you write to them') {
        expect(page?.kind).toBe('person');
      }
    }
  });

  it('tells one consistent story: every repeat, change and ending refers to a line the page holds', () => {
    const live = new Map<string, Set<string>>();
    const linesOf = (slug: string): Set<string> => {
      const lines = live.get(slug) ?? new Set<string>();
      live.set(slug, lines);
      return lines;
    };
    for (let day = 1; day <= MAYA_WORLD_DAYS; day += 1) {
      for (const entry of MAYA_ENTRIES.filter(candidate => candidate.day === day)) {
        for (const decision of entry.expected) {
          if (decision.decision === 'new') {
            expect(linesOf(decision.about).has(decision.text)).toBe(false);
            linesOf(decision.about).add(decision.text);
          } else if (decision.decision === 'same') {
            expect({ id: entry.id, held: linesOf(decision.about).has(decision.matches_text) }).toEqual({
              id: entry.id,
              held: true,
            });
          } else if (decision.decision === 'changed') {
            expect({ id: entry.id, held: linesOf(decision.about).delete(decision.old_text) }).toEqual({
              id: entry.id,
              held: true,
            });
            linesOf(decision.about).add(decision.new_text);
          } else if (decision.decision === 'ended') {
            expect({ id: entry.id, held: linesOf(decision.about).delete(decision.old_text) }).toEqual({
              id: entry.id,
              held: true,
            });
          }
        }
      }
      for (const event of MAYA_EVENTS.filter(candidate => candidate.day === day)) {
        if (event.before_line !== null) {
          expect(linesOf(event.about).delete(event.before_line)).toBe(true);
        }
        linesOf(event.about).add(event.after_line);
      }
    }
  });

  it('holds enough of each hard case', () => {
    expect(decisions('changed').length).toBeGreaterThanOrEqual(8);
    expect(decisions('same').length).toBeGreaterThanOrEqual(10);
    expect(decisions('ended').length).toBeGreaterThanOrEqual(6);
    const temporary = decisions('new').filter(
      decision => decision.decision === 'new' && decision.until !== undefined && decision.until <= LAST_DAY,
    );
    expect(temporary.length).toBeGreaterThanOrEqual(6);

    const sent = MAYA_ENTRIES.filter(
      entry => entry.origin === TOOL_INGESTED_ORIGIN && entry.note_source === SENT_MAIL_SOURCE,
    );
    expect(sent.length).toBeGreaterThanOrEqual(6);
    expect(sent.some(entry => entry.expected.some(decision => decision.decision === 'unconfirmed'))).toBe(true);
    expect(
      sent.filter(entry =>
        entry.expected.some(decision => decision.decision === 'new' && decision.section === 'How you write to them'),
      ).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('holds an instruction planted in mail, and it never becomes a fact', () => {
    const planted = MAYA_ENTRIES.filter(entry => entry.content.includes('evil.example'));
    expect(planted.length).toBeGreaterThanOrEqual(1);
    for (const entry of planted) {
      expect(entry.origin).toBe(TOOL_INGESTED_ORIGIN);
      expect(entry.expected.every(decision => ['ignore', 'unconfirmed'].includes(decision.decision))).toBe(true);
    }
  });

  it('holds a hand edit, and later read content that contradicts it without replacing it', () => {
    const edit = MAYA_EVENTS.find(event => event.day === 20);
    expect(edit?.about).toBe(mayaPageSlug('nora'));
    const contradiction = MAYA_ENTRIES.filter(
      entry => entry.day === 25 && entry.origin === TOOL_INGESTED_ORIGIN,
    ).flatMap(entry => entry.expected);
    expect(contradiction).toContainEqual(
      expect.objectContaining({ decision: 'unconfirmed', about: mayaPageSlug('nora') }),
    );
  });

  describe('written to a vault', () => {
    let dir: string;
    let again: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'maya-world-'));
      again = await mkdtemp(path.join(tmpdir(), 'maya-world-'));
      await buildMayaVault({ dir, throughDay: MAYA_WORLD_DAYS, sorted: false });
      // In two steps, as the recall test moves the world forward.
      await buildMayaVault({ dir: again, throughDay: 30, sorted: false });
      await buildMayaVault({ dir: again, fromDay: 31, throughDay: MAYA_WORLD_DAYS, sorted: false });
    }, 60_000);

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(again, { recursive: true, force: true });
    });

    it('reads back with every entry on its day', async () => {
      const scan = await scanNamespaceEntries({
        baseDir: dir,
        namespace: MAYA_NAMESPACE,
        maxDailyFiles: Number.POSITIVE_INFINITY,
      });
      expect(scan.entries).toHaveLength(MAYA_ENTRIES.length);
      for (let day = 1; day <= MAYA_WORLD_DAYS; day += 1) {
        expect(scan.entries.filter(entry => entry.file === `${mayaDate(day)}.md`)).toHaveLength(
          MAYA_ENTRIES.filter(entry => entry.day === day).length,
        );
      }
    });

    it('holds the hand-edited page as the person left it', async () => {
      const page = await readMemoryPage({
        vaultDir: path.join(dir, MAYA_NAMESPACE),
        kind: 'person',
        slug: mayaPageSlug('nora'),
      });
      expect(
        page?.sections.flatMap(section =>
          section.lines.map(line => (line.kind === 'fact' ? line.fact.text : line.raw)),
        ),
      ).toContainEqual(expect.stringContaining('shellfish and kiwi'));
    });

    it('is the same vault byte for byte however it is built', async () => {
      expect(await vaultHash(again)).toBe(await vaultHash(dir));
    });
  });
});
