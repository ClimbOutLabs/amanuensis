import { getDomain } from 'tldts';

/**
 * Whether the receiving mail server vouched for a message's sender. A message passes when DMARC passed for the From
 * domain and its DKIM signature or its SPF check passed for a domain that lines up with it. The header is read as the
 * receiving server wrote it, so only the topmost Authentication-Results header counts, and only the first result of
 * each method in it: anything below or after could have been written by the sender.
 */

/** The domain of an address, lower case, or undefined when it has none. */
function domainOfAddress(address: string): string | undefined {
  const at = address.lastIndexOf('@');
  const domain =
    at === -1
      ? ''
      : address
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return domain === '' ? undefined : domain;
}

/**
 * Two domains line up when they share one registrable domain (relaxed alignment): `mail.example.com` and
 * `example.com` do, while two sites under one public suffix such as `github.io` or `co.uk` never do.
 */
export function domainsAlign({ left, right }: { left: string; right: string }): boolean {
  const leftSite = getDomain(left, { allowPrivateDomains: true });
  return leftSite !== null && leftSite === getDomain(right, { allowPrivateDomains: true });
}

interface MethodResult {
  method: string;
  result: string;
  properties: Map<string, string>;
}

type Token = { kind: 'word'; text: string } | { kind: 'semicolon' } | { kind: 'equals' };

/**
 * Splits a header into words, `;` and `=`, with comments (which nest) dropped. Undefined when a comment is never
 * closed or closes one that was never opened. The caller refuses quotes and backslashes first, so a comment can only
 * end where its server ended it.
 */
function tokenize(header: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = '';
  const endWord = (): void => {
    if (word !== '') {
      tokens.push({ kind: 'word', text: word });
      word = '';
    }
  };
  let depth = 0;
  for (const char of header) {
    if (char === '(') {
      endWord();
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
    } else if (depth > 0) {
      continue;
    } else if (char === ';' || char === '=') {
      endWord();
      tokens.push({ kind: char === ';' ? 'semicolon' : 'equals' });
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word += char;
    }
  }
  if (depth > 0) {
    return undefined;
  }
  endWord();
  return tokens;
}

/** `name=value` pairs in one part of a header, or undefined when the part is not made of such pairs. */
function pairsOf(tokens: readonly Token[]): { name: string; value: string }[] | undefined {
  const pairs: { name: string; value: string }[] = [];
  for (let at = 0; at < tokens.length; at += 3) {
    const [name, equals, value] = [tokens[at], tokens[at + 1], tokens[at + 2]];
    if (name?.kind !== 'word' || equals?.kind !== 'equals' || value?.kind !== 'word') {
      return undefined;
    }
    pairs.push({ name: name.text.toLowerCase(), value: value.text });
  }
  return pairs;
}

/** The server that wrote the header, and the first result it gave for each method. */
function parseMethods(header: string): { authserv: string; results: Map<string, MethodResult> } | undefined {
  const tokens = tokenize(header);
  if (tokens === undefined) {
    return undefined;
  }
  const parts: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'semicolon') {
      parts.push([]);
    } else {
      parts[parts.length - 1]?.push(token);
    }
  }
  const [head = [], ...rest] = parts;
  const first = head[0];
  const authserv = first?.kind === 'word' ? first.text.toLowerCase() : '';
  const results = new Map<string, MethodResult>();
  for (const part of rest) {
    const [method, ...properties] = pairsOf(part) ?? [];
    const name = method?.name.split('/')[0] ?? '';
    // A later result for the same method may be text the sender got echoed into the header, so only the first counts.
    if (method === undefined || results.has(name)) {
      continue;
    }
    results.set(name, {
      method: name,
      result: method.value.toLowerCase(),
      properties: new Map(properties.map(item => [item.name, item.value.replace(/^<|>$/g, '').toLowerCase()])),
    });
  }
  return { authserv, results };
}

/** The domain a DKIM or SPF property names: `@example.com`, `user@example.com` or `example.com`. */
function propertyDomain(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const at = value.lastIndexOf('@');
  const domain = (at === -1 ? value : value.slice(at + 1)).trim();
  return domain === '' ? undefined : domain;
}

export type SenderCheck = { verified: true; how: 'dkim' | 'spf' } | { verified: false; why: string };

/** Said when a mail source cannot pass on the receiving server's checks, so no sender is vouched for. */
const NOT_PASSED_ON = 'This mail source does not pass on sender checks.';

/**
 * Checks a message's sender against its Authentication-Results headers, given newest first (the topmost first).
 * `trusted_servers` names the receiving servers whose word counts: a header from another server is not read, and an
 * empty list verifies nothing. A message with no header, or whose checks failed or do not line up with the From
 * domain, is not verified.
 */
export function checkSender({
  from_address,
  headers,
  trusted_servers,
}: {
  from_address: string;
  headers: readonly string[];
  trusted_servers: readonly string[];
}): SenderCheck {
  const fromDomain = domainOfAddress(from_address);
  if (fromDomain === undefined) {
    return { verified: false, why: 'The message has no sender address.' };
  }
  if (trusted_servers.length === 0) {
    return { verified: false, why: NOT_PASSED_ON };
  }
  const topmost = headers[0];
  if (topmost === undefined) {
    return { verified: false, why: 'The mail server gave no sender checks for this message.' };
  }
  // A quote or a backslash in the header is something a sender got echoed into it, so the header is not trusted.
  if (/["\\]/.test(topmost)) {
    return { verified: false, why: 'The sender checks on this message could not be read safely.' };
  }
  const parsed = parseMethods(topmost);
  if (parsed === undefined) {
    return { verified: false, why: 'The sender checks on this message could not be read.' };
  }
  const { authserv, results } = parsed;
  if (!trusted_servers.includes(authserv)) {
    return { verified: false, why: 'The sender checks came from a server that is not the one receiving your mail.' };
  }
  const dmarc = results.get('dmarc');
  if (dmarc?.result !== 'pass' || dmarc.properties.get('header.from') !== fromDomain) {
    return { verified: false, why: 'The mail server did not confirm the From address with DMARC.' };
  }
  const dkim = results.get('dkim');
  if (dkim?.result === 'pass') {
    const signer = propertyDomain(dkim.properties.get('header.d') ?? dkim.properties.get('header.i'));
    if (signer !== undefined && domainsAlign({ left: signer, right: fromDomain })) {
      return { verified: true, how: 'dkim' };
    }
  }
  const spf = results.get('spf');
  if (spf?.result === 'pass') {
    const envelope = propertyDomain(spf.properties.get('smtp.mailfrom'));
    if (envelope !== undefined && domainsAlign({ left: envelope, right: fromDomain })) {
      return { verified: true, how: 'spf' };
    }
  }
  return { verified: false, why: 'The sender checks failed or do not match the From address.' };
}
