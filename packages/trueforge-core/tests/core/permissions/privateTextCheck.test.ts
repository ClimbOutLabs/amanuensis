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
      privateTextLeak({ mode: 'search', strings: outgoing('best tapas in Lisbon'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('finds a sender name from a mail header', () => {
    expect(
      privateTextLeak({ mode: 'search', strings: outgoing('Maria Costa clinic reviews'), privateTexts: [MAIL] }),
    ).toBe('name');
  });

  it('finds a name from a mail recipient list, in any case', () => {
    expect(privateTextLeak({ mode: 'search', strings: outgoing('joao silva lisbon'), privateTexts: [MAIL] })).toBe(
      'name',
    );
  });

  it('finds a calendar attendee name', () => {
    expect(
      privateTextLeak({ mode: 'search', strings: outgoing('ana reis restaurants'), privateTexts: [CALENDAR] }),
    ).toBe('name');
  });

  it('finds an email address from the private text', () => {
    expect(
      privateTextLeak({
        mode: 'search',
        strings: outgoing('maria.costa@harbour-clinic.example reviews'),
        privateTexts: [MAIL],
      }),
    ).toBe('contact');
  });

  it('finds a phone number written with spaces', () => {
    expect(privateTextLeak({ mode: 'search', strings: outgoing('call 351 912 345 678'), privateTexts: [MAIL] })).toBe(
      'contact',
    );
  });

  it('finds a run of six or more digits from the private text', () => {
    expect(privateTextLeak({ mode: 'search', strings: outgoing('booking 4417829 status'), privateTexts: [MAIL] })).toBe(
      'number',
    );
  });

  it('finds five consecutive words copied from the private text', () => {
    expect(
      privateTextLeak({
        mode: 'search',
        strings: outgoing('please bring your booking reference tapas'),
        privateTexts: [MAIL],
      }),
    ).toBe('phrase');
  });

  it('allows four consecutive words copied from the private text', () => {
    expect(
      privateTextLeak({ mode: 'search', strings: outgoing('bring your booking reference'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('finds a long hex token', () => {
    expect(
      privateTextLeak({ mode: 'search', strings: outgoing('lookup 3f9a2b7c8d1e4f5a6b7c8d9e'), privateTexts: [MAIL] }),
    ).toBe('token');
  });

  it('finds a long base64 token', () => {
    expect(
      privateTextLeak({ mode: 'search', strings: outgoing('Zm9vYmFyYmF6cXV1eDEyMzQ1Ng=='), privateTexts: [MAIL] }),
    ).toBe('token');
  });

  it('reads plumbing fields as well as the query', () => {
    const strings: OutboundStrings = { values: ['tapas'], scalars: [], keys: [], plumbing: ['Maria Costa'] };
    expect(privateTextLeak({ mode: 'search', strings, privateTexts: [MAIL] })).toBe('name');
  });

  it('has nothing to compare against when no private text is given', () => {
    expect(privateTextLeak({ mode: 'search', strings: outgoing('Maria Costa'), privateTexts: [] })).toBeNull();
  });
});

describe('privateTextLeak for a map', () => {
  it('allows a street address from the private text', () => {
    expect(
      privateTextLeak({ mode: 'maps', strings: outgoing('12 Example Street, Lisbon 1100-000'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('allows a copied run of words, since a place is the point of a map', () => {
    expect(
      privateTextLeak({ mode: 'maps', strings: outgoing('the clinic is at 12 Example Street'), privateTexts: [MAIL] }),
    ).toBeNull();
  });

  it('finds a sender name', () => {
    expect(privateTextLeak({ mode: 'maps', strings: outgoing('Maria Costa'), privateTexts: [MAIL] })).toBe('name');
  });

  it('finds an email address', () => {
    expect(
      privateTextLeak({ mode: 'maps', strings: outgoing('maria.costa@harbour-clinic.example'), privateTexts: [MAIL] }),
    ).toBe('contact');
  });

  it('finds a number from the private text', () => {
    expect(privateTextLeak({ mode: 'maps', strings: outgoing('4417829'), privateTexts: [MAIL] })).toBe('number');
  });
});
