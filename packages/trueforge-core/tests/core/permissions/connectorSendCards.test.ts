import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { OUTBOUND_VALUE_MAX_CHARS, SEND_VALUE_MAX_CHARS } from '../../../src/core/permissions/extractorRegistry';
import { GRANT_BARRED_TIER_REASONS, type TierDecision } from '../../../src/core/permissions/tier';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

const readOnlyClosedWorld = { read_only_hint: true, open_world_hint: false, destructive_hint: false };

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'conv-1',
    repository_id: 'r1',
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

function mailCall(tool_name: string, params: Record<string, unknown>): SentinelAction {
  return {
    tool_name,
    canonical_params: params,
    tool_type: 'mcp',
    mcp_server_name: 'mail',
    mcp_server_host: 'mail.example.com',
    mcp_hints: { destructive_hint: false },
  };
}

function callOn({
  server,
  name,
  params,
}: {
  server: string;
  name: string;
  params: Record<string, unknown>;
}): SentinelAction {
  return { ...mailCall(name, params), mcp_server_name: server };
}

function classify(action: SentinelAction): Promise<TierDecision> {
  return classifyTier(action, makeCtx());
}

function expectRefused(decision: TierDecision): void {
  expect(decision.tier).toBe(3);
  expect(decision.auto_deny).toBe('incomplete_send_card');
  expect(decision.approval_token_id).toBeNull();
}

