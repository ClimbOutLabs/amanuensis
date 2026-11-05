/**
 * Whether the receiving mail server vouched for a message's sender. A message passes when its DKIM signature or its
 * SPF check passed for a domain that lines up with the From domain. The header is read as the receiving server wrote
 * it, so only the topmost Authentication-Results header counts: any below it could have been written by the sender.
 */

/** The domain of an address, lower case, or undefined when it has none. */
export function domainOfAddress(address: string): string | undefined {
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
 * Two domains line up when they are the same or one is a subdomain of the other (relaxed alignment). A bare top level
 * such as `com` never stands for every domain under it.
 */
export function domainsAlign({ left, right }: { left: string; right: string }): boolean {
  if (left === right) {
    return true;
  }
  if (!left.includes('.') || !right.includes('.')) {
    return false;
  }
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

interface MethodResult {
  method: string;
  result: string;
  properties: Map<string, string>;
}

function stripComments(value: string): string {
  return value.replace(/\([^)]*\)/g, ' ');
}

function parseMethods(header: string): { authserv: string; results: MethodResult[] } {
  const [first = '', ...rest] = stripComments(header).split(';');
  const authserv = (first.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const results: MethodResult[] = [];
  for (const part of rest) {
    const tokens = part.trim().split(/\s+/);
    const head = tokens[0] ?? '';
    const equals = head.indexOf('=');
    if (equals <= 0) {
      continue;
    }
    const properties = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq > 0) {
        properties.set(
          token.slice(0, eq).toLowerCase(),
          token
            .slice(eq + 1)
            .replace(/^["<]|[">]$/g, '')
            .toLowerCase(),
        );
      }
    }
    results.push({
      method: head.slice(0, equals).toLowerCase(),
      result: head.slice(equals + 1).toLowerCase(),
      properties,
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

/**
 * Checks a message's sender against its Authentication-Results headers, given newest first (the topmost first).
 * `trusted_servers`, when set, names the receiving servers whose word counts: a header from another server is not
 * read. A message with no header, or whose checks failed or do not line up with the From domain, is not verified.
 */
export function checkSender({
  from_address,
  headers,
  trusted_servers,
}: {
  from_address: string;
  headers: readonly string[];
  trusted_servers: readonly string[] | undefined;
}): SenderCheck {
  const fromDomain = domainOfAddress(from_address);
  if (fromDomain === undefined) {
    return { verified: false, why: 'The message has no sender address.' };
  }
  const topmost = headers[0];
  if (topmost === undefined) {
    return { verified: false, why: 'The mail server gave no sender checks for this message.' };
  }
  const { authserv, results } = parseMethods(topmost);
  if (trusted_servers !== undefined && !trusted_servers.includes(authserv)) {
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
