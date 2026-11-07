import type { DriveWriteReview } from '../../../src/core/drive/writeReview';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import {
  defaultSentinelServices,
  forUnattendedRun,
  type SentinelServices,
} from '../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

function makeCtx(
  services: SentinelServices = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function driveAction(tool_name: string, server = 'google_drive'): SentinelAction {
  return {
    tool_name,
    canonical_params: {},
    tool_type: 'truefoundry-system',
    mcp_server_name: server,
    mcp_hints: { read_only_hint: true, open_world_hint: true },
  };
}

describe('Drive read classification', () => {
  it.each(['list_files', 'read_drive_file'])('runs %s silently and flags it as a sensitive read', async name => {
    const decision = await classifyTier(driveAction(name), makeCtx());
    expect(decision).toMatchObject({
      tier: 1,
      reason: 'google_drive_read',
      reason_detail: 'Read your Google Drive files.',
      sensitive_read: true,
      card: null,
      auto_deny: null,
    });
  });

  it('reads in a scheduled run too', async () => {
    const decision = await classifyTier(
      driveAction('list_files'),
      makeCtx(forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))),
    );
    expect(decision).toMatchObject({ tier: 1, sensitive_read: true, auto_deny: null });
  });

  it.each(['delete_file', 'share_file', 'wipe_everything'])(
    'refuses %s: an unknown name fails closed without repeating it',
    async name => {
      const decision = await classifyTier(driveAction(name), makeCtx());
      expect(decision.reason_detail).toBe('Unknown Drive tool.');
      expect(decision.tier).not.toBe(1);
    },
  );

  it('does not give a connector tool of the same name the host path', async () => {
    const decision = await classifyTier(
      { ...driveAction('list_files', 'some_connector'), tool_type: 'mcp' },
      makeCtx(),
    );
    expect(decision.reason).not.toBe('google_drive_read');
  });

  it('is refused while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(driveAction('list_files'), makeCtx(services));
    expect(decision.auto_deny).toBe('offline_mode');
  });
});

const CREATE_REVIEW: DriveWriteReview = {
  action: 'create_doc',
  account: 'ada@example.com',
  file_name: 'Trip plan',
  sheet_name: null,
  text: 'Fly out Friday.',
  rows: [],
};

const APPEND_REVIEW: DriveWriteReview = {
  action: 'append_rows',
  account: 'ada@example.com',
  file_name: 'Expenses',
  sheet_name: 'Costs',
  text: '',
  rows: [['Coffee', '4']],
};

function writeAction(tool_name: string, review: DriveWriteReview | undefined): SentinelAction {
  return {
    ...driveAction(tool_name),
    canonical_params: { review_hash: 'h1' },
    mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
    drive_write: review,
  };
}

describe('Drive write classification', () => {
  it('always asks for a create, with the whole text on the card', async () => {
    const decision = await classifyTier(writeAction('create_doc', CREATE_REVIEW), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'google_drive_write', auto_deny: null, sensitive_read: false });
    expect(decision.card?.plain_what).toContain('Create a Google Doc named');
    expect(decision.card?.plain_what).toContain('Trip plan');
    expect(decision.card?.outbound_text).toBe('Fly out Friday.');
    expect(decision.approval_token_id).not.toBeNull();
  });

  it('always asks for an append, with every row on the card', async () => {
    const decision = await classifyTier(writeAction('append_rows', APPEND_REVIEW), makeCtx());
    expect(decision).toMatchObject({ tier: 3, reason: 'google_drive_write', auto_deny: null });
    expect(decision.card?.plain_what).toContain('Add 1 row to the tab "Costs" of the Google Sheet');
    expect(decision.card?.outbound_text).toBe('Coffee, 4');
  });

  it('asks in a scheduled run too, so the run holds it for the owner', async () => {
    const decision = await classifyTier(
      writeAction('create_doc', CREATE_REVIEW),
      makeCtx(forUnattendedRun(defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }))),
    );
    expect(decision).toMatchObject({ tier: 3, reason: 'google_drive_write', auto_deny: null });
    expect(decision.card).not.toBeNull();
  });

  it('is refused when the write could not be shown', async () => {
    const decision = await classifyTier(writeAction('create_doc', undefined), makeCtx());
    expect(decision.auto_deny).toBe('destination_unverifiable');
  });

  it('is refused while offline', async () => {
    const services = {
      ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
      isOffline: () => Promise.resolve(true),
    };
    const decision = await classifyTier(writeAction('create_doc', CREATE_REVIEW), makeCtx(services));
    expect(decision.auto_deny).toBe('offline_mode');
  });

  it('runs under a standing grant for the same tool', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    await services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name: 'google_drive',
      tool_name: 'create_doc',
      mcp_server_host: null,
    });
    const decision = await classifyTier(writeAction('create_doc', CREATE_REVIEW), makeCtx(services));
    expect(decision).toMatchObject({ tier: 1, reason: 'mcp_tool_grant', auto_deny: null, card: null });
  });

  it('a grant for one Drive tool does not cover the other', async () => {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    await services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name: 'google_drive',
      tool_name: 'create_doc',
      mcp_server_host: null,
    });
    const decision = await classifyTier(writeAction('append_rows', APPEND_REVIEW), makeCtx(services));
    expect(decision).toMatchObject({ tier: 3, reason: 'google_drive_write' });
  });
});
