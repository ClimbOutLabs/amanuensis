import {
  calendarCardCopy,
  emailCardCopy,
  fileCardCopy,
  paymentCardCopy,
  sandboxCardCopy,
  simpleCardCopy,
} from '../../../src/core/permissions/cardCopy';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import type { Tier3Email } from '../../../src/core/permissions/tier';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';

/** An invented id-shaped token. No card copy may ever carry one, whatever slot it is offered in. */
const ID_TOKEN = 'tok-9f8e7d6c5b4a3f2e1d';

function makeCtx(): ClassifyContext {
  return {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
  };
}

describe('calendarCardCopy', () => {
  it('assembles the headline, the emailed sentence with what cannot be undone, and the reason', () => {
    expect(
      calendarCardCopy({
        headline: 'Delete "Dentist", Fri 7 Nov 2026, 3:00 PM?',
        emailed: 'Deleting this will email: Sam Lee.',
        undo: "This removes the event from the calendar. It can't be restored from here.",
        reason: 'Aman always asks before deleting an event in this calendar.',
      }),
    ).toEqual({
      headline: 'Delete "Dentist", Fri 7 Nov 2026, 3:00 PM?',
      consequence:
        "Deleting this will email: Sam Lee. This removes the event from the calendar. It can't be restored from here.",
      reason: 'Aman always asks before deleting an event in this calendar.',
    });
  });

  it('leaves the consequence out when nothing follows and no one is emailed', () => {
    expect(
      calendarCardCopy({ headline: 'Add "Team sync" to "work"?', emailed: null, undo: null, reason: null }),
    ).toEqual({ headline: 'Add "Team sync" to "work"?', consequence: null, reason: null });
  });

  it('keeps an undo line on its own when nobody is emailed', () => {
    expect(
      calendarCardCopy({
        headline: 'Delete "Dentist"?',
        emailed: null,
        undo: "This removes the event from the calendar. It can't be restored from here.",
        reason: null,
      }).consequence,
    ).toBe("This removes the event from the calendar. It can't be restored from here.");
  });
});

describe('emailCardCopy', () => {
  const base: Tier3Email = {
    action: 'send',
    to: [{ name: 'Grace Hopper', address: 'grace@example.test' }],
    cc: [],
    bcc: [],
    subject: 'Lease',
    body: 'Thursday works.',
    replaces: null,
    reply_in_thread: null,
    reply_to: null,
  };

  it('names the first recipient on a send and says a send cannot be unsent', () => {
    expect(emailCardCopy(base)).toEqual({
      headline: 'Send this email to Grace Hopper?',
      consequence: "Once this is sent, it can't be unsent.",
      reason: null,
    });
  });

  it('counts the rest of the recipients without naming them all', () => {
    const copy = emailCardCopy({
      ...base,
      to: [
        { name: 'Grace Hopper', address: 'grace@example.test' },
        { name: '', address: 'lin@example.test' },
        { name: '', address: 'ada@example.test' },
      ],
    });
    expect(copy.headline).toBe('Send this email to Grace Hopper and 2 more?');
  });

  it('falls back to the address when a recipient has no name', () => {
    const copy = emailCardCopy({ ...base, to: [{ name: '', address: 'grace@example.test' }] });
    expect(copy.headline).toBe('Send this email to grace@example.test?');
  });

  it('asks about a reply when the message answers one', () => {
    const copy = emailCardCopy({ ...base, reply_in_thread: { subject: 'Lease', from: 'Grace Hopper' } });
    expect(copy.headline).toBe('Send this reply to Grace Hopper?');
  });

  it('still asks when the recipient list could not be read, naming no one', () => {
    const copy = emailCardCopy({ ...base, to: [] });
    expect(copy.headline).toBe('Send this email?');
  });

  it('gives a saved draft no consequence, because nothing is sent', () => {
    expect(emailCardCopy({ ...base, action: 'save' })).toEqual({
      headline: 'Save this draft?',
      consequence: null,
      reason: null,
    });
    expect(emailCardCopy({ ...base, action: 'change' })).toEqual({
      headline: 'Change this draft?',
      consequence: null,
      reason: null,
    });
  });
});

describe('fileCardCopy', () => {
  it('keeps the headline that names the file and the undo line as the consequence', () => {
    expect(
      fileCardCopy({ headline: 'Write a file outside your workspace?', undo: 'The old file is replaced.' }),
    ).toEqual({
      headline: 'Write a file outside your workspace?',
      consequence: 'The old file is replaced.',
      reason: null,
    });
  });

  it('has no consequence when the write can be undone', () => {
    expect(fileCardCopy({ headline: 'Change notes.md in your workspace?', undo: null }).consequence).toBeNull();
  });
});

