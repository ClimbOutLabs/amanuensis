import type { OutboundStrings } from '../../../src/core/permissions/outboundGuard';
import { privateTextLeak } from '../../../src/core/permissions/privateTextCheck';

function outgoing(...values: string[]): OutboundStrings {
  return { values, scalars: [], keys: [], plumbing: [] };
}

const MAIL = JSON.stringify({
  from: 'Maria Costa <maria.costa@harbour-clinic.example>',
  to: 'you@example.test',
  cc: 'Joao Silva <joao@example.test>',
  body:
    'Please bring your booking reference 4417829 and call +351 912 345 678 before Friday. ' +
    'The clinic is at 12 Example Street, Lisbon 1100-000.',
});

const CALENDAR = JSON.stringify({
  summary: 'Dinner',
  attendees: [{ displayName: 'Ana Reis', email: 'ana@example.test', responseStatus: 'accepted' }],
});

describe('privateTextLeak for a search', () => {
  it('passes a query with nothing copied from the private text', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('best tapas in Lisbon'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('finds a sender name from a mail header', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('Maria Costa clinic reviews'),
        privateTexts: [MAIL],
      }),
    ).toBe('name');
  });

  it('finds a name from a mail recipient list, in any case', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('joao silva lisbon'), privateTexts: [MAIL] }),
    ).toBe('name');
  });

  it('finds a calendar attendee name', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('ana reis restaurants'),
        privateTexts: [CALENDAR],
      }),
    ).toBe('name');
  });

  it('finds an email address from the private text', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('maria.costa@harbour-clinic.example reviews'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });

  it('finds a phone number written with spaces', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('call 351 912 345 678'), privateTexts: [MAIL] }),
    ).toBe('contact');
  });

  it('finds a run of six or more digits from the private text', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('booking 4417829 status'),
        privateTexts: [MAIL],
      }),
    ).toBe('number');
  });

  it('finds five consecutive words copied from the private text', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('please bring your booking reference tapas'),
        privateTexts: [MAIL],
      }),
    ).toBe('phrase');
  });

  it('allows four consecutive words copied from the private text', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('bring your booking reference'),
        privateTexts: [MAIL],
      }),
    ).toBeNull();
  });

  it('finds a long hex token', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('lookup 3f9a2b7c8d1e4f5a6b7c8d9e'),
        privateTexts: [MAIL],
      }),
    ).toBe('token');
  });

  it('finds a long base64 token', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('Zm9vYmFyYmF6cXV1eDEyMzQ1Ng=='),
        privateTexts: [MAIL],
      }),
    ).toBe('token');
  });

  it('reads plumbing fields as well as the query', () => {
    const strings: OutboundStrings = { values: ['tapas'], scalars: [], keys: [], plumbing: ['Maria Costa'] };
    expect(privateTextLeak({ earlier: '', mode: 'search', strings, privateTexts: [MAIL] })).toBe('name');
  });

  it('has nothing to compare against when no private text is given', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('Maria Costa'), privateTexts: [] }),
    ).toBeNull();
  });
});

describe('privateTextLeak for a map', () => {
  it('allows a street address from the private text', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'maps',
        strings: outgoing('12 Example Street, Lisbon 1100-000'),
        privateTexts: [MAIL],
      }),
    ).toBeNull();
  });

  it('allows a copied run of words, since a place is the point of a map', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'maps',
        strings: outgoing('the clinic is at 12 Example Street'),
        privateTexts: [MAIL],
      }),
    ).toBeNull();
  });

  it('finds a sender name', () => {
    expect(privateTextLeak({ earlier: '', mode: 'maps', strings: outgoing('Maria Costa'), privateTexts: [MAIL] })).toBe(
      'name',
    );
  });

  it('finds an email address', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'maps',
        strings: outgoing('maria.costa@harbour-clinic.example'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });

  it('finds a number from the private text', () => {
    expect(privateTextLeak({ earlier: '', mode: 'maps', strings: outgoing('4417829'), privateTexts: [MAIL] })).toBe(
      'number',
    );
  });
});

const BOOKING = 'Your booking code is 482913 for the Lisbon clinic.';
const LEE = JSON.stringify({ from: 'Lee Park <lee.park@example.test>', body: 'Lunch on Friday.' });

describe('privateTextLeak across the earlier text of the turn', () => {
  it('finds a phrase split across two searches', () => {
    expect(
      privateTextLeak({
        mode: 'search',
        earlier: 'please bring your',
        strings: outgoing('booking reference tapas'),
        privateTexts: [MAIL],
      }),
    ).toBe('phrase');
  });

  it('finds a number split across two searches', () => {
    expect(
      privateTextLeak({
        mode: 'search',
        earlier: 'booking 4417',
        strings: outgoing('829 lisbon'),
        privateTexts: [MAIL],
      }),
    ).toBe('number');
  });

  it('finds a name split across two searches', () => {
    expect(
      privateTextLeak({
        mode: 'search',
        earlier: 'maria',
        strings: outgoing('costa clinic'),
        privateTexts: [MAIL],
      }),
    ).toBe('name');
  });
});

