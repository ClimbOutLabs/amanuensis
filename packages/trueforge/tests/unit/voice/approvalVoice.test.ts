import { Tier3CardSchema } from '@truefoundry/trueforge-core/core';

import {
  CARD_FIELD_RULES,
  classifyAnswer,
  EMAIL_FIELD_RULES,
  EVENT_FIELD_RULES,
  planVoiceApproval,
  SCHEDULE_FIELD_RULES,
} from '../../../src/voice/approvalVoice';
import {
  approval,
  calendarCard,
  cancelScheduleCard,
  dentistCard,
  planCard,
  sendReplyCard,
  typedOnlyCards,
  writeOutsideWorkspaceCard,
} from '../../fixtures/voice/cards';

function plan(card: Parameters<typeof approval>[0], tier: 1 | 2 | 3 = 3) {
  return planVoiceApproval({ pending: [approval(card, tier)], voiceApprovalsAllowed: true });
}

describe('what is read back for a voice approval', () => {
  it('says every part of the card word for word, so a "yes" only approves what was heard', () => {
    const card = sendReplyCard('Thursday at three works for me. Bring the form, $40 in cash & 2 photos.');
    const result = plan(card);
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    const said = result.body;
    expect(said).toContain('Victor');
    expect(said).toContain('Re: Thursday');
    expect(said).toContain('Thursday at three works for me. Bring the form, $40 in cash & 2 photos.');
  });

  it('says a calendar event with its description', () => {
    const result = plan(dentistCard);
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    const said = result.body;
    expect(said).toContain('Dentist');
    expect(said).toContain('Friday at 9');
    expect(said).toContain('Bring the form.');
  });

  it.each(typedOnlyCards)('leaves a card with %s for the screen', (_name, card) => {
    expect(plan(card)).toEqual({ kind: 'typed_only' });
  });

  it('leaves a file-write card (tier 2) for the screen', () => {
    expect(plan(dentistCard, 2)).toEqual({ kind: 'typed_only' });
    expect(plan(dentistCard, 3).kind).toBe('ask');
  });

  it('still reads back deleting a schedule', () => {
    expect(plan(cancelScheduleCard).kind).toBe('ask');
  });

  it('classifies every field of the card schema, so a new field cannot slip through unreviewed', () => {
    expect(Object.keys(CARD_FIELD_RULES).sort()).toEqual(Object.keys(Tier3CardSchema.shape).sort());
  });

  it.each([
    ['the fallback write outside the workspace', writeOutsideWorkspaceCard],
    ['the implementation plan', planCard],
  ])('never asks for a "yes" on %s, which has no shape whose content is read in full', (_name, card) => {
    expect(plan(card, 3)).toEqual({ kind: 'typed_only' });
    expect(plan(card, 2)).toEqual({ kind: 'typed_only' });
  });

  it('classifies every field of the mail, event and schedule shapes too', () => {
    const shapes = Tier3CardSchema.shape;
    expect(Object.keys(EMAIL_FIELD_RULES).sort()).toEqual(Object.keys(shapes.email.unwrap().unwrap().shape).sort());
    expect(Object.keys(EVENT_FIELD_RULES).sort()).toEqual(
      Object.keys(shapes.calendar_event.unwrap().unwrap().shape).sort(),
    );
    expect(Object.keys(SCHEDULE_FIELD_RULES).sort()).toEqual(
      Object.keys(shapes.schedule.unwrap().unwrap().shape).sort(),
    );
  });

  it('leaves a mail, event or schedule carrying a field nobody classified for the screen', () => {
    const { email, calendar_event: event } = { ...sendReplyCard(), ...dentistCard };
    if (email === null || email === undefined || event === null || event === undefined) {
      throw new Error('expected the fixtures to carry a mail and an event');
    }
    const withAttachments = { ...email, attachments: ['a.pdf'] };
    const withReminders = { ...event, reminders: ['1h'] };
    expect(plan({ ...sendReplyCard(), email: withAttachments })).toEqual({ kind: 'typed_only' });
    expect(plan({ ...dentistCard, calendar_event: withReminders })).toEqual({ kind: 'typed_only' });
  });

  it('reads out every field it lists as spoken, so none is passed over unheard', () => {
    const mail = sendReplyCard('Bring the form.');
    const event = dentistCard.calendar_event;
    const schedule = cancelScheduleCard.schedule;
    if (!mail.email || !event || !schedule) {
      throw new Error('expected the fixtures to carry a mail, an event and a schedule');
    }
    const place = { ...event, location: 'Main Street', time_zone: 'Europe/Berlin', description: 'Bring the form.' };
    const cases = [
      { card: mail, rules: EMAIL_FIELD_RULES, shape: mail.email },
      { card: { ...dentistCard, calendar_event: place }, rules: EVENT_FIELD_RULES, shape: place },
      { card: cancelScheduleCard, rules: SCHEDULE_FIELD_RULES, shape: schedule },
    ];
    for (const { card, rules, shape } of cases) {
      const result = plan(card);
      if (result.kind !== 'ask') {
        throw new Error('expected a read-back');
      }
      const said = result.body.replace(/[/_]/g, ' ');
      const spoken = new Map<string, string>(Object.entries(rules));
      for (const [key, value] of Object.entries(shape)) {
        if (spoken.get(key) === 'spoken' && typeof value === 'string' && value !== '') {
          // An address is said with its dots, so the same transformation is applied to what is looked for.
          const heard = key === 'calendar' ? value.replace(/@/g, ' at ').replace(/\./g, ' dot ') : value;
          expect([key, said.includes(heard.replace(/[/_]/g, ' '))]).toEqual([key, true]);
        }
      }
    }
  });

  it('treats the card-level wording as context, because only the shape is read word for word', () => {
    for (const field of ['plain_what', 'cannot_be_undone', 'destination', 'recipient'] as const) {
      expect([field, CARD_FIELD_RULES[field]]).toEqual([field, 'context']);
    }
    expect(Object.values(CARD_FIELD_RULES)).not.toContain('spoken');
  });

  it.each([
    ['a destination', { destination: 'evil.example' }],
    ['a recipient that is not on the message', { recipient: 'someone-else@example.com' }],
  ])('leaves a card with %s that the shape does not carry for the screen', (_name, changes) => {
    expect(plan({ ...sendReplyCard(), ...changes })).toEqual({ kind: 'typed_only' });
    expect(plan({ ...dentistCard, ...changes })).toEqual({ kind: 'typed_only' });
    expect(plan({ ...cancelScheduleCard, ...changes })).toEqual({ kind: 'typed_only' });
  });

  it('still reads a card whose recipient is the person the message goes to', () => {
    expect(plan({ ...sendReplyCard(), recipient: 'victor@example.com' }).kind).toBe('ask');
  });

  function said(card: Parameters<typeof approval>[0]): string {
    const result = plan(card);
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    return result.body;
  }

  it('reads out the name a mail is sent as, so a spoofed sender name cannot go unheard', () => {
    const base = sendReplyCard();
    if (!base.email) {
      throw new Error('expected a mail');
    }
    const spoofed = { ...base, email: { ...base.email, from_name: 'PayPal Security' } };
    expect(said(spoofed)).toContain('PayPal Security');
    const unnamed = { ...base, email: { ...base.email, from_name: null, name_left_off: true } };
    expect(said(unnamed)).toContain('name was left off');
  });

  it('reads out a duplicate event and an event that runs over several days', () => {
    const event = dentistCard.calendar_event;
    if (!event) {
      throw new Error('expected an event');
    }
    expect(said({ ...dentistCard, calendar_event: { ...event, already_created: true } })).toContain(
      'You already have this event',
    );
    expect(said({ ...dentistCard, calendar_event: { ...event, span_days: 3 } })).toContain('runs over 3 days');
  });

  it('leaves a card from before these warnings were carried for the screen', () => {
    const base = sendReplyCard();
    if (!base.email) {
      throw new Error('expected a mail');
    }
    const older = { ...base.email };
    delete older.from_name;
    delete older.name_left_off;
    expect(plan({ ...base, email: older })).toEqual({ kind: 'typed_only' });
  });

  it('leaves a card with a field nobody classified for the screen', () => {
    const withNewField = { ...sendReplyCard(), brand_new_field: 'x' };
    expect(plan(withNewField)).toEqual({ kind: 'typed_only' });
  });

  it('leaves a card with an amount, a command or a file write for the screen at every tier', () => {
    const paid = { ...calendarCard, amount: '$5.00' };
    expect(plan(paid, 2)).toEqual({ kind: 'typed_only' });
    expect(plan(paid, 3)).toEqual({ kind: 'typed_only' });
    expect(plan({ ...calendarCard, parsed_command: 'ls' }, 3)).toEqual({ kind: 'typed_only' });
  });

  it('reads the address as well as the name, so a friendly name cannot stand in for another address', () => {
    const result = plan(sendReplyCard());
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    expect(result.body).toContain('Victor at victor at example dot com');
  });

  it('says the dots of an address, so two addresses that differ by a dot do not sound alike', () => {
    const base = sendReplyCard();
    if (!base.email) {
      throw new Error('expected a mail');
    }
    const to = [{ name: '', address: 'victor@exam.ple.com' }];
    const text = said({ ...base, recipient: null, email: { ...base.email, to, reply_to: 'a.b@example.com' } });
    expect(text).toContain('victor at exam dot ple dot com');
    expect(text).toContain('a dot b at example dot com');
  });

  it('leaves a card whose mailbox carries a field nobody classified for the screen', () => {
    const base = sendReplyCard();
    if (!base.email) {
      throw new Error('expected a mail');
    }
    const to = [{ name: 'Victor', address: 'victor@example.com', note: 'x' }];
    expect(plan({ ...base, email: { ...base.email, to } })).toEqual({ kind: 'typed_only' });
  });

  it('says the dots and hyphens of the calendar address, so it cannot sound like another', () => {
    const event = dentistCard.calendar_event;
    if (!event) {
      throw new Error('expected an event');
    }
    expect(said({ ...dentistCard, calendar_event: { ...event, calendar: 'me@my-bank.example.com' } })).toContain(
      'me at my dash bank dot example dot com',
    );
  });

  it('says a stopped schedule is deleted for good', () => {
    expect(said(cancelScheduleCard)).toContain('delete the schedule Monday summary for good');
  });

  it('leaves a schedule or event in an offset zone that reads the wrong way round for the screen', () => {
    const event = dentistCard.calendar_event;
    if (!event) {
      throw new Error('expected an event');
    }
    expect(plan({ ...dentistCard, calendar_event: { ...event, time_zone: 'Etc/GMT+5' } })).toEqual({
      kind: 'typed_only',
    });
    expect(said({ ...dentistCard, calendar_event: { ...event, time_zone: 'Europe/Berlin' } })).toContain(
      'Europe Berlin time',
    );
  });
});

