import { plainText, privateText, textBody } from '../../../../src/runtime/texts/textWords';
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
      test: false,
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
    expect(plainText('Café “bill” — due… {soon} [ok] ~ |x| ^ `y` \\ 🎉 naïve')).toBe(
      'Cafe "bill" - due... (soon) (ok) - /x/ \'y\' / naive',
    );
    const { body } = textBody({
      test: false,
      name: 'Mannie',
      delivery: delivery('Café “bill” — due… {soon} 🎉 naïve'),
      mode: 'full',
    });
    expect(body).toBe('Mannie: Cafe "bill" - due... (soon) naive');
    expect(body).toMatch(ONE_PLACE);
  });

  it('sends Full words only when they hold no phone number, link or spelled-out address of any kind', () => {
    for (const text of [
      // Digits in a shape that is not an amount, a count, a code, a time or a date.
      'Call 1-800-FLOWERS',
      'call 1-800-flowers',
      'Pay into GB82WEST12345698765432',
      'Order 2 x 100-PACK filters',
      'Call +1955-12-23',
      'Call +12:34',
      'Call +1 555 010',
      // A slash, an at sign, or a dot, comma, colon or hash inside a word.
      'go to bit ly/abc',
      'Write to ceo@evil',
      'Pay at evil.com',
      'Pay at e-v-i-l.c-o-m',
      'Visit evil,io',
      'Visit evil:io',
      'Visit evil#io',
      'Visit w.w.w evil',
      // An at sign in brackets, spaced or not.
      'Write to ceo [at] evil',
      'Write to bob ( at ) gmail',
      // Single letters in a row, whatever punctuation follows them.
      'Pay at e v i l . c o m',
      'Pay at e v i l d o t c o m',
      'Visit w w w evil com',
      'I O U . M E',
      'e! v! i! l! c! o! m!',
      // A site read out in words.
      'Pay at evil dot com',
      'Visit evil dot help today',
      'Visit evil dot xyz',
      'Visit evil dot museum',
      'Visit evil dot ly slash abc',
      'Pay bank dot example',
      'Visit www evil',
      'Open https evil',
      // A number read out in a row, in words or digits, whatever joins them.
      'call eight hundred flowers',
      'call five five five oh one oh oh',
      'call five fifty five, twelve thirty four',
      'call eighteen oh oh',
      'call five; five; five',
      'call five. five. five',
      'call five and five and five',
      'call five! five! five! one! two!',
      'call five? five? five?',
      'call "five" "five" "five"',
      // The same numbers joined by dashes or apostrophes, alone or mixed with digits or spaces.
      'call five-five-five-one-two-three-four',
      'call five-five-five',
      'call fifty-five-five',
      "call five'five'five'one",
      "call five'five five",
      'call five-five five',
      'call 5 five-five',
      'call five-five-5',
      'call 5-five-5',
      'call twenty-five-five',
      'call one-eight-hundred',
      'visit e-v-i-l',
      "visit e'v'i'l",
      'call five: five: five',
      'call nought five five',
      'call niner niner niner',
      'Call 5 5 5',
      // More than 6 digits in all, however they are spread.
      'Ring 2015-12-31 then 45',
      'Call 12/31/2015 then 45',
      'Call 2015-12-31 or 1955-12-31',
      'Renew the passport by 2026-11-20',
      'call 55 five six 12 seven eight',
      'call 12/31/2015 five six 45 seven eight',
      'ring five five, then one two, next three four, next five six, next seven eight',
      'Room 4021 at 9:30',
      'Ring 5551-23-45 then 67:00',
      // Times and dates out of range.
      'Call 20:25 55:51 23:45',
      'Dial 12:34 56:78',
      'call Jan 18 0035 or Dec 55 1234',
      'Back at 13pm',
      'Party on Feb 31',
      'Party on the 31st of April',
      // A currency sign that a text cannot carry.
      'Pay ₹500 today',
    ]) {
      expect([
        text,
        textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' }).withheld,
      ]).toEqual([text, 'not_plain_words']);
    }
  });

  it('keeps ordinary words, amounts, codes, times and dates written the usual ways, in Full', () => {
    for (const text of [
      'Water the plants',
      'Call Mum about the trip',
      'Team lunch at 12:30',
      'Pick up the kids at 3:30 pm',
      'Dentist at 9am tomorrow',
      'Dentist at 2:30 p.m.',
      'Bins go out on 11/06',
      'Call Dana about the move on 7 November',
      'Send the card before Nov 6, 2026',
      'Text me or call me',
      'Plan A or plan B',
      'CALL THE BANK BACK',
      'Doctor follow-up at 3pm',
      "It's a big day",
      'Rent is due on the 1st',
      'Take 2 pills',
      'Join the Google Meet',
      'Coffee at 7.45 with Sam',
      'Party on the 22nd of May',
      'Pay the gas bill (it is due)',
      'Bread & milk - and eggs!',
      'Meet at 12:30, then call Dana at 6 pm.',
      'Book the dentist for Jan 18, 2027',
      // Amounts and counts, with their signs.
      'Pay rent $1,450 by the 1st',
      'Lunch money $20',
      '50% off at the shoe shop',
      'Walk 5,000 steps',
      'Room 204 at 3pm',
      'Book the 60th birthday cake',
      // Short codes of letters and digits.
      'Call Mom re: Q3',
      '5k run Sat 7am',
      'Flight AA100 at 6:05',
      'Take the B12 pills',
      // Ordinary words joined by dashes or apostrophes, and one number written as a hyphenated word.
      'Doctor follow-up at 3pm',
      "It's O'Brien's turn, rock 'n' roll",
      'Buy twenty-five stamps',
      'Book a one-on-one with Sam',
      'Cancel the e-mail from Jean-Luc',
      // Ranges, and a date next to a time.
      'Yoga 3-4pm',
      'Yoga 7:30-9:30',
      'Pickup 3pm-4pm',
      'Trip 3-5 June',
      'Dentist Mar 3 3pm',
      'Flight Jan 18 6:40am',
      'Party 12/25 9am',
      // Abbreviations, and words that look like a site word or a month.
      'Bring snacks, e.g. fruit',
      'Plan the U.S. trip',
      'Lunch w/ Sam',
      'Rom com night with Sam',
      'Call Aunt Dot',
      'Dot called about the meeting',
      'Send the slides to Marketing 40 minutes early',
    ]) {
      expect([text, textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' })]).toEqual([
        text,
        { body: `Mannie: ${text}`, withheld: null },
      ]);
    }
  });

  it('writes the euro, pound and yen signs as letters, so an amount keeps its meaning in Full', () => {
    expect(textBody({ test: false, name: 'Mannie', delivery: delivery('Pay €15 for lunch'), mode: 'full' })).toEqual({
      body: 'Mannie: Pay EUR 15 for lunch',
      withheld: null,
    });
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
      expect(textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' })).toEqual({
        body: 'Mannie: a reminder is due. Open the app to see it.',
        withheld: 'not_plain_words',
      });
    }
  });

  it('sends what the assistant noticed in Private words, even in Full', () => {
    for (const kind of ['nudge', 'approval_waiting'] as const) {
      expect(
        textBody({ test: false, name: 'Mannie', delivery: delivery('Bill due Friday.', kind), mode: 'full' }),
      ).toEqual({
        body: privateText({ name: 'Mannie', kind }),
        withheld: 'noticed',
      });
    }
    expect(
      textBody({ test: false, name: 'Mannie', delivery: delivery('This is a test.', 'note'), mode: 'full' }),
    ).toEqual({
      body: privateText({ name: 'Mannie', kind: 'note' }),
      withheld: 'noticed',
    });
  });

  it('sends a Try it test in its own words in Full', () => {
    expect(
      textBody({ test: true, name: 'Mannie', delivery: delivery('This is a test.', 'note'), mode: 'full' }),
    ).toEqual({
      body: 'Mannie: This is a test.',
      withheld: null,
    });
  });

  it('words every kind with no content', () => {
    const kinds: DeliveryKind[] = ['reminder', 'note', 'nudge', 'approval_waiting'];
    for (const kind of kinds) {
      expect(privateText({ name: 'Mannie', kind })).toMatch(/^Mannie: [a-z ]+\. Open the app to see it\.$/);
      expect(
        textBody({ test: false, name: 'Mannie', delivery: delivery('Pay $482.10 to Dana.', kind), mode: 'private' })
          .body,
      ).toBe(privateText({ name: 'Mannie', kind }));
    }
  });
});