describe('privateTextLeak with encoded or spelled-out text', () => {
  it('finds a number written with spaces between its digits', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('code 482 913'), privateTexts: [BOOKING] }),
    ).toBe('number');
  });

  it('finds an email address with its at sign written as a URL escape', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('maria.costa%40harbour-clinic.example reviews'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });

  it('finds an email address with dot and at spelled out', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('maria dot costa at harbour clinic dot example'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });

  it('finds a phone number with its plus sign written as a URL escape', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('call %2B351 912 345 678'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });
});

describe('privateTextLeak with glued words and look-alike letters', () => {
  it('finds a sender name with its words run together', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('MariaCosta clinic'), privateTexts: [MAIL] }),
    ).toBe('name');
  });

  it('finds a phrase with its words run together', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('PleaseBringYourBookingReferenceTapas'),
        privateTexts: [MAIL],
      }),
    ).toBe('phrase');
  });

  it('finds a name spelled with Cyrillic letters that look Latin', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('Mаria Cоsta'), privateTexts: [MAIL] }),
    ).toBe('name');
  });

  it('finds a name spelled with full-width letters', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('ｍａｒｉａ ｃｏｓｔａ'),
        privateTexts: [MAIL],
      }),
    ).toBe('name');
  });

  it('finds a long run of letters that is not an ordinary word', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('xKqZpLmNvBtRwYsHjFgDcAe'),
        privateTexts: [MAIL],
      }),
    ).toBe('token');
  });

  it('passes a long ordinary word', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('internationalization lisbon'),
        privateTexts: [MAIL],
      }),
    ).toBeNull();
  });
});

const LAST_FIRST = 'From: "Costa, Maria" <maria.costa@harbour-clinic.example>\nLunch on Friday.';
const BODY_DIRECTIONS = 'From: Lee Park <lee@example.test>\nDirections to: Park Clinic, Lisbon.';
const CITY_SENDER = 'From: Lisbon Metro <metro@example.test>\nYour pass is ready.';

describe('privateTextLeak keeps single words and surnames passing', () => {
  it('passes one name part on its own, such as a surname or a first name', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('Lee tapas'), privateTexts: [LEE] }),
    ).toBeNull();
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('costa reviews'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('passes a word that only begins with a name part', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('Leeds tapas'), privateTexts: [LEE] }),
    ).toBeNull();
  });

  it('finds a full name that has a short part', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('Lee Park tapas'), privateTexts: [LEE] }),
    ).toBe('name');
  });

  it('finds a Last, First sender name in first-last order', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('maria costa clinic'),
        privateTexts: [LAST_FIRST],
      }),
    ).toBe('name');
  });

  it('passes a city in a sender name when the search names only the city', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'search', strings: outgoing('Lisbon tapas'), privateTexts: [CITY_SENDER] }),
    ).toBeNull();
    expect(
      privateTextLeak({ earlier: '', mode: 'maps', strings: outgoing('Lisbon'), privateTexts: [CITY_SENDER] }),
    ).toBeNull();
  });

  it('passes a place named after Directions to: in the body, which is not a header', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('Park Clinic Lisbon'),
        privateTexts: [BODY_DIRECTIONS],
      }),
    ).toBeNull();
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'maps',
        strings: outgoing('Park Clinic, Lisbon'),
        privateTexts: [BODY_DIRECTIONS],
      }),
    ).toBeNull();
  });
});

describe('privateTextLeak reads digits and escapes in any form', () => {
  const withDigits = (digits: string, zero: number): string =>
    [...digits].map(digit => String.fromCodePoint(zero + Number(digit))).join('');

  it('finds a number written in Arabic-Indic digits', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing(`booking ${withDigits('4417829', 0x0660)} status`),
        privateTexts: [MAIL],
      }),
    ).toBe('number');
  });

  it('finds a number written in Devanagari digits and in bold mathematical digits', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing(`booking ${withDigits('4417829', 0x0966)} status`),
        privateTexts: [MAIL],
      }),
    ).toBe('number');
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing(`booking ${withDigits('4417829', 0x1d7ce)} status`),
        privateTexts: [MAIL],
      }),
    ).toBe('number');
  });

  it('finds an email address with its at sign escaped twice', () => {
    expect(
      privateTextLeak({
        earlier: '',
        mode: 'search',
        strings: outgoing('maria.costa%2540harbour-clinic.example reviews'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });
});

describe('privateTextLeak keeps public places passing', () => {
  it('passes a city named in the mail text, for a map', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'maps', strings: outgoing('Lisbon'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('passes a clinic named in the mail text, for a map', () => {
    expect(
      privateTextLeak({ earlier: '', mode: 'maps', strings: outgoing('Harbour Clinic Lisbon'), privateTexts: [MAIL] }),
    ).toBeNull();
  });
});
