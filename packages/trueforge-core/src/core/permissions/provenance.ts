/**
 * Where the links, sites and email addresses of an outbound call came from. The person, their own stores and a
 * search's results are theirs to use; text the assistant read (pages, mail bodies, files, tool output) is data.
 * A call is steered when a destination it names was put there by that data and nowhere else.
 */

/** Links, sites and addresses from one side, each folded so two spellings of one value match. */
interface ProvenanceValues {
  urls: Set<string>;
  hosts: Set<string>;
  addresses: Set<string>;
}

export interface ChatProvenance {
  /** From the person's messages, profile and memory, their own mail headers and guests, and search results. */
  trusted: ProvenanceValues;
  /** Seen in content the assistant read: web pages, mail bodies, attached files, tool output, earlier summaries. */
  untrusted: ProvenanceValues;
}

/** Each set stays bounded, so a huge result cannot grow server memory. Past it, nothing more is kept on that side. */
const MAX_VALUES_PER_SET = 5_000;

export function emptyChatProvenance(): ChatProvenance {
  return {
    trusted: { urls: new Set(), hosts: new Set(), addresses: new Set() },
    untrusted: { urls: new Set(), hosts: new Set(), addresses: new Set() },
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

function add(set: Set<string>, value: string): void {
  if (set.size < MAX_VALUES_PER_SET) {
    set.add(value);
  }
}

function recordUrl(side: ProvenanceValues, value: string): void {
  const key = urlKey(value);
  const host = parsedUrl(value)?.hostname;
  if (key === undefined || host === undefined) {
    return;
  }
  add(side.urls, key);
  add(side.hosts, hostKey(host));
}

function recordText(side: ProvenanceValues, text: string): void {
  for (const url of urlsInText(text)) {
    recordUrl(side, url);
  }
  for (const match of text.matchAll(BARE_HOST)) {
    add(side.hosts, hostKey(match[0]));
  }
  for (const match of text.matchAll(EMAIL)) {
    add(side.addresses, match[0].toLowerCase());
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

/** Fields of the person's own mail and calendar that name who they deal with, not what a message says. */
const PEOPLE_KEYS = new Set(['from', 'to', 'cc', 'bcc', 'reply_to', 'sender', 'email', 'organizer', 'attendees']);
const MAX_STORE_DEPTH = 8;

function collectPeople(input: { node: unknown; into: string[]; depth: number; inPeople: boolean }): void {
  const { node, into, depth, inPeople } = input;
  if (depth > MAX_STORE_DEPTH) {
    return;
  }
  if (typeof node === 'string') {
    if (inPeople) {
      into.push(node);
    }
  } else if (Array.isArray(node)) {
    for (const child of node) {
      collectPeople({ node: child, into, depth: depth + 1, inPeople });
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      collectPeople({ node: child, into, depth: depth + 1, inPeople: inPeople || PEOPLE_KEYS.has(key.toLowerCase()) });
    }
  }
}

/**
 * A read of the person's own mail, calendar or spaces. Who a message is from or to, and an event's guests, are the
 * person's own contacts; what a message or an event says is someone else's text, so it is data.
 */
export function recordOwnStoreResult(input: { provenance: ChatProvenance; texts: readonly string[] }): void {
  for (const text of input.texts) {
    recordUntrustedText({ provenance: input.provenance, text });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const people: string[] = [];
    collectPeople({ node: parsed, into: people, depth: 0, inPeople: false });
    for (const value of people) {
      for (const match of value.matchAll(EMAIL)) {
        add(input.provenance.trusted.addresses, match[0].toLowerCase());
      }
    }
  }
}

/** Whether a site came only from content the assistant read: no message of the person, no search result named it. */
function steeredHost(provenance: ChatProvenance, host: string): boolean {
  const key = hostKey(host);
  return provenance.untrusted.hosts.has(key) && !provenance.trusted.hosts.has(key);
}

/**
 * Links a lookup names that read content steered and that carry something that content did not give: the site
 * came only from what the assistant read, and the link is not the one written there. Opening a link exactly as a
 * page or a mail wrote it sends nothing of the person's, so it is not steered; adding to it is.
 */
export function steeredLinks(input: { provenance: ChatProvenance; values: readonly string[] }): string[] {
  const { provenance } = input;
  const steered: string[] = [];
  for (const value of input.values) {
    for (const url of urlsOf(value)) {
      const key = urlKey(url);
      const host = parsedUrl(url)?.hostname;
      if (key === undefined || host === undefined) {
        continue;
      }
      if (provenance.trusted.urls.has(key) || provenance.untrusted.urls.has(key)) {
        continue;
      }
      if (steeredHost(provenance, host)) {
        steered.push(url);
      }
    }
  }
  return steered;
}

/**
 * Recipients and sites of a consequential action that only read content named: an address or a site no message of
 * the person, none of their own contacts and no search result gave.
 */
export function steeredDestinations(input: {
  provenance: ChatProvenance;
  addresses: readonly string[];
  values: readonly string[];
}): string[] {
  const { provenance } = input;
  const steered: string[] = [];
  for (const raw of input.addresses) {
    const address = raw.trim().toLowerCase();
    if (provenance.untrusted.addresses.has(address) && !provenance.trusted.addresses.has(address)) {
      steered.push(raw);
    }
  }
  for (const value of input.values) {
    for (const match of value.matchAll(EMAIL)) {
      const address = match[0].toLowerCase();
      if (provenance.untrusted.addresses.has(address) && !provenance.trusted.addresses.has(address)) {
        steered.push(match[0]);
      }
    }
    for (const url of urlsOf(value.replace(EMAIL, ' '))) {
      const host = parsedUrl(url)?.hostname;
      if (host !== undefined && steeredHost(provenance, host)) {
        steered.push(url);
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