describe('connector send cards', () => {
  test('refuses reply_all, whose recipients are filled in after approval', async () => {
    expectRefused(await classify(mailCall('reply_all', { messageId: 'm1', body: 'Thanks all' })));
  });

  test('refuses send_draft, whose content the card cannot show, even when a recipient is passed', async () => {
    expectRefused(await classify(mailCall('send_draft', { draftId: 'd1' })));
    expectRefused(await classify(mailCall('send_draft', { draftId: 'd1', to: 'friend@example.com' })));
  });

  test('refuses a reply that names no recipient', async () => {
    expectRefused(await classify(mailCall('reply_to_thread', { threadId: 't1', body: 'ok' })));
  });

  test('cards a filter that forwards, naming the forwarding address', async () => {
    const decision = await classify(
      mailCall('create_filter', {
        criteria: { from: 'billing@example.com' },
        action: { addLabelIds: ['L1'], forward: 'archive@example.com' },
      }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.recipient).toBe('archive@example.com');
    expect(decision.card?.plain_what).toContain('Forward every matching message to archive@example.com');
  });

  test('send_email shows the whole body and recipients, and binds them into the token', async () => {
    const body = `${'a'.repeat(OUTBOUND_VALUE_MAX_CHARS)}END-OF-MESSAGE`;
    const decision = await classify(
      mailCall('send_email', { to: ['friend@example.com'], cc: ['boss@example.com'], subject: 'Hi', body }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.outbound_truncated).toBe(false);
    expect(decision.card?.outbound_text).toContain('END-OF-MESSAGE');
    expect(decision.card?.recipient).toBe('friend@example.com, boss@example.com');
  });

  test('refuses a send_email whose body is too long to show, instead of cutting it', async () => {
    const body = `${'a'.repeat(SEND_VALUE_MAX_CHARS)}HIDDEN-TAIL`;
    expectRefused(await classify(mailCall('send_email', { to: ['friend@example.com'], subject: 'Hi', body })));
  });

  test('still cuts a long value on a call that sends nothing', async () => {
    const decision = await classify(mailCall('lookup_note', { text: 'a'.repeat(OUTBOUND_VALUE_MAX_CHARS + 5) }));
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.outbound_truncated).toBe(true);
  });
});

describe('reasons that bar a durable grant', () => {
  test.each([
    ['external_service', mailCall('share_note', { to: 'friend@example.com', body: 'hi' })],
    ['destructive_action', mailCall('delete_note', { id: 'n1' })],
    ['install_action', mailCall('install_pack', { name: 'left-pad' })],
    ['mcp_destructive_hint', { ...mailCall('tidy_notes', {}), mcp_hints: { destructive_hint: true } }],
    ['mcp_open_world_hint', { ...mailCall('tidy_notes', {}), mcp_hints: { open_world_hint: true } }],
    ['connector_send', mailCall('push_files', { owner: 'o', repo: 'r', files: [] })],
    ['connector_send', mailCall('reply_to_thread', { threadId: 't1', to: 'friend@example.com', body: 'ok' })],
  ])('%s is the code the classifier gives and the grant gate bars', async (reason, action) => {
    const decision = await classify(action);
    expect(decision.reason).toBe(reason);
    expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(true);
  });
});

describe('sends are never trusted by a hint or a standing grant', () => {
  const sendTools = [
    ['reply', { messageId: 'm1', to: 'friend@example.com', body: 'ok' }],
    ['forward', { messageId: 'm1', to: 'friend@example.com' }],
    ['push_files', { owner: 'o', repo: 'r', files: [] }],
    ['create_filter', { criteria: { from: 'a@example.com' }, action: { forward: 'archive@example.com' } }],
  ] as const;

  test.each(sendTools)('a read-only closed-world %s on a first-party connector still asks', async (name, params) => {
    const decision = await classify({
      ...mailCall(name, params),
      mcp_first_party: true,
      mcp_hints: readOnlyClosedWorld,
    });
    expect(decision.tier).toBe(3);
    expect(decision.approval_token_id).not.toBeNull();
  });

  test.each(sendTools)('a standing Always allow for %s does not skip the card', async (name, params) => {
    const ctx = makeCtx();
    await ctx.services.tool_grants.recordToolGrant({
      tenant_id: 't1',
      created_by: 'u1',
      mcp_server_name: 'mail',
      tool_name: name,
      mcp_server_host: null,
    });
    const decision = await classifyTier({ ...mailCall(name, params), mcp_hints: readOnlyClosedWorld }, ctx);
    expect(decision.tier).toBe(3);
    expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(true);
  });

  test.each(['invite_user', 'create_event', 'add_issue_comment'])(
    '%s with attendees is barred from durable scope and shows its whole body',
    async name => {
      const body = 'b'.repeat(OUTBOUND_VALUE_MAX_CHARS + 50);
      const decision = await classify(mailCall(name, { attendees: ['guest@example.com'], body }));
      expect(decision.tier).toBe(3);
      expect(decision.card?.recipient).toBe('guest@example.com');
      expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(true);
      expect(decision.card?.outbound_truncated).toBe(false);
    },
  );

  test.each([
    ['list_events', { attendees: ['guest@example.com'] }],
    ['get_user', { user: 'guest@example.com' }],
    ['search_notes', { query: 'tax' }],
  ])('a first-party read-only lookup %s with recipient-like keys runs without asking', async (name, params) => {
    const decision = await classify({
      ...mailCall(name, params),
      mcp_first_party: true,
      mcp_hints: readOnlyClosedWorld,
    });
    expect(decision.tier).toBe(1);
  });

  test.each([
    ['list_events', { attendees: ['guest@example.com'] }],
    ['search_notes', { query: 'tax' }],
  ])('a read-only closed-world %s keeps its durable scope when it asks', async (name, params) => {
    const decision = await classify({ ...mailCall(name, params), mcp_hints: readOnlyClosedWorld });
    expect(decision.tier).toBe(3);
    expect(GRANT_BARRED_TIER_REASONS.has(decision.reason)).toBe(false);
  });
});

describe('hidden sends: one rule for every spelling', () => {
  const to = ['shown@example.com'];

  test.each<[string, Record<string, unknown>]>([
    ['reply_all', { messageId: 'm1', body: 'hi' }],
    ['replyall', { messageId: 'm1', to }],
    ['replyAll', { messageId: 'm1', to }],
    ['respond_all', { messageId: 'm1', to }],
    ['respond_to_all', { messageId: 'm1', to }],
    ['reply_to_all', { messageId: 'm1', to }],
    ['go', { reply_all: true, body: 'hi', to }],
    ['reply', { messageId: 'm1', replyAll: true, to }],
    ['reply', { messageId: 'm1', reply_all: true, to }],
    ['reply', { messageId: 'm1', replyToAll: true, to }],
    ['reply', { messageId: 'm1', reply_to_all: true, to }],
    ['reply', { messageId: 'm1', respondToAll: true, to }],
    ['reply', { messageId: 'm1', mode: 'reply_all', to }],
    ['reply', { messageId: 'm1', action: 'respondAll', to }],
    ['reply', { messageId: 'm1', options: { replyAll: true }, to }],
    ...[true, 1, 2, 'true', 'True', 'yes', 'y', 'on', '1', 'all', 'enabled', [true]].map(
      (value): [string, Record<string, unknown>] => ['reply', { messageId: 'm1', replyAll: value, to }],
    ),
  ])('%s is refused as a reply to everyone for %j', async (name, params) => {
    const decision = await classify(mailCall(name, params));
    expectRefused(decision);
    expect(decision.owner_message).toContain('replying to everyone');
  });

  test.each<[string, Record<string, unknown>]>([
    ['send_draft', { id: 'd1', to }],
    ['senddraft', { id: 'd1' }],
    ['gmail_send_draft', { id: 'd1' }],
    ['send_message', { draftId: 'd1', to }],
    ['send_message', { draft_id: 'd1', to }],
    ['send_message', { draft: 'd1', to }],
    ['send_message', { draft: { id: 'd1' }, to }],
    ['send_message', { draftIds: ['d1'], to }],
    ['send_message', { messageDraftId: 'd1', to }],
    ['send_message', { message: { draft: { id: 'd1' } }, to }],
    ['send_message', { useDraft: true, to }],
    ['send_message', { action: 'send_draft', to }],
    ['send_message', { source: 'draft', to }],
    ['process_draft', { draftId: 'd1' }],
    ['drafts_execute', { id: 'd1', draft: 'd1' }],
    ['push', { draft_id: 'd1' }],
    ['drafts_send', { draftId: 'd1' }],
    ['send', { draftId: 'd1' }],
    ['dispatch', { draftId: 'd1' }],
    ['deliver', { draftId: 'd1' }],
    ['drafts.send', { draftId: 'd1' }],
  ])('%s is refused as a saved draft for %j', async (name, params) => {
    const decision = await classify(mailCall(name, params));
    // A send_message with only a draft id has no destination and is denied earlier.
    expect(decision.auto_deny === 'incomplete_send_card' || decision.auto_deny === 'destination_unverifiable').toBe(
      true,
    );
    expect(decision.approval_token_id).toBeNull();
    if (decision.auto_deny === 'incomplete_send_card') {
      expect(decision.owner_message).toContain('saved draft');
    }
  });

  test('a send_message with only a draft id stays denied for its missing destination', async () => {
    expect((await classify(mailCall('send_message', { draftId: 'd1' }))).auto_deny).toBe('destination_unverifiable');
  });

  test.each<[string, Record<string, unknown>]>([
    ['reply', { messageId: 'm1', replyAll: false, to }],
    ['reply', { messageId: 'm1', replyAll: 'off', to }],
    ['reply', { messageId: 'm1', replyAll: 'no', to }],
    ['reply', { messageId: 'm1', replyAll: 0, to }],
    ['send_message', { to, body: 'hi', isDraft: false }],
    ['create_pull_request', { owner: 'o', repo: 'r', title: 't', draft: true }],
    ['create_pull_request', { owner: 'o', repo: 'r', title: 't', draft: false }],
  ])('%s is carded for %j', async (name, params) => {
    const decision = await classify(mailCall(name, params));
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
  });

  test.each(['get_draft', 'list_drafts'])(
    'a tool declared read-only and closed-world is left alone: %s',
    async name => {
      const decision = await classify({
        ...mailCall(name, { draftId: 'd1', replyAll: true }),
        mcp_hints: readOnlyClosedWorld,
      });
      expect(decision.auto_deny).toBeNull();
    },
  );
});

describe('replies must name every recipient in To', () => {
  const mailTools = [
    'reply',
    'reply_to_thread',
    'reply_email',
    'replyToMessage',
    'respond',
    'respondToThread',
    'answer_thread',
  ];
  const noTo = [
    ['cc only', { threadId: 't1', cc: ['a@example.com'], body: 'ok' }],
    ['bcc only', { threadId: 't1', bcc: ['a@example.com'], body: 'ok' }],
    ['an empty to list', { threadId: 't1', to: [], cc: ['a@example.com'], body: 'ok' }],
    ['an empty to string', { threadId: 't1', to: '', bcc: 'a@example.com', body: 'ok' }],
    ['a blank to entry', { threadId: 't1', to: ['  '], cc: ['a@example.com'], body: 'ok' }],
    ['an empty-string entry', { threadId: 't1', to: [''], cc: ['a@example.com'], body: 'ok' }],
    ['a null to', { threadId: 't1', to: null, cc: ['a@example.com'], body: 'ok' }],
    ['an empty to object', { threadId: 't1', to: [{}], cc: ['a@example.com'], body: 'ok' }],
    ['a to with no address field', { threadId: 't1', to: [{ name: 'Bob' }], cc: ['a@example.com'] }],
    ['an invisible to string', { threadId: 't1', to: '​', cc: ['a@example.com'] }],
    ['an invisible to entry', { threadId: 't1', to: ['​ ﻿'], cc: ['a@example.com'] }],
    ['an empty address object', { threadId: 't1', to: [{ email: '' }], cc: ['a@example.com'] }],
    ['a to nested under message', { message: { to: ['a@example.com'] }, cc: ['b@example.com'] }],
  ] as const;

  test.each(noTo)('refuses a reply with %s', async (_label, params) => {
    for (const name of mailTools) {
      expectRefused(await classify(mailCall(name, params)));
    }
    expectRefused(await classify(callOn({ server: 'gmail', name: 'respond_to_message', params })));
  });

  test.each<[string, Record<string, unknown>]>([
    ['forward', { messageId: 'm1', cc: ['a@example.com'] }],
    ['forward_email', { messageId: 'm1', bcc: ['a@example.com'] }],
    ['reply_to_thread', { threadId: 't1', cc: ['a@example.com'] }],
  ])('refuses %s with cc only', async (name, params) => {
    expectRefused(await classify(mailCall(name, params)));
  });

  test('cards a reply whose to is named', async () => {
    const decision = await classify(
      mailCall('reply', { threadId: 't1', to: ['a@example.com'], cc: ['b@example.com'], body: 'ok' }),
    );
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.recipient).toBe('a@example.com, b@example.com');
  });

  test.each<[string, string, Record<string, unknown>]>([
    ['github', 'add_reply_to_pull_request_comment', { owner: 'o', repo: 'r', pullNumber: 1, body: 'thanks' }],
    ['slack', 'slack_reply_to_thread', { channel_id: 'C1', thread_ts: '1.2', text: 'thanks' }],
    ['linear', 'reply_to_comment', { commentId: 'c1', body: 'thanks' }],
  ])('a %s reply tool with no mail recipients is carded with what it sends', async (server, name, params) => {
    const decision = await classify(callOn({ server, name, params }));
    expect(decision.auto_deny).toBeNull();
    expect(decision.approval_token_id).not.toBeNull();
    expect(decision.card?.outbound_text).toContain('thanks');
  });
});

