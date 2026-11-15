import {
  allowedExtraWords,
  checkedWords,
  heldBackWord,
  isPlainWords,
  plainText,
  privateText,
  textBody,
} from '../../../../src/runtime/texts/textWords';
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
      delivery: delivery('Café’s bill is due 🎉 naïve'),
      mode: 'full',
    });
    expect(body).toBe("Mannie: Cafe's bill is due naive");
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
      // A spoken dot joined by dashes or apostrophes, or a written dot standing alone, also reads out a site.
      'Visit evil-dot-com',
      'Visit evil-dot com',
      'Visit evil dot-com',
      'Visit evil-dot-help',
      "Visit evil'dot'com",
      'Visit evil–dot–com',
      'Visit evil . com',
      'Visit evil [.] com',
      // A dot at the end of a word, or a run of dots, between two words, whatever case the next word has.
      'Visit evil. com today',
      // The dot beside a bracket, a quote or a digit, or a sign or invisible character that cleaning turns into a dot.
      'Visit evil). com',
      'Visit (evil). com',
      'Visit "evil". com',
      "Visit 'evil'. com",
      'Visit [evil]. com',
      'Visit evil.) com',
      'Visit evi1. com',
      'Visit q3. com',
      'Visit ab1. co',
      'Visit evil. 1com',
      'Visit evil ⒈ com',
      'Visit evil‥ com',
      'Visit evil ︙ com',
      'Visit evil︰ com',
      'Visit evil.\u200B com',
      'Visit evil.\u200Bcom',
      'Visit evil.\u200Ccom',
      'Visit evil.\u2060com',
      'Visit evil.\u00ADcom',
      // A dotted abbreviation followed by a site ending.
      'Visit a.b. com',
      'Visit x.y. co today',
      'Visit U.S. com',
      'Visit evil. Com today',
      'Visit evil .. com',
      'Visit evil ... com',
      'Visit evil … com',
      'Visit evil . . . com',
      'Visit evil .com',
      'Visit evil ｡ com',
      'Visit evil · com',
      'Visit evil。 com',
      'Visit evil. (com)',
      'Visit evil. "com"',
      'Visit evil ．． com',
      'Visit evil.\nCom',
      'Plan the U.S… trip now',
      'Visit evil (.) com',
      'Visit evil ( . ) com',
      'Visit evil ． com',
      // Other words for the dot of a site.
      'Visit evil point com',
      'Visit evil period help',
      'Visit evil-point-com',
      // A toll-free number whose rest is spelled out.
      'call 1 800 FLOWERS',
      'call 1 800 Flowers',
      'Call 800 Mattress',
      'call (800) Contacts',
      'call 1 800 (FLOWERS)',
      'call 1 800 "FLOWERS"',
      "call 1 800 'FLOWERS'",
      'call 1 800, FLOWERS',
      'call 1 800: FLOWERS',
      'call 1 800; FLOWERS',
      'call 1 800. FLOWERS',
      'dial 1800 Flowers',
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
      // A sentence sign beside the dot or a dot run, which spells a site, as in the review's eleventh gate.
      'Visit evil!. com',
      'Visit evil?. com',
      'Visit evil,. com',
      'Visit evil;. com',
      'Visit evil:. com',
      'Visit evil!. Com',
      'Visit evil?!. com',
      'Visit evil.! com',
      'Visit evil.? com',
      'Visit evil., com',
      'Visit evil.; com',
      'Visit evil.: com',
      'Visit evil .! com',
      'Visit evil !.. com',
      'Visit evil ,.. com',
      'Visit evil , .. com',
      'Visit evil : .. com',
      'Visit evil , ... com',
      'Visit evil .. : com',
      'Visit evil - .. com',
      'Visit evil .. - com',
      'Visit evil … , com',
      'Visit evil ‥ ; com',
      // A dotted abbreviation before an ending, whatever the ending.
      'Visit U.S. ly',
      'Visit a.b. me',
      'Visit x.y. de',
      'Visit e.g. app',
      // The web endings and the spoken dot, in every spelling the review found.
      'Visit evil. co',
      'Visit evil. io',
      'Visit evil dot help today',
      'Visit evil point help',
      'Visit evil period help',
      'Visit evil. app',
      'Visit evil. dev',
      'Visit evil. xyz',
      'Visit evil. me',
      'Visit evil. us',
      'Visit evil. uk',
      'Visit evil. info',
      'Visit evil. net',
      'Visit evil. org',
      'Visit evil. ly',
      // Words and signs that are not on the list or not allowed in a word.
      'Visit evil.com',
      'Visit wwwevil',
      'Visit evil (com)',
      'Visit "evil"',
      'Visit evil; then go',
      'Visit evil: now',
      'Visit evil_lair',
      'Visit evil & co',
      'Visit zxqvj',
      'Call 1 800 flowers',
      'Call 1800 flowers',
      'Call 1-800 flowers',
      'Visit evil 1com',
      // A single letter is a word only as a or i, so a link cannot be spelled out one letter at a time.
      'Plan B is on for Saturday',
      'Take vitamin D with lunch',
      'Visit e v i l',
      'Visit w w w',
      'Visit e-v-i-l',
      "Visit evil'",
      // Number words, which could be read out as a phone number.
      'Call five five five',
      'Call two',
      'Buy twenty-five stamps',
      'Pay a hundred',
      'Pay a million',
      'Call oh seven',
      'Press double nine',
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
      'Send the card before Nov 6, 2026',
      'CALL THE BANK BACK',
      'Doctor follow-up at 3pm',
      "It's a big day",
      'Rent is due on the 1st',
      'Take 2 pills',
      'Party on the 22nd of May',
      'Book the dentist for Jan 18, 2027',
      // Amounts and counts, with their signs.
      'Pay rent $1,450 by the 1st',
      'Lunch money $20',
      '50% off at the shoe shop',
      'Walk 5,000 steps',
      'Room 204 at 3pm',
      'Book the 60th birthday cake',
      // Short codes of letters and digits.
      '5k run Sat 7am',
      'Flight AA100 at 6:05',
      'Take the B12 pills',
      // Ordinary words joined by dashes or apostrophes, and one number written as a hyphenated word.
      'Doctor follow-up at 3pm',
      // Ranges, and a date next to a time.
      'Pickup 3pm-4pm',
      'Trip 3-5 June',
      'Dentist Mar 3 3pm',
      'Flight Jan 18 6:40am',
      'Party 12/25 9am',
      // Abbreviations, and words that look like a site word or a month.
      'Wait...',
      'Done.',
      'Meet at 3 p.m. today',
      'Pay the $4.50 bill.',
      'Send the slides to Marketing 40 minutes early',
      // Sentence full stops, which no ending can follow, and the other signs a sentence ends with.
      'Call the dentist at 3pm. Bring the insurance card.',
      'Pay the electric bill. It is due Friday.',
      'Done. Next, call Mom',
      'Dr. Lee at 3pm',
      'Wait... then call',
      'Is the doctor in? Call back, please!',
      "Don't forget the keys, we'll leave at 8",
      // Ordinary words with a dash or an apostrophe inside, and single letters.
      'Book a check-in with the well-known doctor',
      'Call Dad about the visa',
      'Email Ms. Lee, soccer is at 5pm',
      "The parents' evening is on Tuesday",
      "It's the o'clock chime",
    ]) {
      expect([text, textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' })]).toEqual([
        text,
        { body: `Mannie: ${text}`, withheld: null, held: null },
      ]);
    }
  });

  it('writes the euro, pound and yen signs as letters, so an amount keeps its meaning in Full', () => {
    expect(textBody({ test: false, name: 'Mannie', delivery: delivery('Pay €15 for lunch'), mode: 'full' })).toEqual({
      body: 'Mannie: Pay EUR 15 for lunch',
      withheld: null,
      held: null,
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
      expect(textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' })).toMatchObject({
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
        held: null,
      });
    }
    expect(
      textBody({ test: false, name: 'Mannie', delivery: delivery('This is a test.', 'note'), mode: 'full' }),
    ).toEqual({
      body: privateText({ name: 'Mannie', kind: 'note' }),
      withheld: 'noticed',
      held: null,
    });
  });

  it('sends a Try it test in its own words in Full', () => {
    expect(
      textBody({ test: true, name: 'Mannie', delivery: delivery('This is a test.', 'note'), mode: 'full' }),
    ).toEqual({
      body: 'Mannie: This is a test.',
      withheld: null,
      held: null,
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

/** Endings and spoken dots a site is spelled with, which the oracle of what is sent looks for. */
const SITE_PARTS = [
  'com',
  'net',
  'org',
  'io',
  'co',
  'ly',
  'us',
  'uk',
  'me',
  'app',
  'dev',
  'info',
  'xyz',
  'dot',
  'point',
  'period',
];

describe('the words allowed besides the list', () => {
  const owner = { tenant_id: 't1', created_by: 'alice' };

  it("holds the person's added words and the words of the assistant's name, for texts and calls alike", async () => {
    const contacts = { listWords: () => Promise.resolve(['patel', 'lopez']) };
    const extra = await allowedExtraWords({ contacts, owner, name: "Mannie O'Neil-Smith" });
    expect([...extra].sort()).toEqual(['lopez', 'mannie', 'neil', "o'neil", 'patel', 'smith']);
    expect(await allowedExtraWords({ contacts: { listWords: () => Promise.resolve([]) }, owner, name: 'J' })).toEqual(
      new Set(),
    );
    expect(isPlainWords('Ask Mannie to call Patel', extra)).toBe(true);
    expect(checkedWords({ text: 'Ask Mannie to call Patel', room: 300, extra })).toBe('Ask Mannie to call Patel');
    expect(checkedWords({ text: 'Ask Mannie to call Patel', room: 300 })).toBeUndefined();
  });

  it('leaves out a stored word that breaks the rules for an added word, so none can let a web ending through', async () => {
    const contacts = { listWords: () => Promise.resolve(['patel', 'com', 'five', 'dot']) };
    const extra = await allowedExtraWords({ contacts, owner, name: 'Mannie' });
    expect([...extra].sort()).toEqual(['mannie', 'patel']);
    expect(isPlainWords('Visit evil. com', extra)).toBe(false);
  });

  it('takes the words of the owner it is asked about, and no other', async () => {
    const asked: unknown[] = [];
    const contacts = {
      listWords: (who: unknown) => {
        asked.push(who);
        return Promise.resolve([]);
      },
    };
    await allowedExtraWords({ contacts, owner, name: 'Mannie' });
    expect(asked).toEqual([owner]);
  });
});

describe('a plural possessive', () => {
  it("passes when the word before the apostrophe is allowed: the Patels' house", () => {
    expect(heldBackWord({ text: "Dinner at the Patels' house" })).toBe("patels'");
    expect(heldBackWord({ text: "Dinner at the Patels' house", extra: new Set(['patels']) })).toBeUndefined();
    expect(heldBackWord({ text: "The parents' evening and the doctors' office" })).toBeUndefined();
    expect(heldBackWord({ text: "The zxqvjs' house" })).toBe("zxqvjs'");
  });
});

describe('everyday reminders', () => {
  // The 11 two-sentence reminders from the tenth review, and 19 more of the same style.
  const EVERYDAY = [
    "Mom's birthday is Saturday. Order the flowers today.",
    'Pay the electric bill. It is due Friday.',
    'Dinner with the Parks at 7pm. Bring wine.',
    'Renew your passport. It expires in March.',
    "Call Dr. Patel's office to confirm the appointment.",
    'Gym at 6am tomorrow. Pack your bag tonight.',
    'Meeting with Mr. Lopez at 3pm in room 204.',
    'Check in for your flight. Boarding starts at 8:15am.',
    'Buy a gift for Anna. Her party is on Sunday.',
    'Pay rent today. It is $1,450 this month.',
    'Call the bank about the card. Ask about the late fee.',
    'Take out the trash tonight.',
    'Dentist appointment at 3:30pm, bring your insurance card.',
    'Pick up the dry cleaning on the way home!',
    'Submit the Q3 report by Friday.',
    'Your car service is booked for the 14th at 9am.',
    'Remember: the parent meeting starts at 6:30pm.',
    'Pay $45 to the electrician before Monday.',
    'Refill your prescription, it is 50% off this week.',
    'Water the plants, they are very dry.',
    'Book the vet for Rex before the 20th.',
    'Call Sam back about the weekend plans.',
    "Send Jordan's birthday card today.",
    'Team lunch on Thursday at noon, order early.',
    'Return the library books by Saturday.',
    'Take your vitamins after breakfast.',
    'The 5k run starts at 7am on Sunday.',
    'Check the oven before you leave!',
    'Update your resume before the interview on Tuesday.',
    'Buy milk, eggs and bread on the way home.',
  ];

  it('go out in Full unless they hold a name that is not known or a colon: 7 of 30 go Private', () => {
    const held = EVERYDAY.flatMap(text => {
      const word = heldBackWord({ text });
      return word === undefined ? [] : [[text, word]];
    });
    expect(held.map(([, word]) => word)).toEqual(["patel's", 'lopez', 'anna.', 'remember:', 'rex', 'sam', "jordan's"]);
  });

  it('all go out in Full once the person adds the names', () => {
    const names = new Set(['patel', 'lopez', 'anna', 'rex', 'sam', 'jordan']);
    expect(
      EVERYDAY.filter(text => text !== 'Remember: the parent meeting starts at 6:30pm.' && !isPlainWords(text, names)),
    ).toEqual([]);
  });
});

describe('the words a Full text sends', () => {
  const PIECES = [
    'evil',
    'com',
    'Evil',
    'Com',
    'io',
    'help',
    'dot',
    'point',
    'Sam',
    'call',
    'pay',
    'the',
    'bill',
    'q3',
    'evi1',
    '1',
    '800',
    'FLOWERS',
    'five',
    'two',
    '3pm',
    '7:30',
    'e.g.',
    'U.S.',
    'a',
    'b',
    'c',
    '.',
    '..',
    '...',
    ',',
    ';',
    ':',
    '(',
    ')',
    '[',
    ']',
    '"',
    "'",
    '-',
    '_',
    '@',
    '/',
    '$',
    '€',
    '%',
    '…',
    '‥',
    '︙',
    '︰',
    '⒈',
    '。',
    '·',
    '\u200B',
    '\u200C',
    '\u2060',
    '\u00AD',
    '\uFEFF',
    '\u0301',
    '🎉',
    '\n',
    '\t',
    ' ',
    ' ',
    ' ',
    ' ',
  ];

  /** Texts made from risky pieces by a fixed pseudo-random walk, so a failure can be replayed. */
  function texts(count: number): string[] {
    let seed = 20261107;
    const next = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    return Array.from({ length: count }, () => {
      const length = 2 + next(9);
      return Array.from({ length }, () => PIECES[next(PIECES.length)] ?? '').join(next(3) === 0 ? '' : ' ');
    });
  }

  it('are exactly the words that pass the check on themselves, whatever text they were made from', () => {
    let sentInFull = 0;
    for (const text of [...texts(20000), ...EVIL_SHAPES]) {
      const out = textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' });
      if (out.withheld === null) {
        sentInFull += 1;
        const sent = out.body.slice('Mannie: '.length);
        expect([text, isPlainWords(sent)]).toEqual([text, true]);
        expect([text, checkedWords({ text: sent, room: 306 })]).toEqual([text, sent]);
        // An oracle that does not use the check: what is sent reads out no ending, spoken dot, long number or odd sign.
        const tokens = sent
          .toLowerCase()
          .split(' ')
          .map(token => token.replace(/[.,?!]+$/, ''));
        expect([text, tokens.filter(token => SITE_PARTS.includes(token))]).toEqual([text, []]);
        expect([text, sent.replace(/\D/g, '').length <= 6]).toEqual([text, true]);
        expect([text, /^[A-Za-z0-9 ,.?!'\-$%:/]*$/.test(sent)]).toEqual([text, true]);
      }
    }
    // The walk must send some words in Full, or the property would hold for nothing.
    expect(sentInFull).toBeGreaterThan(500);
  });

  it('are refused by the check itself, not only by the sender, when only the cleaned text spells a site', () => {
    for (const text of ['Visit evil.\u200B com', 'Visit evil‥ com', 'Visit evil ⒈ com', 'Visit evil︙ com']) {
      expect([text, isPlainWords(text)]).toEqual([text, false]);
    }
  });

  it('are exactly the checked string, so words cut where the cut form fails the check are never sent', () => {
    // The given text passes, but the cut falls inside the one long word and leaves a piece that is no word.
    const text = `call. ${'well-known-'.repeat(30)}end`;
    expect(isPlainWords(text)).toBe(true);
    const out = textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' });
    expect(out.withheld).toBe('not_plain_words');
    expect(out.body).toBe(privateText({ name: 'Mannie', kind: 'reminder' }));
    expect(checkedWords({ text, room: 306 - 'Mannie: '.length })).toBeUndefined();
  });

  it('are never made from a text that passes only as written', () => {
    // These pass as written but read out a site once cleaned, so they must go out Private.
    for (const text of ['Visit evil.\u200B com', 'Visit evil‥ com', 'Visit [evil]. com']) {
      expect([
        text,
        textBody({ test: false, name: 'Mannie', delivery: delivery(text), mode: 'full' }).withheld,
      ]).toEqual([text, 'not_plain_words']);
    }
  });
});

const EVIL_SHAPES = [
  'Visit evil. com',
  'Visit evil.\u200B com',
  'Visit [evil]. com',
  'Visit evi1. com',
  'Visit evil‥ com',
];
