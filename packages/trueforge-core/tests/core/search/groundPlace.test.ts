import { FetchedPageStore } from '../../../src/core/search/fetchedPages';
import { groundPlace, isInCalendar, type PlaceClaim } from '../../../src/core/search/groundPlace';
import { GARDEN_TEXT, GARDEN_URL, HARBOUR_TEXT, HARBOUR_URL } from './tavilyFixtures';

function storeWithPages(): FetchedPageStore {
  const store = new FetchedPageStore({ now: () => Date.parse('2026-10-17T10:00:00Z'), ttlMs: 60_000, maxPages: 10 });
  store.remember({ url: HARBOUR_URL, text: HARBOUR_TEXT });
  store.remember({ url: GARDEN_URL, text: GARDEN_TEXT });
  return store;
}

const harbour: PlaceClaim = {
  name: 'Harbour Family Clinic',
  address: '12 Example Street, Lisbon 1100-000',
  languages: 'English, Portuguese',
  hours: 'Mon-Fri 9:00-18:00',
  price: 'Consultation 60 EUR',
  phone: '+351 210 000 111',
  source_url: HARBOUR_URL,
};

describe('groundPlace', () => {
  it('keeps every field the page really contains and stamps the server time and site', () => {
    const result = groundPlace({ claim: harbour, pages: storeWithPages() });
    expect(result).toEqual({
      ok: true,
      place: {
        ...harbour,
        source_site: 'harbour-clinic.example',
        fetched_at: '2026-10-17T10:00:00.000Z',
      },
    });
  });

  it('drops a field the page does not contain and keeps the rest', () => {
    const result = groundPlace({
      claim: { ...harbour, price: 'Free for everyone', languages: 'English, Klingon' },
      pages: storeWithPages(),
    });
    expect(result).toMatchObject({ ok: true, place: { price: null, languages: null, hours: 'Mon-Fri 9:00-18:00' } });
  });

  it('matches a phone number whatever its spacing', () => {
    const result = groundPlace({ claim: { ...harbour, phone: '351210000111' }, pages: storeWithPages() });
    expect(result).toMatchObject({ ok: true, place: { phone: '351210000111' } });
  });

  it('does not match a phone number that only appears across separate numbers', () => {
    const result = groundPlace({ claim: { ...harbour, phone: '0000111210' }, pages: storeWithPages() });
    expect(result).toMatchObject({ ok: true, place: { phone: null } });
  });

  it('refuses a source page that was never fetched', () => {
    const result = groundPlace({
      claim: { ...harbour, source_url: 'https://elsewhere.example/' },
      pages: storeWithPages(),
    });
    expect(result).toEqual({ ok: false, reason: 'source_not_fetched' });
  });

  it('refuses a place whose name or address is not on the source page', () => {
    expect(groundPlace({ claim: { ...harbour, name: 'Invented Clinic' }, pages: storeWithPages() })).toEqual({
      ok: false,
      reason: 'name_not_found',
    });
    expect(groundPlace({ claim: { ...harbour, address: '99 Nowhere Road' }, pages: storeWithPages() })).toEqual({
      ok: false,
      reason: 'address_not_found',
    });
  });

  it('does not let a value borrow another page', () => {
    const result = groundPlace({ claim: { ...harbour, hours: 'Open daily 8:00-20:00' }, pages: storeWithPages() });
    expect(result).toMatchObject({ ok: true, place: { hours: null } });
  });

  it('ignores case, accents and punctuation but not whole words', () => {
    const pages = storeWithPages();
    expect(groundPlace({ claim: { ...harbour, name: 'HARBOUR family clinic' }, pages })).toMatchObject({ ok: true });
    expect(groundPlace({ claim: { ...harbour, name: 'Harbou' }, pages })).toEqual({
      ok: false,
      reason: 'name_not_found',
    });
  });

  it('matches a short address written with abbreviations against the full page text', () => {
    const pages = new FetchedPageStore({
      now: () => Date.parse('2026-10-17T10:00:00Z'),
      ttlMs: 60_000,
      maxPages: 10,
    });
    pages.remember({
      url: 'https://hope-house.example/',
      text: 'Hope House\n916 St. Andrew Street, New Orleans\nA food pantry open to everyone.',
    });
    const claim: PlaceClaim = {
      name: 'Hope House',
      address: '916 St Andrew St',
      languages: null,
      hours: null,
      price: null,
      phone: null,
      source_url: 'https://hope-house.example/',
    };
    expect(groundPlace({ claim, pages })).toMatchObject({ ok: true, place: { name: 'Hope House' } });
  });

  it('matches Street against St and Avenue against Ave in both directions', () => {
    const pages = storeWithPages();
    expect(groundPlace({ claim: { ...harbour, address: '12 Example St, Lisbon 1100-000' }, pages })).toMatchObject({
      ok: true,
    });
    expect(
      groundPlace({
        claim: {
          name: 'Garden Health Centre',
          address: '4 Sample Ave, Lisbon 1200-000',
          languages: null,
          hours: null,
          price: null,
          phone: null,
          source_url: GARDEN_URL,
        },
        pages,
      }),
    ).toMatchObject({ ok: true });
  });

  it('still refuses a near miss with the wrong house number', () => {
    const pages = new FetchedPageStore({
      now: () => Date.parse('2026-10-17T10:00:00Z'),
      ttlMs: 60_000,
      maxPages: 10,
    });
    pages.remember({
      url: 'https://hope-house.example/',
      text: 'Hope House\n916 St. Andrew Street, New Orleans\nA food pantry open to everyone.',
    });
    const claim: PlaceClaim = {
      name: 'Hope House',
      address: '917 St Andrew St',
      languages: null,
      hours: null,
      price: null,
      phone: null,
      source_url: 'https://hope-house.example/',
    };
    expect(groundPlace({ claim, pages })).toEqual({ ok: false, reason: 'address_not_found' });
  });
});

describe('isInCalendar', () => {
  const place = { name: 'Harbour Family Clinic', address: '12 Example Street, Lisbon 1100-000' };

  it('matches an appointment location that names the place or its address', () => {
    expect(isInCalendar({ place, locations: ['Harbour Family Clinic, Lisbon'] })).toBe(true);
    expect(isInCalendar({ place, locations: ['12 Example Street Lisbon 1100-000'] })).toBe(true);
    expect(isInCalendar({ place, locations: ['harbour family clinic'] })).toBe(true);
  });

  it('matches a longer address line that contains the appointment location', () => {
    expect(isInCalendar({ place, locations: ['12 Example Street'] })).toBe(true);
  });

  it('does not match a different place or a one-word area', () => {
    expect(isInCalendar({ place, locations: ['Garden Health Centre, 4 Sample Avenue'] })).toBe(false);
    expect(isInCalendar({ place, locations: ['Lisbon'] })).toBe(false);
    expect(isInCalendar({ place, locations: [] })).toBe(false);
  });
});