describe('what is shown in full and what is cut', () => {
  test.each([
    ['create_or_update_file', { owner: 'o', repo: 'r', path: 'a.md', content: 'x'.repeat(30_000) }],
    ['push_files', { owner: 'o', repo: 'r', files: [{ path: 'a.md', content: 'x'.repeat(25_000) }] }],
    ['create_gist', { files: { 'a.md': { content: 'x'.repeat(25_000) } } }],
  ])('%s with a long file keeps the cut preview instead of being refused', async (name, params) => {
    const decision = await classify(mailCall(name, params));
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.outbound_truncated).toBe(true);
    expect(decision.approval_token_id).not.toBeNull();
  });
});

describe('attachment file data on the card', () => {
  const sendWith = (attachments: Record<string, unknown>) =>
    classify(
      mailCall('send_email', { to: ['friend@example.com'], subject: 'Hi', body: 'See attached', ...attachments }),
    );
  const blob = (fill: number) => Buffer.alloc(30_000, fill).toString('base64');

  test.each([
    ['standard', (text: string) => Buffer.from(text).toString('base64')],
    ['URL-safe unpadded', (text: string) => Buffer.from(text).toString('base64url')],
    [
      'line-wrapped',
      (text: string) =>
        (
          Buffer.from(text)
            .toString('base64')
            .match(/.{1,60}/g) ?? []
        ).join('\r\n'),
    ],
  ])('short %s text is decoded and readable', async (_label, encode) => {
    const note = 'Wire 9,000 USD to account 1234 today';
    const decision = await sendWith({
      attachments: [{ filename: 'n.txt', mimeType: 'text/plain', content: encode(note) }],
    });
    expect(decision.card?.outbound_text).toContain(note);
  });

  test('plain text in an attachment is shown as it is, and counts toward the cap', async () => {
    const decision = await sendWith({
      attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', content: 'meet me at noon by the old bridge' }],
    });
    expect(decision.card?.outbound_text).toContain('meet me at noon by the old bridge');
    expectRefused(
      await sendWith({
        attachments: [{ filename: 'notes.txt', mimeType: 'text/plain', content: 'word '.repeat(SEND_VALUE_MAX_CHARS) }],
      }),
    );
  });

  test('a long text file becomes one summary line and is not refused', async () => {
    const text = 'quarterly numbers '.repeat(2000);
    const decision = await sendWith({
      attachments: [{ filename: 'q.csv', content: Buffer.from(text).toString('base64') }],
    });
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.outbound_text).toContain('text file, about 35 KB, fingerprint');
  });

  test('a string that is not valid base64 is left as it is', async () => {
    const notBase64 = `${'A'.repeat(40)}!`;
    const decision = await sendWith({ attachments: [{ filename: 'a.bin', content: notBase64 }] });
    expect(decision.card?.outbound_text).toContain(notBase64);
  });

  test('bytes with control characters in the 0x0e-0x1f range are binary, not text', async () => {
    const bytes = Buffer.concat([Buffer.from('plain words here '), Buffer.from([0x0f]), Buffer.from('and more words')]);
    const decision = await sendWith({ attachments: [{ filename: 'a.bin', content: bytes.toString('base64') }] });
    expect(decision.card?.outbound_text).toContain('file data, 32 bytes, fingerprint');
  });

  test('two different files of the same size look different', async () => {
    const first = await sendWith({ attachments: [{ name: 'a.bin', contentBytes: blob(1) }] });
    const second = await sendWith({ attachments: [{ name: 'a.bin', contentBytes: blob(2) }] });
    expect(first.card?.outbound_text).not.toBe(second.card?.outbound_text);
  });

  test('a binary file keeps its type from a data URL', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('secret '.repeat(500))]);
    const decision = await sendWith({
      attachments: [{ filename: 'a.png', content: `data:image/png;base64,${png.toString('base64')}` }],
    });
    expect(decision.card?.outbound_text).toContain('file data, image/png, about 3 KB, fingerprint');
  });

  test('only file data keys under exact attachment keys are summarised', async () => {
    const hex = 'ab'.repeat(40);
    expectRefused(await sendWith({ notAttachment: [{ content: blob(4) }] }));
    const decision = await sendWith({ attachments: [{ filename: hex, note: hex }] });
    expect(decision.card?.outbound_text).toContain(hex);
    expect(decision.card?.outbound_text).not.toContain('fingerprint');
  });

  test.each([
    ['contentBytes under attachments', { attachments: [{ name: 'a.bin', contentBytes: blob(3) }] }],
    ['file_attachments', { file_attachments: [{ filename: 'a.bin', content: blob(3) }] }],
    ['a nested message.attachments', { message: { attachments: [{ filename: 'a.bin', file_data: blob(3) }] } }],
    [
      'attachments deeper in the call',
      { payload: { message: { attachments: [{ filename: 'a.bin', raw: blob(3) }] } } },
    ],
  ])('%s is summarised, not counted as text', async (_label, extra) => {
    const decision = await sendWith(extra);
    expect(decision.auto_deny).toBeNull();
    expect(decision.card?.outbound_text).toContain('file data, about 29 KB, fingerprint');
    expect(decision.card?.outbound_truncated).toBe(false);
  });
});

