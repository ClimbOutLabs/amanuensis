import { OpenAPIHono } from '@hono/zod-openapi';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import winston from 'winston';
import { z } from 'zod';

import { createMemoryVaultRouter } from '../../../src/apis/memoryVault';
import type { RequestContext } from '../../../src/auth/identity';
import { replaceMemoryWithExample } from '../../../src/cli/memoryExample/replace';
import configuration from '../../../src/config';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';

const ALICE: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'alice', type: 'user', display_name: 'alice' },
  roles: [],
  user_credential: null,
};
const NOW = new Date('2026-11-13T20:00:00.000Z');
const JACKET = 'My Versace jacket has a hole in the sleeve.';
const TAX_MAIL =
  'From an email, found Nov 12: The CPA, Dana Whitfield, said to file taxes early this year, because nothing is expected to be corrected.';
const DeletedSchema = z.object({ data: z.object({ deleted: z.number() }) });
const ErrorSchema = z.object({ error: z.object({ message: z.string() }) });

describe('deleting a memory by the words a chat showed', () => {
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  let baseDir: string;
  let app: OpenAPIHono;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'vault-delete-shown-'));
    configuration.MEMORY_MARKDOWN_DIR = baseDir;
    await replaceMemoryWithExample({ baseDir, namespace: 'default', now: NOW });
    app = new OpenAPIHono();
    app.route(
      '/api/v1/memory/vault',
      createMemoryVaultRouter({ resolveRequestContext: () => ALICE, logger: winston.createLogger({ silent: true }) }),
    );
  });

  afterEach(async () => {
    configuration.MEMORY_MARKDOWN_DIR = originalDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  async function deleteShown(shownText: string): Promise<Response> {
    return app.request('/api/v1/memory/vault/delete-shown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shown_text: shownText }),
    });
  }

  async function texts(namespace = ''): Promise<string[]> {
    const listed = await new MarkdownMemoryClient({ baseDir, namespace: 'default' }).listEntries({
      namespace,
      timeoutMs: 10_000,
    });
    return listed.ok ? listed.entries.map(entry => entry.text) : [];
  }

  it('deletes the one memory with those words and leaves the rest', async () => {
    const before = await texts();
    const response = await deleteShown(JACKET);
    expect(response.status).toBe(200);
    expect(DeletedSchema.parse(await response.json()).data.deleted).toBe(1);
    const after = await texts();
    expect(after).toHaveLength(before.length - 1);
    expect(after.some(text => text.includes('Versace'))).toBe(false);
  });

  it('deletes a note found in mail by the line the chat showed for it', async () => {
    const response = await deleteShown(TAX_MAIL);
    expect(response.status).toBe(200);
    expect((await texts()).some(text => text.includes('file taxes early this year, because'))).toBe(false);
  });

  it('deletes the copy an assistant keeps in its own collection as well', async () => {
    await cp(path.join(baseDir, 'default'), path.join(baseDir, 'default__persona_Chef'), { recursive: true });
    const response = await deleteShown(JACKET);
    expect(DeletedSchema.parse(await response.json()).data.deleted).toBe(2);
    expect((await texts('persona:Chef')).some(text => text.includes('Versace'))).toBe(false);
  });

  it('deletes nothing and says what to do when no memory has those words', async () => {
    const before = await texts();
    const response = await deleteShown('My Versace jacket has a hole');
    expect(response.status).toBe(404);
    expect(ErrorSchema.parse(await response.json()).error.message).toContain('Open Settings, then Memory');
    expect(await texts()).toEqual(before);
  });

  it('deletes nothing when words that were cut short fit more than one memory', async () => {
    const before = await texts();
    const response = await deleteShown('The CPA, Dana Whitfield, said...');
    expect(response.status).toBe(404);
    expect(await texts()).toEqual(before);
  });
});
