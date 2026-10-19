import type { FetchedPageScope, FetchedPageStore } from './fetchedPages';

/** What the model claims about one place. A claimed field the page does not contain is dropped. */
export interface PlaceClaim {
  name: string;
  address: string;
  languages: string | null;
  hours: string | null;
  price: string | null;
  phone: string | null;
  source_url: string;
}

export interface GroundedPlace extends PlaceClaim {
  source_site: string;
  fetched_at: string;
}

export type GroundResult =
  | { ok: true; place: GroundedPlace }
  | { ok: false; reason: 'source_not_fetched' | 'name_not_found' | 'address_not_found' };

const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;
const MIN_PHONE_SUFFIX_DIGITS = 7;

/**
 * Short and long spellings of one address word, folded to the short one. Folding both sides to the
 * same word means "St" matches "Street" and "Saint", in either direction, while every other word
 * still has to match in full.
 */
const ADDRESS_WORD_FORMS: Readonly<Record<string, string>> = {
  street: 'st',
  saint: 'st',
  avenue: 'ave',
  road: 'rd',
  boulevard: 'blvd',
  drive: 'dr',
  lane: 'ln',
  court: 'ct',
  place: 'pl',
  square: 'sq',
  highway: 'hwy',
  parkway: 'pkwy',
  suite: 'ste',
  apartment: 'apt',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  mount: 'mt',
  fort: 'ft',
};

/**
 * Lower case, accents removed, every run of other characters one space, address words folded to
 * one spelling, padded so words match whole.
 */
export function normalizedWords(text: string): string {
  const folded = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const tokens = folded === '' ? [] : folded.split(' ').map(token => ADDRESS_WORD_FORMS[token] ?? token);
  return ` ${tokens.join(' ')} `;
}

function pageHas({ pageWords, value }: { pageWords: string; value: string }): boolean {
  const needle = normalizedWords(value);
  return needle.trim() !== '' && pageWords.includes(needle);
}

function pageHasPhone({ text, phone }: { text: string; phone: string }): boolean {
  const wanted = phone.replace(/\D/g, '');
  if (wanted.length < MIN_PHONE_SUFFIX_DIGITS) {
    return false;
  }
  return (text.match(PHONE_LIKE) ?? []).some(found => {
    const digits = found.replace(/\D/g, '');
    return digits === wanted || digits.endsWith(wanted);
  });
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Keeps only what the fetched source page really says. The name and address must be on the page or
 * the place is refused; any other field it cannot find is dropped, never guessed. The source must
 * be a page this server fetched, and the fetch time is the server's.
 */
export function groundPlace({
  claim,
  pages,
  scope,
}: {
  claim: PlaceClaim;
  pages: FetchedPageStore;
  scope: FetchedPageScope;
}): GroundResult {
  const page = pages.recall({ scope, url: claim.source_url });
  if (page === undefined) {
    return { ok: false, reason: 'source_not_fetched' };
  }
  const pageWords = normalizedWords(page.text);
  if (!pageHas({ pageWords, value: claim.name })) {
    return { ok: false, reason: 'name_not_found' };
  }
  if (!pageHas({ pageWords, value: claim.address })) {
    return { ok: false, reason: 'address_not_found' };
  }
  const found = (value: string | null): string | null =>
    value !== null && pageHas({ pageWords, value }) ? value : null;
  return {
    ok: true,
    place: {
      name: claim.name,
      address: claim.address,
      languages: found(claim.languages),
      hours: found(claim.hours),
      price: found(claim.price),
      phone: claim.phone !== null && pageHasPhone({ text: page.text, phone: claim.phone }) ? claim.phone : null,
      source_url: claim.source_url,
      source_site: siteOf(claim.source_url),
      fetched_at: page.fetched_at,
    },
  };
}

/** An appointment location needs this many words before it can match by being part of an address. */
const MIN_WORDS_TO_MATCH_INSIDE_ADDRESS = 3;

/**
 * Whether the user's calendar already holds this place: an appointment location that contains the
 * place's name or address, or a fuller address line that contains a specific location. A bare area
 * such as a city never matches.
 */
export function isInCalendar({
  place,
  locations,
}: {
  place: { name: string; address: string };
  locations: readonly string[];
}): boolean {
  const candidates = [normalizedWords(place.name), normalizedWords(place.address)];
  return locations.some(location => {
    const where = normalizedWords(location);
    if (where.trim() === '') {
      return false;
    }
    const specific = where.trim().split(' ').length >= MIN_WORDS_TO_MATCH_INSIDE_ADDRESS;
    return candidates.some(candidate => where.includes(candidate) || (specific && candidate.includes(where)));
  });
}
