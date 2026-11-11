import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import winston from 'winston';
import { z } from 'zod';
import { createMemoryPagesRouter } from '../../../src/apis/memoryPages';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import {
  namespaceDirFor,
  sanitizeNamespace,
  vaultFilesystemNamespace,
} from '../../../src/runtime/memory/markdownMemoryFiles';
import { pagePath } from '../../../src/runtime/memory/memoryPages';
import { MADRID, WENDY, writePageFile } from '../runtime/memory/pageFixtures';

function contextFor(tenant: string): RequestContext {
  return {
    tenant_id: tenant,
    subject: { id: tenant, type: 'user', display_name: tenant },
    roles: [],
    user_credential: null,
  };
}

const LineSchema = z.object({
  id: z.string().nullable(),
  text: z.string(),
  source: z.string(),
  own: z.boolean(),
});
const PageSchema = z.object({
  title: z.string(),
  summary: z.string().nullable(),
  markdown: z.string(),
  version: z.string(),
  sections: z.array(z.object({ name: z.string(), lines: z.array(LineSchema) })),
});
const ErrorSchema = z.object({ error: z.object({ message: z.string() }) });
const ChangesSchema = z.object({
  data: z.object({
    available: z.boolean(),
    changes: z.array(
      z.object({
        id: z.string(),
        message: z.string(),
        pages: z.array(z.object({ slug: z.string() })),
        undo_blocked_by: z.string().nullable(),
      }),
    ),
  }),
});

