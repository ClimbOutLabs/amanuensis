import { privateText, textBody } from '../../../../src/runtime/texts/textWords';
import type { Delivery, DeliveryKind } from '../../../../src/schemas/deliveries';

function delivery(text: string, kind: DeliveryKind = 'reminder'): Delivery {
  const shared = {
    id: 'd1',
    level: 'nudge' as const,
    text,
    reason: 'A test.',
    created_at: '2026-11-06T10:00:00.000Z',
    seen_at: null,
    attempts: [],
  };
  return kind === 'approval_waiting'
    ? { ...shared, kind, link: { type: 'approval', session_id: 's1', approval_id: 'a1' } }
    : { ...shared, kind, link: null };
}

/** Plain characters that each take one place in a text, so two text segments hold 306 of them. */
const ONE_PLACE = /^[A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@_]*$/;

describe('the words of a text', () => {
  it('cuts a long Full message at a word, within two text segments, name included', () => {
    const { body, withheld } = textBody({
      name: 'Mannie',
      delivery: delivery(`${'word '.repeat(200)}end`),
      mode: 'full',
    });
    expect(withheld).toBeNull();
    expect(body.length).toBeLessThanOrEqual(306);
    expect(body.endsWith('word...')).toBe(true);
    expect(body).toMatch(ONE_PLACE);
  });

  it('writes a Full message in plain characters, so it is not sent in the costlier long form', () => {
    const { body } = textBody({
      name: 'Mannie',
      delivery: delivery('Café “bill” — due… {soon} [ok] ~ |x| ^ `y` \\ 🎉 naïve'),
      mode: 'full',
    });
    expect(body).toBe('Mannie: Cafe "bill" - due... (soon) (ok) - /x/ \'y\' / naive');
    expect(body).toMatch(ONE_PLACE);
  });

  it('sends a Full message that names a link, a site, a phone number or an address in Private words', () => {
    for (const text of [
      'Your parcel is held. Pay the fee at https://parcel-fees.example.invalid/pay today.',
      'Your parcel is held. Pay the fee at parcel-fees.example.invalid/pay today.',
      'Your parcel is held. Pay the fee at parcel-fees.example.com today.',
      'Your parcel is held. Pay at parcel-fees dot com today.',
      'Your bank needs you. Write to help@bank-help.example.com now.',
      'Your bank needs you. Call five five five oh one oh oh one nine nine.',
      'Your bank needs you. Call +1 555 010 0199 right away.',
      'Your bank needs you. Call (555) 010-0199 right away.',
    ]) {
      expect(textBody({ name: 'Mannie', delivery: delivery(text), mode: 'full' })).toEqual({
        body: 'Mannie: a reminder is due. Open the app to see it.',
        withheld: 'contact_detail',
      });
    }
  });

  it('sends what the assistant noticed in Private words, even in Full', () => {
    for (const kind of ['nudge', 'approval_waiting'] as const) {
      expect(textBody({ name: 'Mannie', delivery: delivery('Bill due Friday.', kind), mode: 'full' })).toEqual({
        body: privateText({ name: 'Mannie', kind }),
        withheld: 'noticed',
      });
    }
    expect(textBody({ name: 'Mannie', delivery: delivery('This is a test.', 'note'), mode: 'full' }).body).toBe(
      'Mannie: This is a test.',
    );
  });

  it('words every kind with no content', () => {
    const kinds: DeliveryKind[] = ['reminder', 'note', 'nudge', 'approval_waiting'];
    for (const kind of kinds) {
      expect(privateText({ name: 'Mannie', kind })).toMatch(/^Mannie: [a-z ]+\. Open the app to see it\.$/);
      expect(textBody({ name: 'Mannie', delivery: delivery('Pay $482.10 to Dana.', kind), mode: 'private' }).body).toBe(
        privateText({ name: 'Mannie', kind }),
      );
    }
  });
});
