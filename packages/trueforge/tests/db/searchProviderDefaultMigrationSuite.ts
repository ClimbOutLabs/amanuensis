/**
 * Shared scenarios for `20261016_000004_search_provider_default`, run against SQLite and Postgres.
 * Every name, URL and value here is invented.
 */

export const PREVIOUS_MIGRATION = '20261011_000001_sentinel_search_without_asking';

export interface StoredManifest {
  [key: string]: unknown;
}

export interface SearchProviderMigrationHarness {
  /** Inserts a connector row while the schema is still at the previous migration. */
  insert(row: { id: string; tenant_id: string; name: string; manifest: StoredManifest }): Promise<void>;
  /** Runs the migration under test (and anything after it). */
  migrate(): Promise<void>;
  manifestOf(id: string): Promise<StoredManifest>;
  teardown(): Promise<void>;
}

const PARALLEL_URL = 'https://search.parallel.ai/mcp';

function remote({ name, url, ...rest }: { name: string; url: string } & StoredManifest): StoredManifest {
  return { type: 'remote', name, url, description: `${name} for tests.`, ...rest };
}

export function runSearchProviderDefaultMigrationSuite({
  describeFn,
  setup,
}: {
  describeFn: jest.Describe;
  setup: () => Promise<SearchProviderMigrationHarness>;
}): void {
  describeFn('search provider default migration', () => {
    let h: SearchProviderMigrationHarness;

    beforeEach(async () => {
      h = await setup();
    }, 120_000);

    afterEach(async () => {
      await h.teardown();
    });

    it('designates a legacy connector at a search preset endpoint and fills its search tools', async () => {
      const manifest = remote({
        name: 'parallel-web',
        url: PARALLEL_URL,
        auth: { type: 'header', headers: { 'x-invented': 'placeholder' } },
      });
      await h.insert({ id: 'c1', tenant_id: 't1', name: 'parallel-web', manifest });
      await h.migrate();
      expect(await h.manifestOf('c1')).toEqual({
        ...manifest,
        search_provider: true,
        search_tools: ['web_search', 'web_fetch'],
      });
    });

    it('links by endpoint, not by the name the user gave it or a key in the query string', async () => {
      await h.insert({
        id: 'c1',
        tenant_id: 't1',
        name: 'my-finder',
        manifest: remote({ name: 'my-finder', url: `${PARALLEL_URL}/?key=invented` }),
      });
      await h.migrate();
      expect(await h.manifestOf('c1')).toMatchObject({
        search_provider: true,
        search_tools: ['web_search', 'web_fetch'],
      });
    });

    it('leaves a provider the user chose, and every other connector, untouched', async () => {
      const chosen = remote({
        name: 'own-search',
        url: 'https://search.invented.example/mcp',
        search_provider: true,
        search_tools: ['own_tool'],
      });
      const legacy = remote({ name: 'parallel-web', url: PARALLEL_URL });
      await h.insert({ id: 'chosen', tenant_id: 't1', name: 'own-search', manifest: chosen });
      await h.insert({ id: 'legacy', tenant_id: 't1', name: 'parallel-web', manifest: legacy });
      await h.migrate();
      expect(await h.manifestOf('chosen')).toEqual(chosen);
      expect(await h.manifestOf('legacy')).toEqual(legacy);
    });

    it('never re-designates a connector the user turned off', async () => {
      const off = remote({ name: 'parallel-web', url: PARALLEL_URL, search_provider: false });
      await h.insert({ id: 'off', tenant_id: 't1', name: 'parallel-web', manifest: off });
      await h.migrate();
      expect(await h.manifestOf('off')).toEqual(off);
    });

    it('treats an explicit off anywhere in the tenant as the user’s choice, for the whole tenant', async () => {
      const off = remote({ name: 'other-search', url: 'https://search.invented.example/mcp', search_provider: false });
      const legacy = remote({ name: 'parallel-web', url: PARALLEL_URL });
      await h.insert({ id: 'off', tenant_id: 't1', name: 'other-search', manifest: off });
      await h.insert({ id: 'legacy', tenant_id: 't1', name: 'parallel-web', manifest: legacy });
      await h.migrate();
      expect(await h.manifestOf('legacy')).toEqual(legacy);
    });

    it('decides each tenant on its own', async () => {
      const chosen = remote({ name: 'parallel-web', url: PARALLEL_URL, search_provider: false });
      await h.insert({
        id: 'a',
        tenant_id: 'tenant-a',
        name: 'parallel-web',
        manifest: remote({ name: 'parallel-web', url: PARALLEL_URL }),
      });
      await h.insert({ id: 'b', tenant_id: 'tenant-b', name: 'parallel-web', manifest: chosen });
      await h.migrate();
      expect(await h.manifestOf('a')).toMatchObject({ search_provider: true });
      expect(await h.manifestOf('b')).toEqual(chosen);
    });

    it('designates at most one connector per tenant', async () => {
      await h.insert({
        id: 'one',
        tenant_id: 't1',
        name: 'a-copy',
        manifest: remote({ name: 'a-copy', url: PARALLEL_URL }),
      });
      await h.insert({
        id: 'two',
        tenant_id: 't1',
        name: 'b-copy',
        manifest: remote({ name: 'b-copy', url: `${PARALLEL_URL}/` }),
      });
      await h.migrate();
      const flags = [await h.manifestOf('one'), await h.manifestOf('two')].map(manifest => manifest['search_provider']);
      expect(flags.filter(flag => flag === true)).toHaveLength(1);
      expect(flags[0]).toBe(true);
    });

    it('does not touch a connector that is no search preset, or a tenant without a match', async () => {
      const other = remote({ name: 'notes', url: 'https://notes.invented.example/mcp' });
      await h.insert({ id: 'other', tenant_id: 't1', name: 'notes', manifest: other });
      await h.migrate();
      expect(await h.manifestOf('other')).toEqual(other);
    });
  });
}
