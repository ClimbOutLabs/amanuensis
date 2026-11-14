import fc from 'fast-check';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FACT_SOURCES, type FactMarker } from '../../../../src/runtime/memory/memoryNotes';
import {
  addFact,
  freePageSlug,
  moveFactToEarlier,
  newMemoryPage,
  pageFacts,
  pagePath,
  parseMemoryPage,
  readMemoryPage,
  renderMemoryPage,
  stampUnmarkedBullets,
  withFactMarker,
  writeMemoryPage,
} from '../../../../src/runtime/memory/memoryPages';
import { MADRID, NORA, pageText, SECTION_NAMES, writePageFile } from './pageFixtures';

const person = { kind: 'person', title: 'Someone' } as const;
const matter = { kind: 'matter', title: 'Something' } as const;

function roundTrip(content: string, fallback: typeof person | typeof matter = person): string {
  return renderMemoryPage(parseMemoryPage({ content, fallback }));
}

const FIXTURES: Record<string, string> = {
  'a person page': NORA,
  'a matter page': MADRID,
  'a person page with Windows line endings': NORA.replace(/\n/g, '\r\n'),
  'a page with a byte order mark': `﻿${NORA}`,
  'a page with no final line break': NORA.trimEnd(),
  'a page that ends on a bare carriage return': `${NORA.trimEnd()}\r`,
  'a page with mixed line endings': NORA.replace('\n## Now', '\r\n## Now').replace('Nora\n\nThe', 'Nora\r\n\nThe'),
  'an empty file': '',
  'a single line break': '\n',
  'only a byte order mark': '﻿',
  'front matter with no closing fence': '---\nkind: person\n# Nora\n',
  'an empty front matter': '---\n---\n',
  'front matter that is not a map': '---\n- a\n- b\n---\n## Now\n- x\n',
  'a page with no headings': 'Just a note.\n- one\n- two\n',
  'broken and wrapped markers':
    '## Now\n- a <!-- fact: id=f_1 src=bank -->\n- b\n<!-- fact: id=f_2 src=you_said -->\n- c <!-- fact: id=f_3\n--> tail\n',
  'odd bullets and spacing':
    '## Now\n*   star bullet <!--   fact:   id=f_1   src=you_said   -->   \n    - indented\n-\n- \n\n\n## Notes\n- free\n',
  'a heading with extra spaces': '##  Now  \n- x <!-- fact: id=f_1 src=mail -->\n',
};

