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
import { listDisagreements } from '../../../src/runtime/memory/pageDisagreements';
import { modelAnswering, silentLogger } from '../runtime/memory/nightlyTestKit';
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
  source_label: z.string(),
  own: z.boolean(),
});
const PageSchema = z.object({
  title: z.string(),
  summary: z.string().nullable(),
  text: z.string(),
  confirmable_sections: z.array(z.string()),
  version: z.string(),
  sections: z.array(z.object({ name: z.string(), lines: z.array(LineSchema) })),
});
const ErrorSchema = z.object({ error: z.object({ message: z.string() }) });
const DataSchema = z.object({ data: z.unknown() });
const PageListSchema = z.object({
  data: z.object({ pages: z.array(z.record(z.string(), z.unknown())), skipped_files: z.array(z.string()) }),
});
const ChangesSchema = z.object({
  data: z.object({
    available: z.boolean(),
    changes: z.array(
      z.object({
        id: z.string(),
        message: z.string(),
        pages: z.array(z.object({ slug: z.string() })),
        undo_blocked_by: z.string().nullable(),
        is_undo: z.boolean(),
      }),
    ),
  }),
});

describe('memory pages API', () => {
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
    return PageSchema.parse(DataSchema.parse(await response.json()).data);
  }

  function fileText(slug = 'wendy') {
    return readFile(pagePath({ vaultDir: vault(), kind: 'person', slug }), 'utf8');
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
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  it('lists pages with summary and the files it could not read', async () => {
    await seed();
    await writeFile(join(vault(), 'people', 'Bob Smith.md'), '# Bob\n');
    const body = PageListSchema.parse(await (await call('')).json());
    expect(body.data.pages.map(page => [page['kind'], page['slug'], page['title']])).toEqual([
      ['person', 'wendy', 'Wendy'],
      ['matter', 'the-madrid-move', 'The Madrid move'],
    ]);
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
    expect(lines.get('Short and casual. No sign-off.')).toMatchObject({
      source: 'sent_mail',
      source_label: 'External source: a message you sent',
      own: true,
    });
    expect(lines.get('Booked the movie for Saturday 7 PM.')).toMatchObject({
      source: 'mail',
      source_label: 'External source: email',
      own: false,
    });
    expect(lines.get('Might be travelling the week of Nov 16.')).toMatchObject({
      section: 'Unconfirmed',
      source_label: 'External source: read content',
      own: false,
    });
    expect(lines.get('Worked at Acme.')).toMatchObject({ source: 'you_said', source_label: 'From you', own: true });
    expect(lines.get('Typed by hand')).toMatchObject({
      id: null,
      source: 'you_edited',
      source_label: 'From you',
      own: true,
    });
    expect(page.text).toContain('## Unconfirmed');
    expect(page.confirmable_sections).toEqual(['How you write to them', 'Now']);
    expect((await call('/person/nobody')).status).toBe(404);
    expect((await call('/person/..%2Fx')).status).toBe(404);
  });

  it('labels a line the way a note names its source: "From you" or "External source: ..."', async () => {
    await seed();
    await writeFile(
      pagePath({ vaultDir: vault(), kind: 'person', slug: 'wendy' }),
      `${WENDY}\n## Open\n- Guessed. <!-- fact: id=f_20 src=inferred seen=2026-10-29 -->\n- On the calendar. <!-- fact: id=f_21 src=calendar since=2026-10-29 -->\n- Edited by you. <!-- fact: id=f_22 src=you_edited since=2026-10-29 -->\n`,
    );
    const page = await readPage();
    const labels = new Map(page.sections.flatMap(section => section.lines.map(line => [line.text, line.source_label])));
    expect(labels.get('Guessed.')).toBe('External source: Aman’s guess');
    expect(labels.get('On the calendar.')).toBe('External source: calendar');
    expect(labels.get('Edited by you.')).toBe('From you');
  });

  it('saves an edit as one history entry and makes the new lines the person’s own', async () => {
    await seed();
    const page = await readPage();
    const edited = page.text
      .replace('## Now\n', '## Now\n- Likes tea in the morning.\n')
      .replace('Worked at Acme.', 'Worked at Acme Corp.');
    const response = await call('/person/wendy', json('PUT', { text: edited, version: page.version }));
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

  it('shows the page for editing without its settings or hidden notes', async () => {
    await seed();
    const { text } = await readPage();
    expect(text.startsWith('# Wendy\n')).toBe(true);
    expect(text).not.toContain('---');
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('household');
    expect(text).toContain('## Unconfirmed\n- Might be travelling the week of Nov 16.\n');
  });

  it('keeps the source, id and dates of every line the person left alone', async () => {
    await seed();
    const before = await fileText();
    const page = await readPage();
    const response = await call(
      '/person/wendy',
      json('PUT', {
        text: page.text.replace('## Now\n', '## Now\n- Likes tea in the morning.\n'),
        version: page.version,
      }),
    );
    expect(response.status).toBe(200);
    const after = await fileText();
    for (const line of before.split('\n').filter(stored => stored.includes('<!-- fact:'))) {
      expect(after).toContain(`${line}\n`);
    }
    expect(after.startsWith(before.slice(0, before.indexOf('# Wendy')))).toBe(true);
    const saved = await readPage();
    const unconfirmed = saved.sections.find(section => section.name === 'Unconfirmed');
    expect(unconfirmed?.lines[0]).toMatchObject({ id: 'f_03', source: 'read_content', own: false });
  });

  it('keeps a line’s source when the person moves it to another section', async () => {
    await seed();
    const page = await readPage();
    const moved = page.text
      .replace('- Might be travelling the week of Nov 16.\n', '')
      .replace('## Now\n', '## Now\n- Might be travelling the week of Nov 16.\n');
    expect((await call('/person/wendy', json('PUT', { text: moved, version: page.version }))).status).toBe(200);
    const now = (await readPage()).sections.find(section => section.name === 'Now');
    expect(now?.lines.find(line => line.id === 'f_03')).toMatchObject({ source: 'read_content', own: false });
  });

  it('makes a reworded line the person’s own and leaves a twin line its own source', async () => {
    await writePageFile({
      vaultDir: vault(),
      kind: 'person',
      slug: 'wendy',
      content: `${WENDY}- Twin line. <!-- fact: id=f_30 src=you_said since=2026-01 -->\n\n## Open\n- Twin line. <!-- fact: id=f_31 src=mail since=2026-02 -->\n`,
    });
    const page = await readPage();
    const response = await call(
      '/person/wendy',
      json('PUT', {
        text: page.text.replace('Might be travelling the week of Nov 16.', 'Travelling the week of Nov 16.'),
        version: page.version,
      }),
    );
    expect(response.status).toBe(200);
    const saved = await readPage();
    const lineIn = (name: string, text: string) =>
      saved.sections.find(section => section.name === name)?.lines.find(line => line.text === text);
    expect(lineIn('Unconfirmed', 'Travelling the week of Nov 16.')).toMatchObject({ source: 'you_edited' });
    expect(lineIn('Unconfirmed', 'Travelling the week of Nov 16.')?.id).not.toBe('f_03');
    expect(lineIn('Earlier', 'Twin line.')).toMatchObject({ id: 'f_30', source: 'you_said' });
    expect(lineIn('Open', 'Twin line.')).toMatchObject({ id: 'f_31', source: 'mail' });
  });

  it('never turns a line with a broken hidden note into the person’s own', async () => {
    await writePageFile({
      vaultDir: vault(),
      kind: 'person',
      slug: 'wendy',
      content: `${WENDY}- Note on the next line.\n<!-- fact: id=f_40 src=mail since=2026-02 -->\n- Broken note. <!-- fact: id= -->\n`,
    });
    const page = await readPage();
    expect(page.text).toContain('- Note on the next line.\n- Broken note.\n');
    const response = await call(
      '/person/wendy',
      json('PUT', { text: page.text.replace('## Now\n', '## Now\n- Likes tea.\n'), version: page.version }),
    );
    expect(response.status).toBe(200);
    const earlier = (await readPage()).sections.find(section => section.name === 'Earlier');
    expect(earlier?.lines.find(line => line.text === 'Note on the next line.')).toMatchObject({
      source: 'unreadable',
      own: false,
    });
    expect(earlier?.lines.find(line => line.text === 'Broken note.')).toMatchObject({
      source: 'unreadable',
      own: false,
    });
  });

  it('renames the page from its first line and puts a missing name line back', async () => {
    await seed();
    const page = await readPage();
    const renamed = await call(
      '/person/wendy',
      json('PUT', { text: page.text.replace('# Wendy', '# Wendy Smith'), version: page.version }),
    );
    expect(renamed.status).toBe(200);
    const saved = await readPage();
    expect(saved.title).toBe('Wendy Smith');
    expect(await fileText()).toContain('title: Wendy Smith\n');
    expect(await fileText()).toContain('aliases: [Wendy, my wife, wendy@example.com]\n');
    const unnamed = await call(
      '/person/wendy',
      json('PUT', { text: saved.text.replace('# Wendy Smith\n', ''), version: saved.version }),
    );
    expect(unnamed.status).toBe(200);
    expect((await readPage()).text.startsWith('# Wendy Smith\n')).toBe(true);
  });

  it('refuses a stale save and text that is not a page', async () => {
    await seed();
    const page = await readPage();
    await call('/person/wendy', json('PUT', { text: page.text.replace('Acme', 'Beta'), version: page.version }));
    const stale = await call('/person/wendy', json('PUT', { text: page.text, version: page.version }));
    expect(stale.status).toBe(409);
    expect(ErrorSchema.parse(await stale.json()).error.message).toContain('Reload');
    const fresh = await readPage();
    const hiddenNote = await call(
      '/person/wendy',
      json('PUT', { text: `${fresh.text}\n- bad <!-- oops\n`, version: fresh.version }),
    );
    expect(hiddenNote.status).toBe(400);
    expect(ErrorSchema.parse(await hiddenNote.json()).error.message).toContain('<!--');
    const noteEnd = await call(
      '/person/wendy',
      json('PUT', { text: `${fresh.text}\n- bad --> oops\n`, version: fresh.version }),
    );
    expect(noteEnd.status).toBe(400);
    const noName = await call(
      '/person/wendy',
      json('PUT', { text: fresh.text.replace('# Wendy', '# '), version: fresh.version }),
    );
    expect(noName.status).toBe(400);
    expect(ErrorSchema.parse(await noName.json()).error.message).toContain('no name');
    const blank = await call('/person/wendy', json('PUT', { text: '   \n', version: fresh.version }));
    expect(blank.status).toBe(400);
    const huge = await call('/person/wendy', json('PUT', { text: 'x'.repeat(60_001), version: fresh.version }));
    expect(huge.status).toBe(400);
    expect((await call('/person/nobody', json('PUT', { text: fresh.text, version: fresh.version }))).status).toBe(404);
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
    expect(page.text).not.toContain('Might be travelling');
    expect((await changes()).changes[0]?.message).toContain('You: dismissed');
    expect((await call('/matter/the-madrid-move', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/matter/the-madrid-move')).status).toBe(404);
    expect((await call('/matter/the-madrid-move', { method: 'DELETE' })).status).toBe(404);
    expect((await changes()).changes[0]?.message).toBe('You: deleted the page for The Madrid move');
  });

  it('undoes an edit, a confirm, a dismiss and a delete', async () => {
    await seed();
    const original = await fileText();
    await call('/person/wendy/lines/f_03/confirm', json('POST', {}));
    const afterConfirm = await fileText();
    await undo(0);
    expect(await fileText()).toBe(original);

    await call('/person/wendy/lines/f_03/dismiss', json('POST', {}));
    await undo(0);
    expect(await fileText()).toBe(original);

    const base = await readPage();
    await call('/person/wendy', json('PUT', { text: base.text.replace('Acme', 'Beta'), version: base.version }));
    await undo(0);
    expect(await fileText()).toBe(original);

    await call('/matter/the-madrid-move', { method: 'DELETE' });
    await undo(0);
    expect((await call('/matter/the-madrid-move')).status).toBe(200);
    expect(await readFile(pagePath({ vaultDir: vault(), kind: 'matter', slug: 'the-madrid-move' }), 'utf8')).toContain(
      'Lease on Calle Mayor',
    );
    expect(afterConfirm).not.toBe(original);

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
    await call('/person/wendy', json('PUT', { text: page.text.replace('Acme', 'Beta'), version: page.version }));
    const second = (await changes()).changes[0];
    const listed = (await changes()).changes;
    expect(listed.find(change => change.id === first?.id)?.undo_blocked_by).toBe(second?.message);
    const refused = await call(`/changes/${first?.id ?? ''}/undo`, { method: 'POST' });
    expect(refused.status).toBe(409);
    expect(ErrorSchema.parse(await refused.json()).error.message).toContain('Undo that change first');
    expect((await call(`/changes/${second?.id ?? ''}/undo`, { method: 'POST' })).status).toBe(200);
    expect((await call(`/changes/${first?.id ?? ''}/undo`, { method: 'POST' })).status).toBe(200);
    expect((await readPage()).text).toContain('Might be travelling');
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
    const shared = PageListSchema.parse(await (await call('')).json());
    expect(shared.data.pages.map(page => page['slug'])).toEqual(['wendy', 'the-madrid-move']);
    const persona = PageListSchema.parse(await (await call('?namespace=persona%3AAda')).json());
    expect(persona.data.pages.map(page => page['slug'])).toEqual(['ada-friend']);
    expect((await call('/person/wendy?namespace=persona%3AAda')).status).toBe(404);
    expect((await call('/person/wendy?namespace=persona%3AAda', { method: 'DELETE' })).status).toBe(404);
    tenant = 'someone-else';
    const other = PageListSchema.parse(await (await call('')).json());
    expect(other.data.pages).toEqual([]);
    expect((await call('/person/wendy')).status).toBe(404);
    expect((await changes()).changes).toEqual([]);
  });

  describe('lines that disagree', () => {
    const DisagreementsSchema = z.object({
      data: z.object({
        disagreements: z.array(
          z.object({
            id: z.string(),
            first: z.object({ id: z.string(), text: z.string() }),
            second: z.object({ id: z.string(), text: z.string() }),
            reason: z.string(),
            found_on: z.string(),
          }),
        ),
      }),
    });

    async function findPair() {
      await seed();
      await listDisagreements({
        vaultDir: vault(),
        today: '2026-11-11',
        askModel: modelAnswering(() => ({ pairs: [{ a: 'f_02', b: 'f_03', reason: 'Two plans for one night.' }] })),
        logger: silentLogger,
      });
    }

    it('counts the pairs in the list and shows them with both lines on the page', async () => {
      await findPair();
      const list = PageListSchema.parse(await (await call('')).json());
      expect(list.data.pages.map(page => [page['slug'], page['disagreement_count']])).toEqual([
        ['wendy', 1],
        ['the-madrid-move', 0],
      ]);
      const [pair] = DisagreementsSchema.parse(await (await call('/person/wendy')).json()).data.disagreements;
      expect(pair).toMatchObject({
        first: { id: 'f_02', text: 'Booked the movie for Saturday 7 PM.' },
        second: { id: 'f_03', text: 'Might be travelling the week of Nov 16.' },
        reason: 'Two plans for one night.',
        found_on: '2026-11-11',
      });
    });

    it('drops a pair on “Not a problem”, changes no line and makes no history entry', async () => {
      await findPair();
      const before = await readFile(pagePath({ vaultDir: vault(), kind: 'person', slug: 'wendy' }), 'utf8');
      const [pair] = DisagreementsSchema.parse(await (await call('/person/wendy')).json()).data.disagreements;

      const response = await call(`/person/wendy/disagreements/${pair?.id ?? ''}/dismiss`, json('POST', {}));

      expect(response.status).toBe(200);
      expect(DisagreementsSchema.parse(await response.json()).data.disagreements).toEqual([]);
      expect(await readFile(pagePath({ vaultDir: vault(), kind: 'person', slug: 'wendy' }), 'utf8')).toBe(before);
      expect((await changes()).changes).toEqual([]);
      const again = await call(`/person/wendy/disagreements/${pair?.id ?? ''}/dismiss`, json('POST', {}));
      expect(again.status).toBe(404);
      expect(ErrorSchema.parse(await again.json()).error.message).toContain('Reload the page');
    });
  });
});
