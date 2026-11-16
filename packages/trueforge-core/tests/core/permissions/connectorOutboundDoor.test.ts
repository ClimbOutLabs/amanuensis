import { CALDAV_SERVER_NAME } from '../../../src/core/calendar/caldav/toolContract';
import { CALENDAR_SERVER_ID, LIST_EVENTS_TOOL_NAME } from '../../../src/core/calendar/toolContract';
import { CREATE_DOC_TOOL_NAME, DRIVE_SERVER_ID, LIST_FILES_TOOL_NAME } from '../../../src/core/drive/toolContract';
import type { DriveWriteReview } from '../../../src/core/drive/writeReview';
import { GMAIL_SERVER_ID, LIST_INBOX_THREADS_TOOL_NAME } from '../../../src/core/email/gmail/toolContract';
import { MAIL_CONNECTOR_NAME, MAIL_LIST_TOOL_NAME } from '../../../src/core/email/mailConnector/toolContract';
import { HOME_ASSISTANT_SERVER_NAME } from '../../../src/core/homeassistant/toolContract';
import { REVIEW_HASH_ARGUMENT } from '../../../src/core/permissions/approvalTokens';
import { classifyTier } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices, type SentinelServices } from '../../../src/core/permissions/context';
import { CONNECTOR_READ_GUARD_REASON } from '../../../src/core/permissions/tier';
import type { ClassifyContext, SentinelAction } from '../../../src/core/permissions/tierTypes';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/** Synthetic values only: a made-up key the host holds, and coded text that hides what it carries. */
const HELD_KEY = 'zq-held-key-93-synthetic';
const CODED_TEXT = 'c2VjcmV0IGtleSBoZXJlIGZvciB5b3UgYW5kIG1vcmUgdGV4dA==';

const CREATE_REVIEW: DriveWriteReview = {
  action: 'create_doc',
  account: 'ada@example.com',
  file_name: 'Trip plan',
  sheet_name: null,
  text: 'Fly out Friday.',
  rows: [],
  shared_with: 0,
};

function makeCtx(services: SentinelServices): ClassifyContext {
  return {
    services,
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

/**
 * Every branch that can let a connector call run without a card. Each carries `text` in the argument the
 * connector receives. A new branch that runs connector calls silently belongs in this list.
 */
const SILENT_CONNECTOR_CALLS: ReadonlyArray<{
  branch: string;
  call: (text: string) => SentinelAction;
  grant?: { mcp_server_name: string; tool_name: string };
}> = [
  {
    branch: 'a Gmail read',
    call: text => ({
      tool_name: LIST_INBOX_THREADS_TOOL_NAME,
      canonical_params: { query: text },
      tool_type: 'truefoundry-system',
      mcp_server_name: GMAIL_SERVER_ID,
      mcp_hints: { read_only_hint: true, open_world_hint: true },
    }),
  },
  {
    branch: 'a Google Calendar read',
    call: text => ({
      tool_name: LIST_EVENTS_TOOL_NAME,
      canonical_params: { query: text },
      tool_type: 'truefoundry-system',
      mcp_server_name: CALENDAR_SERVER_ID,
      mcp_hints: { read_only_hint: true, open_world_hint: true },
    }),
  },
  {
    branch: 'a Google Drive read',
    call: text => ({
      tool_name: LIST_FILES_TOOL_NAME,
      canonical_params: { query: text },
      tool_type: 'truefoundry-system',
      mcp_server_name: DRIVE_SERVER_ID,
      mcp_hints: { read_only_hint: true, open_world_hint: true },
    }),
  },
  {
    branch: 'a Google Drive write the person always allows',
    call: text => ({
      tool_name: CREATE_DOC_TOOL_NAME,
      canonical_params: { title: 'Trip plan', text, [REVIEW_HASH_ARGUMENT]: 'a'.repeat(64) },
      tool_type: 'truefoundry-system',
      mcp_server_name: DRIVE_SERVER_ID,
      mcp_hints: { read_only_hint: false, open_world_hint: true },
      drive_write: { ...CREATE_REVIEW, text },
    }),
    grant: { mcp_server_name: DRIVE_SERVER_ID, tool_name: CREATE_DOC_TOOL_NAME },
  },
  {
    branch: "a read of Aman's own Email connector",
    call: text => ({
      tool_name: MAIL_LIST_TOOL_NAME,
      canonical_params: { query: text },
      tool_type: 'mcp',
      mcp_server_name: MAIL_CONNECTOR_NAME,
      mcp_first_party: true,
      mcp_hints: { read_only_hint: true, open_world_hint: false },
    }),
  },
  {
    branch: "a read of Aman's own CalDAV connector",
    call: text => ({
      tool_name: 'search_events',
      canonical_params: { query: text },
      tool_type: 'mcp',
      mcp_server_name: CALDAV_SERVER_NAME,
      mcp_first_party: true,
      mcp_hints: { read_only_hint: true, open_world_hint: false },
    }),
  },
  {
    branch: 'a Home Assistant read',
    call: text => ({
      tool_name: 'GetLiveContext',
      canonical_params: { note: text },
      tool_type: 'mcp',
      mcp_server_name: HOME_ASSISTANT_SERVER_NAME,
      mcp_hints: { read_only_hint: true, open_world_hint: false },
    }),
  },
  {
    branch: 'a read-only tool on a connector the host set up',
    call: text => ({
      tool_name: 'lookup_record',
      canonical_params: { query: text },
      tool_type: 'mcp',
      mcp_server_name: 'records',
      mcp_first_party: true,
      mcp_hints: { read_only_hint: true, open_world_hint: false },
    }),
  },
  {
    branch: 'a connector read the person always allows',
    call: text => ({
      tool_name: 'lookup_record',
      canonical_params: { query: text },
      tool_type: 'mcp',
      mcp_server_name: 'chatlog',
      mcp_hints: { read_only_hint: true, open_world_hint: false },
    }),
    grant: { mcp_server_name: 'chatlog', tool_name: 'lookup_record' },
  },
];

async function ctxFor(grant: { mcp_server_name: string; tool_name: string } | undefined): Promise<ClassifyContext> {
  const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
  services.outboundSecrets = () => Promise.resolve([HELD_KEY]);
  if (grant !== undefined) {
    await services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      ...grant,
      connector_binding: null,
    });
  }
  return makeCtx(services);
}

