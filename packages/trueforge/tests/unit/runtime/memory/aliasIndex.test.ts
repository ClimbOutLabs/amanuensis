import fc from 'fast-check';
import fsPromises, { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ALIAS_INDEX_FILE,
  loadAliasIndex,
  matchAliases,
  normalizeAliasText,
  type AliasIndexFile,
} from '../../../../src/runtime/memory/aliasIndex';
import type { PageFrontMatter } from '../../../../src/runtime/memory/memoryPages';
import { pageText, writePageFile } from './pageFixtures';

const index: AliasIndexFile = {
  version: 1,
  pages: [
    {
      kind: 'person',
      slug: 'nora',
      title: 'Nora',
      content_hash: 'a',
      aliases: ['Nora', 'my wife', 'nora@example.com', 'W.'],
    },
    { kind: 'person', slug: 'sam', title: 'Sam', content_hash: 'b', aliases: ['Sam'] },
    { kind: 'person', slug: 'sam-plumber', title: 'Sam (plumber)', content_hash: 'c', aliases: ['Sam', 'the plumber'] },
    { kind: 'person', slug: 'jose', title: 'José', content_hash: 'd', aliases: [] },
    {
      kind: 'matter',
      slug: 'the-madrid-move',
      title: 'The Madrid move',
      content_hash: 'e',
      aliases: ['Madrid', 'the move'],
    },
  ],
};

function slugs(text: string): string[] {
  return matchAliases({ index, text }).map(match => match.slug);
}

async function makeVault(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'alias-index-'));
}