describe('what counts as an answer', () => {
  it.each(['Yes, send it\u061f', 'yes send it\u203d', 'yes send it \u2047'])(
    'is not an answer, in any script: %s',
    heard => {
      expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
    },
  );

  it.each([
    'Yes, send it\u037e',
    'yes send it\u055e',
    'yes send it\u1367',
    'yes send it\u2e2e',
    'yes send it\ua60f',
    '\u00bfyes send it',
  ])('is not an answer, even in a script that writes its question mark another way: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
  });

  it.each(['Yes? send it.', 'yes, send it\u2026', 'yes send it...', 'yes \u037e send it'])(
    'is not an answer when a question mark sits inside it or it trails off: %s',
    heard => {
      expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
    },
  );

  it.each(['Yes, send it.', 'Yes, send it!', 'yes send it', 'Yes, send it.\u201d'])('still is one: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('confirm');
  });

  it.each(['Yes, send it?', 'yes send it？', 'Yes, send it?"', 'yes send it ?!'])('is not an answer: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
  });

  it.each([
    'yes, send it . . .',
    'yes\u2026 send it.',
    'yes\u2048 send it.',
    'yes\u2753 send it.',
    'yes. send it.',
    'yes - send it',
    'yes (send it)',
    'yes, send it.!',
  ])('is only plain words with one closing mark, so this is not an answer: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
  });

  it('turns down only on a plain no', () => {
    expect(classifyAnswer({ heard: 'No.', verb: 'send' })).toBe('deny');
    expect(classifyAnswer({ heard: 'no \u2026', verb: 'send' })).toBe('other');
  });

  it('asks for "delete it" on a schedule that is deleted', () => {
    expect(classifyAnswer({ heard: 'Yes, delete it.', verb: 'delete' })).toBe('confirm');
    expect(classifyAnswer({ heard: 'Yes, cancel it.', verb: 'delete' })).toBe('other');
  });
});