describe('renderMemoryPage', () => {
  describe('round trip', () => {
    it.each(Object.entries(FIXTURES))('returns the bytes of %s', (_name, content) => {
      expect(roundTrip(content)).toBe(content);
      expect(roundTrip(content, matter)).toBe(content);
    });

    it('returns the bytes of pages made by the fixture builder', () => {
      const text = pageText({
        front: { kind: 'person', title: 'Sam: plumber', aliases: ['a, b', '#tag'], household: false },
        summary: 'Fixes sinks.',
        facts: SECTION_NAMES.map((section, index) => ({
          section,
          text: `Fact ${String(index)}`,
          marker: { kind: 'fact', id: `f_${String(index)}`, src: 'you_said', since: '2026-03' },
        })),
      });
      expect(roundTrip(text)).toBe(text);
    });

    const piece = fc.oneof(
      fc.string({ maxLength: 40, unit: 'binary' }),
      fc.constantFrom(
        '---',
        '## Now',
        '## Earlier',
        '##  Odd ',
        '- plain bullet',
        '* star',
        '    - nested',
        '- fact <!-- fact: id=f_a1 src=you_said since=2026-03 -->',
        '- bad <!-- fact: id=f_a1 src=nope -->',
        '<!--',
        '-->',
        '# Title',
        '',
        '﻿',
        'title: x',
        'kind: matter',
      ),
    );
    const ending = fc.constantFrom('\n', '\r\n', '\n', '\r');

    it('returns the bytes of any text, however oddly shaped', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(piece, ending), { maxLength: 24 }),
          fc.boolean(),
          fc.boolean(),
          fc.constantFrom(person, matter),
          (lines, bom, finalBreak, fallback) => {
            const body = lines.map(([text, end]) => `${text}${end}`).join('');
            const content = `${bom ? '﻿' : ''}${finalBreak ? body : body.replace(/(\r?\n|\r)$/, '')}`;
            expect(roundTrip(content, fallback)).toBe(content);
          },
        ),
        { numRuns: 1000 },
      );
    });

    it('returns the bytes of any string at all', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200, unit: 'binary' }), content => {
          expect(roundTrip(content)).toBe(content);
        }),
        { numRuns: 1000 },
      );
    });

    const factDate = fc
      .tuple(fc.integer({ min: 2000, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
      .map(([y, m, d]) => `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    const marker: fc.Arbitrary<FactMarker> = fc.record(
      {
        kind: fc.constant<'fact'>('fact'),
        id: fc.stringMatching(/^f_[a-z0-9]{1,8}$/),
        src: fc.constantFrom(...FACT_SOURCES),
        since: factDate,
        until: factDate,
        seen: factDate,
      },
      { requiredKeys: ['kind', 'id', 'src'] },
    );

    it('returns the bytes of generated pages, with their facts read back unchanged', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              section: fc.constantFrom(...SECTION_NAMES),
              text: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 ,.']{0,40}$/),
              marker,
            }),
            { maxLength: 8 },
          ),
          facts => {
            const content = pageText({
              front: { kind: 'person', title: 'Nora', aliases: ['W'], household: false },
              facts,
            });
            expect(roundTrip(content)).toBe(content);
            const read = pageFacts(parseMemoryPage({ content, fallback: person })).map(at => at.fact.marker);
            const inPageOrder = SECTION_NAMES.flatMap(name => facts.filter(fact => fact.section === name));
            expect(read).toEqual(inPageOrder.map(fact => fact.marker));
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  describe('a new page', () => {
    it('reads back with its settings and returns the same bytes', () => {
      for (const title of ['Nora', 'Sam: plumber', 'yes', '#1 fan', "O'Brien", '東京']) {
        const page = addFact(newMemoryPage({ kind: 'person', title }), {
          section: 'Now',
          fact: { text: 'Likes tea.', marker: { kind: 'fact', id: 'f_1', src: 'you_said', since: '2026-11-06' } },
        });
        const text = renderMemoryPage(page);
        const read = parseMemoryPage({ content: text, fallback: { kind: 'person', title: 'wrong' } });
        expect(read.frontMatter).toEqual({ kind: 'person', title, aliases: [], household: false });
        expect(renderMemoryPage(read)).toBe(text);
      }
    });

    it('writes a matter page with a status', () => {
      const text = renderMemoryPage(newMemoryPage({ kind: 'matter', title: 'Lisbon trip' }));
      expect(text).toBe('---\nkind: matter\ntitle: Lisbon trip\naliases: []\nstatus: active\n---\n# Lisbon trip\n\n');
    });
  });

  describe('changes', () => {
    const marker = (id: string): FactMarker => ({ kind: 'fact', id, src: 'you_said', since: '2026-11-06' });

    it('adds a fact after the last line of its section and keeps the blank line that closes it', () => {
      const page = parseMemoryPage({ content: NORA, fallback: person });
      const text = renderMemoryPage(
        addFact(page, { section: 'Now', fact: { text: 'New fact.', marker: marker('f_n1') } }),
      );
      expect(text).toBe(
        NORA.replace(
          'until=2026-11-01 -->\n',
          'until=2026-11-01 -->\n- New fact. <!-- fact: id=f_n1 src=you_said since=2026-11-06 -->\n',
        ),
      );
    });

    it('creates a missing section in its usual place with a blank line between sections', () => {
      let page = newMemoryPage({ kind: 'person', title: 'Nora' });
      page = addFact(page, { section: 'Earlier', fact: { text: 'Old.', marker: marker('f_e') } });
      page = addFact(page, { section: 'How you write to them', fact: { text: 'Short.', marker: marker('f_w') } });
      page = addFact(page, { section: 'Now', fact: { text: 'Now.', marker: marker('f_n') } });
      const text = renderMemoryPage(page);
      expect(text.split('\n').slice(8)).toEqual([
        '## How you write to them',
        '- Short. <!-- fact: id=f_w src=you_said since=2026-11-06 -->',
        '',
        '## Now',
        '- Now. <!-- fact: id=f_n src=you_said since=2026-11-06 -->',
        '',
        '## Earlier',
        '- Old. <!-- fact: id=f_e src=you_said since=2026-11-06 -->',
        '',
      ]);
      expect(pageFacts(parseMemoryPage({ content: text, fallback: person })).map(at => at.fact.marker.id)).toEqual([
        'f_w',
        'f_n',
        'f_e',
      ]);
    });

    it('keeps a Windows page in Windows line endings', () => {
      const page = parseMemoryPage({ content: NORA.replace(/\n/g, '\r\n'), fallback: person });
      const text = renderMemoryPage(addFact(page, { section: 'Now', fact: { text: 'New.', marker: marker('f_n1') } }));
      expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    });

    it.each([
      ['a line break', 'one\ntwo'],
      ['a hidden comment', 'one <!-- two'],
      ['nothing', '  '],
    ])('refuses fact text with %s', (_name, text) => {
      expect(() =>
        addFact(newMemoryPage({ kind: 'person', title: 'A' }), {
          section: 'Now',
          fact: { text, marker: marker('f_x') },
        }),
      ).toThrow();
    });

    it('moves a fact to Earlier with an end date, keeping its text, id and source and dropping seen', () => {
      const page = parseMemoryPage({ content: NORA, fallback: person });
      const at = pageFacts(page).find(entry => entry.fact.marker.id === 'f_03');
      expect(at).toBeDefined();
      if (at === undefined) {
        return;
      }
      const text = renderMemoryPage(moveFactToEarlier(page, { at, until: '2026-11-06' }));
      expect(text).toBe(
        NORA.replace(
          '- Might be travelling the week of Nov 16. <!-- fact: id=f_03 src=read_content seen=2026-10-29 -->\n',
          '',
        ).replace(
          'until=2026-03 -->\n',
          'until=2026-03 -->\n- Might be travelling the week of Nov 16. <!-- fact: id=f_03 src=read_content until=2026-11-06 -->\n',
        ),
      );
    });

    it('leaves a fact that is already under Earlier where it is', () => {
      const page = parseMemoryPage({ content: NORA, fallback: person });
      const at = pageFacts(page).find(entry => entry.fact.marker.id === 'f_04');
      if (at === undefined) {
        throw new Error('fixture changed');
      }
      expect(renderMemoryPage(moveFactToEarlier(page, { at, until: '2026-11-06' }))).toBe(NORA);
    });

    it('rewrites only the marker of a line, even when the line is oddly spaced', () => {
      const content =
        '## Now\n*   Odd   spacing  <!--  fact:  id=f_1  src=you_said  -->   \n- Other <!-- fact: id=f_2 src=mail -->\n';
      const page = parseMemoryPage({ content, fallback: person });
      const [first] = pageFacts(page);
      if (first === undefined) {
        throw new Error('no fact');
      }
      const text = renderMemoryPage(
        withFactMarker(page, { at: first, marker: { ...first.fact.marker, src: 'you_edited' } }),
      );
      expect(text).toBe(
        '## Now\n*   Odd   spacing  <!-- fact: id=f_1 src=you_edited -->\n- Other <!-- fact: id=f_2 src=mail -->\n',
      );
    });

    it('gives each hand-written bullet a marker and touches nothing else', () => {
      const content =
        '# X\n- not in a section\n## Now\n- typed by hand\n  indented note\n- done <!-- fact: id=f_1 src=mail -->\n- broken <!-- fact: id=f_2 src=bank -->\n\n## Notes\n- free\n';
      const page = parseMemoryPage({ content, fallback: person });
      let n = 0;
      const stamped = stampUnmarkedBullets(page, () => {
        n += 1;
        return { kind: 'fact', id: `f_s${String(n)}`, src: 'you_edited', since: '2026-11-06' };
      });
      expect(renderMemoryPage(stamped)).toBe(
        '# X\n- not in a section\n## Now\n- typed by hand <!-- fact: id=f_s1 src=you_edited since=2026-11-06 -->\n  indented note\n- done <!-- fact: id=f_1 src=mail -->\n- broken <!-- fact: id=f_2 src=bank -->\n\n## Notes\n- free\n',
      );
    });
  });

  describe('files', () => {
    it('writes a page by temp file and rename and leaves no temp file behind', async () => {
      const vaultDir = await mkdtemp(path.join(tmpdir(), 'render-'));
      const page = addFact(newMemoryPage({ kind: 'person', title: 'Nora' }), {
        section: 'Now',
        fact: { text: 'Likes tea.', marker: { kind: 'fact', id: 'f_1', src: 'you_said' } },
      });
      await writeMemoryPage({ vaultDir, kind: 'person', slug: 'nora', page });
      expect(await readFile(pagePath({ vaultDir, kind: 'person', slug: 'nora' }), 'utf8')).toBe(renderMemoryPage(page));
      expect(await readdir(path.join(vaultDir, 'people'))).toEqual(['nora.md']);
    });

    it('chooses a free page name', async () => {
      const vaultDir = await mkdtemp(path.join(tmpdir(), 'slug-'));
      expect(await freePageSlug({ vaultDir, kind: 'person', title: 'Nora' })).toBe('nora');
      await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: NORA });
      await writePageFile({ vaultDir, kind: 'person', slug: 'nora-2', content: NORA });
      expect(await freePageSlug({ vaultDir, kind: 'person', title: 'Nora' })).toBe('nora-3');
      expect(await freePageSlug({ vaultDir, kind: 'matter', title: 'Nora' })).toBe('nora');
      expect((await readMemoryPage({ vaultDir, kind: 'person', slug: 'nora' }))?.frontMatter.title).toBe('Nora');
    });
  });
});