describe('memory pages API', () => {
  const originalBackend = configuration.MEMORY_BACKEND;
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  let baseDir: string;
  let tenant = 'default';
  let app: OpenAPIHono;

  function vault(namespace?: string, forTenant = tenant): string {
    return namespaceDirFor(baseDir, vaultFilesystemNamespace(sanitizeNamespace(forTenant), namespace));
  }

  const call = (path: string, init?: RequestInit) => app.request(`/api/v1/memory/pages${path}`, init);
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function readPage(path = '/person/wendy') {
    const response = await call(path);
    expect(response.status).toBe(200);
    return PageSchema.parse(((await response.json()) as { data: unknown }).data);
  }

  async function changes() {
    return ChangesSchema.parse(await (await call('/changes')).json()).data;
  }

  async function seed() {
    await writePageFile({ vaultDir: vault(), kind: 'person', slug: 'wendy', content: WENDY });
    await writePageFile({ vaultDir: vault(), kind: 'matter', slug: 'the-madrid-move', content: MADRID });
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'pages-api-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = baseDir;
    tenant = 'default';
    app = new OpenAPIHono();
    app.route(
      '/api/v1/memory/pages',
      createMemoryPagesRouter({
        resolveRequestContext: () => contextFor(tenant),
        logger: winston.createLogger({ silent: true }),
      }),
    );
  });

  afterEach(async () => {
    configuration.MEMORY_BACKEND = originalBackend;
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  it('lists pages with summary, unconfirmed count and the files it could not read', async () => {
    await seed();
    await writeFile(join(vault(), 'people', 'Bob Smith.md'), '# Bob\n');
    const body = (await (await call('')).json()) as {
      data: { pages: Record<string, unknown>[]; skipped_files: string[] };
    };
    expect(body.data.pages.map(page => [page['kind'], page['slug'], page['title'], page['unconfirmed_count']])).toEqual(
      [
        ['person', 'wendy', 'Wendy', 1],
        ['matter', 'the-madrid-move', 'The Madrid move', 0],
      ],
    );
    expect(body.data.pages[0]?.['summary']).toBe("The owner's wife. Lives with them; plans are shared.");
    expect(body.data.pages[0]?.['other_names']).toEqual(['Wendy', 'my wife', 'wendy@example.com']);
    expect(body.data.pages[0]?.['changed_on']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.data.skipped_files).toEqual(['people/Bob Smith.md']);
  });

  it('reads a page with sources, own and read lines, and its Markdown', async () => {
    await seed();
    await writeFile(
      pagePath({ vaultDir: vault(), kind: 'person', slug: 'wendy' }),
      `${WENDY}\n## Open\n- Typed by hand\n`,
    );
    const page = await readPage();
    const lines = new Map(
      page.sections.flatMap(section =>
        section.lines.map(line => [line.text, { ...line, section: section.name }] as const),
      ),
    );
    expect(lines.get('Short and casual. No sign-off.')).toMatchObject({ source: 'sent_mail', own: true });
    expect(lines.get('Booked the movie for Saturday 7 PM.')).toMatchObject({ source: 'mail', own: false });
    expect(lines.get('Might be travelling the week of Nov 16.')).toMatchObject({ section: 'Unconfirmed', own: false });
    expect(lines.get('Worked at Acme.')).toMatchObject({ source: 'you_said', own: true });
    expect(lines.get('Typed by hand')).toMatchObject({ id: null, source: 'you_edited', own: true });
    expect(page.markdown).toContain('## Unconfirmed');
    expect((await call('/person/nobody')).status).toBe(404);
    expect((await call('/person/..%2Fx')).status).toBe(404);
  });

  it('saves an edit as one history entry and makes the new lines the person’s own', async () => {
    await seed();
    const page = await readPage();
    const edited = page.markdown
      .replace('## Now\n', '## Now\n- Likes tea in the morning.\n')
      .replace('Worked at Acme.', 'Worked at Acme Corp.');
    const response = await call('/person/wendy', json('PUT', { markdown: edited, version: page.version }));
    expect(response.status).toBe(200);
    const saved = await readPage();
    const now = saved.sections.find(section => section.name === 'Now');
    expect(now?.lines.find(line => line.text === 'Likes tea in the morning.')).toMatchObject({
      source: 'you_edited',
      own: true,
    });
    expect(now?.lines.find(line => line.text === 'Likes tea in the morning.')?.id).toMatch(/^f_/);
    const earlier = saved.sections.find(section => section.name === 'Earlier');
    expect(earlier?.lines[0]).toMatchObject({ text: 'Worked at Acme Corp.', source: 'you_edited' });
    const { changes: list } = await changes();
    expect(list[0]?.message).toBe('You: edited the page for Wendy');
    expect(list.map(change => change.message)).toContain('Your edits');
  });

  it('refuses a stale save and text that is not a page', async () => {
    await seed();
    const page = await readPage();
    await call(
      '/person/wendy',
      json('PUT', { markdown: page.markdown.replace('Acme', 'Beta'), version: page.version }),
    );
    const stale = await call('/person/wendy', json('PUT', { markdown: page.markdown, version: page.version }));
    expect(stale.status).toBe(409);
    expect(ErrorSchema.parse(await stale.json()).error.message).toContain('Reload');
    const fresh = await readPage();
    const noSettings = await call(
      '/person/wendy',
      json('PUT', { markdown: '# Wendy\n- hi\n', version: fresh.version }),
    );
    expect(noSettings.status).toBe(400);
    expect(ErrorSchema.parse(await noSettings.json()).error.message).toContain('settings');
    const noTitle = await call(
      '/person/wendy',
      json('PUT', { markdown: '---\nkind: person\n---\n# W\n', version: fresh.version }),
    );
    expect(ErrorSchema.parse(await noTitle.json()).error.message).toContain('title');
    const brokenNote = await call(
      '/person/wendy',
      json('PUT', { markdown: `${fresh.markdown}\n- bad <!-- oops\n`, version: fresh.version }),
    );
    expect(brokenNote.status).toBe(400);
    expect(ErrorSchema.parse(await brokenNote.json()).error.message).toContain('<!--');
    const blank = await call('/person/wendy', json('PUT', { markdown: '   \n', version: fresh.version }));
    expect(blank.status).toBe(400);
    const huge = await call('/person/wendy', json('PUT', { markdown: 'x'.repeat(60_001), version: fresh.version }));
    expect(huge.status).toBe(400);
    expect(
      (await call('/person/nobody', json('PUT', { markdown: fresh.markdown, version: fresh.version }))).status,
    ).toBe(404);
  });

  it('confirms a line into the chosen section as the person’s own', async () => {
    await seed();
    expect((await call('/person/wendy/lines/f_03/confirm', json('POST', { section: 'Decided' }))).status).toBe(400);
    const response = await call('/person/wendy/lines/f_03/confirm', json('POST', {}));
    expect(response.status).toBe(200);
    const page = await readPage();
    expect(page.sections.find(section => section.name === 'Unconfirmed')?.lines).toEqual([]);
    expect(page.sections.find(section => section.name === 'Now')?.lines.find(line => line.id === 'f_03')).toMatchObject(
      {
        source: 'you_edited',
        own: true,
      },
    );
    expect((await changes()).changes[0]?.message).toContain('You: confirmed Might be travelling');
    expect((await call('/person/wendy/lines/f_03/confirm', json('POST', {}))).status).toBe(404);
    const matter = await call('/matter/the-madrid-move/lines/f_12/confirm', json('POST', {}));
    expect(matter.status).toBe(404);
  });

  it('dismisses a line and deletes a page', async () => {
    await seed();
    expect((await call('/person/wendy/lines/f_03/dismiss', json('POST', {}))).status).toBe(200);
    const page = await readPage();
    expect(page.markdown).not.toContain('Might be travelling');
    expect((await changes()).changes[0]?.message).toContain('You: dismissed');
    expect((await call('/matter/the-madrid-move', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/matter/the-madrid-move')).status).toBe(404);
    expect((await call('/matter/the-madrid-move', { method: 'DELETE' })).status).toBe(404);
    expect((await changes()).changes[0]?.message).toBe('You: deleted the page for The Madrid move');
  });

  it('undoes an edit, a confirm, a dismiss and a delete', async () => {
    await seed();
    const original = await readPage();
    await call('/person/wendy/lines/f_03/confirm', json('POST', {}));
    const afterConfirm = await readPage();
    await undo(0);
    expect((await readPage()).markdown).toBe(original.markdown);

    await call('/person/wendy/lines/f_03/dismiss', json('POST', {}));
    await undo(0);
    expect((await readPage()).markdown).toBe(original.markdown);

    const base = await readPage();
    await call(
      '/person/wendy',
      json('PUT', { markdown: base.markdown.replace('Acme', 'Beta'), version: base.version }),
    );
    await undo(0);
    expect((await readPage()).markdown).toBe(original.markdown);

    await call('/matter/the-madrid-move', { method: 'DELETE' });
    await undo(0);
    expect((await call('/matter/the-madrid-move')).status).toBe(200);
    expect(await readFile(pagePath({ vaultDir: vault(), kind: 'matter', slug: 'the-madrid-move' }), 'utf8')).toContain(
      'Lease on Calle Mayor',
    );
    expect(afterConfirm.markdown).not.toBe(original.markdown);

    async function undo(index: number) {
      const target = (await changes()).changes[index];
      const response = await call(`/changes/${target?.id ?? ''}/undo`, { method: 'POST' });
      expect(response.status).toBe(200);
      expect((await changes()).changes[0]?.message).toContain('You: undid');
    }
  });

  it('refuses to undo while a later change left the page different, and allows it after that is undone', async () => {
    await seed();
    await call('/person/wendy/lines/f_03/dismiss', json('POST', {}));
    const first = (await changes()).changes[0];
    const page = await readPage();
    await call(
      '/person/wendy',
      json('PUT', { markdown: page.markdown.replace('Acme', 'Beta'), version: page.version }),
    );
    const second = (await changes()).changes[0];
    const listed = (await changes()).changes;
    expect(listed.find(change => change.id === first?.id)?.undo_blocked_by).toBe(second?.message);
    const refused = await call(`/changes/${first?.id ?? ''}/undo`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(ErrorSchema.parse(await refused.json()).error.message).toContain('Undo that change first');
    expect((await call(`/changes/${second?.id ?? ''}/undo`, { method: 'POST' })).status).toBe(200);
    expect((await call(`/changes/${first?.id ?? ''}/undo`, { method: 'POST' })).status).toBe(200);
    expect((await readPage()).markdown).toContain('Might be travelling');
    expect((await call(`/changes/${'0'.repeat(40)}/undo`, { method: 'POST' })).status).toBe(404);
    expect((await call('/changes/not-an-id/undo', { method: 'POST' })).status).toBe(400);
  });

  it('keeps persona vaults and other people’s vaults apart', async () => {
    await seed();
    await writePageFile({
      vaultDir: vault('persona:Ada'),
      kind: 'person',
      slug: 'ada-friend',
      content: WENDY.replace('Wendy', 'Zed'),
    });
    const shared = (await (await call('')).json()) as { data: { pages: { slug: string }[] } };
    expect(shared.data.pages.map(page => page.slug)).toEqual(['wendy', 'the-madrid-move']);
    const persona = (await (await call('?namespace=persona%3AAda')).json()) as { data: { pages: { slug: string }[] } };
    expect(persona.data.pages.map(page => page.slug)).toEqual(['ada-friend']);
    expect((await call('/person/wendy?namespace=persona%3AAda')).status).toBe(404);
    expect((await call('/person/wendy?namespace=persona%3AAda', { method: 'DELETE' })).status).toBe(404);
    tenant = 'someone-else';
    const other = (await (await call('')).json()) as { data: { pages: unknown[] } };
    expect(other.data.pages).toEqual([]);
    expect((await call('/person/wendy')).status).toBe(404);
    expect((await changes()).changes).toEqual([]);
  });

  it('answers not available when the store keeps no pages', async () => {
    configuration.MEMORY_BACKEND = 'hindsight';
    for (const path of ['', '/changes', '/person/wendy']) {
      const response = await call(path);
      expect(response.status).toBe(501);
      expect(ErrorSchema.parse(await response.json()).error.message).toContain('markdown memory backend');
    }
  });
});
