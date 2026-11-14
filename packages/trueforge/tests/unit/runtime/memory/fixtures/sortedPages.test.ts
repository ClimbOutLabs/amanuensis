import { parseMemoryPage } from '../../../../../src/runtime/memory/memoryPages';
import { MAYA_EVENTS } from '../../../../fixtures/memory/mayaWorld/events';
import { mayaPageSlug } from '../../../../fixtures/memory/mayaWorld/pages';
import { MayaEntrySchema } from '../../../../fixtures/memory/mayaWorld/schema';
import { mayaSortedPages, sortedPagesFrom, type SortedPage } from '../../../../fixtures/memory/mayaWorld/sortedPages';

function readBack(page: SortedPage) {
  return parseMemoryPage({ content: page.content, fallback: { kind: page.kind, title: page.slug } });
}

function pageOf({ throughDay, slug }: { throughDay: number; slug: string }): SortedPage {
  const page = mayaSortedPages(throughDay).find(candidate => candidate.slug === slug);
  if (page === undefined) {
    throw new Error(`No page ${slug} on day ${String(throughDay)}.`);
  }
  return page;
}

/** The non-blank lines under one section. */
function linesUnder({ page, section }: { page: SortedPage; section: string }) {
  return readBack(page)
    .sections.filter(block => block.name === section)
    .flatMap(block => block.lines)
    .filter(line => line.kind !== 'other' || line.raw.trim() !== '');
}

describe('the pages a perfect sorter would write', () => {
  it.each([1, 20, 30, 60])('reads back on day %i with only marked bullets, bar the hand-typed ones', day => {
    const pages = mayaSortedPages(day);
    expect(pages.length).toBeGreaterThan(0);
    const handTyped = MAYA_EVENTS.filter(event => event.day <= day && event.before_line === null).length;
    let other = 0;
    for (const page of pages) {
      for (const section of readBack(page).sections) {
        expect(section.name).toBeDefined();
        for (const line of section.lines) {
          expect(line.kind).not.toBe('unreadable');
          if (line.kind === 'other' && line.raw.trim() !== '') {
            other += 1;
          }
        }
      }
    }
    expect(other).toBe(handTyped);
  });

  it('holds the new Madrid dates under Now and the old ones under Earlier on day 30', () => {
    const page = pageOf({ throughDay: 30, slug: mayaPageSlug('madrid') });
    const now = linesUnder({ page, section: 'Now' });
    const earlier = linesUnder({ page, section: 'Earlier' });
    expect(now).toEqual([
      expect.objectContaining({
        kind: 'fact',
        fact: expect.objectContaining({ text: 'The trip runs from October 16 to October 21.' }),
      }),
    ]);
    expect(earlier).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'fact',
          fact: expect.objectContaining({
            text: 'The trip runs from October 9 to October 14.',
            marker: expect.objectContaining({ until: '2026-08-22' }),
          }),
        }),
      ]),
    );
  });

  it('gives the plumber the alias plumber from the day he is first called that', () => {
    const slug = mayaPageSlug('samRossi');
    const before = mayaSortedPages(1).find(page => page.slug === slug);
    expect(before === undefined || !before.content.includes('  - plumber')).toBe(true);
    expect(readBack(pageOf({ throughDay: 2, slug })).frontMatter.aliases).toEqual(['plumber']);
  });

  it('changes the words of a hand edit and keeps the marker', () => {
    const slug = mayaPageSlug('nora');
    const before = pageOf({ throughDay: 19, slug }).content;
    const after = pageOf({ throughDay: 20, slug }).content;
    const marker = /Nora is allergic to shellfish\. (<!-- fact: [^>]*-->)/.exec(before)?.[1];
    expect(marker).toBeDefined();
    expect(after).toContain(`Nora is allergic to shellfish and kiwi. ${marker ?? ''}`);
    expect(after).not.toContain('allergic to shellfish. <!--');
  });

  it('gives the same bytes for the same day twice', () => {
    expect(mayaSortedPages(45)).toEqual(mayaSortedPages(45));
  });

  it('names the entry and the text when a changed fact is not on the page', () => {
    const entry = MayaEntrySchema.parse({
      id: 'd01_e01',
      day: 1,
      timestamp: '2026-08-01T09:00:00.000Z',
      session: 'chat-1',
      content: 'The plumber now comes on Fridays.',
      origin: 'user_stated',
      expected: [
        {
          decision: 'changed',
          about: mayaPageSlug('samRossi'),
          old_text: 'He comes on Thursday mornings.',
          new_text: 'He comes on Fridays.',
          until_old: '2026-08-01',
          since_new: '2026-08-01',
          reason: 'test',
        },
      ],
    });
    expect(() => sortedPagesFrom({ entries: [entry], events: [], throughDay: 1 })).toThrow(
      /d01_e01.*He comes on Thursday mornings\./,
    );
  });
});
