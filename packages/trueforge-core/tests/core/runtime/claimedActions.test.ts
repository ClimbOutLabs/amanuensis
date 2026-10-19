/**
 * The claimed-action guard: an answer that claims an action with no matching successful call in
 * the turn gets the plain note; plans, questions, negations and backed claims get nothing.
 */
import {
  CLAIMED_ACTION_NOTE,
  claimedActionNote,
  detectActionClaims,
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
