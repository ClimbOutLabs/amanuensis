import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Tier3CardSchema } from '@truefoundry/trueforge-core/core';

import { CARD_FIELD_RULES, classifyAnswer, planVoiceApproval, readsAsWritten } from '../../../src/voice/approvalVoice';
import {
  approval,
  calendarCard,
  cancelScheduleCard,
  dentistCard,
  sendReplyCard,
  typedOnlyCards,
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

  it('keeps ordinary writing, numbers, money and hyphenated words on the voice path', () => {
    const body = 'It\'s "fine" (really) - see you at 9:30, 3.5 hours, in e-mail form... Costs $1,200 or 15%!';
    expect(plan(sendReplyCard(body.replace(' - ', ', '))).kind).toBe('ask');
  });

  it('leaves a file-write card (tier 2) for the screen', () => {
    expect(plan(calendarCard, 2)).toEqual({ kind: 'typed_only' });
    expect(plan(calendarCard, 3).kind).toBe('ask');
  });

  it('still reads back stopping a schedule', () => {
    expect(plan(cancelScheduleCard).kind).toBe('ask');
  });

  it('classifies every field of the card schema, so a new field cannot slip through unreviewed', () => {
    expect(Object.keys(CARD_FIELD_RULES).sort()).toEqual(Object.keys(Tier3CardSchema.shape).sort());
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
  it.each(['Yes, send it?', 'yes send it？', 'Yes, send it?"', 'yes send it ?!'])('is not an answer: %s', heard => {
    expect(classifyAnswer({ heard, verb: 'send' })).toBe('other');
  });
});

describe('the read-back check against the voice service', () => {
  const cases: unknown = JSON.parse(
    readFileSync(path.join(__dirname, '../../../../../ops/aman-tts/tests/read_back_cases.json'), 'utf8'),
  );

  it('agrees with the cases the voice service tests against its own text cleaning', () => {
    if (!Array.isArray(cases)) {
      throw new Error('expected a list of cases');
    }
    expect(cases.length).toBeGreaterThan(10);
    for (const entry of cases) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('text' in entry) ||
        !('read_aloud' in entry) ||
        !('cleaning_keeps_words' in entry)
      ) {
        throw new Error('bad case');
      }
      const { text, read_aloud: readAloud, cleaning_keeps_words: keeps } = entry;
      if (typeof text !== 'string' || typeof readAloud !== 'boolean' || typeof keeps !== 'boolean') {
        throw new Error('bad case');
      }
      expect([text, readsAsWritten(text)]).toEqual([text, readAloud]);
      // Never read aloud anything the voice would change.
      expect(readAloud && !keeps).toBe(false);
    }
  });
});
