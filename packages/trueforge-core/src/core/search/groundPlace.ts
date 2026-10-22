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
  | {
      ok: false;
      reason:
        | 'source_not_fetched'
        | 'name_not_found'
        | 'address_not_found'
        | 'address_apart_from_name'
        | 'place_only_in_address'
        | 'place_only_in_search_query';
    };

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
  terrace: 'ter',
  circle: 'cir',
  trail: 'trl',
};

/**
 * Lower case, accents removed, every run of other characters one space, address words folded to
 * one spelling, padded so words match whole.
 */
export function normalizedWords(text: string): string {
  return ` ${unfoldedWords(text)
    .map(token => ADDRESS_WORD_FORMS[token] ?? token)
    .join(' ')} `;
}

/** The words normalizedWords keeps, one for one, before address words are folded. */
function unfoldedWords(text: string): string[] {
  const plain = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return plain === '' ? [] : plain.split(' ');
}

function pageHas({ pageWords, value }: { pageWords: string; value: string }): boolean {
  const needle = normalizedWords(value);
  return needle.trim() !== '' && pageWords.includes(needle);
}

function tokensOf(text: string): string[] {
  const words = normalizedWords(text).trim();
  return words === '' ? [] : words.split(' ');
}

/** Undoes %-escapes up to three times, so a doubly encoded link still yields its words. */
function urlTokensOf(url: string): string[] {
  let decoded = url;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return tokensOf(decoded);
}

/**
 * Whether every word of the claimed name and address comes from the page's own link. A page reader
 * may print the link it was given, so those words prove nothing about the page.
 */
function placeOnlyInUrl({
  nameTokens,
  addressTokens,
  url,
}: {
  nameTokens: readonly string[];
  addressTokens: readonly string[];
  url: string;
}): boolean {
  const claimed = [...nameTokens, ...addressTokens];
  if (claimed.length === 0) {
    return false;
  }
  const words = new Set(urlTokensOf(url));
  return claimed.every(token => words.has(token));
}

/** Every run of the page's words that is exactly the given words, as start and end positions. */
function occurrences({
  tokens,
  phrase,
}: {
  tokens: readonly string[];
  phrase: readonly string[];
}): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  if (phrase.length === 0 || phrase.length > tokens.length) {
    return found;
  }
  for (let at = 0; at + phrase.length <= tokens.length; at += 1) {
    if (phrase.every((token, offset) => tokens[at + offset] === token)) {
      found.push({ start: at, end: at + phrase.length });
    }
  }
  return found;
}

/** A listing's name, rating, reviews, price, cuisine and address fit in about 40 words; more is another block. */
const MAX_WORDS_IN_LISTING_BLOCK = 40;

/**
 * Words that on their own mark a street, as normalizedWords folds them, in English and the other
 * languages listings commonly use. A line holding one of these is another listing's address.
 */
const STREET_WORDS: ReadonlySet<string> = new Set([
  'ave',
  'rd',
  'blvd',
  'ln',
  'sq',
  'hwy',
  'pkwy',
  'way',
  'ter',
  'cir',
  'trl',
  'crescent',
  'alley',
  'rua',
  'avenida',
  'travessa',
  'largo',
  'praca',
  'calle',
  'carrer',
  'paseo',
  'plaza',
  'via',
  'viale',
  'piazza',
  'corso',
  'rue',
  'chemin',
  'allee',
  'quai',
  'strasse',
  'straße',
  'platz',
  'weg',
  'gasse',
  'straat',
  'laan',
  'plein',
  'ulica',
]);

/** Folded words that are also titles or common words ("Dr", "St", "Place"): they mark a street only next to a number. */
const STREET_WORDS_NEEDING_A_NUMBER: ReadonlySet<string> = new Set([
  'st',
  'dr',
  'pl',
  'ct',
  'mt',
  'ft',
  'av',
  'str',
  'ul',
  'row',
  'close',
]);

/** German and Dutch street names are one word: "Hauptstrasse", "Bergweg". */
const STREET_WORD_ENDINGS = ['strasse', 'straße', 'gasse', 'platz', 'straat', 'weg', 'laan'];

/** How far a house number may sit from an ambiguous street word, on either side. */
const HOUSE_NUMBER_REACH = 3;

/**
 * Every word position that marks an address line: a street word in any language, in any place on
 * the line, with or without a house number. Deny by default: a word that might be a street counts.
 * Takes the words before folding, so "Street" (always a street) stays apart from "St" (maybe Saint).
 */