describe('paymentCardCopy', () => {
  it('names the amount and the recipient, never a transaction id', () => {
    const copy = paymentCardCopy({ amount: '$25.00', recipient: 'sam@example.test', destination: null });
    expect(copy).toEqual({
      headline: 'Pay $25.00 to sam@example.test?',
      consequence: "Once this is sent, it can't be unsent.",
      reason: null,
    });
  });

  it('falls back to the destination when there is no recipient', () => {
    expect(paymentCardCopy({ amount: '$25.00', recipient: null, destination: 'Billing service' }).headline).toBe(
      'Pay $25.00 to Billing service?',
    );
  });

  it('names only the amount when neither is known', () => {
    expect(paymentCardCopy({ amount: '$25.00', recipient: null, destination: null }).headline).toBe('Pay $25.00?');
  });
});

describe('sandboxCardCopy and simpleCardCopy', () => {
  it('sandbox copy carries its reason through', () => {
    expect(
      sandboxCardCopy({ headline: 'Run this command?', undo: 'Commands can change or delete files.', reason: null }),
    ).toEqual({
      headline: 'Run this command?',
      consequence: 'Commands can change or delete files.',
      reason: null,
    });
  });

  it('simple copy makes the question the headline', () => {
    expect(simpleCardCopy({ headline: 'Create the schedule "Morning"?', undo: null })).toEqual({
      headline: 'Create the schedule "Morning"?',
      consequence: null,
      reason: null,
    });
  });
});

describe('no card copy carries an internal id', () => {
  it('a shell command holding an id token keeps it out of the copy', async () => {
    const action: SentinelAction = {
      tool_name: 'exec',
      canonical_params: { command: `curl https://example.test/${ID_TOKEN}` },
      tool_type: 'truefoundry-system',
      mcp_hints: {},
    };
    const decision = await classifyTier(action, makeCtx());
    expect(decision.card).not.toBeNull();
    expect(decision.card?.parsed_command).toContain(ID_TOKEN);
    const copy = decision.card?.copy;
    expect(copy).not.toBeNull();
    expect(copy?.headline).not.toContain(ID_TOKEN);
    expect(copy?.consequence ?? '').not.toContain(ID_TOKEN);
    expect(copy?.reason ?? '').not.toContain(ID_TOKEN);
  });

  it('a connector payment holding a transaction id keeps it out of the copy', async () => {
    const action: SentinelAction = {
      tool_name: 'send_payment',
      canonical_params: { to: 'sam@example.test', amount: '$25.00', transaction_id: ID_TOKEN },
      tool_type: 'mcp',
      mcp_server_name: 'billing',
      mcp_server_host: 'billing.example.test',
      mcp_hints: { destructive_hint: false },
    };
    const decision = await classifyTier(action, makeCtx());
    expect(decision.card).not.toBeNull();
    const copy = decision.card?.copy;
    expect(copy).not.toBeNull();
    expect(copy?.headline).not.toContain(ID_TOKEN);
    expect(copy?.consequence ?? '').not.toContain(ID_TOKEN);
    expect(copy?.reason ?? '').not.toContain(ID_TOKEN);
    expect(decision.card?.safe_choice).toBe(true);
  });

  it('a gmail send whose thread id is an id token keeps it out of the copy', async () => {
    const action: SentinelAction = {
      tool_name: 'send_draft',
      canonical_params: { draft_id: 'd1' },
      tool_type: 'truefoundry-system',
      mcp_server_name: 'gmail',
      mcp_hints: { read_only_hint: false, destructive_hint: false, open_world_hint: true },
      mail_draft: {
        to: [{ name: '', address: 'grace@example.test' }],
        cc: [],
        bcc: [],
        subject: 'Lease',
        body: 'Thursday works.',
        threadId: ID_TOKEN,
        inReplyTo: '',
        references: '',
        fromName: '',
        nameLeftOff: false,
        replyTo: null,
      },
    };
    const decision = await classifyTier(action, makeCtx());
    const copy = decision.card?.copy;
    expect(copy).not.toBeNull();
    expect(copy?.headline).toBe('Send this email to grace@example.test?');
    expect(copy?.headline).not.toContain(ID_TOKEN);
    expect(decision.card?.safe_choice).toBe(true);
    expect(decision.card?.destructive).toBe(true);
  });
});