describe('aliasIndex', () => {
  describe('normalizeAliasText', () => {
    it('lowercases, folds accents and flattens punctuation but keeps emails and possessives', () => {
      expect(normalizeAliasText('  Hello, José!  (nora@example.com) ')).toBe(
        'hello josé nora@example.com'.replace('josé', 'jose'),
      );
      expect(normalizeAliasText("Nora's")).toBe("nora's");
      expect(normalizeAliasText('W.')).toBe('w.');
    });
  });

  describe('apostrophes', () => {
    it('folds curly apostrophes and drops quotes around a word', () => {
      expect(normalizeAliasText('Nora\u2019s')).toBe("nora's");
      expect(normalizeAliasText("'Sam'")).toBe('sam');
      expect(normalizeAliasText('\u2018Sam\u2019')).toBe('sam');
      expect(normalizeAliasText("James' car")).toBe("james' car");
    });

    it('matches a name in single quotes', () => {
      expect(slugs("ask 'Sam' about it")).toContain('sam');
      expect(matchAliases({ index, text: "ask 'Sam' about it" })[0]).toEqual(
        expect.objectContaining({ slug: 'sam', possessive: false }),
      );
    });

    it('treats a curly possessive like a straight one', () => {
      expect(matchAliases({ index, text: 'Nora\u2019s sister' })).toEqual([
        expect.objectContaining({ slug: 'nora', possessive: true }),
      ]);
    });

    it('treats a bare trailing apostrophe after s as possessive', () => {
      const james: AliasIndexFile = {
        version: 1,
        pages: [{ kind: 'person', slug: 'james', title: 'James', content_hash: 'f', aliases: [] }],
      };
      expect(matchAliases({ index: james, text: "James' car" })).toEqual([
        expect.objectContaining({ slug: 'james', possessive: true }),
      ]);
      expect(matchAliases({ index: james, text: "James's car" })).toEqual([
        expect.objectContaining({ slug: 'james', possessive: true }),
      ]);
      expect(matchAliases({ index: james, text: 'James\u2019 car' })).toEqual([
        expect.objectContaining({ slug: 'james', possessive: true }),
      ]);
    });
  });

  describe('matchAliases', () => {
    it('finds a page by title, alias, email or initial, whatever the case', () => {
      expect(slugs('Is Nora free on Saturday?')).toEqual(['nora']);
      expect(slugs('my WIFE said yes')).toEqual(['nora']);
      expect(slugs('mail nora@example.com about it')).toEqual(['nora']);
      expect(slugs('ask W. about it')).toEqual(['nora']);
      expect(slugs('ask W about it')).toEqual(['nora']);
    });

    it('ignores punctuation around a hit', () => {
      expect(slugs('(Nora)')).toEqual(['nora']);
      expect(slugs('Nora, then')).toEqual(['nora']);
      expect(slugs('Nora!')).toEqual(['nora']);
      expect(slugs('"Nora"')).toEqual(['nora']);
    });

    it('matches whole words only', () => {
      expect(slugs('Noraline is a town')).toEqual([]);
      expect(slugs('the samples arrived')).toEqual([]);
      expect(slugs('moved on')).toEqual([]);
    });

    it('does not match a Latin name inside a longer word', () => {
      expect(slugs('Samantha called')).toEqual([]);
      expect(slugs('Sam called')).toEqual(['sam', 'sam-plumber']);
    });

    it('finds a name in a script written without spaces inside running text', () => {
      const names: AliasIndexFile = {
        version: 1,
        pages: [
          { kind: 'person', slug: 'tanaka', title: '田中', content_hash: 'f', aliases: ['たなか'] },
          { kind: 'person', slug: 'kim', title: '김민수', content_hash: 'g', aliases: [] },
          { kind: 'person', slug: 'somchai', title: 'สมชาย', content_hash: 'h', aliases: [] },
        ],
      };
      const found = (text: string) => matchAliases({ index: names, text }).map(match => match.slug);
      expect(found('田中さんに会った')).toEqual(['tanaka']);
      expect(found('今日はたなかさんと話した')).toEqual(['tanaka']);
      expect(found('김민수씨를 만났어요')).toEqual(['kim']);
      expect(found('วันนี้เจอสมชายที่ตลาด')).toEqual(['somchai']);
      expect(found('山田さんに会った')).toEqual([]);
    });

    it('does not mix up names that differ only by a letter or a mark outside Latin', () => {
      const names: AliasIndexFile = {
        version: 1,
        pages: [
          { kind: 'person', slug: 'min-su', title: '민수', content_hash: 'a', aliases: [] },
          { kind: 'person', slug: 'haru', title: 'ハル', content_hash: 'b', aliases: [] },
          { kind: 'person', slug: 'jon', title: 'ジョン', content_hash: 'c', aliases: [] },
          { kind: 'person', slug: 'ka', title: 'ก', content_hash: 'd', aliases: [] },
        ],
      };
      const found = (text: string) => matchAliases({ index: names, text }).map(match => match.slug);
      expect(found('민숙 씨를 만났어요')).toEqual([]);
      expect(found('민수 씨를 만났어요')).toEqual(['min-su']);
      expect(found('バルに会った')).toEqual([]);
      expect(found('ハルに会った')).toEqual(['haru']);
      expect(found('ションに会った')).toEqual([]);
      expect(found('ジョンに会った')).toEqual(['jon']);
      expect(found('กขค')).toEqual(['ka']);
      expect(found('ก็ได้')).toEqual([]);
    });

    it('lets the longest name in the index take a span in a script written without spaces', () => {
      const names: AliasIndexFile = {
        version: 1,
        pages: [
          { kind: 'person', slug: 'nid', title: 'นิด', content_hash: 'a', aliases: [] },
          { kind: 'person', slug: 'nida', title: 'นิดา', content_hash: 'b', aliases: [] },
          { kind: 'person', slug: 'tanaka', title: '田中', content_hash: 'c', aliases: [] },
          { kind: 'person', slug: 'tanaka-ko', title: '田中子', content_hash: 'd', aliases: [] },
        ],
      };
      const found = (text: string) => matchAliases({ index: names, text }).map(match => match.slug);
      expect(found('วันนี้เจอนิดาที่ตลาด')).toEqual(['nida']);
      expect(found('วันนี้เจอนิดที่ตลาด')).toEqual(['nid']);
      expect(found('นิด และ นิดา')).toEqual(['nid', 'nida']);
      expect(found('田中子さんに会った')).toEqual(['tanaka-ko']);
      expect(found('田中さんに会った')).toEqual(['tanaka']);
    });

    it('matches a name typed in decomposed form against its composed form', () => {
      const names: AliasIndexFile = {
        version: 1,
        pages: [{ kind: 'person', slug: 'kim', title: '김민수', content_hash: 'a', aliases: [] }],
      };
      expect(matchAliases({ index: names, text: '김민수씨'.normalize('NFD') }).map(match => match.slug)).toEqual([
        'kim',
      ]);
    });

    it('keeps the letters of Devanagari words so each name is one whole word', () => {
      const names: AliasIndexFile = {
        version: 1,
        pages: [{ kind: 'person', slug: 'priya', title: 'प्रिया', content_hash: 'a', aliases: [] }],
      };
      expect(matchAliases({ index: names, text: 'आज प्रिया आई' }).map(match => match.slug)).toEqual(['priya']);
      expect(matchAliases({ index: names, text: 'आज प्रियांका आई' })).toEqual([]);
    });

    it('never throws and always returns text that normalises to itself', () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), text => {
          const once = normalizeAliasText(text);
          expect(normalizeAliasText(once)).toBe(once);
        }),
        { numRuns: 300 },
      );
    });

    it('folds accents both ways', () => {
      expect(slugs('call Jose')).toEqual(['jose']);
      expect(slugs('call José')).toEqual(['jose']);
    });

    it('marks a possessive hit, and a direct hit anywhere wins over it', () => {
      const sister = matchAliases({ index, text: "Nora's sister is visiting" });
      expect(sister).toEqual([expect.objectContaining({ slug: 'nora', possessive: true })]);
      const both = matchAliases({ index, text: "Nora's sister asked Nora" });
      expect(both).toEqual([expect.objectContaining({ slug: 'nora', possessive: false, position: 0 })]);
    });

    it('returns every page an alias is shared by, ordered by first appearance', () => {
      expect(slugs('Sam called about the move')).toEqual(['sam', 'sam-plumber', 'the-madrid-move']);
      expect(slugs('The plumber, Sam, came by')).toEqual(['sam-plumber', 'sam']);
    });

    it('matches multi-word aliases across punctuation and case', () => {
      expect(slugs('Where are we on the Madrid thing? And THE MOVE?')).toEqual(['the-madrid-move']);
    });

    it('reports the alias that hit and where', () => {
      expect(matchAliases({ index, text: 'Hi. Is my wife home?' })).toEqual([
        { kind: 'person', slug: 'nora', title: 'Nora', alias: 'my wife', possessive: false, position: 7 },
      ]);
    });

    it('finds nothing in an empty or unrelated message', () => {
      expect(slugs('')).toEqual([]);
      expect(slugs('What is the weather?')).toEqual([]);
    });
  });

  describe('loadAliasIndex', () => {
    it('builds the index from the pages and writes the cache', async () => {
      const vaultDir = await makeVault();
      await writePageFile({
        vaultDir,
        kind: 'person',
        slug: 'nora',
        content: pageText({ front: { kind: 'person', title: 'Nora', aliases: ['my wife'], household: true } }),
      });
      await writePageFile({
        vaultDir,
        kind: 'matter',
        slug: 'madrid',
        content: pageText({ front: { kind: 'matter', title: 'Madrid', aliases: ['the move'], status: 'active' } }),
      });
      const loaded = await loadAliasIndex({ vaultDir, persist: true });
      expect(loaded.pages.map(page => [page.kind, page.slug, page.title, page.aliases])).toEqual([
        ['person', 'nora', 'Nora', ['my wife']],
        ['matter', 'madrid', 'Madrid', ['the move']],
      ]);
      const cached: unknown = JSON.parse(await readFile(path.join(vaultDir, ALIAS_INDEX_FILE), 'utf8'));
      expect(cached).toEqual(loaded);
    });

    it('reuses the cache while pages are unchanged, and rebuilds when any page changes', async () => {
      const vaultDir = await makeVault();
      const front: PageFrontMatter = { kind: 'person', title: 'Nora', aliases: ['my wife'], household: true };
      await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: pageText({ front }) });
      const first = await loadAliasIndex({ vaultDir, persist: true });
      const cacheFile = path.join(vaultDir, ALIAS_INDEX_FILE);
      const tampered: AliasIndexFile = {
        ...first,
        pages: first.pages.map(entry => ({ ...entry, aliases: ['from cache'] })),
      };
      await writeFile(cacheFile, JSON.stringify(tampered));
      expect((await loadAliasIndex({ vaultDir, persist: true })).pages[0]?.aliases).toEqual(['from cache']);

      await writePageFile({
        vaultDir,
        kind: 'person',
        slug: 'nora',
        content: pageText({ front: { kind: 'person', title: 'Nora', aliases: ['my wife', 'W.'], household: true } }),
      });
      expect((await loadAliasIndex({ vaultDir, persist: true })).pages[0]?.aliases).toEqual(['my wife', 'W.']);

      await writePageFile({
        vaultDir,
        kind: 'person',
        slug: 'sam',
        content: pageText({ front: { kind: 'person', title: 'Sam', aliases: [], household: false } }),
      });
      expect((await loadAliasIndex({ vaultDir, persist: true })).pages.map(entry => entry.slug)).toEqual([
        'nora',
        'sam',
      ]);
    });

    describe('hashing pages', () => {
      const front: PageFrontMatter = { kind: 'person', title: 'Nora', aliases: ['my wife'], household: true };

      afterEach(() => {
        jest.restoreAllMocks();
      });

      function pageReads(readFileSpy: jest.SpyInstance, file: string): number {
        return readFileSpy.mock.calls.filter(call => call[0] === file).length;
      }

      /** Loads the index as if a minute had passed since the files were last changed, so their hashes may be reused. */
      async function loadSettled(vaultDir: string): Promise<AliasIndexFile> {
        const realNow = Date.now();
        const now = jest.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
        try {
          return await loadAliasIndex({ vaultDir, persist: true });
        } finally {
          now.mockRestore();
        }
      }

      it('does not read a page again while its size and timestamps are unchanged', async () => {
        const vaultDir = await makeVault();
        const file = path.join(vaultDir, 'people', 'nora.md');
        await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: pageText({ front }) });
        await loadSettled(vaultDir);
        const readFileSpy = jest.spyOn(fsPromises, 'readFile');
        await loadAliasIndex({ vaultDir, persist: true });
        await loadAliasIndex({ vaultDir, persist: true });
        expect(pageReads(readFileSpy, file)).toBe(0);
      });

      it('sees a page that changed, even to the same size', async () => {
        const vaultDir = await makeVault();
        const file = path.join(vaultDir, 'people', 'nora.md');
        await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: pageText({ front }) });
        await loadSettled(vaultDir);
        const original = await readFile(file, 'utf8');
        await writeFile(file, original.replace('my wife', 'my mate'));
        const edited = await loadAliasIndex({ vaultDir, persist: true });
        expect(edited.pages[0]?.aliases).toEqual(['my mate']);
      });

      it('sees a same-size edit whose modification time was set back', async () => {
        const vaultDir = await makeVault();
        const file = path.join(vaultDir, 'people', 'nora.md');
        await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: pageText({ front }) });
        const old = new Date(Date.now() - 60_000);
        await utimes(file, old, old);
        await loadSettled(vaultDir);
        const original = await readFile(file, 'utf8');
        await writeFile(file, original.replace('my wife', 'my mate'));
        await utimes(file, old, old);
        const edited = await loadAliasIndex({ vaultDir, persist: true });
        expect(edited.pages[0]?.aliases).toEqual(['my mate']);
      });

      it('reads a page that was changed a moment ago every time, because its timestamp may be coarse', async () => {
        const vaultDir = await makeVault();
        const file = path.join(vaultDir, 'people', 'nora.md');
        await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: pageText({ front }) });
        await loadAliasIndex({ vaultDir, persist: true });
        const readFileSpy = jest.spyOn(fsPromises, 'readFile');
        await loadAliasIndex({ vaultDir, persist: true });
        expect(pageReads(readFileSpy, file)).toBeGreaterThan(0);
      });

      it('drops a page that was deleted', async () => {
        const vaultDir = await makeVault();
        const file = path.join(vaultDir, 'people', 'nora.md');
        await writePageFile({ vaultDir, kind: 'person', slug: 'nora', content: pageText({ front }) });
        await loadSettled(vaultDir);
        await rm(file);
        expect((await loadAliasIndex({ vaultDir, persist: true })).pages).toEqual([]);
      });

      it('keeps hashes for a bounded number of vaults, and a turn only touches the vaults it reads', async () => {
        const first = await makeVault();
        const file = path.join(first, 'people', 'nora.md');
        await writePageFile({ vaultDir: first, kind: 'person', slug: 'nora', content: pageText({ front }) });
        await loadSettled(first);
        for (let count = 0; count < 70; count++) {
          const other = await makeVault();
          await writePageFile({ vaultDir: other, kind: 'person', slug: 'nora', content: pageText({ front }) });
          await loadSettled(other);
        }
        const readFileSpy = jest.spyOn(fsPromises, 'readFile');
        await loadAliasIndex({ vaultDir: first, persist: true });
        expect(pageReads(readFileSpy, file)).toBeGreaterThan(0);
      });
    });

    it('rebuilds in memory without writing when persist is off', async () => {
      const vaultDir = await makeVault();
      await writePageFile({
        vaultDir,
        kind: 'person',
        slug: 'nora',
        content: pageText({ front: { kind: 'person', title: 'Nora', aliases: ['my wife'], household: true } }),
      });
      const loaded = await loadAliasIndex({ vaultDir });
      expect(loaded.pages.map(page => page.slug)).toEqual(['nora']);
      expect(await readdir(vaultDir)).toEqual(['people']);
    });

    it('never creates the vault folder or a state folder for a vault with no pages', async () => {
      const parent = await makeVault();
      const missing = path.join(parent, 'ghost');
      expect(await loadAliasIndex({ vaultDir: missing, persist: true })).toEqual({ version: 1, pages: [] });
      expect(await readdir(parent)).toEqual([]);
      const bare = path.join(parent, 'bare');
      await mkdir(bare);
      expect(await loadAliasIndex({ vaultDir: bare, persist: true })).toEqual({ version: 1, pages: [] });
      expect(await readdir(bare)).toEqual([]);
    });

    it('rebuilds from an unreadable cache and from a page with no front matter', async () => {
      const vaultDir = await makeVault();
      await mkdir(path.join(vaultDir, '.memory-state'), { recursive: true });
      await writeFile(path.join(vaultDir, ALIAS_INDEX_FILE), '{not json');
      await mkdir(path.join(vaultDir, 'people'), { recursive: true });
      await writeFile(path.join(vaultDir, 'people', 'sam-plumber.md'), '- fixed the sink\n');
      const loaded = await loadAliasIndex({ vaultDir, persist: true });
      expect(loaded.pages).toEqual([
        expect.objectContaining({ kind: 'person', slug: 'sam-plumber', title: 'sam-plumber', aliases: [] }),
      ]);
    });

    it('is empty for a vault with no pages and does not need a state folder first', async () => {
      const vaultDir = await makeVault();
      expect(await loadAliasIndex({ vaultDir, persist: true })).toEqual({ version: 1, pages: [] });
    });

    it('indexes what a rendered page says, not what the file name says', async () => {
      const vaultDir = await makeVault();
      const content = pageText({
        front: { kind: 'person', title: 'Sam (plumber)', aliases: ['the plumber'], household: false },
      });
      await mkdir(path.join(vaultDir, 'people'), { recursive: true });
      await writeFile(path.join(vaultDir, 'people', 'sam-plumber.md'), content);
      const loaded = await loadAliasIndex({ vaultDir, persist: true });
      expect(loaded.pages[0]?.title).toBe('Sam (plumber)');
    });
  });
});