describe('the owner line for a refused send', () => {
  const lines = async () => ({
    replyAll: (await classify(mailCall('reply_all', { messageId: 'm1' }))).owner_message,
    draft: (await classify(mailCall('send_draft', { id: 'd1' }))).owner_message,
    tooLong: (
      await classify(mailCall('send_email', { to: 'friend@example.com', body: 'a'.repeat(SEND_VALUE_MAX_CHARS + 1) }))
    ).owner_message,
    noRecipient: (await classify(mailCall('reply_to_thread', { threadId: 't1', body: 'ok' }))).owner_message,
  });

  test('each reason has its own words', async () => {
    const found = await lines();
    expect(found.replyAll).toContain('replying to everyone');
    expect(found.draft).toContain('saved draft');
    expect(found.tooLong).toContain('too long');
    expect(found.noRecipient).toContain('did not say who gets it');
  });

  test('every line is short, plain and says nothing was sent', async () => {
    for (const line of Object.values(await lines())) {
      expect(line).toMatch(/^Nothing was sent/);
      expect(line?.length).toBeLessThan(120);
      expect(line).not.toMatch(/card|`/i);
    }
  });

  test('the model is told the one step for each reason', async () => {
    expect((await classify(mailCall('reply_all', { messageId: 'm1' }))).reason_detail).toContain('same message');
    expect((await classify(mailCall('send_draft', { id: 'd1' }))).reason_detail).toContain('in full');
    expect((await classify(mailCall('reply_to_thread', { threadId: 't1' }))).reason_detail).toContain('in `to`');
  });
});
