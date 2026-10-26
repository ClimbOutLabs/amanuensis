/**
 * Where the links, sites and email addresses of an outbound call came from. The person and a search's results are
 * theirs to use; text the assistant read (pages, mail, files, tool output) is data. A call is steered when a
 * destination it names was put there by that data and nowhere else. The record also keeps the person's own
 * details, the addresses and phone numbers in their words, their mail and their events, so a lookup that would
 * send one can ask first once the chat has read other content.
 */

/** Links, sites and addresses from one side, each folded so two spellings of one value match. */
interface ProvenanceValues {
  urls: Set<string>;
  hosts: Set<string>;
  addresses: Set<string>;
  /** A set on this side filled up, so some values were never kept. */
  overflowed: boolean;
}

/** Where the assistant read a value: as the sender of an email, or the kind of content it appeared in. */
export type ReadSource = 'email_sender' | 'email' | 'event' | 'page' | 'file' | 'tool_result' | 'other';

export interface ReadOrigin {
  source: ReadSource;
  /** The display name an email's sender gave, or null. */
  name: string | null;
}

export interface ChatProvenance {
  /** From the person's messages, profile and memory, and search results. */
  trusted: ProvenanceValues;
  /** Seen in content the assistant read: web pages, mail (headers too), files, tool output, earlier summaries. */
  untrusted: ProvenanceValues;
  /** Where each address (`address:`) and site (`site:`) on the read side was first read, so a card can say so. */
  read_from: Map<string, ReadOrigin>;
  /** The person's own details seen in this chat: addresses and phone numbers from their words, mail and events. */
  own_details: Set<string>;
  /** The details set filled up, so some were never kept; a lookup then counts any address or number as one. */
  own_details_overflowed: boolean;
  /** True once the chat has read content that is not the person's own words. */
  read_content: boolean;
}

/**
 * Each set stays bounded, so a huge result cannot grow server memory. Past it, nothing more is kept on that side,
 * and once the read side overflows every value the person did not give counts as read content: it fails toward asking.
 */
const MAX_VALUES_PER_SET = 5_000;

function emptyValues(): ProvenanceValues {
  return { urls: new Set(), hosts: new Set(), addresses: new Set(), overflowed: false };
}

export function emptyChatProvenance(): ChatProvenance {
  return {
    trusted: emptyValues(),
    untrusted: emptyValues(),
    read_from: new Map(),
    own_details: new Set(),
    own_details_overflowed: false,
    read_content: false,
  };
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const SCHEME_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\`]+/g;
const SCHEMELESS_URL_WITH_PATH = /(?<![\w@.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\/[^\s"'<>\\`]*/g;
const WWW_URL = /(?<![\w@.-])www\.[^\s"'<>\\`]+/gi;
/** A site named on its own in prose, such as `evil.example`; an address's domain is not one. */
const BARE_HOST = /(?<![\w@./-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![\w@-])/g;
/** A whole value that is a bare host (optionally with port and path): `example.com`, `10.0.0.1:8080/x`. */
const WHOLE_HOST = /^(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]\S*)?$/;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

/** URLs in free text, each match removed before the next pattern runs so one URL is never counted twice. */
function urlsInText(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const pattern of [SCHEME_URL, WWW_URL, SCHEMELESS_URL_WITH_PATH]) {
    rest = rest.replace(pattern, match => {
      found.push(match.replace(TRAILING_PUNCTUATION, ''));
      return ' ';
    });
  }
  return found;
}

function isWholeUrl(value: string): boolean {
  return WHOLE_HOST.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value) || /^www\.\S+$/i.test(value);
}

/** The URLs an outbound value names: the value itself when it is one, else those written inside it. */
function urlsOf(value: string): string[] {
  const trimmed = value.trim();
  return isWholeUrl(trimmed) ? [trimmed] : urlsInText(value);
}

/** Whether any outbound value is, or contains, a URL: a call that opens a page rather than searches. */
export function namesUrl(values: readonly string[]): boolean {
  return values.some(value => urlsOf(value).length > 0);
}

