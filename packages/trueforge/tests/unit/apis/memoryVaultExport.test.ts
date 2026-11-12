import { OpenAPIHono } from '@hono/zod-openapi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import winston from 'winston';
import { z } from 'zod';
import { createMemoryVaultRouter } from '../../../src/apis/memoryVault';
import type { RequestContext } from '../../../src/auth/identity';
import configuration from '../../../src/config';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};

const EntrySchema = z.object({ text: z.string(), timestamp: z.string() });
const ListResponseSchema = z.object({ data: z.array(EntrySchema) });
const ExportResponseSchema = z.object({ data: z.object({ entries: z.array(EntrySchema) }) });

describe('memory vault export keeps the internal id an entry was filed under', () => {
  const originalBackend = configuration.MEMORY_BACKEND;
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  let baseDir: string;
  let app: OpenAPIHono;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'vault-export-'));
    configuration.MEMORY_BACKEND = 'markdown';
    configuration.MEMORY_MARKDOWN_DIR = baseDir;
    app = new OpenAPIHono();
    app.route(
      '/api/v1/memory/vault',
      createMemoryVaultRouter({
        resolveRequestContext: () => ALICE,
        logger: winston.createLogger({ silent: true }),
      }),
    );
  });

  afterEach(async () => {
    configuration.MEMORY_BACKEND = originalBackend;
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  it('lists the entry without the id, exports it with the id line, and reads the id back after an import', async () => {
    const client = new MarkdownMemoryClient({ baseDir, namespace: 'default' });
    const retained = await client.retain({
      items: [
        {
          content: 'Lives in Lisbon with a cat.',
          timestamp: '2026-10-02T10:00:00.000Z',
          document_id: 'maya-identity',
          context: 'maya:identity',
        },
      ],
      operationId: 'op-1',
      timeoutMs: 5_000,
    });
    expect(retained.ok).toBe(true);

    const listed = ListResponseSchema.parse(await (await app.request('/api/v1/memory/vault')).json());
    expect(listed.data.map(entry => entry.text)).toEqual(['Lives in Lisbon with a cat.']);

    const exported = ExportResponseSchema.parse(await (await app.request('/api/v1/memory/vault/export')).json());
    expect(exported.data.entries.map(entry => entry.text)).toEqual(['Lives in Lisbon with a cat.\n\n> maya:identity']);

    const imported = await app.request('/api/v1/memory/vault/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'topic:again', entries: exported.data.entries }),
    });
    expect(imported.status).toBe(201);
    const again = await client.listEntries({ namespace: 'topic:again', timeoutMs: 5_000 });
    if (!again.ok) {
      throw new Error('expected a vault listing');
    }
    expect(again.entries.map(entry => ({ text: entry.text, context: entry.context }))).toEqual([
      { text: 'Lives in Lisbon with a cat.', context: 'maya:identity' },
    ]);
  });
});
