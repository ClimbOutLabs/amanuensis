/**
 * The vault summary-status endpoint: the Memories page asks, per collection, whether
 * that vault is still owed a turn summary after a failed attempt, so it can show the
 * plain line in place of the missing summary. The mark is per vault: one agent's
 * failed summary never shows as another agent's.
 */
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

const SummaryStatusResponseSchema = z.object({ data: z.object({ summary_pending: z.boolean() }) });

describe('memory vault summary status', () => {
  const originalBackend = configuration.MEMORY_BACKEND;
  const originalDir = configuration.MEMORY_MARKDOWN_DIR;
  let baseDir: string;
  let app: OpenAPIHono;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'vault-summary-status-'));
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

  async function summaryPending(namespace?: string): Promise<boolean> {
    const query = namespace === undefined ? '' : `?namespace=${encodeURIComponent(namespace)}`;
    const response = await app.request(`/api/v1/memory/vault/summary-status${query}`);
    expect(response.status).toBe(200);
    return SummaryStatusResponseSchema.parse(await response.json()).data.summary_pending;
  }

  it('reports a failed summary for its own vault only, and clears after a later success', async () => {
    expect(await summaryPending('persona:Zara')).toBe(false);
    expect(await summaryPending()).toBe(false);

    const zaraClient = new MarkdownMemoryClient({
      baseDir,
      namespace: 'default',
      vaultScope: { personaName: 'Zara', personaId: 'p-zara' },
    });
    await zaraClient.noteSummaryOutcome({ outcome: 'failed', reason: 'model_timeout' });

    expect(await summaryPending('persona:Zara')).toBe(true);
    // Another agent's vault is not marked by Zara's failure.
    expect(await summaryPending()).toBe(false);
    expect(await summaryPending('persona:Nova')).toBe(false);

    await zaraClient.noteSummaryOutcome({ outcome: 'summarized' });
    expect(await summaryPending('persona:Zara')).toBe(false);
  });
});
