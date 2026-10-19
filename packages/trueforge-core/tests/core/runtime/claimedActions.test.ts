/**
 * The claimed-action guard: an answer that claims an action with no matching successful call in
 * the turn gets the plain note; plans, questions, negations and backed claims get nothing.
 */
import { HELD_RESULT_TEXT } from '../../../src/core/permissions/heldActions';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import {
  CLAIMED_ACTION_NOTE,
  claimedActionNote,
  detectActionClaims,
  successfulActionCallsThisTurn,
  type SuccessfulActionCall,
} from '../../../src/core/runtime/claimedActions';

const CREATE_EVENT: SuccessfulActionCall = { name: 'create_event', destructive: false };
const SEND: SuccessfulActionCall = { name: 'send_draft', destructive: false };
const SAVE_NOTE: SuccessfulActionCall = { name: 'write_file', destructive: false };
const DELETE_FILE: SuccessfulActionCall = { name: 'delete_file', destructive: true };

describe('detectActionClaims', () => {
  it('hears the owner-reported fake: a done claim about a calendar add', () => {
    expect(detectActionClaims('Done, I added the appointment to your calendar.')).toEqual(
      expect.arrayContaining(['calendar', 'create']),
    );
  });

  it('hears email, schedule, delete and save claims', () => {
    expect(detectActionClaims("I've sent the email to Sam.")).toContain('email');
    expect(detectActionClaims('I created a reminder for every Friday.')).toContain('schedule');
    expect(detectActionClaims('I deleted the old event.')).toContain('delete');
    expect(detectActionClaims("I've saved the note to your memory.")).toContain('save');
    expect(detectActionClaims('The appointment was added to your calendar.')).toContain('calendar');
    expect(detectActionClaims('Your message has been sent.')).toContain('email');
  });

  it('does not hear plans, offers, questions or instructions', () => {
    const calm = [
      'I can add that appointment whenever you are ready.',
      'Shall I send the email now?',
      'Would you like me to create a reminder?',
      'To add an event, open your calendar and pick a time.',
      'I will add it once you confirm the time.',
      'Nothing has been booked yet.',
    ];
    for (const text of calm) {
      expect(detectActionClaims(text)).toEqual([]);
    }
  });

  it('does not hear negated claims', () => {
    expect(detectActionClaims("I haven't added the appointment yet, the time is unclear.")).toEqual([]);
    expect(detectActionClaims('I could not send the email because the address bounced.')).toEqual([]);
    expect(detectActionClaims('I never deleted anything.')).toEqual([]);
  });

  it('does not hear a claim inside a quoted draft the person asked for', () => {
    const draft = 'Here is the draft you asked for: "I sent the email to the team yesterday." Want changes?';
    expect(detectActionClaims(draft)).toEqual([]);
    expect(detectActionClaims('Here is the draft: “I added the appointment to your calendar.”')).toEqual([]);
  });

  it('still hears the same words said in the answer itself, outside the quotes', () => {
    expect(detectActionClaims('I sent the email to the team yesterday.')).toContain('email');
    const mixed = '"I sent the email yesterday," is what the draft said. I deleted the old draft.';
    expect(detectActionClaims(mixed)).toEqual(['delete']);
  });
});

describe('claimedActionNote', () => {
  it('marks a calendar claim with no tool success at all', () => {
    expect(claimedActionNote({ content: 'Done, I added the appointment to your calendar.', successes: [] })).toBe(
      CLAIMED_ACTION_NOTE,
    );
  });

  it('stays silent when the matching call succeeded', () => {
    expect(
      claimedActionNote({
        content: 'Done, I added the appointment to your calendar.',
        successes: [CREATE_EVENT],
      }),
    ).toBeUndefined();
    expect(claimedActionNote({ content: "I've sent the email.", successes: [SEND] })).toBeUndefined();
    expect(claimedActionNote({ content: 'I deleted the old draft.', successes: [DELETE_FILE] })).toBeUndefined();
    expect(claimedActionNote({ content: "I've saved the note.", successes: [SAVE_NOTE] })).toBeUndefined();
  });

  it('marks the family that did not happen even when another action succeeded', () => {
    // The note was saved, but no email was sent: the email claim is unbacked.
    expect(claimedActionNote({ content: "I've saved the note and sent the email.", successes: [SAVE_NOTE] })).toBe(
      CLAIMED_ACTION_NOTE,
    );
  });

  it('stays silent for plain answers with no claim', () => {
    expect(claimedActionNote({ content: 'Your meeting is at 2:30 pm on Tuesday.', successes: [] })).toBeUndefined();
    expect(claimedActionNote({ content: 'Here is what I found in your inbox.', successes: [] })).toBeUndefined();
  });
});

describe('successfulActionCallsThisTurn against real result shapes', () => {
  const CLAIM = 'Done, I added the appointment to your calendar.';

  function contextWithResult(resultContent: string): ContextMessage[] {
    return [
      { role: 'user', content: 'Please add the appointment.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'create_event', arguments: '{"title":"Dentist"}' },
            tool_info: {
              type: 'mcp',
              mcp_server_id: 'google_calendar',
              mcp_server_name: 'google_calendar',
              original_tool_name: 'create_event',
              is_approval_required: false,
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: resultContent },
    ];
  }

  it('does not count a call that is only held for the owner', () => {
    const successes = successfulActionCallsThisTurn(contextWithResult(HELD_RESULT_TEXT));
    expect(successes).toEqual([]);
    expect(claimedActionNote({ content: CLAIM, successes })).toBe(CLAIMED_ACTION_NOTE);
  });

  it('does not count a provider error body passed through unchanged', () => {
    const successes = successfulActionCallsThisTurn(
      contextWithResult('{"error":{"code":404,"message":"The event was not found."}}'),
    );
    expect(successes).toEqual([]);
    expect(claimedActionNote({ content: CLAIM, successes })).toBe(CLAIMED_ACTION_NOTE);
  });

  it('does not count a JSON-RPC shaped error (a numeric code beside a message, no error key)', () => {
    const successes = successfulActionCallsThisTurn(contextWithResult('{"code":-32603,"message":"Internal error"}'));
    expect(successes).toEqual([]);
    expect(claimedActionNote({ content: CLAIM, successes })).toBe(CLAIMED_ACTION_NOTE);
  });

  it('does not count a denied call', () => {
    const successes = successfulActionCallsThisTurn(
      contextWithResult('{"error":"User denied tool call: no reason provided"}'),
    );
    expect(successes).toEqual([]);
  });

  it('counts a genuine success, so the claim behind it draws no note', () => {
    const successes = successfulActionCallsThisTurn(contextWithResult('{"event_id":"evt-1","status":"confirmed"}'));
    expect(successes).toHaveLength(1);
    expect(claimedActionNote({ content: CLAIM, successes })).toBeUndefined();
  });

  it('does not let a success from an earlier turn back this turn’s claim', () => {
    const context: ContextMessage[] = [
      ...contextWithResult('{"event_id":"evt-1","status":"confirmed"}'),
      { role: 'user', content: 'And did you add it?' },
    ];
    const successes = successfulActionCallsThisTurn(context);
    expect(successes).toEqual([]);
    expect(claimedActionNote({ content: CLAIM, successes })).toBe(CLAIMED_ACTION_NOTE);
  });
});
