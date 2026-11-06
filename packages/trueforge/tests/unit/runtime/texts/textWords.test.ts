import { privateText, textBody } from '../../../../src/runtime/texts/textWords';
import type { DeliveryKind } from '../../../../src/schemas/deliveries';

function words({ notice_text, kind = 'nudge' }: { notice_text: string; kind?: DeliveryKind }) {
  return { name: 'Mannie', kind, notice_text };
}

/** Plain characters that each take one place in a text, so two text segments hold 306 of them. */
const ONE_PLACE = /^[A-Za-z0-9 !"#$%&'()*+,\-./:;<=>?@_]*$/;

describe('the words of a text', () => {
  it('cuts a long Full message at a word, within two text segments, name included', () => {
    const { body, sent_as } = textBody({ ...words({ notice_text: `${'word '.repeat(200)}end` }), mode: 'full' });
    expect(sent_as).toBe('full');
    expect(body.length).toBeLessThanOrEqual(306);
    expect(body.endsWith('word...')).toBe(true);
    expect(body).toMatch(ONE_PLACE);
  });

  it('writes a Full message in plain characters, so it is not sent in the costlier long form', () => {
    const { body } = textBody({
      ...words({ notice_text: 'Café “bill” — due… {soon} [ok] ~ |x| ^ `y` \\ 🎉 naïve' }),
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
      expect(textBody({ ...words({ notice_text: text }), mode: 'full' })).toEqual({
        body: 'Mannie: something needs you. Open the app to see it.',
        sent_as: 'private',
      });
    }
  });

  it('words every kind with no content', () => {
    const kinds: DeliveryKind[] = ['reminder', 'note', 'nudge', 'approval_waiting'];
    for (const kind of kinds) {
      expect(privateText({ name: 'Mannie', kind })).toMatch(/^Mannie: [a-z ]+\. Open the app to see it\.$/);
      expect(textBody({ ...words({ notice_text: 'Pay $482.10 to Dana.', kind }), mode: 'private' }).body).toBe(
        privateText({ name: 'Mannie', kind }),
      );
    }
  });
});
