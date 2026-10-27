import { SLOT_MIRROR_GUEST_PORT } from '@truefoundry/trueforge-core/core';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'winston';
import type { PackageMirrorGrant, PackageMirrorTokenRegistry } from './packageMirrorTokens';

export type MirrorEcosystem = 'pypi' | 'npm' | 'go' | 'cargo';

const ECOSYSTEMS: readonly MirrorEcosystem[] = ['pypi', 'npm', 'go', 'cargo'];

/**
 * The whole upstream list of each mirror. A mirror fetches from these addresses and no others, and a
 * redirect is followed only while every hop stays on the same list.
 */
export const MIRROR_UPSTREAM_BASES: Record<MirrorEcosystem, readonly string[]> = {
  pypi: ['https://pypi.org', 'https://files.pythonhosted.org'],
  npm: ['https://registry.npmjs.org'],
  go: ['https://proxy.golang.org', 'https://sum.golang.org'],
  cargo: ['https://index.crates.io', 'https://static.crates.io'],
};

/** One download may be at most this large by default; the server setting of the same name overrides it. */
export const DEFAULT_MIRROR_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
/** The whole cache may be at most this large by default; the server setting of the same name overrides it. */
export const DEFAULT_MIRROR_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;

/** Bodies larger than this are streamed untouched: index and metadata pages never come close. */
const REWRITE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

export interface PackageMirrorGatewayOptions {
  registry: PackageMirrorTokenRegistry;
  cacheDir: string;
  logger: Logger;
  maxDownloadBytes?: number;
  maxCacheBytes?: number;
  /**
   * Test seam only: replaces the fixed upstream addresses with local stand-ins, and with them the
   * public-address check that only makes sense for the real ones. The server never sets this; its
   * mirrors always use MIRROR_UPSTREAM_BASES and the address check.
   */
  upstreamBases?: Partial<Record<MirrorEcosystem, readonly string[]>>;
}

interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

interface CachedEntry {
  status: number;
  contentType: string | undefined;
}

/** Whether an address is a public one. Private, loopback, link-local and reserved answers are refused. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isPublicIpv4(address);
  }
  if (family === 6) {
    return isPublicIpv6(address);
  }
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = [parts[0] ?? -1, parts[1] ?? -1];
  if (a === 0 || a === 10 || a === 127) {
    return false;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return false;
  }
  if (a === 169 && b === 254) {
    return false;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false;
  }
  if (a === 192 && b === 0) {
    return false;
  }
  if (a === 192 && b === 168) {
    return false;
  }
  if (a === 192 && b === 88) {
    return false;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return false;
  }
  if (a === 198 && b === 51) {
    return false;
  }
  if (a === 203 && b === 0) {
    return false;
  }
  if (a >= 224) {
    return false;
  }
  return true;
}

function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') {
    return false;
  }
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? isPublicIpv4(mapped) : false;
  }
  const first = lower.split(':')[0] ?? '';
  const head = Number.parseInt(first === '' ? '0' : first, 16);
  if (Number.isNaN(head)) {
    return false;
  }
  if (head >= 0xfe80 && head <= 0xfebf) {
    return false;
  }
  if (head >= 0xfc00 && head <= 0xfdff) {
    return false;
  }
  if (head >= 0xff00) {
    return false;
  }
  const segments = lower.split(':');
  if (segments[0] === '2001' && segments[1] === 'db8') {
    return false;
  }
  return true;
}

/**
 * DNS lookup for upstream fetches: resolves the name, refuses the whole answer when any address in
 * it is not public, and pins the checked addresses for the connection, so what was checked is what
 * gets connected to. Shared with the skill network gateway, which makes the same promise.
 */
type GuardedLookup = NonNullable<RequestOptions['lookup']>;

