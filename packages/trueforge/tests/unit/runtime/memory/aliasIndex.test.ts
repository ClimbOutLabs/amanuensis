import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ALIAS_INDEX_FILE,
  AliasIndexFileSchema,
  loadAliasIndex,
  matchAliases,
  normalizeAliasText,
  type AliasIndexFile,
} from '../../../../src/runtime/memory/aliasIndex';
import { newMemoryPage, renderMemoryPage, writeMemoryPage } from '../../../../src/runtime/memory/memoryPages';

const index: AliasIndexFile = {
  version: 1,
  pages: [
    {
      kind: 'person',
      slug: 'wendy',
      title: 'Wendy',
      content_hash: 'a',
      aliases: ['Wendy', 'my wife', 'wendy@example.com', 'W.'],
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
      expect(normalizeAliasText('  Hello, José!  (wendy@example.com) ')).toBe(
        'hello josé wendy@example.com'.replace('josé', 'jose'),
      );
      expect(normalizeAliasText("Wendy's")).toBe("wendy's");
      expect(normalizeAliasText('W.')).toBe('w.');
    });
  });

  describe('apostrophes', () => {
    it('folds curly apostrophes and drops quotes around a word', () => {
      expect(normalizeAliasText('Wendy\u2019s')).toBe("wendy's");
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
      expect(matchAliases({ index, text: 'Wendy\u2019s sister' })).toEqual([
        expect.objectContaining({ slug: 'wendy', possessive: true }),
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
      expect(slugs('Is Wendy free on Saturday?')).toEqual(['wendy']);
      expect(slugs('my WIFE said yes')).toEqual(['wendy']);
      expect(slugs('mail wendy@example.com about it')).toEqual(['wendy']);
      expect(slugs('ask W. about it')).toEqual(['wendy']);
      expect(slugs('ask W about it')).toEqual(['wendy']);
    });

    it('ignores punctuation around a hit', () => {
      expect(slugs('(Wendy)')).toEqual(['wendy']);
      expect(slugs('Wendy, then')).toEqual(['wendy']);
      expect(slugs('Wendy!')).toEqual(['wendy']);
      expect(slugs('"Wendy"')).toEqual(['wendy']);
    });

    it('matches whole words only', () => {
      expect(slugs('Wendyline is a town')).toEqual([]);
      expect(slugs('the samples arrived')).toEqual([]);
      expect(slugs('moved on')).toEqual([]);
    });

    it('folds accents both ways', () => {
      expect(slugs('call Jose')).toEqual(['jose']);
      expect(slugs('call José')).toEqual(['jose']);
    });

    it('marks a possessive hit, and a direct hit anywhere wins over it', () => {
      const sister = matchAliases({ index, text: "Wendy's sister is visiting" });
      expect(sister).toEqual([expect.objectContaining({ slug: 'wendy', possessive: true })]);
      const both = matchAliases({ index, text: "Wendy's sister asked Wendy" });
      expect(both).toEqual([expect.objectContaining({ slug: 'wendy', possessive: false, position: 0 })]);
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
        { kind: 'person', slug: 'wendy', title: 'Wendy', alias: 'my wife', possessive: false, position: 7 },
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
      await writeMemoryPage({
        vaultDir,
        kind: 'person',
        slug: 'wendy',
        page: newMemoryPage({ kind: 'person', title: 'Wendy', aliases: ['my wife'], household: true }),
      });
      await writeMemoryPage({
        vaultDir,
        kind: 'matter',
        slug: 'madrid',
        page: newMemoryPage({ kind: 'matter', title: 'Madrid', aliases: ['the move'], status: 'active' }),
      });
      const loaded = await loadAliasIndex({ vaultDir, persist: true });
      expect(loaded.pages.map(page => [page.kind, page.slug, page.title, page.aliases])).toEqual([
        ['person', 'wendy', 'Wendy', ['my wife']],
        ['matter', 'madrid', 'Madrid', ['the move']],
      ]);
      const cached: unknown = JSON.parse(await readFile(path.join(vaultDir, ALIAS_INDEX_FILE), 'utf8'));
      expect(AliasIndexFileSchema.parse(cached)).toEqual(loaded);
    });

    it('reuses the cache while pages are unchanged, and rebuilds when any page changes', async () => {
      const vaultDir = await makeVault();
      const page = newMemoryPage({ kind: 'person', title: 'Wendy', aliases: ['my wife'], household: true });
      await writeMemoryPage({ vaultDir, kind: 'person', slug: 'wendy', page });
      const first = await loadAliasIndex({ vaultDir, persist: true });
      const cacheFile = path.join(vaultDir, ALIAS_INDEX_FILE);
      const tampered: AliasIndexFile = {
        ...first,
        pages: first.pages.map(entry => ({ ...entry, aliases: ['from cache'] })),
      };
      await writeFile(cacheFile, JSON.stringify(tampered));
      expect((await loadAliasIndex({ vaultDir, persist: true })).pages[0]?.aliases).toEqual(['from cache']);

      await writeMemoryPage({
        vaultDir,
        kind: 'person',
        slug: 'wendy',
        page: newMemoryPage({ kind: 'person', title: 'Wendy', aliases: ['my wife', 'W.'], household: true }),
      });
      expect((await loadAliasIndex({ vaultDir, persist: true })).pages[0]?.aliases).toEqual(['my wife', 'W.']);

      await writeMemoryPage({
        vaultDir,
        kind: 'person',
        slug: 'sam',
        page: newMemoryPage({ kind: 'person', title: 'Sam', aliases: [], household: false }),
      });
      expect((await loadAliasIndex({ vaultDir, persist: true })).pages.map(entry => entry.slug)).toEqual([
        'sam',
        'wendy',
      ]);
    });

    it('rebuilds in memory without writing when persist is off', async () => {
      const vaultDir = await makeVault();
      await writeMemoryPage({
        vaultDir,
        kind: 'person',
        slug: 'wendy',
        page: newMemoryPage({ kind: 'person', title: 'Wendy', aliases: ['my wife'], household: true }),
      });
      const loaded = await loadAliasIndex({ vaultDir });
      expect(loaded.pages.map(page => page.slug)).toEqual(['wendy']);
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
      const page = newMemoryPage({
        kind: 'person',
        title: 'Sam (plumber)',
        aliases: ['the plumber'],
        household: false,
      });
      await mkdir(path.join(vaultDir, 'people'), { recursive: true });
      await writeFile(path.join(vaultDir, 'people', 'sam-plumber.md'), renderMemoryPage(page));
      const loaded = await loadAliasIndex({ vaultDir, persist: true });
      expect(loaded.pages[0]?.title).toBe('Sam (plumber)');
    });
  });
});
