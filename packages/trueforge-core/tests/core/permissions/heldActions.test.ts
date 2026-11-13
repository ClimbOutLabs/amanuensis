import type { InternalEnrichedAssistantMessage, InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import { InMemoryApprovalTokenStore } from '../../../src/core/permissions/approvalTokens';
import {
  checkHeldReplay,
  CLICK_AFTER_HELD_EDIT_MESSAGE,
  HELD_ACTION_CAP,
  holdApprovalCalls,
} from '../../../src/core/permissions/heldActions';
import type { Tier3Card } from '../../../src/core/permissions/tier';

const SCOPE = { tenant_id: 't1', created_by: 'u1' };

function info(overrides: Partial<InternalToolCallInfo> = {}): InternalToolCallInfo {
  return {
    type: 'mcp',
    mcp_server_id: 'mail',
    mcp_server_name: 'mail',
    original_tool_name: 'send_note',
    is_approval_required: true,
    tier: 3,
    ...overrides,
  };
}

function message(infos: InternalToolCallInfo[]): InternalEnrichedAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: infos.map((tool_info, index) => ({
      id: `call-${String(index)}`,
      type: 'function' as const,
      function: { name: 'send_note', arguments: JSON.stringify({ tool: tool_info.original_tool_name }) },
      tool_info,
    })),
  };
}

function card(overrides: Partial<Tier3Card> = {}): Tier3Card {
  return {
    plain_what: 'Send a note to Ana.',
    copy: null,
    plain_why: null,
    cannot_be_undone: null,
    why_asked_again: null,
    destination: 'mail',
    recipient: 'ana@example.com',
    amount: null,
    parsed_command: null,
    outbound_text: 'to: ana@example.com',
    destination_host: 'mail.example.com',
    outbound_truncated: false,
    ...overrides,
  };
}