export const guardedLookup: GuardedLookup = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, '', 0);
      return;
    }
    if (addresses.length === 0 || addresses.some(entry => !isPublicAddress(entry.address))) {
      callback(new Error(`The package site name ${hostname} answered with an address that is not public.`), '', 0);
      return;
    }
    if (options.all === true) {
      callback(null, addresses, 0);
      return;
    }
    const first: LookupAddress | undefined = addresses[0];
    if (first === undefined) {
      callback(new Error(`The package site name ${hostname} gave no answer.`), '', 0);
      return;
    }
    callback(null, first.address, first.family);
  });
};

/** Splits a raw request target into its still-escaped path and query, without decoding anything. */
function splitRequestTarget(target: string): { rawPath: string; query: string } {
  const mark = target.indexOf('?');
  if (mark === -1) {
    return { rawPath: target, query: '' };
  }
  return { rawPath: target.slice(0, mark), query: target.slice(mark) };
}

/**
 * Whether a raw mirror path is safe to route: every segment must decode cleanly and must not decode
 * to a dot step or carry a backslash or control character. An encoded slash inside one segment (npm
 * writes scoped names that way) stays as it is and goes to the upstream still encoded.
 */
export function isSafeMirrorPath(rawPath: string): boolean {
  if (!rawPath.startsWith('/') || rawPath.includes('\\')) {
    return false;
  }
  for (const segment of rawPath.split('/')) {
    if (segment === '') {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded.includes('\\')) {
      return false;
    }
    // An encoded slash may hide a dot step inside one segment (npm scoped names use one openly,
    // as plain words either side of it), so the decoded pieces are what get checked.
    if (decoded.split('/').some(piece => piece === '.' || piece === '..')) {
      return false;
    }
    for (const ch of decoded) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) {
        return false;
      }
    }
  }
  return true;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The host-side package mirrors: one caching, download-only gateway that speaks the four standard
 * read protocols (PEP 503 for Python, the npm registry read interface, the Go module proxy
 * protocol, and the cargo sparse index). It listens only on Unix sockets inside the slots' control
 * directories, which the slot agents reach; nothing here listens on the network.
 */
export class PackageMirrorGateway {
  readonly #registry: PackageMirrorTokenRegistry;
  readonly #cacheDir: string;
  readonly #logger: Logger;
  readonly #maxDownloadBytes: number;
  readonly #maxCacheBytes: number;
  readonly #bases: Record<MirrorEcosystem, readonly string[]>;
  readonly #testMode: boolean;
  readonly #servers: Server[] = [];

