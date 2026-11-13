import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * Host-side request to a URL on the public internet (a GET unless told otherwise). Every hop is checked (http or https, no credentials,
 * ports 80 and 443, every resolved address public) and the connection is pinned to the checked
 * address, so neither a redirect nor DNS rebinding can reach this machine or its network.
 */

/** What stopped a public fetch; the caller words it for its own audience. */
export type PublicFetchProblem =
  | { kind: 'invalid_url'; url: string }
  | { kind: 'scheme' }
  | { kind: 'credentials' }
  | { kind: 'port' }
  | { kind: 'private_host'; hostname: string }
  | { kind: 'lookup_failed'; hostname: string }
  | { kind: 'unresolved'; hostname: string }
  | { kind: 'refused_hop'; url: string }
  | { kind: 'too_many_redirects' };

export class PublicFetchError extends Error {
  readonly problem: PublicFetchProblem;

  constructor(input: { problem: PublicFetchProblem; message: string; cause: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'PublicFetchError';
    this.problem = input.problem;
  }
}

export type ResolveAddresses = (hostname: string) => Promise<string[]>;

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const entries = await lookup(hostname, { all: true });
  return entries.map(entry => entry.address);
}

/**
 * True only for global-unicast IP literals. This is an allowlist over the
 * IANA special-purpose registries: anything that isn't plain public
 * address space (private, loopback, link-local, CGNAT, multicast, reserved,
 * documentation, transition mechanisms…) fails closed. A denylist here
 * would silently miss the next special range.
 */
function isPublicIpLiteral(ip: string): boolean {
  if (ip.includes(':')) {
    return isPublicIpv6Literal(ip);
  }
  const octets = ip.split('.').map(part => Number(part));
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined) {
    return false;
  }
  return !(
    a === 0 || // 0.0.0.0/8 — software scope
    a === 10 || // 10.0.0.0/8 — private
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — CGNAT
    a === 127 || // 127.0.0.0/8 — loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — private
    (a === 192 && b === 0) || // 192.0.0.0/24 — IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 — documentation (subsumed above)
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 — 6to4 relay (deprecated)
    (a === 192 && b === 168) || // 192.168.0.0/16 — private
    (a === 198 && b >= 18 && b <= 19) || // 198.18.0.0/15 — benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 — documentation
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 — documentation
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  );
}

/** Parses an IPv6 literal into 8 hextets. Returns null when unparseable. */
function ipv6Hextets(ip: string): number[] | null {
  const lower = ip.toLowerCase();
  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4): validate the v4 part with the
  // v4 allowlist; the v6 prefix must be all zeros or it's a transition
  // mechanism and fails closed.
  if (lower.includes('.')) {
    const lastColon = lower.lastIndexOf(':');
    const v4 = lower.slice(lastColon + 1);
    const prefix = lower.slice(0, lastColon).replace(/:/g, '');
    if (prefix !== '' && prefix !== '0' && !/^0+$/.test(prefix)) {
      return null;
    }
    return isPublicIpLiteral(v4) ? [0, 0, 0, 0, 0, 0xffff, 0, 0] : null;
  }
  const halves = lower.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length < 2 || halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':');
  const parse = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    return parseInt(part, 16);
  };
  const headNums: number[] = [];
  for (const part of head) {
    const n = parse(part);
    if (n === null) {
      return null;
    }
    headNums.push(n);
  }
  const tailNums: number[] = [];
  for (const part of tail) {
    const n = parse(part);
    if (n === null) {
      return null;
    }
    tailNums.push(n);
  }
  if (halves.length === 1) {
    return headNums.length === 8 ? headNums : null;
  }
  const zeros = 8 - headNums.length - tailNums.length;
  if (zeros < 1) {
    return null;
  }
  return [...headNums, ...new Array<number>(zeros).fill(0), ...tailNums];
}

function isPublicIpv6Literal(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (h?.length !== 8) {
    return false;
  }
  const [h0, h1, h2, h3, h4, h5] = h;
  if (
    h0 === undefined ||
    h1 === undefined ||
    h2 === undefined ||
    h3 === undefined ||
    h4 === undefined ||
    h5 === undefined
  ) {
    return false;
  }
  const allZero = h.every(part => part === 0);
  const isLoopback = h.every((part, index) => part === (index === 7 ? 1 : 0));
  return !(
    allZero || // :: — unspecified
    isLoopback || // ::1 — loopback
    (h0 & 0xffc0) === 0xfe80 || // fe80::/10 — link-local
    (h0 & 0xfe00) === 0xfc00 || // fc00::/7 — unique local
    (h0 & 0xff00) === 0xff00 || // ff00::/8 — multicast
    // ::ffff:0:0/96 — IPv4-mapped (the v4 tail was already allowlisted, but a
    // mapped address reaching a socket API may still behave as v4)
    (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) ||
    // 64:ff9b::/96 — NAT64 translation prefix
    (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0) ||
    h0 === 0x2002 || // 2002::/16 — 6to4
    (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) || // 100::/64 — discard
    (h0 === 0x2001 && (h1 & 0xfe00) === 0) // 2001::/23 — IETF protocol assignments (incl. documentation)
  );
}

function fail(input: {
  problem: PublicFetchProblem;
  describe: (problem: PublicFetchProblem) => string;
  cause?: unknown;
}): never {
  throw new PublicFetchError({ problem: input.problem, message: input.describe(input.problem), cause: input.cause });
}