describe('holdApprovalCalls', () => {
  it('holds a call that would ask and stops it asking', () => {
    const { message: held, refused } = holdApprovalCalls({
      message: message([info()]),
      alreadyHeld: 0,
      browserEditWaiting: false,
      isSubAgent: false,
    });
    const [call] = held.tool_calls ?? [];
    expect(call?.tool_info.is_approval_required).toBe(false);
    expect(Date.parse(call?.tool_info.held_for_owner?.expires_at ?? '')).toBeGreaterThan(Date.now());
    expect(refused).toEqual([]);
  });

  it('leaves calls that do not ask, are client-side, create threads, or were already refused', () => {
    const original = message([
      info({ is_approval_required: false, tier: 1 }),
      info({ is_client_side: true }),
      info({ is_thread_creation: true }),
      info({ is_approval_required: false, pre_dispatch_failure: { kind: 'policy_blocked', message: 'Auto-denied.' } }),
    ]);
    expect(
      holdApprovalCalls({ message: original, alreadyHeld: 0, browserEditWaiting: false, isSubAgent: false }).message,
    ).toBe(original);
  });

  it('refuses what it cannot hold past the cap, counting what the chat already holds, and says so', () => {
    const asks = Array.from({ length: 3 }, (_, index) => info({ original_tool_name: `tool_${String(index)}` }));
    const calls = message(asks);
    const result = holdApprovalCalls({
      message: calls,
      alreadyHeld: HELD_ACTION_CAP - 1,
      browserEditWaiting: false,
      isSubAgent: false,
    });
    const infos = (result.message.tool_calls ?? []).map(call => call.tool_info);
    expect(infos.filter(candidate => candidate.held_for_owner !== undefined)).toHaveLength(1);
    expect(infos.filter(candidate => candidate.pre_dispatch_failure?.kind === 'policy_blocked')).toHaveLength(2);
    expect(infos[1]?.pre_dispatch_failure?.message).toContain('Too many actions are already waiting');
    expect(infos[1]?.pre_dispatch_failure?.owner_message).toBe(infos[1]?.pre_dispatch_failure?.message);
    expect(result.refused.map(entry => entry.reason)).toEqual(['too_many', 'too_many']);
  });

  it('refuses a helper agent call because the main chat cannot replay it', () => {
    const result = holdApprovalCalls({
      message: message([info()]),
      alreadyHeld: 0,
      browserEditWaiting: false,
      isSubAgent: true,
    });
    const [call] = result.message.tool_calls ?? [];
    expect(call?.tool_info.held_for_owner).toBeUndefined();
    expect(call?.tool_info.pre_dispatch_failure?.message).toContain('helper agent');
    expect(result.refused).toEqual([{ id: 'call-0', reason: 'helper_agent' }]);
  });

  it('holds one of two identical calls in a batch and marks the repeat, which uses no room under the cap', () => {
    const result = holdApprovalCalls({
      message: message([info(), info()]),
      alreadyHeld: HELD_ACTION_CAP - 1,
      browserEditWaiting: false,
      isSubAgent: false,
    });
    const [first, second] = (result.message.tool_calls ?? []).map(call => call.tool_info);
    expect(first?.held_for_owner?.duplicate).toBeUndefined();
    expect(second?.held_for_owner?.duplicate).toBe(true);
    expect(second?.pre_dispatch_failure).toBeUndefined();
    expect(result.refused).toEqual([]);
  });

  it('does not save a click after held typing, and tells the model to click again once it is approved', () => {
    const typing = info({ original_tool_name: 'browser_type' });
    const click = info({ original_tool_name: 'browser_click' });
    for (const [infos, waiting] of [
      [[typing, click], false],
      [[click], true],
    ] as const) {
      const result = holdApprovalCalls({
        message: message([...infos]),
        alreadyHeld: 0,
        browserEditWaiting: waiting,
        isSubAgent: false,
      });
      const last = result.message.tool_calls?.at(-1)?.tool_info;
      expect(last?.held_for_owner).toBeUndefined();
      expect(last?.is_approval_required).toBe(false);
      expect(last?.pre_dispatch_failure?.message).toBe(CLICK_AFTER_HELD_EDIT_MESSAGE);
      expect(result.refused).toEqual([]);
    }
  });

  it('still saves a click when no browser typing is waiting', () => {
    const result = holdApprovalCalls({
      message: message([info({ original_tool_name: 'browser_click' })]),
      alreadyHeld: 0,
      browserEditWaiting: false,
      isSubAgent: false,
    });
    expect(result.message.tool_calls?.[0]?.tool_info.held_for_owner).toBeDefined();
  });
});

