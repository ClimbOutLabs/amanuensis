import { getDomain } from 'tldts';

/**
 * Whether the receiving mail server vouched for a message's sender. A message passes when its DKIM signature or its
 * SPF check passed for a domain that lines up with the From domain. The header is read as the receiving server wrote
 * it, so only the topmost Authentication-Results header counts: any below it could have been written by the sender.
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

type Token = { kind: 'word'; text: string; quoted: boolean } | { kind: 'semicolon' } | { kind: 'equals' };

/**
 * Splits a header into words, `;` and `=`, as RFC 8601 reads it: comments nest and are dropped, and a quoted string
 * keeps its `;`, `=` and spaces inside one word. Undefined when a comment or a quote is never closed.
 */
function tokenize(header: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word: { text: string; quoted: boolean } | undefined;
  const endWord = (): void => {
    if (word !== undefined) {
      tokens.push({ kind: 'word', ...word });
      word = undefined;
    }
  };
  let index = 0;
  while (index < header.length) {
    const char = header.charAt(index);
    if (char === '(') {
      endWord();
      let depth = 1;
      index += 1;
      while (index < header.length && depth > 0) {
        const inner = header.charAt(index);
        index += inner === '\\' ? 2 : 1;
        depth += inner === '(' ? 1 : inner === ')' ? -1 : 0;
      }
      if (depth > 0) {
        return undefined;
      }
    } else if (char === '"') {
      const current = word ?? { text: '', quoted: false };
      current.quoted = true;
      index += 1;
      let closed = false;
      while (index < header.length && !closed) {
        const inner = header.charAt(index);
        if (inner === '\\') {
          current.text += header.charAt(index + 1);
          index += 2;
        } else {
          closed = inner === '"';
          current.text += closed ? '' : inner;
          index += 1;
        }
      }
      if (!closed) {
        return undefined;
      }
      word = current;
    } else if (char === ')') {
      return undefined;
    } else {
      if (char === ';' || char === '=' || /\s/.test(char)) {
        endWord();
        if (char !== ';' && char !== '=') {
          index += 1;
          continue;
        }
        tokens.push({ kind: char === ';' ? 'semicolon' : 'equals' });
      } else {
        word = { text: `${word?.text ?? ''}${char}`, quoted: word?.quoted ?? false };
      }
      index += 1;
    }
  }
  endWord();
  return tokens;
}

/** `name=value` pairs in one part of a header, or undefined when the part is not made of such pairs. */
function pairsOf(tokens: readonly Token[]): { name: string; value: string; quoted: boolean }[] | undefined {
  const pairs: { name: string; value: string; quoted: boolean }[] = [];
  for (let at = 0; at < tokens.length; at += 3) {
    const [name, equals, value] = [tokens[at], tokens[at + 1], tokens[at + 2]];
    if (name?.kind !== 'word' || name.quoted || equals?.kind !== 'equals' || value?.kind !== 'word') {
      return undefined;
    }
    pairs.push({ name: name.text.toLowerCase(), value: value.text, quoted: value.quoted });
  }
  return pairs;
}

function parseMethods(header: string): { authserv: string; results: MethodResult[] } | undefined {
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
  const authserv = first?.kind === 'word' && !first.quoted ? first.text.toLowerCase() : '';
  const results: MethodResult[] = [];
  for (const part of rest) {
    const [method, ...properties] = pairsOf(part) ?? [];
    if (method === undefined || method.quoted) {
      continue;
    }
    results.push({
      method: method.name.split('/')[0] ?? '',
      result: method.value.toLowerCase(),
      // A quoted value can hold anything a sender wrote, so it never counts toward a check.
      properties: new Map(
        properties
          .filter(item => !item.quoted)
          .map(item => [item.name, item.value.replace(/^<|>$/g, '').toLowerCase()]),
      ),
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
  const parsed = parseMethods(topmost);
  if (parsed === undefined) {
    return { verified: false, why: 'The sender checks on this message could not be read.' };
  }
  const { authserv, results } = parsed;
  if (!trusted_servers.includes(authserv)) {
    return { verified: false, why: 'The sender checks came from a server that is not the one receiving your mail.' };
  }
  for (const entry of results) {
    if (entry.result !== 'pass') {
      continue;
    }
    if (entry.method === 'dkim') {
      const signer = propertyDomain(entry.properties.get('header.d') ?? entry.properties.get('header.i'));
      if (signer !== undefined && domainsAlign({ left: signer, right: fromDomain })) {
        return { verified: true, how: 'dkim' };
      }
    }
    if (entry.method === 'spf') {
      const envelope = propertyDomain(entry.properties.get('smtp.mailfrom'));
      if (envelope !== undefined && domainsAlign({ left: envelope, right: fromDomain })) {
        return { verified: true, how: 'spf' };
      }
    }
  }
  return { verified: false, why: 'The sender checks failed or do not match the From address.' };
}
