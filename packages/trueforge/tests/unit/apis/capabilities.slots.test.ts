// On slots the sandbox status comes from the slot agents; stub it so no socket is opened.
jest.mock('../../../src/sandbox/slotBackend', () => ({
  slotsBackendEnabled: jest.fn(() => true),
  slotSandboxBuildStatus: jest.fn(),
}));

import { OpenAPIHono } from '@hono/zod-openapi';
import { createLogger } from 'winston';
import { z } from 'zod';
import { createCapabilitiesRouter, SANDBOX_UNAVAILABLE_FOR_MEMBER } from '../../../src/apis/capabilities';
import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { disableOidcAuth } from '../../../src/auth/oidc';
import { StandaloneAuthenticator } from '../../../src/auth/standaloneAuthenticator';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteGlobalSettingsStore } from '../../../src/db/sqlite/global-settings-store/SqliteGlobalSettingsStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { slotSandboxBuildStatus } from '../../../src/sandbox/slotBackend';

const mockSlotStatus = jest.mocked(slotSandboxBuildStatus);

const CapabilitiesBodySchema = z.object({
  data: z.object({
    sandbox: z.object({ enabled: z.boolean(), reason: z.string().optional() }),
    skill: z.object({ enabled: z.boolean(), reason: z.string().optional() }),
  }),
});

const FULL_REASON =
  'The sandbox is full: every slot already holds as many chats as its disk fits (slot 1 holds 7 chats; slot 2 holds 7 chats). Delete old chats, then try again.';
const NOT_READY_REASON =
  "Code can't run on this computer yet. To turn it on, run `aman doctor sandbox --fix` on the computer where Aman is installed, then try again.";
type CapabilitiesBody = z.infer<typeof CapabilitiesBodySchema>;

/** Signs everyone in as a person who does not run the server. */
const memberAuthenticator: Authenticator = {
  authenticate: () =>
    Promise.resolve({
      tenant_id: 'default',
      subject: { id: 'member', type: 'user', display_name: 'member' },
      roles: [],
      user_credential: null,
    }),
};

async function capabilities(
  authenticator: Authenticator = new StandaloneAuthenticator(),
): Promise<CapabilitiesBody['data']> {
  disableOidcAuth();
  const db = createSqliteDb(':memory:');
  await migrateSqliteToLatest(db);
  const shell = new OpenAPIHono();
  shell.use('*', createAuthMiddleware(authenticator));
  shell.route(
    '/',
    createCapabilitiesRouter({
      resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
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

  it('is off while no slot is usable, with the reason the provider reported', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: NOT_READY_REASON, metadata: null });
    expect((await capabilities()).sandbox).toEqual({ enabled: false, reason: NOT_READY_REASON });
  });

  it('is off with the full reason when every slot holds as many chats as its disk fits', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: FULL_REASON, metadata: null });
    expect((await capabilities()).sandbox).toEqual({ enabled: false, reason: FULL_REASON });
  });

  it('is off with no reason when the failed build reported none', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: null, metadata: null });
    expect((await capabilities()).sandbox).toEqual({ enabled: false });
  });
});

// Skills are served host-side on slots: the host copies the skill files in, and approved sites go
// through the skill network gateway. So the skill flag follows the sandbox flag.
describe('sandbox reason for a person who does not run the server', () => {
  it('still says the sandbox is full, since deleting old chats is something they can do', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: FULL_REASON, metadata: null });
    expect((await capabilities(memberAuthenticator)).sandbox).toEqual({ enabled: false, reason: FULL_REASON });
  });

  it('points to the person who runs Aman instead of a command only they can run', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: NOT_READY_REASON, metadata: null });
    const data = await capabilities(memberAuthenticator);
    expect(data.sandbox).toEqual({ enabled: false, reason: SANDBOX_UNAVAILABLE_FOR_MEMBER });
    expect(data.skill).toEqual({ enabled: false, reason: SANDBOX_UNAVAILABLE_FOR_MEMBER });
  });
});

describe('skill capability on the slot backend', () => {
  it('is on when the sandbox is on, with no offline reason', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'ready', reason: null, metadata: null });
    expect((await capabilities()).skill).toEqual({ enabled: true });
  });

  it('is off with the not-ready reason while no slot is usable', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: NOT_READY_REASON, metadata: null });
    expect((await capabilities()).skill).toEqual({ enabled: false, reason: NOT_READY_REASON });
  });

  it('is off with the full reason when every slot is full, so a person learns deleting chats is the way out', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: FULL_REASON, metadata: null });
    expect((await capabilities()).skill).toEqual({ enabled: false, reason: FULL_REASON });
  });

  it('keeps the not configured reason when the failed build reported none', async () => {
    mockSlotStatus.mockResolvedValue({ status: 'failed', reason: null, metadata: null });
    expect((await capabilities()).skill).toEqual({
      enabled: false,
      reason: 'Skills run in a sandbox, which is not configured.',
    });
  });
});