describe('checkHeldReplay', () => {
  async function held(options: { expiresAt?: string } = {}) {
    const tokens = new InMemoryApprovalTokenStore();
    const params = { to: 'ana@example.com' };
    const heldToken = await tokens.mint({
      ...SCOPE,
      action_id: 'action-a',
      canonical_params: params,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const freshToken = await tokens.mint({
      ...SCOPE,
      action_id: 'action-a',
      canonical_params: params,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return {
      tokens,
      heldToken,
      freshToken,
      heldInfo: info({
        approval_token_id: heldToken.token_id,
        tier3_card: card(),
        held_for_owner: { expires_at: options.expiresAt ?? new Date(Date.now() + 60_000).toISOString() },
      }),
    };
  }

  it('lets the fresh call run on the hold-time token', async () => {
    const { tokens, heldToken, freshToken, heldInfo } = await held();
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card({ plain_why: 'Different reason' }) });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: true,
      approval_token_id: heldToken.token_id,
    });
  });

  describe('the page element a held browser action was shown with', () => {
    const element = (accessible_name: string) => ({
      site: 'stream.example',
      accessible_name,
      role: 'button',
      is_form_submit: false,
      form_values: {},
      link_url: null,
    });

    it('runs when the element reads the same as when it was held', async () => {
      const { tokens, heldToken, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        browser_element: element('Keep my plan'),
      });
      await expect(
        checkHeldReplay({
          held: { ...heldInfo, browser_element: element('Keep my plan') },
          fresh,
          tokens,
          scope: SCOPE,
        }),
      ).resolves.toEqual({ ok: true, approval_token_id: heldToken.token_id });
    });

    it.each([
      ['now carries another label', element('Cancel membership')],
      ['can no longer be read', undefined],
    ])('refuses the replay when the element %s', async (_name, now) => {
      const { tokens, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        ...(now === undefined ? {} : { browser_element: now }),
      });
      await expect(
        checkHeldReplay({
          held: { ...heldInfo, browser_element: element('Keep my plan') },
          fresh,
          tokens,
          scope: SCOPE,
        }),
      ).resolves.toEqual({ ok: false, reason: 'changed' });
    });
  });

  describe('git remotes seen when the call was held', () => {
    const remotes = (url: string) => ({
      remotes: [{ name: 'origin', url }],
      summary: `origin is ${url}`,
    });
    const shown = remotes('https://github.com/o/r.git');

    it('lets the replay run when the remotes are unchanged', async () => {
      const { tokens, heldToken, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        git_remote_precondition: shown,
      });
      await expect(
        checkHeldReplay({
          held: { ...heldInfo, git_remote_precondition: shown },
          fresh,
          tokens,
          scope: SCOPE,
        }),
      ).resolves.toEqual({ ok: true, approval_token_id: heldToken.token_id });
    });

    it.each([
      ['repointed', remotes('https://github.com/attacker/x.git')],
      ['no longer observed', undefined],
    ])('refuses the replay when the remote is %s', async (_name, now) => {
      const { tokens, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        ...(now === undefined ? {} : { git_remote_precondition: now }),
      });
      await expect(
        checkHeldReplay({ held: { ...heldInfo, git_remote_precondition: shown }, fresh, tokens, scope: SCOPE }),
      ).resolves.toEqual({ ok: false, reason: 'changed' });
    });

    it('refuses a replay that now has a remote the owner was never shown', async () => {
      const { tokens, freshToken, heldInfo } = await held();
      const fresh = info({
        approval_token_id: freshToken.token_id,
        tier3_card: card(),
        git_remote_precondition: shown,
      });
      await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
        ok: false,
        reason: 'changed',
      });
    });
  });

  it('refuses after the hold ran out', async () => {
    const { tokens, freshToken, heldInfo } = await held({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses once the hold-time token was used', async () => {
    const { tokens, heldToken, freshToken, heldInfo } = await held();
    await tokens.redeem({ ...SCOPE, token_id: heldToken.token_id });
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses when a rule now auto-denies the call', async () => {
    const { tokens, heldInfo } = await held();
    const fresh = info({
      is_approval_required: false,
      pre_dispatch_failure: { kind: 'policy_blocked', message: 'Auto-denied: offline mode is on.' },
    });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('refuses when the action id differs', async () => {
    const { tokens, heldInfo } = await held();
    const other = await tokens.mint({
      ...SCOPE,
      action_id: 'action-b',
      canonical_params: {},
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const fresh = info({ approval_token_id: other.token_id, tier3_card: card() });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  it.each([
    { field: 'recipient', value: 'bob@example.com' },
    { field: 'destination', value: 'other-service' },
    { field: 'outbound_text', value: 'to: bob@example.com' },
    { field: 'parsed_command', value: 'rm -rf /' },
  ] as const)('refuses when the $field differs', async ({ field, value }) => {
    const { tokens, freshToken, heldInfo } = await held();
    const fresh = info({ approval_token_id: freshToken.token_id, tier3_card: card({ [field]: value }) });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: false,
      reason: 'changed',
    });
  });

  const EVENT: NonNullable<Tier3Card['calendar_event']> = {
    action: 'change',
    calendar: 'primary',
    title: 'Dentist',
    when: 'Fri 13 Nov, 10:00',
    time_zone: 'Europe/London',
    duration: '30 minutes',
    location: '',
    description: '',
    attendees: ['ana@example.com'],
    guests_line: 'Google will email every guest about this.',
    one_of_repeating: false,
    before: { title: 'Dentist', when: 'Fri 13 Nov, 09:00', duration: '30 minutes', location: '' },
  };

  const EMAIL: NonNullable<Tier3Card['email']> = {
    action: 'send',
    sent_from: { address: 'ada@example.com', service: 'Gmail' },
    to: [{ name: 'Ana', address: 'ana@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Lunch on Friday',
    body: 'Are you free at one?',
    replaces: null,
    reply_in_thread: null,
    reply_to: null,
  };

  const SCHEDULE: NonNullable<Tier3Card['schedule']> = {
    action: 'create',
    name: 'friday-review',
    when: 'Every Friday at 16:00',
    time_zone: 'Europe/London',
    task: 'Tell me what I finished this week.',
    runs_as: 'Aman',
    next_runs: ['Fri 13 Nov, 16:00'],
  };

  const PERSONA: NonNullable<Tier3Card['persona']> = {
    name: 'Trip planner',
    description: 'Plans trips.',
    instructions: 'Plan trips step by step.',
    model_name: 'test-provider/chat-model',
  };

  /** Checks a later approval where the card read `shown` when the call was held and reads `now` today. */
  async function laterApproval(input: { shown: Partial<Tier3Card>; now: Partial<Tier3Card> }) {
    const { tokens, heldToken, freshToken, heldInfo } = await held();
    return {
      heldToken,
      result: await checkHeldReplay({
        held: { ...heldInfo, tier3_card: card(input.shown) },
        fresh: info({ approval_token_id: freshToken.token_id, tier3_card: card(input.now) }),
        tokens,
        scope: SCOPE,
      }),
    };
  }

  it.each<{ name: string; shown: Partial<Tier3Card>; now: Partial<Tier3Card> }>([
    {
      name: 'the main sentence reads differently',
      shown: {},
      now: { plain_what: 'Send a note to Ana and 40 others.' },
    },
    { name: 'the amount changed', shown: { amount: '$10.00' }, now: { amount: '$1,000.00' } },
    {
      name: 'the note on what cannot be undone changed',
      shown: { cannot_be_undone: null },
      now: { cannot_be_undone: 'Once sent, it cannot be taken back.' },
    },
    {
      name: 'the connector that receives the call changed',
      shown: {},
      now: { destination_host: 'mail.elsewhere.test' },
    },
    {
      name: 'part of what goes out is now cut short',
      shown: { outbound_truncated: false },
      now: { outbound_truncated: true },
    },
    {
      name: 'a calendar change gained a guest',
      shown: { calendar_event: EVENT },
      now: { calendar_event: { ...EVENT, attendees: ['ana@example.com', 'stranger@elsewhere.test'] } },
    },
    {
      name: 'the event a calendar change starts from was moved',
      shown: { calendar_event: EVENT },
      now: {
        calendar_event: {
          ...EVENT,
          before: { title: 'Dentist', when: 'Mon 16 Nov, 14:00', duration: '30 minutes', location: '' },
        },
      },
    },
    {
      name: 'the body of an email changed',
      shown: { email: EMAIL },
      now: { email: { ...EMAIL, body: 'Please send the deposit today.' } },
    },
    {
      name: 'an email gained a hidden copy',
      shown: { email: EMAIL },
      now: { email: { ...EMAIL, bcc: [{ name: '', address: 'stranger@elsewhere.test' }] } },
    },
    {
      name: 'the task of a schedule reads differently',
      shown: { schedule: SCHEDULE },
      now: { schedule: { ...SCHEDULE, task: 'Email my week to stranger@elsewhere.test.' } },
    },
    {
      name: 'a persona reads differently',
      shown: { persona: PERSONA },
      now: { persona: { ...PERSONA, name: 'Another name' } },
    },
    {
      name: 'the list of new recipients changed',
      shown: { mail_new_recipients: ['ana@example.com'] },
      now: { mail_new_recipients: ['ana@example.com', 'stranger@elsewhere.test'] },
    },
    {
      name: 'the new-recipient notice is gone and the sentence after it reads differently',
      shown: {
        plain_what:
          'New recipient. You have never emailed stranger@elsewhere.test. Approving adds them to your send list and sends. Send a note to Ana.',
        mail_new_recipients: ['stranger@elsewhere.test'],
      },
      now: { plain_what: 'Send a note to Ana and 40 others.' },
    },
    {
      name: 'the new-recipient notice is gone and another part changed',
      shown: {
        plain_what:
          'New recipient. You have never emailed stranger@elsewhere.test. Approving adds them to your send list and sends. Send a note to Ana.',
        mail_new_recipients: ['stranger@elsewhere.test'],
      },
      now: { outbound_text: 'to: ana@example.com\nbcc: stranger@elsewhere.test' },
    },
    {
      name: 'a mail now has a new address the card never showed',
      shown: {},
      now: {
        plain_what:
          'New recipient. You have never emailed stranger@elsewhere.test. Approving adds them to your send list and sends. Send a note to Ana.',
        mail_new_recipients: ['stranger@elsewhere.test'],
      },
    },
    {
      name: 'a part of the card that was not there is there now',
      shown: {},
      now: { email: EMAIL },
    },
  ])('refuses a later approval when $name', async ({ shown, now }) => {
    const { result } = await laterApproval({ shown, now });
    expect(result).toEqual({ ok: false, reason: 'changed' });
  });

  it.each<{ name: string; shown: Partial<Tier3Card>; now: Partial<Tier3Card> }>([
    {
      name: 'nothing on the card changed',
      shown: { email: EMAIL, amount: '$10.00' },
      now: { email: EMAIL, amount: '$10.00' },
    },
    {
      name: 'only the reason lines differ',
      shown: { plain_why: 'To confirm lunch.', why_asked_again: null },
      now: { plain_why: 'Ana asked about Friday.', why_asked_again: 'You were asked before.' },
    },
    {
      name: "only a schedule's next runs moved with the clock",
      shown: { schedule: SCHEDULE },
      now: { schedule: { ...SCHEDULE, next_runs: ['Fri 20 Nov, 16:00'] } },
    },
    {
      name: 'the new addresses of a mail are on the Email list by now, so their notice is gone',
      shown: {
        plain_what:
          'New recipient. You have never emailed stranger@elsewhere.test. Approving adds them to your send list and sends. Send a note to Ana.',
        mail_new_recipients: ['stranger@elsewhere.test'],
      },
      now: {},
    },
    {
      name: 'the new addresses of a draft are on the Email list by now, so their notice is gone',
      shown: {
        plain_what:
          'New recipient. You have never emailed stranger@elsewhere.test. Approving adds them to your send list and saves this draft. Send a note to Ana.',
        mail_new_recipients: ['stranger@elsewhere.test'],
        mail_draft: true,
      },
      now: {},
    },
    {
      name: 'an empty part is stored as nothing on one side and left out on the other',
      shown: { email: null, mail_new_recipients: null },
      now: {},
    },
  ])('lets a later approval run when $name', async ({ shown, now }) => {
    const { heldToken, result } = await laterApproval({ shown, now });
    expect(result).toEqual({ ok: true, approval_token_id: heldToken.token_id });
  });

  it('runs a call that no longer asks without a token', async () => {
    const { tokens, heldInfo } = await held();
    const fresh = info({ is_approval_required: false, tier: 1, approval_token_id: null, tier3_card: null });
    await expect(checkHeldReplay({ held: heldInfo, fresh, tokens, scope: SCOPE })).resolves.toEqual({
      ok: true,
      approval_token_id: null,
    });
  });
});