function checkFetchableUrl(input: { raw: string; describe: (problem: PublicFetchProblem) => string }): URL {
  let url: URL;
  try {
    url = new URL(input.raw);
  } catch (error) {
    return fail({ problem: { kind: 'invalid_url', url: input.raw }, describe: input.describe, cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail({ problem: { kind: 'scheme' }, describe: input.describe });
  }
  if (url.username !== '' || url.password !== '') {
    return fail({ problem: { kind: 'credentials' }, describe: input.describe });
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    return fail({ problem: { kind: 'port' }, describe: input.describe });
  }
  return url;
}

async function checkPublicHost(input: {
  hostname: string;
  resolveAddresses: ResolveAddresses;
  describe: (problem: PublicFetchProblem) => string;
}): Promise<string> {
  const { hostname, describe } = input;
  // An IP literal is its own address: validate it directly instead of trusting
  // a resolver to echo the literal back.
  if (isIP(hostname) !== 0) {
    if (!isPublicIpLiteral(hostname)) {
      return fail({ problem: { kind: 'private_host', hostname }, describe });
    }
    return hostname;
  }
  let addresses: string[];
  try {
    addresses = await input.resolveAddresses(hostname);
  } catch (error) {
    return fail({ problem: { kind: 'lookup_failed', hostname }, describe, cause: error });
  }
  if (addresses.length === 0 || addresses.some(address => !isPublicIpLiteral(address))) {
    return fail({ problem: { kind: 'private_host', hostname }, describe });
  }
  const address = addresses[0];
  if (address === undefined) {
    return fail({ problem: { kind: 'unresolved', hostname }, describe });
  }
  return address;
}

export interface PublicFetchOptions {
  /** Defaults to undici's fetch, so the `dispatcher` carrying the address pin is always honoured. */
  fetchImpl: typeof undiciFetch | undefined;
  /** DNS resolver seam; tests inject a fake so they never touch public DNS. */
  resolveAddresses: ResolveAddresses | undefined;
  /** One budget for every hop and the body read that follows. */
  timeoutMs: number;
  maxRedirects: number;
  headers: Record<string, string>;
  /** Defaults to GET. A POST is never repeated after a redirect, so give it `maxRedirects: 0`. */
  method?: 'GET' | 'POST';
  body?: Uint8Array<ArrayBuffer>;
  /** Extra check run on every hop's URL before it is requested; false refuses the hop. */
  allowHop: ((url: URL) => boolean) | undefined;
  describe: (problem: PublicFetchProblem) => string;
}

export interface PublicFetchResult {
  response: Response;
  /** URL after following redirects. */
  finalUrl: string;
  /** Releases the pinned connection; call once the body has been read or abandoned. */
  release: () => Promise<void>;
}

/**
 * Requests a public URL, following at most `maxRedirects` redirects and re-checking each hop. Sends only
 * the given headers: never cookies, a Referer or credentials.
 */
export async function fetchPublicUrl(rawUrl: string, options: PublicFetchOptions): Promise<PublicFetchResult> {
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
  const { describe } = options;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = checkFetchableUrl({ raw: rawUrl, describe }).toString();
  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const url = checkFetchableUrl({ raw: current, describe });
    if (options.allowHop !== undefined && !options.allowHop(url)) {
      return fail({ problem: { kind: 'refused_hop', url: current }, describe });
    }
    const address = await checkPublicHost({ hostname: url.hostname, resolveAddresses, describe });
    // Pin the connection to the validated address: the hostname still drives
    // TLS SNI and the Host header, but the TCP destination cannot move.
    const dispatcher = pinnedDispatcher(address);
    let fetched: Response;
    try {
      fetched = await fetchImpl(current, {
        dispatcher,
        signal,
        redirect: 'manual',
        headers: options.headers,
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (error) {
      // A throwing fetch never returns a response whose dispatcher we close
      // later — release its sockets here instead of leaking them.
      await dispatcher.close().catch(() => undefined);
      throw error;
    }
    const location = fetched.headers.get('location');
    if (fetched.status >= 300 && fetched.status < 400 && location !== null) {
      await fetched.arrayBuffer().catch(() => undefined);
      await dispatcher.close().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }
    return {
      response: fetched,
      finalUrl: current,
      release: async () => {
        await fetched.body?.cancel().catch(() => undefined);
        await dispatcher.close().catch(() => undefined);
      },
    };
  }
  return fail({ problem: { kind: 'too_many_redirects' }, describe });
}

/**
 * Builds a dispatcher whose connections always go to the given validated IP
 * address, regardless of what DNS reports at connection time. The original
 * hostname is still used for TLS SNI and the Host header — only the TCP
 * destination is pinned — which closes the DNS-rebinding window between the
 * address check and the connection for every redirect hop. DNS validation
 * alone is a check, not a guarantee; this is the guarantee.
 *
 * Exported so tests can prove the pin holds against an unresolvable
 * hostname, not just assert a dispatcher object exists.
 */
export function pinnedDispatcher(address: string): Dispatcher {
  const family = isIP(address) === 6 ? 6 : 4;
  return new Agent({
    connect: {
      // Node asks for every address (`all: true`) when autoSelectFamily is on;
      // the lookup must answer in the shape asked for, or net.connect rejects
      // the result and the fetch fails outright.
      lookup: (
        _hostname: string,
        options: { all?: boolean | undefined },
        callback: (
          err: NodeJS.ErrnoException | null,
          addresses: string | { address: string; family: number }[],
          family?: number,
        ) => void,
      ) => {
        if (options.all === true) {
          callback(null, [{ address, family }]);
        } else {
          callback(null, address, family);
        }
      },
    },
  });
}