function parsedUrl(value: string): URL | undefined {
  try {
    return new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`);
  } catch {
    return undefined;
  }
}

/** A site as the person thinks of it: lower case, without a leading `www.`. */
function hostKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/** One page however it is spelled: http or https, host case, `www.`, one trailing slash, and the fragment fold away. */
function urlKey(value: string): string | undefined {
  const url = parsedUrl(value);
  if (url === undefined || url.hostname === '') {
    return undefined;
  }
  const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${hostKey(url.hostname)}${port}${path === '/' ? '' : path}${url.search}`;
}

function add(input: { side: ProvenanceValues; kind: 'urls' | 'hosts' | 'addresses'; value: string }): void {
  const set = input.side[input.kind];
  if (set.has(input.value)) {
    return;
  }
  if (set.size < MAX_VALUES_PER_SET) {
    set.add(input.value);
  } else {
    input.side.overflowed = true;
  }
}

/** Whether read content may have named the value: it did, or the read side overflowed and cannot say it did not. */
function untrustedHas(input: { provenance: ChatProvenance; kind: 'urls' | 'hosts' | 'addresses'; value: string }) {
  const side = input.provenance.untrusted;
  return side.overflowed || side[input.kind].has(input.value);
}

/** Records one link; returns its site, or undefined when it is not a link. */
function recordUrl(side: ProvenanceValues, value: string): string | undefined {
  const key = urlKey(value);
  const host = parsedUrl(value)?.hostname;
  if (key === undefined || host === undefined) {
    return undefined;
  }
  add({ side, kind: 'urls', value: key });
  add({ side, kind: 'hosts', value: hostKey(host) });
  return hostKey(host);
}

/** Records the links, sites and addresses in a text; returns the `site:` and `address:` keys it found. */
function recordText(side: ProvenanceValues, text: string): string[] {
  const found: string[] = [];
  for (const url of urlsInText(text)) {
    const site = recordUrl(side, url);
    if (site !== undefined) {
      found.push(`site:${site}`);
    }
  }
  for (const match of text.matchAll(BARE_HOST)) {
    add({ side, kind: 'hosts', value: hostKey(match[0]) });
    found.push(`site:${hostKey(match[0])}`);
  }
  for (const match of text.matchAll(EMAIL)) {
    add({ side, kind: 'addresses', value: match[0].toLowerCase() });
    found.push(`address:${match[0].toLowerCase()}`);
  }
  return found;
}

/** A phone number as written, with its spaces and marks: `+1 (415) 555-0132`. A few marks may sit between digits. */
const PHONE_CANDIDATE = /\+?\d(?:[\s().-]{0,3}\d){6,}/g;
/** Fewest digits a phone number has, when written with a leading plus sign. */
const MIN_INTERNATIONAL_PHONE_DIGITS = 8;
/** Fewest digits a phone number has when written without one. Shorter runs are postal codes and dates. */
const MIN_PHONE_DIGITS = 10;

/** One number however it is written: its digits, with a leading country `1` folded away when it has one to spare. */
function phoneKey(digits: string): string {
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** The phone numbers in a text, each folded so two writings of one number match. */
function phoneDetails(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const digits = match[0].replace(/\D/g, '');
    if (
      match[0].startsWith('+') ? digits.length >= MIN_INTERNATIONAL_PHONE_DIGITS : digits.length >= MIN_PHONE_DIGITS
    ) {
      found.push(phoneKey(digits));
    }
  }
  return found;
}

const MAX_DECODE_ROUNDS = 3;
/** Characters that show nothing, which a writer can hide inside a value to break an exact match. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

/** One round of undoing percent coding; a value whose coding is broken is spelled out character by character. */
function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (_whole: string, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
}

/** Compatibility forms folded to plain ones (a full-width `＠` becomes `@`) and hidden characters removed. */
function plainForm(value: string): string {
  return value.normalize('NFKC').replace(INVISIBLE, '');
}

/**
 * A text as it will be read where it arrives: plain characters, coding spelled out until it stops changing, and
 * the spaces people leave around an at sign folded away. The one place a detail's spelling is settled, for the
 * text the person gave and for the text a call sends alike.
 */
function foldSpelling(text: string): string {
  let folded = plainForm(text);
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const next = plainForm(decodeOnce(folded));
    if (next === folded) {
      break;
    }
    folded = next;
  }
  return folded.replace(/\s*@\s*/g, '@');
}

