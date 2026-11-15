/**
 * Whether the receiving mail server vouched for a message's sender: DMARC passed for the From domain. DMARC only passes
 * when a DKIM signature or the SPF check lined up with that domain, so nothing more is asked. The header is read as the
 * receiving server wrote it, so only the topmost Authentication-Results header counts.
 *
 * The sender can get some of its own text into that header: its envelope address, its HELO name, and the comments
 * that repeat them. So the header is read as RFC 8601 lays it out (quoted strings and comments kept whole), and
 * refused when it holds anything that text could use to pass for a result: a part that does not parse, more than one
 * DMARC result, a HELO check, an address in brackets, `header.from=` more than once, or a value that holds `dmarc=` or
 * `header.from=`.
 *
 * A raw `"` inside a comment is read as the start of a quoted string. RFC 5322 comments have none, but reading it that
 * way keeps a `)` inside a quoted address from closing the comment early. The cost is that an unpaired quote in a
 * comment can hide text from this reader. That is covered by the `header.from=` count: Gmail writes the envelope
 * address in the SPF comment and again in `smtp.mailfrom`, so any echo of it holds `header.from=` at least twice.
 * Only `dmarc=` and `header.from=` are looked for inside values, since a real tracking address can end in `.arc`.
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
  properties: { name: string; value: string }[];
}

type Token = { kind: 'word'; text: string } | { kind: 'semicolon' };

/** Reads a quoted string that starts at `start`, with its `\` escapes. Undefined when it never closes. */
function quotedAt({ header, start }: { header: string; start: number }): { text: string; end: number } | undefined {
  let text = '';
  for (let at = start + 1; at < header.length; at += 1) {
    const char = header[at] ?? '';
    if (char === '\\') {
      at += 1;
      if (at >= header.length) {
        return undefined;
      }
      text += header[at] ?? '';
    } else if (char === '"') {
      return { text, end: at };
    } else {
      text += char;
    }
  }
  return undefined;
}

/**
 * Splits a header into words and `;`. A word runs to the next space, `;` or comment, so `=` inside a value stays in
 * it. A quoted string is part of its word, and inside a comment it is skipped whole, so a `)` the sender put in an
 * address cannot end the comment early. Comments nest and are dropped. Undefined when a comment or a quoted string
 * never closes, a comment closes one that was never opened, or a backslash stands outside both.
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
  for (let at = 0; at < header.length; at += 1) {
    const char = header[at] ?? '';
    if (char === '"') {
      const quoted = quotedAt({ header, start: at });
      if (quoted === undefined) {
        return undefined;
      }
      if (depth === 0) {
        word += quoted.text;
      }
      at = quoted.end;
    } else if (char === '\\') {
      if (depth === 0) {
        return undefined;
      }
      at += 1;
    } else if (char === '(') {
      endWord();
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
    } else if (depth > 0) {
      continue;
    } else if (char === ';') {
      endWord();
      tokens.push({ kind: 'semicolon' });
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

/** A `name=value` word split at its first `=`, or undefined when it has no name or no value. */
function pairOf(word: string): { name: string; value: string } | undefined {
  const equals = word.indexOf('=');
  if (equals <= 0 || equals === word.length - 1) {
    return undefined;
  }
  return { name: word.slice(0, equals).toLowerCase(), value: word.slice(equals + 1) };
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
  const parts: string[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'semicolon') {
      parts.push([]);
    } else {
      parts[parts.length - 1]?.push(token.text);
    }
  }
  const [head = [], ...rest] = parts;
  const authserv = (head[0] ?? '').toLowerCase();
  const results: MethodResult[] = [];
  for (const part of rest) {
    // Servers often end the header with a `;`, which leaves an empty part.
    if (part.length === 0) {
      continue;
    }
    const pairs = part.map(pairOf);
    const [method, ...properties] = pairs;
    if (method === undefined || properties.some(pair => pair === undefined)) {
      return undefined;
    }
    results.push({
      method: method.name.split('/')[0] ?? '',
      result: method.value.toLowerCase(),
      properties: properties.flatMap(pair =>
        pair === undefined ? [] : [{ name: pair.name, value: pair.value.replace(/^<|>$/g, '').toLowerCase() }],
      ),
    });
  }
  return { authserv, results };
}

/** The two texts that could pass for the result this reader looks for, inside one property's value. */
const CHECK_INSIDE_VALUE = /(?:^|[^a-z0-9])(?:dmarc|header\.from)=/i;

/** Why a parsed header cannot be trusted, or undefined when nothing in it could be the sender's own text. */
function echoIn(results: readonly MethodResult[]): string | undefined {
  if (results.filter(item => item.method === 'dmarc').length > 1) {
    return 'more than one DMARC result';
  }
  for (const item of results) {
    for (const property of item.properties) {
      // Mail with no envelope sender is checked by its HELO name, which the sender writes freely.
      if (property.name === 'smtp.helo') {
        return 'a HELO check';
      }
      // A DKIM signature is random text, so it is the one value left out.
      if (property.name !== 'header.b' && CHECK_INSIDE_VALUE.test(property.value)) {
        return 'a check inside a value';
      }
    }
  }
  return undefined;
}

export type SenderCheck = { verified: true } | { verified: false; why: string };

/** Said when a mail source cannot pass on the receiving server's checks, so no sender is vouched for. */
const NOT_PASSED_ON = 'This mail source does not pass on sender checks.';
const NOT_SAFE = 'The sender checks on this message could not be read safely.';

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
  // An address in brackets can hold a `;` or a `(` outside any quotes, so a header with one is not read.
  if (/[[\]]/.test(topmost)) {
    return { verified: false, why: NOT_SAFE };
  }
  // Echoed text repeats the envelope address, so it brings a second `header.from=`; the real result has one. Quotes
  // and backslashes are dropped first, since the reader joins `header."from"=` into the same word.
  if ((topmost.replace(/["\\]/g, '').match(/header\.from=/gi) ?? []).length > 1) {
    return { verified: false, why: NOT_SAFE };
  }
  const parsed = parseMethods(topmost);
  if (parsed === undefined) {
    return { verified: false, why: 'The sender checks on this message could not be read.' };
  }
  const { authserv, results } = parsed;
  if (!trusted_servers.includes(authserv)) {
    return { verified: false, why: 'The sender checks came from a server that is not the one receiving your mail.' };
  }
  if (echoIn(results) !== undefined) {
    return { verified: false, why: NOT_SAFE };
  }
  const [dmarc] = results.filter(item => item.method === 'dmarc');
  const from = dmarc?.properties.find(property => property.name === 'header.from')?.value;
  if (dmarc?.result !== 'pass' || from !== fromDomain) {
    return { verified: false, why: 'The mail server did not confirm the From address with DMARC.' };
  }
  return { verified: true };
}
