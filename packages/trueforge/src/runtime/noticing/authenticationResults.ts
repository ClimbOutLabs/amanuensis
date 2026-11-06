/**
 * Whether the receiving mail server vouched for a message's sender: DMARC passed for the From domain. DMARC only passes
 * when a DKIM signature or the SPF check lined up with that domain, so nothing more is asked. The header is read as the
 * receiving server wrote it, so only the topmost Authentication-Results header counts, and it must hold exactly one
 * DMARC result: a second one could be text the sender got echoed into it.
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

/**
 * The server that wrote the header and every result in it, or undefined when any part cannot be read: a part that
 * does not parse may be where echoed text broke out, so the whole header is refused.
 */
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
  const authserv = first?.kind === 'word' ? first.text.toLowerCase() : '';
  const results: MethodResult[] = [];
  for (const part of rest) {
    // Servers often end the header with a `;`, which leaves an empty part.
    if (part.length === 0) {
      continue;
    }
    const pairs = pairsOf(part);
    const [method, ...properties] = pairs ?? [];
    if (method === undefined) {
      return undefined;
    }
    results.push({
      method: method.name.split('/')[0] ?? '',
      result: method.value.toLowerCase(),
      properties: new Map(properties.map(item => [item.name, item.value.replace(/^<|>$/g, '').toLowerCase()])),
    });
  }
  return { authserv, results };
}

export type SenderCheck = { verified: true; how: 'dmarc' } | { verified: false; why: string };

/** Said when a mail source cannot pass on the receiving server's checks, so no sender is vouched for. */
const NOT_PASSED_ON = 'This mail source does not pass on sender checks.';

/**
 * Checks a message's sender against its Authentication-Results headers, given newest first (the topmost first).
 * `trusted_servers` names the receiving servers whose word counts: a header from another server is not read, and an
 * empty list verifies nothing. A message with no header, or whose DMARC check did not pass for the From domain, is
 * not verified.
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
  const dmarc = results.filter(item => item.method === 'dmarc');
  if (dmarc.length > 1) {
    return { verified: false, why: 'The sender checks on this message could not be read safely.' };
  }
  const [only] = dmarc;
  if (only?.result !== 'pass' || only.properties.get('header.from') !== fromDomain) {
    return { verified: false, why: 'The mail server did not confirm the From address with DMARC.' };
  }
  return { verified: true, how: 'dmarc' };
}