/** A mailbox however it is addressed: lower case, with a `+tag` dropped from the part before the at sign. */
function mailboxKey(address: string): string {
  const lower = address.toLowerCase();
  const at = lower.lastIndexOf('@');
  const tag = lower.indexOf('+');
  return tag > 0 && tag < at ? `${lower.slice(0, tag)}${lower.slice(at)}` : lower;
}

/** The person's own details in a text: its mailboxes and its phone numbers, each folded so any writing of one matches. */
function detailsInText(text: string): string[] {
  const folded = foldSpelling(text);
  return [...folded.matchAll(EMAIL)].map(match => mailboxKey(match[0])).concat(phoneDetails(folded));
}

/** Keeps a text's details among the person's own; past the cap the set overflows and every detail counts. */
function recordDetails(provenance: ChatProvenance, text: string): void {
  for (const detail of detailsInText(text)) {
    if (provenance.own_details.has(detail)) {
      continue;
    }
    if (provenance.own_details.size < MAX_VALUES_PER_SET) {
      provenance.own_details.add(detail);
    } else {
      provenance.own_details_overflowed = true;
    }
  }
}

/** Notes where a value was first read. An email's sender wins over any plainer place, since it says who they are. */
function noteOrigin(input: { provenance: ChatProvenance; key: string; origin: ReadOrigin }): void {
  const known = input.provenance.read_from.get(input.key);
  if (known === undefined) {
    if (input.provenance.read_from.size < MAX_VALUES_PER_SET) {
      input.provenance.read_from.set(input.key, input.origin);
    }
    return;
  }
  if (known.source !== 'email_sender' && input.origin.source === 'email_sender') {
    input.provenance.read_from.set(input.key, input.origin);
  }
}

/** Text the person wrote or that is theirs: their messages, their profile, what the assistant remembers of them. */
export function recordPersonText(input: { provenance: ChatProvenance; text: string }): void {
  recordText(input.provenance.trusted, input.text);
  recordDetails(input.provenance, input.text);
}

/** Text the assistant read: a page, a mail, a file, a tool's output. It is data, never the person's say. */
export function recordUntrustedText(input: { provenance: ChatProvenance; text: string; source: ReadSource }): void {
  if (input.text.trim() !== '') {
    input.provenance.read_content = true;
  }
  if (input.source === 'event' || input.source === 'file' || input.source === 'other') {
    // The person's own events, their files and the host's notes on their chat hold their details too.
    recordDetails(input.provenance, input.text);
  }
  for (const key of recordText(input.provenance.untrusted, input.text)) {
    noteOrigin({ provenance: input.provenance, key, origin: { source: input.source, name: null } });
  }
}

/** Header keys that name who sent a message. */
const SENDER_KEYS = new Set(['from', 'sender']);
const MAX_MAIL_DEPTH = 8;
const MAX_SENDER_NAME_CHARS = 80;
const FROM_LINE = /^[ \t]*from:[ \t]*(.+)$/gim;

function collectSenders(input: { node: unknown; into: string[]; depth: number; isSender: boolean }): void {
  const { node, into, depth, isSender } = input;
  if (depth > MAX_MAIL_DEPTH) {
    return;
  }
  if (typeof node === 'string') {
    if (isSender) {
      into.push(node);
    }
  } else if (Array.isArray(node)) {
    for (const child of node) {
      collectSenders({ node: child, into, depth: depth + 1, isSender });
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      collectSenders({ node: child, into, depth: depth + 1, isSender: SENDER_KEYS.has(key.toLowerCase()) });
    }
  }
}