  constructor(options: PackageMirrorGatewayOptions) {
    this.#registry = options.registry;
    this.#cacheDir = options.cacheDir;
    this.#logger = options.logger;
    this.#maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MIRROR_DOWNLOAD_MAX_BYTES;
    this.#maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MIRROR_CACHE_MAX_BYTES;
    this.#testMode = options.upstreamBases !== undefined;
    this.#bases = {
      pypi: options.upstreamBases?.pypi ?? MIRROR_UPSTREAM_BASES.pypi,
      npm: options.upstreamBases?.npm ?? MIRROR_UPSTREAM_BASES.npm,
      go: options.upstreamBases?.go ?? MIRROR_UPSTREAM_BASES.go,
      cargo: options.upstreamBases?.cargo ?? MIRROR_UPSTREAM_BASES.cargo,
    };
  }

  /** The request handler, shared by every socket this gateway listens on. */
  readonly handler = (req: IncomingMessage, res: ServerResponse): void => {
    void this.#handle(req, res).catch((error: unknown) => {
      this.#logger.warn('The package mirror could not answer a request', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        this.#plain(res, 502, 'The package mirrors could not answer. Try again in a moment.');
      } else {
        res.destroy();
      }
    });
  };

  /** Listens on one Unix socket per slot. A socket that cannot be opened fails only the mirrors. */
  async listenOnSockets(socketPaths: readonly string[]): Promise<void> {
    await mkdir(this.#cacheDir, { recursive: true });
    void this.#enforceCacheCap();
    for (const socketPath of socketPaths) {
      await mkdir(path.dirname(socketPath), { recursive: true });
      await unlink(socketPath).catch(() => undefined);
      const server = createServer(this.handler);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      // The socket is created with the process umask, which leaves it closed to anyone but the app
      // user; the slot agent runs as another user and connecting to a socket needs write permission
      // on it. The folder around the socket is mounted only by the app and that one slot, so the
      // folder is what limits who can reach the socket; open the socket itself the way the slot
      // agent opens its control socket to the app.
      try {
        await chmod(socketPath, 0o666);
      } catch (error: unknown) {
        server.close();
        throw error;
      }
      this.#servers.push(server);
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      this.#servers.map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
    this.#servers.length = 0;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAt = new Date();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      this.#plain(res, 405, 'Package mirrors only answer downloads. Nothing can be published or uploaded here.');
      return;
    }
    const { rawPath, query } = splitRequestTarget(req.url ?? '/');
    const segments = rawPath.split('/').filter(segment => segment !== '');
    const ecoSegment = segments[0];
    const ecosystem = ECOSYSTEMS.find(candidate => candidate === ecoSegment);
    if (ecosystem === undefined || !isSafeMirrorPath(rawPath)) {
      this.#plain(res, 404, 'There is no package mirror at that address.');
      return;
    }
    const tokenHeader = req.headers['x-aman-mirror-token'];
    const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
    const grant = token === undefined ? undefined : this.#registry.resolve(token);
    if (grant === undefined || token === undefined) {
      this.#plain(res, 403, 'This sandbox has no package download grant. Allow downloads for this repo first.');
      return;
    }
    // The rest of the path goes upstream exactly as written, trailing slash and all.
    const rest = rawPath.length > ecosystem.length + 1 ? rawPath.slice(ecosystem.length + 1) : '/';
    if (segments[1] === 'off-list' && segments.length >= 3) {
      this.#plain(res, 403, "That package file is not on this mirror's own list, so it was not fetched.");
      this.#log({ grant, ecosystem, path: rest, status: 403, bytes: 0, cached: false, at: startedAt });
      return;
    }
    const publicBase = `http://127.0.0.1:${String(SLOT_MIRROR_GUEST_PORT)}/m/${token}`;
    if (ecosystem === 'cargo' && rest === '/config.json') {
      const body = Buffer.from(
        JSON.stringify({ dl: `${publicBase}/cargo/dl/{crate}/{version}`, api: `${publicBase}/cargo` }),
      );
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
      this.#log({ grant, ecosystem, path: rest, status: 200, bytes: body.length, cached: false, at: startedAt });
      return;
    }
    const upstreamUrl = this.#upstreamUrl({ ecosystem, rest, query });
    if (upstreamUrl === undefined) {
      this.#plain(res, 404, 'There is no package mirror at that address.');
      return;
    }
    const cacheable =
      req.method === 'GET' &&
      req.headers.range === undefined &&
      req.headers['if-none-match'] === undefined &&
      req.headers['if-modified-since'] === undefined;
    if (cacheable) {
      const hit = await this.#cacheHit({ ecosystem, upstreamUrl });
      if (hit !== undefined) {
        const raw = createReadStream(hit.file);
        const served = await this.#serveBody({
          res,
          method: req.method,
          ecosystem,
          raw,
          status: hit.entry.status,
          contentType: hit.entry.contentType,
          publicBase,
        });
        this.#log({
          grant,
          ecosystem,
          path: rest,
          status: hit.entry.status,
          bytes: served,
          cached: true,
          at: startedAt,
        });
        return;
      }
    }
    const upstream = await this.#fetchUpstream({
      ecosystem,
      url: upstreamUrl,
      method: req.method,
      headers: req.headers,
    });
    if (upstream === undefined) {
      this.#plain(res, 502, 'The package site could not be reached, or sent the mirror somewhere it may not go.');
      this.#log({ grant, ecosystem, path: rest, status: 502, bytes: 0, cached: false, at: startedAt });
      return;
    }
    const contentLength = headerValue(upstream.headers, 'content-length');
    if (contentLength !== undefined && Number(contentLength) > this.#maxDownloadBytes) {
      upstream.body.destroy();
      this.#plain(res, 413, 'That package file is larger than the mirror allows in one download.');
      this.#log({ grant, ecosystem, path: rest, status: 413, bytes: 0, cached: false, at: startedAt });
      return;
    }
    const served = await this.#serveBody({
      res,
      method: req.method,
      ecosystem,
      raw: upstream.body,
      status: upstream.status,
      contentType: headerValue(upstream.headers, 'content-type'),
      publicBase,
      headers: upstream.headers,
      cacheTarget: cacheable && upstream.status === 200 ? this.#cachePaths({ ecosystem, upstreamUrl }) : undefined,
    });
    this.#log({ grant, ecosystem, path: rest, status: upstream.status, bytes: served, cached: false, at: startedAt });
  }

  /** Maps a mirror path to the one upstream address it may fetch, or undefined when there is none. */
  #upstreamUrl(input: { ecosystem: MirrorEcosystem; rest: string; query: string }): string | undefined {
    const bases = this.#bases[input.ecosystem];
    const primary = bases[0];
    if (primary === undefined) {
      return undefined;
    }
    const { ecosystem, rest, query } = input;
    if (rest.startsWith('/via/')) {
      const after = rest.slice('/via/'.length);
      const host = after.split('/')[0] ?? '';
      const base = bases.find(candidate => new URL(candidate).hostname === host);
      if (base === undefined) {
        return undefined;
      }
      return `${base}${after.slice(host.length)}${query}`;
    }
    switch (ecosystem) {
      case 'pypi':
        if (rest.startsWith('/files/')) {
          const files = bases.find(candidate => new URL(candidate).hostname === 'files.pythonhosted.org') ?? bases[1];
          return files === undefined ? undefined : `${files}${rest.slice('/files'.length)}${query}`;
        }
        return `${primary}${rest}${query}`;
      case 'npm':
        return `${primary}${rest}${query}`;
      case 'go': {
        if (rest.startsWith('/sumdb/')) {
          const inner = rest.slice('/sumdb/'.length);
          const host = inner.split('/')[0] ?? '';
          const base = bases.find(candidate => new URL(candidate).hostname === host);
          if (base !== undefined) {
            return `${base}${inner.slice(host.length)}${query}`;
          }
          return this.#testMode ? `${primary}${rest}${query}` : undefined;
        }
        return `${primary}${rest}${query}`;
      }
      case 'cargo': {
        if (rest.startsWith('/dl/')) {
          const parts = rest.slice('/dl/'.length).split('/');
          const crate = parts[0] ?? '';
          const version = parts[1] ?? '';
          if (crate === '' || version === '' || parts.length !== 2) {
            return undefined;
          }
          const files =
            bases.find(candidate => new URL(candidate).hostname === 'static.crates.io') ?? bases[1] ?? primary;
          return `${files}/crates/${crate}/${crate}-${version}.crate${query}`;
        }
        return `${primary}${rest}${query}`;
      }
    }
  }

  /**
   * Fetches one upstream address, following redirects by hand: every hop must stay on this mirror's
   * own list, at the same host and port as an address on that list and carrying no user name or
   * password, and only GET and HEAD are ever sent. Returns undefined when a hop leaves the list.
   */
  async #fetchUpstream(input: {
    ecosystem: MirrorEcosystem;
    url: string;
    method: string;
    headers: IncomingMessage['headers'];
  }): Promise<UpstreamResponse | undefined> {
    let url = input.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.#fetchOnce({ url, method: input.method, headers: input.headers });
      const location = headerValue(response.headers, 'location');
      const redirect =
        location !== undefined &&
        (response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308);
      if (!redirect) {
        return response;
      }
      response.body.destroy();
      if (hop === MAX_REDIRECTS) {
        return undefined;
      }
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return undefined;
      }
      const allowed = this.#bases[input.ecosystem].some(candidate => {
        const base = new URL(candidate);
        return base.hostname === next.hostname && base.port === next.port;
      });
      const schemeOk = this.#testMode
        ? next.protocol === 'http:' || next.protocol === 'https:'
        : next.protocol === 'https:';
      // A redirect carrying a user name or password would send those credentials upstream, so
      // it is refused even when it points at a listed host.
      const carriesCredentials = next.username !== '' || next.password !== '';
      if (!allowed || !schemeOk || carriesCredentials) {
        return undefined;
      }
      url = next.toString();
    }
    return undefined;
  }

  #fetchOnce(input: { url: string; method: string; headers: IncomingMessage['headers'] }): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      const target = new URL(input.url);
      const isHttps = target.protocol === 'https:';
      const request = (isHttps ? httpsRequest : httpRequest)(
        target,
        {
          method: input.method,
          headers: {
            accept: input.headers.accept ?? '*/*',
            ...(input.headers.range === undefined ? {} : { range: input.headers.range }),
            ...(input.headers['if-none-match'] === undefined
              ? {}
              : { 'if-none-match': input.headers['if-none-match'] }),
            ...(input.headers['if-modified-since'] === undefined
              ? {}
              : { 'if-modified-since': input.headers['if-modified-since'] }),
            'user-agent': 'Aman package mirror',
          },
          ...(isHttps && !this.#testMode ? { lookup: guardedLookup } : {}),
        },
        response => {
          resolve({
            status: response.statusCode ?? 502,
            headers: response.headers,
            body: response,
          });
        },
      );
      request.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
        request.destroy(new Error('The package site took too long to answer.'));
      });
      request.once('error', error => {
        reject(new Error('The package site could not be reached.', { cause: error }));
      });
      request.end();
    });
  }

  /**
   * Sends one upstream body to the guest. Index and metadata bodies are buffered and their file
   * links rewritten so every later fetch also comes through this mirror; everything else streams,
   * counted against the per-download cap, and is stored in the cache on the way when asked.
   */
  async #serveBody(input: {
    res: ServerResponse;
    method: string;
    ecosystem: MirrorEcosystem;
    raw: Readable;
    status: number;
    contentType: string | undefined;
    publicBase: string;
    headers?: Record<string, string | string[] | undefined>;
    cacheTarget?: { bodyPath: string; metaPath: string } | undefined;
  }): Promise<number> {
    const rewritable =
      (input.ecosystem === 'pypi' || input.ecosystem === 'npm') &&
      input.contentType !== undefined &&
      (input.contentType.includes('text/html') || input.contentType.includes('json')) &&
      input.status === 200;
    if (rewritable) {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of input.raw) {
        const piece: unknown = chunk;
        if (!Buffer.isBuffer(piece) && typeof piece !== 'string') {
          input.raw.destroy();
          this.#plain(input.res, 502, 'The package site sent an answer the mirror could not read.');
          return 0;
        }
        const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        total += buffer.length;
        if (total > REWRITE_MAX_BYTES || total > this.#maxDownloadBytes) {
          input.raw.destroy();
          this.#plain(input.res, 413, 'That package file is larger than the mirror allows in one download.');
          return 0;
        }
        chunks.push(buffer);
      }
      const rawBody = Buffer.concat(chunks);
      if (input.cacheTarget !== undefined) {
        await this.#storeCache({
          target: input.cacheTarget,
          body: rawBody,
          entry: { status: input.status, contentType: input.contentType },
        });
      }
      const served = Buffer.from(
        this.#rewriteLinks({
          ecosystem: input.ecosystem,
          text: rawBody.toString('utf8'),
          publicBase: input.publicBase,
        }),
        'utf8',
      );
      this.#sendHeaders({
        res: input.res,
        status: input.status,
        contentType: input.contentType,
        contentLength: served.length,
        headers: input.headers,
      });
      input.res.end(input.method === 'HEAD' ? undefined : served);
      return served.length;
    }
    let counted = 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        counted += chunk.length;
        if (counted > this.#maxDownloadBytes) {
          callback(new Error('download larger than the mirror allows'));
          return;
        }
        callback(null, chunk);
      },
    });
    this.#sendHeaders({
      res: input.res,
      status: input.status,
      contentType: input.contentType,
      contentLength: undefined,
      headers: input.headers,
    });
    if (input.method === 'HEAD') {
      input.raw.destroy();
      input.res.end();
      return 0;
    }
    let tempPath: string | undefined;
    try {
      if (input.cacheTarget !== undefined) {
        // The entry is committed before the guest sees the end of the body, so an immediate repeat is a cache hit.
        tempPath = `${input.cacheTarget.bodyPath}.part-${String(process.pid)}-${String(Date.now())}`;
        await pipeline(input.raw, counter, createWriteStream(tempPath));
        await rename(tempPath, input.cacheTarget.bodyPath);
        tempPath = undefined;
        await writeFile(
          input.cacheTarget.metaPath,
          JSON.stringify({ status: input.status, contentType: input.contentType ?? null }),
        );
        void this.#enforceCacheCap();
        await pipeline(createReadStream(input.cacheTarget.bodyPath), input.res);
      } else {
        await pipeline(input.raw, counter, input.res);
      }
    } catch {
      // The guest went away or the download passed the cap; either way the answer is over.
      if (tempPath !== undefined) {
        await unlink(tempPath).catch(() => undefined);
      }
      if (!input.res.writableEnded) {
        input.res.destroy();
      }
    }
    return counted;
  }

  #sendHeaders(input: {
    res: ServerResponse;
    status: number;
    contentType: string | undefined;
    contentLength: number | undefined;
    headers: Record<string, string | string[] | undefined> | undefined;
  }): void {
    const headers: Record<string, string> = {};
    if (input.contentType !== undefined) {
      headers['content-type'] = input.contentType;
    }
    if (input.contentLength !== undefined) {
      headers['content-length'] = String(input.contentLength);
    }
    if (input.headers !== undefined) {
      for (const name of ['etag', 'last-modified', 'cache-control', 'accept-ranges', 'content-range']) {
        const value = headerValue(input.headers, name);
        if (value !== undefined) {
          headers[name] = value;
        }
      }
      if (input.contentLength === undefined) {
        const length = headerValue(input.headers, 'content-length');
        if (length !== undefined) {
          headers['content-length'] = length;
        }
      }
    }
    input.res.writeHead(input.status, headers);
  }

  /**
   * Points every absolute package-site link in an index or metadata body back at this mirror. A
   * link to the mirror's own primary site keeps its path; a link to another site on the mirror's
   * list goes through the via route; any other link is sent to the off-list route, which refuses it,
   * so a package whose metadata names another site fails instead of wandering off.
   */
  #rewriteLinks(input: { ecosystem: MirrorEcosystem; text: string; publicBase: string }): string {
    const bases = this.#bases[input.ecosystem];
    const primary = bases[0];
    if (primary === undefined) {
      return input.text;
    }
    const primaryHost = new URL(primary).hostname;
    const pattern = /https?:\/\/(?:[^\s"'<>\\/@]+@)?[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[^\s"'<>\\]*)?/g;
    return input.text.replace(pattern, match => {
      let url: URL;
      try {
        url = new URL(match);
      } catch {
        return match;
      }
      if (url.username !== '' || url.password !== '') {
        // A link whose address carries a name before the host (http://name@host/...) goes to the
        // refusal path as a whole: rewriting only the part before the @ would leave the real host
        // dangling after it as a junk path.
        return `${input.publicBase}/${input.ecosystem}/off-list/${url.hostname}${url.pathname}`;
      }
      const tail = `${url.pathname}${url.search}${url.hash}`;
      if (url.hostname === primaryHost) {
        return `${input.publicBase}/${input.ecosystem}${tail === '' ? '/' : tail}`;
      }
      if (bases.some(candidate => new URL(candidate).hostname === url.hostname)) {
        return `${input.publicBase}/${input.ecosystem}/via/${url.hostname}${tail}`;
      }
      return `${input.publicBase}/${input.ecosystem}/off-list/${url.hostname}${url.pathname}`;
    });
  }

  #cachePaths(input: { ecosystem: MirrorEcosystem; upstreamUrl: string }): { bodyPath: string; metaPath: string } {
    const key = createHash('sha256').update(`${input.ecosystem}\n${input.upstreamUrl}`).digest('hex');
    return {
      bodyPath: path.join(this.#cacheDir, `${key}.body`),
      metaPath: path.join(this.#cacheDir, `${key}.meta.json`),
    };
  }

  async #cacheHit(input: {
    ecosystem: MirrorEcosystem;
    upstreamUrl: string;
  }): Promise<{ file: string; entry: CachedEntry } | undefined> {
    const target = this.#cachePaths(input);
    try {
      const parsed: unknown = JSON.parse(await readFile(target.metaPath, 'utf8'));
      const info = await stat(target.bodyPath);
      if (!info.isFile() || typeof parsed !== 'object' || parsed === null) {
        return undefined;
      }
      const meta: Record<string, unknown> = { ...parsed };
      if (typeof meta['status'] !== 'number') {
        return undefined;
      }
      return {
        file: target.bodyPath,
        entry: {
          status: meta['status'],
          contentType: typeof meta['contentType'] === 'string' ? meta['contentType'] : undefined,
        },
      };
    } catch {
      return undefined;
    }
  }

  async #storeCache(input: {
    target: { bodyPath: string; metaPath: string };
    body: Buffer;
    entry: CachedEntry;
  }): Promise<void> {
    await mkdir(this.#cacheDir, { recursive: true });
    const tempPath = `${input.target.bodyPath}.part-${String(process.pid)}-${String(Date.now())}`;
    await writeFile(tempPath, input.body);
    await rename(tempPath, input.target.bodyPath);
    await writeFile(
      input.target.metaPath,
      JSON.stringify({ status: input.entry.status, contentType: input.entry.contentType ?? null }),
    );
    void this.#enforceCacheCap();
  }

  /** Keeps the cache within its total cap by removing the oldest stored files first. */
  async #enforceCacheCap(): Promise<void> {
    try {
      const names = (await readdir(this.#cacheDir)).filter(name => name.endsWith('.body'));
      const entries: { name: string; size: number; mtimeMs: number }[] = [];
      let total = 0;
      for (const name of names) {
        const info = await stat(path.join(this.#cacheDir, name));
        entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
        total += info.size;
      }
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of entries) {
        if (total <= this.#maxCacheBytes) {
          break;
        }
        await unlink(path.join(this.#cacheDir, entry.name)).catch(() => undefined);
        await unlink(path.join(this.#cacheDir, entry.name.replace(/\.body$/, '.meta.json'))).catch(() => undefined);
        total -= entry.size;
      }
    } catch {
      // A cache that cannot be pruned only grows until the next pass; downloads keep working.
    }
  }

  #log(input: {
    grant: PackageMirrorGrant;
    ecosystem: MirrorEcosystem;
    path: string;
    status: number;
    bytes: number;
    cached: boolean;
    at: Date;
  }): void {
    this.#logger.info('Package mirror answered a download', {
      ecosystem: input.ecosystem,
      path: input.path,
      repository_id: input.grant.repository_id,
      session_id: input.grant.session_id,
      status: input.status,
      bytes: input.bytes,
      cached: input.cached,
      at: input.at.toISOString(),
    });
  }

  #plain(res: ServerResponse, status: number, message: string): void {
    const body = Buffer.from(`${message}\n`);
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }
}