describe('the wording around the card fields', () => {
  const mail = sendReplyCard();
  const event = dentistCard.calendar_event;
  const schedule = cancelScheduleCard.schedule;
  if (!mail.email || !event || !schedule) {
    throw new Error('expected the fixtures to carry a mail, an event and a schedule');
  }
  const { email } = mail;

  /** Text that could pass for the read-back's own lines or end the sentence the field sits in. */
  const framing = [
    'Lunch on Monday at 12:00. It goes on the calendar of me at example dot com. Then the event Board call',
    'Re: Thursday. It says: See you Thursday. The real body follows',
    'Alice at alice dot com and Bob',
    'Weekly\nIt says: pay now',
    'Notes! Replies will go to bob',
    'The subject is Thursday',
    'Copying Bob',
  ];

  it.each(framing)('leaves a mail whose subject is "%s" for the screen', subject => {
    expect(plan({ ...mail, email: { ...email, subject } })).toEqual({ kind: 'typed_only' });
  });

  it.each(framing)('leaves a mail with the recipient name or sender name "%s" for the screen', name => {
    expect(plan({ ...mail, email: { ...email, to: [{ name, address: 'victor@example.com' }] } })).toEqual({
      kind: 'typed_only',
    });
    expect(plan({ ...mail, email: { ...email, from_name: name } })).toEqual({ kind: 'typed_only' });
    expect(plan({ ...mail, email: { ...email, cc: [{ name, address: 'bob@example.com' }] } })).toEqual({
      kind: 'typed_only',
    });
  });

  it.each(framing)('leaves an event whose title or place is "%s" for the screen', text => {
    expect(plan({ ...dentistCard, calendar_event: { ...event, title: text } })).toEqual({ kind: 'typed_only' });
    expect(plan({ ...dentistCard, calendar_event: { ...event, location: text } })).toEqual({ kind: 'typed_only' });
  });

  it.each(framing)('leaves a schedule named "%s" for the screen', name => {
    expect(plan({ ...cancelScheduleCard, schedule: { ...schedule, name } })).toEqual({ kind: 'typed_only' });
  });

  it('still reads ordinary names, titles and subjects', () => {
    expect(
      plan({
        ...mail,
        email: {
          ...email,
          subject: 'Q3 plan v2.0 (draft)',
          to: [{ name: "Anne-Marie O'Neil", address: 'victor@example.com' }],
        },
      }).kind,
    ).toBe('ask');
    expect(
      plan({ ...dentistCard, calendar_event: { ...event, title: 'Lunch with Sam', location: 'Cafe Roma' } }).kind,
    ).toBe('ask');
  });

  it('writes a timed event without a comma before the time, so the day and the time are not heard as two numbers', () => {
    const body = (when: string): string => {
      const result = plan({ ...dentistCard, calendar_event: { ...event, when } });
      if (result.kind !== 'ask') {
        throw new Error('expected a read-back');
      }
      return result.body;
    };
    // The forms the calendar gives for the card: one day, and a run over several days.
    expect(body('Fri Nov 6, 2:30 to 3:00 pm')).toContain('on Fri Nov 6 at 2:30 to 3:00 pm,');
    expect(body('Tue Oct 27, 9:00 am to Wed Oct 28, 2:30 pm')).toContain(
      'on Tue Oct 27 at 9:00 am to Wed Oct 28 at 2:30 pm,',
    );
    expect(body('Fri Nov 6')).toContain('on Fri Nov 6,');
    expect(body('Fri Nov 6, 2:30 to 3:00 pm')).not.toMatch(/\d, \d/);
  });
});