/** A sender as `Name <address>` or a bare address: the address and the display name it gave. */
function senderOf(value: string): { address: string; name: string | null } | undefined {
  const address = [...value.matchAll(EMAIL)][0]?.[0];
  if (address === undefined) {
    return undefined;
  }
  const angle = value.indexOf('<');
  const before = angle === -1 ? '' : value.slice(0, angle);
  const name = before.replace(/["']/g, '').trim().slice(0, MAX_SENDER_NAME_CHARS);
  return { address: address.toLowerCase(), name: name === '' ? null : name };
}

/**
 * A read of the person's mail. Every address in it is read content, headers too; who sent each message is noted, so
 * a card can say "who sent the email" rather than only that an email named them.
 */
export function recordEmailText(input: { provenance: ChatProvenance; text: string }): void {
  recordUntrustedText({ provenance: input.provenance, text: input.text, source: 'email' });
  recordDetails(input.provenance, input.text);
  const senders = [...input.text.matchAll(FROM_LINE)].map(match => match[1] ?? '');
  try {
    collectSenders({ node: JSON.parse(input.text), into: senders, depth: 0, isSender: false });
  } catch {
    // Plain text: only its From lines name a sender.
  }
  for (const value of senders) {
    const sender = senderOf(value);
    if (sender !== undefined) {
      noteOrigin({
        provenance: input.provenance,
        key: `address:${sender.address}`,
        origin: { source: 'email_sender', name: sender.name },
      });
    }
  }
}

/** Keys whose contents describe a result or what it links to, never the result's own link. */
const NON_RESULT_KEYS = new Set(['links', 'metadata', 'images', 'favicon', 'excerpts', 'content', 'raw_content']);
const MAX_RESULT_DEPTH = 3;

/** The `url` field of each result object in a provider's JSON; text inside a result is never read for links. */
function collectResultUrls(node: unknown, into: string[], depth: number): void {
  if (depth > MAX_RESULT_DEPTH) {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectResultUrls(child, into, depth + 1);
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      if (key === 'url' && typeof child === 'string') {
        into.push(child);
      } else if (!NON_RESULT_KEYS.has(key)) {
        collectResultUrls(child, into, depth + 1);
      }
    }
  }
}

/**
 * A search's results: each result's own link is the person's to open. The rest of the result text is neither side,
 * so a site an excerpt mentions neither steers nor vouches for a later call.
 */
export function recordSearchResults(input: { provenance: ChatProvenance; texts: readonly string[] }): void {
  for (const text of input.texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const urls: string[] = [];
    collectResultUrls(parsed, urls, 0);
    for (const url of urls) {
      recordUrl(input.provenance.trusted, url);
    }
  }
}

/**
 * Picture links from a page the chat opened: opening the page saw them, so a space may use a
 * picture file no search result named. Only the page's own pictures count; a link the page
 * merely points at is not a picture on it.
 */
export function recordPageImageUrls(input: { provenance: ChatProvenance; urls: readonly string[] }): void {
  for (const url of input.urls) {
    recordUrl(input.provenance.trusted, url);
  }
}

/** Whether a link names only a site, with no path or query: it adds nothing to the site, so the site's trust holds. */
function isBareSite(url: string): boolean {
  const parsed = parsedUrl(url);
  return parsed !== undefined && (parsed.pathname === '' || parsed.pathname === '/') && parsed.search === '';
}

/**
 * Whether read content steered a link. A bare site is steered when only read content named it. A link that adds a
 * path or a query is trusted only as the exact link the person gave or a search returned, once read content named
 * its site: a shared site (a forms host, a link shortener) serves anyone's page, so the person naming the site once
 * does not vouch for a page on it that read content chose.
 */
function steeredUrl(input: { provenance: ChatProvenance; url: string }): boolean {
  const { provenance } = input;
  const key = urlKey(input.url);
  const host = parsedUrl(input.url)?.hostname;
  if (key === undefined || host === undefined) {
    return false;
  }
  const site = hostKey(host);
  if (!untrustedHas({ provenance, kind: 'hosts', value: site })) {
    return false;
  }
  return isBareSite(input.url) ? !provenance.trusted.hosts.has(site) : !provenance.trusted.urls.has(key);
}

/**
 * Links a lookup names that read content steered and that carry something that content did not give. Opening a
 * link exactly as a page or a mail wrote it sends nothing of the person's, so it is not steered; adding to it is.
 */
export function steeredLinks(input: { provenance: ChatProvenance; values: readonly string[] }): string[] {
  const { provenance } = input;
  return input.values.flatMap(value =>
    urlsOf(value).filter(url => {
      const key = urlKey(url);
      return key !== undefined && !provenance.untrusted.urls.has(key) && steeredUrl({ provenance, url });
    }),
  );
}

/** Whether only read content named an address: the person never gave it, and it is not the reply's own sender. */
function steeredAddress(input: { provenance: ChatProvenance; address: string; reply_sender: string | null }): boolean {
  const address = input.address.trim().toLowerCase();
  return (
    address !== input.reply_sender?.trim().toLowerCase() &&
    !input.provenance.trusted.addresses.has(address) &&
    untrustedHas({ provenance: input.provenance, kind: 'addresses', value: address })
  );
}

/** A recipient or site only read content named, and where the assistant read it. */
export interface SteeredDestination {
  value: string;
  kind: 'address' | 'link';
  origin: ReadOrigin;
}

/** Where a steered value was read; a value past the cap was never noted, so it reads as "something". */
function originOf(input: { provenance: ChatProvenance; key: string }): ReadOrigin {
  return input.provenance.read_from.get(input.key) ?? { source: 'other', name: null };
}

/**
 * Recipients and sites of a consequential action that only read content named. `reply_sender` is the From of the
 * one message this action replies to, as the host read it; it is trusted for this reply and nothing else, so a
 * Reply-To, a Cc or a guest that read content named still counts as steered.
 */
export function steeredDestinations(input: {
  provenance: ChatProvenance;
  addresses: readonly string[];
  values: readonly string[];
  reply_sender: string | null;
}): SteeredDestination[] {
  const { provenance, reply_sender } = input;
  const steered: SteeredDestination[] = [];
  const addAddress = (address: string): void => {
    if (steeredAddress({ provenance, address, reply_sender })) {
      const key = `address:${address.trim().toLowerCase()}`;
      steered.push({ value: address.trim(), kind: 'address', origin: originOf({ provenance, key }) });
    }
  };
  input.addresses.forEach(addAddress);
  for (const value of input.values) {
    for (const match of value.matchAll(EMAIL)) {
      addAddress(match[0]);
    }
    for (const url of urlsOf(value.replace(EMAIL, ' '))) {
      const host = parsedUrl(url)?.hostname;
      if (host !== undefined && steeredUrl({ provenance, url })) {
        steered.push({ value: url, kind: 'link', origin: originOf({ provenance, key: `site:${hostKey(host)}` }) });
      }
    }
  }
  return steered;
}

/** Whether a link is exactly one the person gave or a search returned. */
export function isTrustedLink(input: { provenance: ChatProvenance; url: string }): boolean {
  const key = urlKey(input.url);
  return key !== undefined && input.provenance.trusted.urls.has(key);
}

/** Whether this chat has read content that is not the person's own words. */
export function hasReadContent(provenance: ChatProvenance): boolean {
  return provenance.read_content;
}

/**
 * The person's own details a call's text carries: an address or a phone number the chat saw in the person's
 * words, their own mail or their events. Pages, files and tool output do not count: a detail only they named is
 * that content's own value, and sending it back to its source is ordinary. Mail does count even when a stranger
 * wrote it, because the mailbox is the person's; the cost is an extra question, never a leak. Each value is
 * folded the same way the record was, so a detail counts however the value spells it.
 */
export function carriedPrivateDetails(input: { provenance: ChatProvenance; values: readonly string[] }): string[] {
  const carried = new Set<string>();
  for (const value of input.values) {
    for (const detail of detailsInText(value)) {
      if (input.provenance.own_details_overflowed || input.provenance.own_details.has(detail)) {
        carried.add(detail);
      }
    }
  }
  return [...carried];
}
