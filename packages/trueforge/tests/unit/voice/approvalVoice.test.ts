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
    const said = result.segments.map(segment => segment.text).join('\n');
    expect(said).toContain('Victor');
    expect(said).toContain('Re: Thursday');
    expect(said).toContain('Thursday at three works for me. Bring the form, $40 in cash & 2 photos.');
  });

  it('says a calendar event with its description', () => {
    const result = plan(dentistCard);
    if (result.kind !== 'ask') {
      throw new Error('expected a read-back');
    }
    const said = result.segments.map(segment => segment.text).join('\n');
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

  it('still reads back stopping a schedule', () => {
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
      const said = result.segments.map(segment => segment.text.replace(/[/_]/g, ' ')).join('\n');
      const spoken = new Map<string, string>(Object.entries(rules));
      for (const [key, value] of Object.entries(shape)) {
        if (spoken.get(key) === 'spoken' && typeof value === 'string' && value !== '') {
          expect([key, said.includes(value.replace(/[/_]/g, ' '))]).toEqual([key, true]);
        }
      }
    }
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
    expect(result.segments[0]?.text).toContain('Victor at victor@example.com');
  });
});

describe('what counts as an answer', () => {
  it.each(['Yes, send it\u061f', 'yes send it\u203d', 'yes send it \u2047'])(
    'is not an answer, in any script: %s',
    heard => {
      expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
    },
  );

  it.each(['Yes, send it?', 'yes send it？', 'Yes, send it?"', 'yes send it ?!'])('is not an answer: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
  });
});