describe.each(SILENT_CONNECTOR_CALLS)('$branch passes the one outbound check', ({ call, grant }) => {
  it('runs without a card when it carries ordinary text, and remembers what it sent', async () => {
    const ctx = await ctxFor(grant);
    const decision = await classifyTier(call('lunch on friday'), ctx);
    expect(decision).toMatchObject({ auto_deny: null, card: null, approval_token_id: null });
    expect(ctx.web_search.sentText).toContain('lunch on friday');
  });

  it('asks first when it carries coded text, and says why', async () => {
    const ctx = await ctxFor(grant);
    const decision = await classifyTier(call(`notes ${CODED_TEXT}`), ctx);
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON, auto_deny: null });
    expect(decision.card?.plain_what).toContain('coded text');
    expect(decision.card?.plain_what).toMatch(/^(Look this up on|Send this to) /);
    expect(decision.standing_grant_barred).toBe(true);
    expect(ctx.web_search.sentText).toBe('');
  });

  it('does not run when it carries a key this computer holds, and shows no card with the key on it', async () => {
    const ctx = await ctxFor(grant);
    const decision = await classifyTier(call(`status ${HELD_KEY}`), ctx);
    expect(decision).toMatchObject({ auto_deny: 'outbound_guard', card: null });
    expect(decision.reason_detail).not.toContain(HELD_KEY);
  });

  it('sees a key split across two silent calls', async () => {
    const ctx = await ctxFor(grant);
    const first = await classifyTier(call(`part ${HELD_KEY.slice(0, 12)}`), ctx);
    expect(first).toMatchObject({ auto_deny: null, card: null });
    const second = await classifyTier(call(HELD_KEY.slice(12)), ctx);
    expect(second.auto_deny).toBe('outbound_guard');
  });
});

describe("Aman's own Google tools", () => {
  it('do not read their own review hash as text sent to Google', async () => {
    const ctx = await ctxFor({ mcp_server_name: DRIVE_SERVER_ID, tool_name: CREATE_DOC_TOOL_NAME });
    const decision = await classifyTier(
      {
        tool_name: CREATE_DOC_TOOL_NAME,
        canonical_params: { title: 'Trip plan', text: 'Fly out Friday.', [REVIEW_HASH_ARGUMENT]: CODED_TEXT },
        tool_type: 'truefoundry-system',
        mcp_server_name: DRIVE_SERVER_ID,
        mcp_hints: { read_only_hint: false, open_world_hint: true },
        drive_write: CREATE_REVIEW,
      },
      ctx,
    );
    expect(decision).toMatchObject({ tier: 1, auto_deny: null });
  });

  it('name an always-allowed write the check stopped as a send, not a lookup', async () => {
    const ctx = await ctxFor({ mcp_server_name: DRIVE_SERVER_ID, tool_name: CREATE_DOC_TOOL_NAME });
    const text = `notes ${CODED_TEXT}`;
    const decision = await classifyTier(
      {
        tool_name: CREATE_DOC_TOOL_NAME,
        canonical_params: { title: 'Trip plan', text },
        tool_type: 'truefoundry-system',
        mcp_server_name: DRIVE_SERVER_ID,
        mcp_hints: { read_only_hint: false, open_world_hint: true },
        drive_write: { ...CREATE_REVIEW, text },
      },
      ctx,
    );
    expect(decision.card?.plain_what).toMatch(/^Send this to Google Drive\? /);
  });

  it("a connector's own argument with that name is read like any other", async () => {
    const ctx = await ctxFor(undefined);
    const decision = await classifyTier(
      {
        tool_name: 'lookup_record',
        canonical_params: { query: 'lunch', [REVIEW_HASH_ARGUMENT]: CODED_TEXT },
        tool_type: 'mcp',
        mcp_server_name: 'records',
        mcp_first_party: true,
        mcp_hints: { read_only_hint: true, open_world_hint: false },
      },
      ctx,
    );
    expect(decision).toMatchObject({ tier: 3, reason: CONNECTOR_READ_GUARD_REASON });
  });
});

describe('a search through the connector the person picked for web searches', () => {
  it('runs without a card and is remembered once, so the window of earlier text is not used up twice', async () => {
    const ctx = await ctxFor(undefined);
    const decision = await classifyTier(
      {
        tool_name: 'web_search',
        canonical_params: { query: 'lunch on friday' },
        tool_type: 'mcp',
        mcp_server_name: 'search',
        mcp_search_provider: true,
        mcp_hints: { read_only_hint: true },
      },
      ctx,
    );
    expect(decision).toMatchObject({ auto_deny: null, card: null, approval_token_id: null });
    expect(ctx.web_search.sentText.split('lunch on friday')).toHaveLength(2);
  });
});