function addressMarkers(tokens: readonly string[]): number[] {
  const hasNumberNear = (at: number): boolean =>
    tokens
      .slice(Math.max(0, at - HOUSE_NUMBER_REACH), at + 1 + HOUSE_NUMBER_REACH)
      .some(word => /^\d+[a-z]?$/.test(word));
  const markers: number[] = [];
  tokens.forEach((raw, at) => {
    const token = ADDRESS_WORD_FORMS[raw] ?? raw;
    const isStreet =
      STREET_WORDS.has(token) ||
      raw === 'street' ||
      (STREET_WORDS_NEEDING_A_NUMBER.has(token) && hasNumberNear(at)) ||
      STREET_WORD_ENDINGS.some(ending => token.length > ending.length + 2 && token.endsWith(ending));
    if (isStreet) {
      markers.push(at);
    }
  });
  return markers;
}

interface Span {
  start: number;
  end: number;
}

/**
 * Whether a name and an address sit in one listing block and belong to each other: the address is
 * the nearest address line to the name, looking after the name first. An address after the name
 * must have no other address line before it; an address before the name counts only when no
 * address line follows the name within the block. So a name cannot borrow the address of the
 * listing next to it, on either side.
 */
function closeTogether({
  nameHits,
  addressHits,
  tokens,
}: {
  nameHits: readonly Span[];
  addressHits: readonly Span[];
  /** The page's words before folding, in the same positions as the hits. */
  tokens: readonly string[];
}): boolean {
  const markers = addressMarkers(tokens);
  const markerIn = ({ start, end }: Span): boolean => markers.some(at => at >= start && at < end);
  return nameHits.some(name =>
    addressHits.some(address => {
      if (address.start >= name.end) {
        const gap = { start: name.end, end: address.start };
        return gap.end - gap.start <= MAX_WORDS_IN_LISTING_BLOCK && !markerIn(gap);
      }
      if (address.end <= name.start) {
        const gap = { start: address.end, end: name.start };
        const after = { start: name.end, end: name.end + MAX_WORDS_IN_LISTING_BLOCK };
        return gap.end - gap.start <= MAX_WORDS_IN_LISTING_BLOCK && !markerIn(gap) && !markerIn(after);
      }
      return false;
    }),
  );
}

/** A name of two or more words is specific enough; a lone word must be at least this long. */
const MIN_SINGLE_WORD_NAME_CHARS = 6;

/**
 * An address must run to at least this many words, one of them at least this long, before it can
 * carry a match. Anything less ("9", "9 St") is a scrap that turns up anywhere on a page, in the
 * opening hours as easily as in an address.
 */
const MIN_ADDRESS_WORDS = 3;
const MIN_ADDRESS_WORD_CHARS = 3;

function nameIsSpecific(tokens: readonly string[]): boolean {
  if (tokens.length >= 2) {
    return true;
  }
  const only = tokens[0];
  return only !== undefined && only.length >= MIN_SINGLE_WORD_NAME_CHARS;
}

function addressIsSpecific(tokens: readonly string[]): boolean {
  return tokens.length >= MIN_ADDRESS_WORDS && tokens.some(token => token.length >= MIN_ADDRESS_WORD_CHARS);
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
 * Keeps only what the fetched source page really says. The name and address must be on the page,
 * in one listing block, or the place is refused; a search result whose place was in the chat's own
 * searches is refused too. Any other field it
 * cannot find is dropped, never guessed. The source must be a page this server fetched for this
 * chat, and the fetch time is the server's.
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
  const nameTokens = tokensOf(claim.name);
  const addressTokens = tokensOf(claim.address);
  if (placeOnlyInUrl({ nameTokens, addressTokens, url: claim.source_url })) {
    return { ok: false, reason: 'place_only_in_address' };
  }
  const pageWords = normalizedWords(page.text);
  const pageTokens = tokensOf(page.text);
  const nameHits = nameIsSpecific(nameTokens) ? occurrences({ tokens: pageTokens, phrase: nameTokens }) : [];
  if (nameHits.length === 0) {
    return { ok: false, reason: 'name_not_found' };
  }
  const addressHits = addressIsSpecific(addressTokens)
    ? occurrences({ tokens: pageTokens, phrase: addressTokens })
    : [];
  if (addressHits.length === 0) {
    return { ok: false, reason: 'address_not_found' };
  }
  if (!closeTogether({ nameHits, addressHits, tokens: unfoldedWords(page.text) })) {
    return { ok: false, reason: 'address_apart_from_name' };
  }
  if (
    page.is_snippet &&
    (pages.queriesContain({ scope, text: claim.name }) || pages.queriesContain({ scope, text: claim.address }))
  ) {
    // A search result can repeat the words it was searched with; those prove nothing about the place.
    return { ok: false, reason: 'place_only_in_search_query' };
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
