// On slots the sandbox status comes from the slot agents; stub it so no socket is opened.
jest.mock('../../../src/sandbox/slotBackend', () => ({
  slotsBackendEnabled: jest.fn(() => true),
  slotSandboxBuildStatus: jest.fn(),
}));

import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createCapabilitiesRouter } from '../../../src/apis/capabilities';
import { resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth } from '../../../src/auth/oidc';
import { StandaloneAuthenticator } from '../../../src/auth/standaloneAuthenticator';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { slotSandboxBuildStatus } from '../../../src/sandbox/slotBackend';

const mockSlotStatus = jest.mocked(slotSandboxBuildStatus);

const CapabilitiesBodySchema = z.object({
  data: z.object({
    sandbox: z.object({ enabled: z.boolean() }),
    skill: z.object({ enabled: z.boolean(), reason: z.string().optional() }),
  }),
});
type CapabilitiesBody = z.infer<typeof CapabilitiesBodySchema>;

async function capabilities(): Promise<CapabilitiesBody['data']> {
  disableOidcAuth();
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const shell = new OpenAPIHono();
  shell.use('*', createAuthMiddleware(new StandaloneAuthenticator()));
  shell.route(
    '/',
    createCapabilitiesRouter({
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
      mcpServerStore: new SqliteMcpServerStore(db),
      globalSettingsStore: new SqliteGlobalSettingsStore(db),
      withTransaction: callback => db.transaction().execute(callback),
      logger: createLogger({ silent: true }),
      resolveRequestContext,
    }),
  );
  return CapabilitiesBodySchema.parse(await (await shell.request('/')).json()).data;
}

// New chats and agents start with the sandbox on exactly when this flag is on (the UI seeds its default spec from it).
describe('sandbox capability on the slot backend', () => {
  it('is on once a slot proves its isolation, so new agents get the sandbox by default', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'ready', reason: null, metadata: null });
    expect((await capabilities()).sandbox).toEqual({ enabled: true });
  });

  it('is off while no slot is usable', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: 'no slots', metadata: null });
    expect((await capabilities()).sandbox).toEqual({ enabled: false });
  });
});

// Skills are served host-side on slots: the host copies the skill files in, and approved sites go
// through the skill network gateway. So the skill flag follows the sandbox flag.
describe('skill capability on the slot backend', () => {
  it('is on when the sandbox is on, with no offline reason', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'ready', reason: null, metadata: null });
    expect((await capabilities()).skill).toEqual({ enabled: true });
  });

  it('is off with the sandbox reason while no slot is usable', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: 'no slots', metadata: null });
    expect((await capabilities()).skill).toEqual({
      enabled: false,
      reason: 'Skills run in a sandbox, which is not configured.',
    });
  });
});
