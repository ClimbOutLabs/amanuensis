/**
 * Where the links, sites and email addresses of an outbound call came from. The person and a search's results are
 * theirs to use; text the assistant read (pages, mail, files, tool output) is data. A call is steered when a
 * destination it names was put there by that data and nowhere else.
 */

/** Links, sites and addresses from one side, each folded so two spellings of one value match. */
interface ProvenanceValues {
  urls: Set<string>;
  hosts: Set<string>;
  addresses: Set<string>;
  /** A set on this side filled up, so some values were never kept. */
  overflowed: boolean;
}

export interface ChatProvenance {
  /** From the person's messages, profile and memory, and search results. */
  trusted: ProvenanceValues;
  /** Seen in content the assistant read: web pages, mail (headers too), files, tool output, earlier summaries. */
  untrusted: ProvenanceValues;
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
  return { trusted: emptyValues(), untrusted: emptyValues() };
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

function recordUrl(side: ProvenanceValues, value: string): void {
  const key = urlKey(value);
  const host = parsedUrl(value)?.hostname;
  if (key === undefined || host === undefined) {
    return;
  }
  add({ side, kind: 'urls', value: key });
  add({ side, kind: 'hosts', value: hostKey(host) });
}

function recordText(side: ProvenanceValues, text: string): void {
  for (const url of urlsInText(text)) {
    recordUrl(side, url);
  }
  for (const match of text.matchAll(BARE_HOST)) {
    add({ side, kind: 'hosts', value: hostKey(match[0]) });
  }
  for (const match of text.matchAll(EMAIL)) {
    add({ side, kind: 'addresses', value: match[0].toLowerCase() });
  }
}

/** Text the person wrote or that is theirs: their messages, their profile, what the assistant remembers of them. */
export function recordPersonText(input: { provenance: ChatProvenance; text: string }): void {
  recordText(input.provenance.trusted, input.text);
}

/** Text the assistant read: a page, a mail body, a file, a tool's output. It is data, never the person's say. */
export function recordUntrustedText(input: { provenance: ChatProvenance; text: string }): void {
  recordText(input.provenance.untrusted, input.text);
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
}): string[] {
  const { provenance, reply_sender } = input;
  const steered = input.addresses.filter(address => steeredAddress({ provenance, address, reply_sender }));
  for (const value of input.values) {
    for (const match of value.matchAll(EMAIL)) {
      if (steeredAddress({ provenance, address: match[0], reply_sender })) {
        steered.push(match[0]);
      }
    }
    steered.push(...urlsOf(value.replace(EMAIL, ' ')).filter(url => steeredUrl({ provenance, url })));
  }
  return steered;
}

/** Whether a link is exactly one the person gave or a search returned. */
export function isTrustedLink(input: { provenance: ChatProvenance; url: string }): boolean {
  const key = urlKey(input.url);
  return key !== undefined && input.provenance.trusted.urls.has(key);
}
