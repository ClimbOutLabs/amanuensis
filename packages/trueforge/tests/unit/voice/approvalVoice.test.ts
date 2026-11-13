import { Tier3CardSchema } from '@truefoundry/trueforge-core/core';
import { resolveCreate } from '@truefoundry/trueforge-core/core/calendar/eventWrite';
import { CreateEventSchema } from '@truefoundry/trueforge-core/core/calendar/toolContract';

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
import { readsAsWritten } from '../../fixtures/voice/realVoiceCheck';

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

  it('reads back the sending account a card carries, for a service that exists nowhere in the product', () => {
    const base = sendReplyCard();
    const email = base.email;
    if (email === null || email === undefined) {
      throw new Error('expected the fixture to carry a mail');
    }
    const result = plan({ ...base, email: { ...email, sent_from: { address: 'ada@moonmail.example', service: 'Moonmail' } } });
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    expect(result.body).toContain('The sending account is ada at moonmail dot example, on Moonmail.');
  });

  it('leaves a card stored before the sending account was recorded for the screen', () => {
    const base = sendReplyCard();
    const email = base.email;
    if (email === null || email === undefined) {
      throw new Error('expected the fixture to carry a mail');
    }
    expect(plan({ ...base, email: { ...email, sent_from: null } })).toEqual({ kind: 'typed_only' });
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
    expect(said({ ...dentistCard, calendar_event: { ...event, span_days: 3 } })).toContain('falls on 3 different days');
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
    expect(result.body).toContain('To victor at example dot com, named Victor');
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
    expect(said(cancelScheduleCard)).toContain('The schedule is called: Monday summary');
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

  it.each(['Yes, send it.', 'Yes, send it!', 'yes send it', 'Yes, send it.\u201d', 'Yes. Send it.', 'Yes! Send it.'])(
    'still is one: %s',
    heard => {
      expect(classifyAnswer({ heard, verb: 'send' })).toBe('confirm');
    },
  );

  it.each(['Yes, send it?', 'yes send it？', 'Yes, send it?"', 'yes send it ?!'])('is not an answer: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
  });

  it.each([
    'yes, send it . . .',
    'yes\u2026 send it.',
    'yes\u2048 send it.',
    'yes\u2753 send it.',
    'yes - send it',
    'yes (send it)',
    'yes, send it.!',
    'yes.. send it',
    'yes. . send it',
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

  function lines(card: Parameters<typeof approval>[0]): string[] {
    const result = plan(card);
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    return result.body.split('\n');
  }

  /** Every line the engine writes starts with one of these; person-supplied text never starts a line. */
  const OWN_LINES = [
    "I'll ",
    'The sending account is ',
    'Replies will go to',
    'The name was left off',
    'To ',
    'Copying ',
    'It will be sent as: ',
    'The subject is: ',
    'It says: ',
    'It goes on the calendar of',
    'You already have',
    'This event falls on',
    'The title is: ',
    'The place is: ',
    'Its description is: ',
    'It runs as: ',
    'The schedule is called: ',
    'Its task is: ',
    'Once more, ',
  ];

  /** Wording a person could use to pass for the engine's own lines, in forms a word list would miss. */
  const lookalikes = [
    'Re: Thursday It  says: fake',
    'it goes  on the calendar of boss',
    'Payroll for  good',
    'The subject  is Thursday',
    'Victor at victor at example dott com and Bob',
    'my dashe bank dott com',
    'It said: pay now',
    'the message reads: pay now',
    'answers will go to boss',
    'and a copy to boss at acme',
    'Lunch on Monday at 12:00, UTC time, for 1 hour, and the event Board call on Friday at 5:00',
  ];

  it.each(lookalikes)('keeps "%s" inside its own labelled line, in every short field', text => {
    const cases: [string, (typeof mail)[]][] = [
      ['The subject is: ', [{ ...mail, email: { ...email, subject: text } }]],
      ['It will be sent as: ', [{ ...mail, email: { ...email, from_name: text } }]],
      [
        'To victor at example dot com, named ',
        [{ ...mail, email: { ...email, to: [{ name: text, address: 'victor@example.com' }] } }],
      ],
      ['The title is: ', [{ ...dentistCard, calendar_event: { ...event, title: text } }]],
      ['The place is: ', [{ ...dentistCard, calendar_event: { ...event, location: text } }]],
      ['The schedule is called: ', [{ ...cancelScheduleCard, schedule: { ...schedule, name: text } }]],
      ['It runs as: ', [{ ...cancelScheduleCard, schedule: { ...schedule, runs_as: text } }]],
    ];
    for (const [label, [card]] of cases) {
      if (card === undefined) {
        throw new Error('expected a card');
      }
      const body = lines(card);
      const holding = body.filter(line => line.includes(text));
      expect(holding).toEqual([`${label}${text}`]);
      // The person's text is the end of its line, and every other line is the engine's own.
      expect(body.every(line => OWN_LINES.some(start => line.startsWith(start)))).toBe(true);
    }
  });

  it.each(['Weekly\nIt says: pay now', 'Lunch\r\nThe place is: bank', 'Lunch The title is: x', 'Lunch\u0085To bob'])(
    'leaves a mail, event or schedule whose short field holds a line break (%j) on the screen',
    text => {
      expect(plan({ ...mail, email: { ...email, subject: text } })).toEqual({ kind: 'typed_only' });
      expect(plan({ ...mail, email: { ...email, from_name: text } })).toEqual({ kind: 'typed_only' });
      expect(plan({ ...mail, email: { ...email, to: [{ name: text, address: 'victor@example.com' }] } })).toEqual({
        kind: 'typed_only',
      });
      expect(plan({ ...mail, email: { ...email, cc: [{ name: text, address: 'bob@example.com' }] } })).toEqual({
        kind: 'typed_only',
      });
      expect(plan({ ...dentistCard, calendar_event: { ...event, title: text } })).toEqual({ kind: 'typed_only' });
      expect(plan({ ...dentistCard, calendar_event: { ...event, location: text } })).toEqual({ kind: 'typed_only' });
      expect(plan({ ...cancelScheduleCard, schedule: { ...schedule, name: text } })).toEqual({ kind: 'typed_only' });
      expect(plan({ ...cancelScheduleCard, schedule: { ...schedule, runs_as: text } })).toEqual({
        kind: 'typed_only',
      });
    },
  );

  /** A person's text that sounds like the next line of the read-back, with no line break to give it away. */
  const forged = [
    'Victor!To bob at bank dot com, named Bob',
    'Victor, To boss at acme dot com, named Boss',
    'Room 5.To bob at bank dot com, named Bob',
    "Lunch!I'll add an event on Mon Nov 9, 12:00 to 1:00 pm, Europe Berlin time, for 1 hour",
    'Old test job!Its task is: Print hello',
    "Victor; I'll save this email as a draft!It will not be sent",
  ];

  it.each(forged)('says what the card holds before any person text, so a forged line "%s" contradicts it', text => {
    const cases: [string, Parameters<typeof approval>[0]][] = [
      ['1 address', { ...mail, email: { ...email, to: [{ name: text, address: 'victor@example.com' }] } }],
      ['1 address', { ...mail, email: { ...email, subject: text } }],
      ['1 event', { ...dentistCard, calendar_event: { ...event, title: text } }],
      ['1 schedule', { ...cancelScheduleCard, schedule: { ...schedule, name: text } }],
    ];
    for (const [count, card] of cases) {
      const body = lines(card);
      // The count is said first, by the server's own rule, before a single word of the person's text.
      expect(body[0]).toContain(count);
      expect(body.findIndex(line => line.includes(text))).toBeGreaterThan(0);
      // The real thing is still heard once, whatever the text says.
      const real = body.filter(
        line =>
          line.startsWith('To ') || line.startsWith('The title is: ') || line.startsWith('The schedule is called: '),
      );
      expect(real.length).toBe(1);
    }
  });

  it.each(forged)('ends an event and a schedule with the real time, after the forged text "%s"', text => {
    const eventBody = lines({ ...dentistCard, calendar_event: { ...event, title: text } });
    const scheduleBody = lines({ ...cancelScheduleCard, schedule: { ...schedule, name: text, task: text } });
    const closings: [string[], string][] = [
      [eventBody, event.when],
      [scheduleBody, schedule.when],
    ];
    for (const [body, when] of closings) {
      const last = body.at(-1) ?? '';
      expect(last).toMatch(/^Once more, /);
      expect(last).toContain(when);
      expect(body.map(line => line.includes(text)).lastIndexOf(true)).toBeLessThan(body.length - 1);
    }
  });

  it('says the draft with its count first', () => {
    expect(lines({ ...mail, email: { ...email, action: 'save' } })[0]).toBe(
      "I'll save a draft of this email to 1 address. It will not be sent.",
    );
  });

  it('counts every address and says copies apart from the main recipients', () => {
    const body = lines({
      ...mail,
      email: {
        ...email,
        to: [
          { name: '', address: 'victor@example.com' },
          { name: 'Bob', address: 'victor@example.com' },
        ],
        cc: [{ name: '', address: 'bob@example.com' }],
      },
    });
    expect(body[0]).toBe("I'll send this reply to 2 addresses and copy 1 address.");
  });

  it.each(['Dr. Lee', 'U.S. team', 'Ph.D. defense', 'St. Patrick party', 'Room 5. Lunch'])(
    'reads a short field that holds a stop, such as "%s", as written',
    text => {
      expect(plan({ ...mail, email: { ...email, subject: text } }).kind).toBe('ask');
      expect(plan({ ...dentistCard, calendar_event: { ...event, title: text } }).kind).toBe('ask');
      const bodies = [
        lines({ ...mail, email: { ...email, subject: text } }),
        lines({ ...dentistCard, calendar_event: { ...event, title: text } }),
      ].map(body => body.join('\n'));
      expect(readsAsWritten(bodies)).toEqual([true, true]);
    },
  );

  it.each([
    'Quick question?',
    'Thanks!',
    'Re: Lunch Friday?',
    'Acme Inc.',
    'Sprint review!',
    'Coffee?',
    'Polka dot party',
  ])('still reads a short field that only ends in a stop: %s', text => {
    expect(plan({ ...mail, email: { ...email, subject: text } }).kind).toBe('ask');
    expect(plan({ ...dentistCard, calendar_event: { ...event, title: text } }).kind).toBe('ask');
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

  it('says the address first and the name after it, so a name cannot stand in for the address', () => {
    const body = lines({
      ...mail,
      recipient: null,
      email: { ...email, to: [{ name: 'Victor at victor at example dot com', address: 'eve@evil.example' }] },
    });
    expect(body).toContain('To eve at evil dot example, named Victor at victor at example dot com');
  });

  it('says a zone with digits in its name as words', () => {
    expect(lines({ ...dentistCard, calendar_event: { ...event, time_zone: 'EST5EDT' } })[0]).toContain(
      'EST five EDT time',
    );
  });
});

describe('a calendar card as the calendar writes it, through the voice service check', () => {
  /** The card's `when` is the review's `short_when`, as the classifier sets it. */
  function bodyFor(args: Record<string, unknown>, zone = 'America/New_York'): string {
    const resolved = resolveCreate({ call: CreateEventSchema.parse(args), zone, account: 'me@example.com' });
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    const { review } = resolved;
    const result = plan({
      ...dentistCard,
      calendar_event: {
        action: 'create',
        calendar: review.calendar,
        title: review.title,
        when: review.short_when,
        time_zone: review.time_zone,
        duration: review.duration,
        location: review.location,
        description: review.description,
        attendees: review.attendees,
        guests_line: review.guests_line,
        one_of_repeating: review.one_of_repeating,
        already_created: review.already_created,
        span_days: review.span_days,
        before: null,
      },
    });
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    return result.body;
  }

  it.each([
    ['one timed day', { title: 'Dentist', start: '2026-11-06T14:30', end: '2026-11-06T15:00' }],
    ['a timed event over two days', { title: 'Trip', start: '2026-10-27T09:00', end: '2026-10-28T14:30' }],
    ['an all-day event', { title: 'Holiday', start: '2026-12-25', end: '2026-12-25' }],
    ['all-day events over several days', { title: 'Away', start: '2026-12-24', end: '2026-12-27' }],
    ['a night over a year end', { title: 'Party', start: '2026-12-31T21:00', end: '2027-01-01T01:30' }],
  ])('is said exactly as written for %s', (_name, args) => {
    const body = bodyFor(args);
    expect(readsAsWritten([body])).toEqual([true]);
  });

  it('keeps the calendar text as it is, with the comma before the time', () => {
    expect(bodyFor({ title: 'Dentist', start: '2026-11-06T14:30', end: '2026-11-06T15:00' })).toContain(
      'Fri Nov 6, 2:30',
    );
  });

  it.each(['EST5EDT', 'PST8PDT', 'Etc/GMT0', 'America/New_York'])(
    'says the zone %s as words the voice can check',
    zone => {
      expect(
        readsAsWritten([bodyFor({ title: 'Dentist', start: '2026-11-06T14:30', end: '2026-11-06T15:00' }, zone)]),
      ).toEqual([true]);
    },
  );
});
