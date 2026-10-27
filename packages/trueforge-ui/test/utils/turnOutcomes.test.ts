import { describe, expect, it } from 'vitest';

import { turnOutcomeLines, type TurnOutcomePart } from '@/utils/turnOutcomes.js';

/** A result in the host's envelope, the way a finished call's part carries it on the real wire. */
function envelope(result: unknown, disposition = 'executed_ok'): unknown {
  return { schema_version: 'tool.response.v2', outcome: { disposition }, result };
}

/** An MCP-shaped result: the payload as a JSON text block. */
function mcpText(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolPart(part: Partial<TurnOutcomePart> & { toolName: string }): TurnOutcomePart {
  return { type: 'tool-call', args: {}, ...part };
}

const REMINDER_SET = {
  set: {
    id: 'rem-1',
    what: 'nudge me if Imperial & Legal go quiet',
    when: 'Once, on Friday, October 30 at 9:00 AM',
    time_zone: 'America/Los_Angeles',
    repeats: false,
    next: 'Friday, October 30 at 9:00 AM',
  },
};

describe('turnOutcomeLines', () => {
  it('names a set reminder with its words and when it fires', () => {
    const part = toolPart({ toolName: 'set_reminder', result: envelope(mcpText(REMINDER_SET)) });
    expect(turnOutcomeLines([part])).toEqual([
      'Reminder set for Friday, October 30 at 9:00 AM: nudge me if Imperial & Legal go quiet',
    ]);
  });

  it('reads a reminder result stored as a plain object, with no MCP wrapping', () => {
    const part = toolPart({ toolName: 'set_reminder', result: envelope(REMINDER_SET) });
    expect(turnOutcomeLines([part])).toEqual([
      'Reminder set for Friday, October 30 at 9:00 AM: nudge me if Imperial & Legal go quiet',
    ]);
  });

  it('describes a repeating reminder by its stored timing when no next firing is recorded', () => {
    const part = toolPart({
      toolName: 'set_reminder',
      result: envelope(
        mcpText({ set: { ...REMINDER_SET.set, when: 'Every Friday at 9:00 AM', repeats: true, next: null } }),
      ),
    });
    expect(turnOutcomeLines([part])).toEqual([
      'Reminder set: nudge me if Imperial & Legal go quiet. Every Friday at 9:00 AM',
    ]);
  });

  it('shows no line for a reminder call the host denied or that errored', () => {
    const denied = toolPart({ toolName: 'set_reminder', result: envelope(mcpText(REMINDER_SET), 'denied') });
    const errored = toolPart({
      toolName: 'set_reminder',
      result: envelope(mcpText({ error: 'There is no reminder like that.' })),
    });
    const failed = toolPart({ toolName: 'set_reminder', result: envelope(mcpText(REMINDER_SET), 'executed_nonzero') });
    expect(turnOutcomeLines([denied, errored, failed])).toEqual([]);
  });

  it('shows no line while a call has no result yet', () => {
    expect(turnOutcomeLines([toolPart({ toolName: 'set_reminder' })])).toEqual([]);
  });

  it('names a created Google calendar event with its title and when', () => {
    const part = toolPart({
      toolName: 'create_event',
      result: envelope(
        mcpText({
          account: 'owner@example.com',
          event_id: 'evt-1',
          status: 'created',
          title: 'Dentist',
          when: 'Friday, October 30, 9:00 AM to 10:00 AM',
          time_zone: 'America/Los_Angeles',
          guests_emailed: false,
        }),
      ),
    });
    expect(turnOutcomeLines([part])).toEqual([
      'Added to your calendar: Dentist, Friday, October 30, 9:00 AM to 10:00 AM',
    ]);
  });

  it('names a changed Google calendar event', () => {
    const part = toolPart({
      toolName: 'update_event',
      result: envelope(
        mcpText({ status: 'updated', title: 'Dentist', when: 'Friday, October 30, 11:00 AM to 12:00 PM' }),
      ),
    });
    expect(turnOutcomeLines([part])).toEqual([
      'Calendar event changed: Dentist, Friday, October 30, 11:00 AM to 12:00 PM',
    ]);
  });

  it('names a CalDAV event from the event the server stored', () => {
    const part = toolPart({
      toolName: 'create_event',
      result: envelope(
        mcpText({
          event: {
            summary: 'Dentist',
            start: { value: '2026-10-30T09:00:00', tzid: 'America/Los_Angeles', all_day: false },
          },
        }),
      ),
    });
    expect(turnOutcomeLines([part])).toEqual([
      'Added to your calendar: Dentist, 30 Oct 2026, 09:00 (America/Los_Angeles)',
    ]);
  });

  it('falls back to the create call itself when the answer names neither title nor time', () => {
    const part = toolPart({
      toolName: 'create_event',
      args: { title: 'Dentist', start: '2026-10-30T09:00', end: '2026-10-30T10:00' },
      result: envelope(mcpText({ event_id: 'evt-1' })),
    });
    expect(turnOutcomeLines([part])).toEqual(['Added to your calendar: Dentist, 30 Oct 2026, 09:00']);
  });

  it('invents nothing for an update that names no title and no time', () => {
    const part = toolPart({
      toolName: 'update_event',
      args: { event_id: 'evt-1' },
      result: envelope(mcpText({ event_id: 'evt-1' })),
    });
    expect(turnOutcomeLines([part])).toEqual([]);
  });

  it('names who an email went to, from the send call', () => {
    const part = toolPart({
      toolName: 'send_email',
      args: { recipients: ['dana@example.com'], subject: 'Friday', body: 'See you then.' },
      result: envelope(mcpText({ message_id: 'msg-1' })),
    });
    expect(turnOutcomeLines([part])).toEqual(['Email sent to dana@example.com']);
  });

  it('joins a few recipients in words and counts the rest', () => {
    const two = toolPart({
      toolName: 'send_email',
      args: { recipients: ['a@example.com', 'b@example.com'] },
      result: envelope(mcpText({})),
    });
    const five = toolPart({
      toolName: 'forward_email',
      args: { recipients: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'] },
      result: envelope(mcpText({})),
    });
    expect(turnOutcomeLines([two])).toEqual(['Email sent to a@example.com and b@example.com']);
    expect(turnOutcomeLines([five])).toEqual(['Email sent to a@example.com, b@example.com, c@example.com and 2 more']);
  });

  it('names a saved draft by who it is for, on both mail tools', () => {
    const connector = toolPart({
      toolName: 'save_draft',
      args: { recipients: ['dana@example.com'], subject: 'Lease', body: 'See the lease.' },
      result: envelope(mcpText({ draft_id: 'd-1' })),
    });
    const gmail = toolPart({
      toolName: 'draft_email',
      args: { to: ['ana@example.org'], subject: 'Hello', body: 'Hi' },
      result: envelope(mcpText({ action: 'drafted', draft_id: 'd-2' })),
    });
    expect(turnOutcomeLines([connector])).toEqual(['Draft saved for dana@example.com']);
    expect(turnOutcomeLines([gmail])).toEqual(['Draft saved for ana@example.org']);
  });

  it('names an updated Gmail draft by who it is for', () => {
    const part = toolPart({
      toolName: 'update_draft',
      args: { draft_id: 'd-2', to: ['ana@example.org'], subject: 'Hello', body: 'Hi, with the new date.' },
      result: envelope(
        mcpText({
          account: 'owner@example.com',
          draft_id: 'd-2',
          message_id: 'msg-9',
          thread_id: 'th-1',
          status: 'updated',
        }),
      ),
    });
    expect(turnOutcomeLines([part])).toEqual(['Draft updated for ana@example.org']);
  });

  it('names an updated Gmail draft on its own when the call names no recipient', () => {
    const part = toolPart({
      toolName: 'update_draft',
      args: { draft_id: 'd-2' },
      result: envelope(
        mcpText({
          account: 'owner@example.com',
          draft_id: 'd-2',
          message_id: 'msg-9',
          thread_id: 'th-1',
          status: 'updated',
        }),
      ),
    });
    expect(turnOutcomeLines([part])).toEqual(['Draft updated']);
  });

  it('names a Gmail send on its own, because the send call carries no recipient', () => {
    const part = toolPart({
      toolName: 'send_draft',
      args: { draft_id: 'd-1' },
      result: envelope(mcpText({ status: 'sent', message_id: 'msg-1' })),
    });
    expect(turnOutcomeLines([part])).toEqual(['Email sent']);
  });

  it('sees through the call_tool wrapper to the connector tool inside', () => {
    const part = toolPart({
      toolName: 'call_tool',
      args: {},
      argsText: JSON.stringify({
        mcp_server: 'Email',
        tool_name: 'send_email',
        input: { recipients: ['dana@example.com'], subject: 'Friday', body: 'See you then.' },
      }),
      result: envelope(mcpText({ message_id: 'msg-1' })),
    });
    expect(turnOutcomeLines([part])).toEqual(['Email sent to dana@example.com']);
  });

  it('leaves reads and other tools lineless, and keeps part order across a turn', () => {
    const read = toolPart({ toolName: 'list_reminders', result: envelope(mcpText({ reminders: [REMINDER_SET.set] })) });
    const search = toolPart({ toolName: 'web_search', result: envelope(mcpText({ results: [] })) });
    const reminder = toolPart({ toolName: 'set_reminder', result: envelope(mcpText(REMINDER_SET)) });
    const sent = toolPart({
      toolName: 'send_email',
      args: { recipients: ['dana@example.com'] },
      result: envelope(mcpText({})),
    });
    const text: TurnOutcomePart = { type: 'text' };
    expect(turnOutcomeLines([text, read, reminder, search, sent])).toEqual([
      'Reminder set for Friday, October 30 at 9:00 AM: nudge me if Imperial & Legal go quiet',
      'Email sent to dana@example.com',
    ]);
  });
});
