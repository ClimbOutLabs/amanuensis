import { extractRawText } from 'mammoth';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

/**
 * Document ingestion: turns uploads and URL snapshots into plain text for
 * chunking. Every parser is bounded (byte caps, page caps) and every failure
 * surfaces as a plain-English error the UI can show verbatim.
 */

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_URL_BYTES = 5 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export type UploadKind = 'pdf' | 'docx' | 'txt' | 'md';

export interface ExtractedUpload {
  kind: UploadKind;
  text: string;
  /**
   * Plain-English truncation note (e.g. page cap), shown on the ready
   * document. Absent when the whole file was indexed.
   */
  note?: string;
}

/** Page-count bombs: a tiny PDF can declare 100k+ empty pages and peg the event loop. */
const MAX_PDF_PAGES = 300;
/**
 * Zip bombs: a 15 MB .docx can inflate to gigabytes. The chunker caps text at
 * 500k chars, but mammoth inflates the whole archive first — so the real
 * uncompressed size is checked up front with a bounded inflate.
 */
const MAX_DOCX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;

const KIND_BY_EXTENSION: Record<string, UploadKind> = {
  pdf: 'pdf',
  docx: 'docx',
  txt: 'txt',
  md: 'md',
  markdown: 'md',
};

const KIND_BY_MIME: Record<string, UploadKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

/** Detects the upload kind from filename first, MIME type second. Throws on unsupported types. */
export function detectUploadKind(input: { filename: string; mimeType?: string }): UploadKind {
  const extension = input.filename.split('.').pop()?.toLowerCase() ?? '';
  const byExtension = KIND_BY_EXTENSION[extension];
  if (byExtension !== undefined) {
    return byExtension;
  }
  const mime = input.mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  const byMime = KIND_BY_MIME[mime];
  if (byMime !== undefined) {
    return byMime;
  }
  throw new Error(
    `“${input.filename}” isn’t a supported file type. Knowledge files can be PDF, Word (.docx), plain text, or Markdown.`,
  );
}

/** Extracts text from an upload. Lazy-loads the PDF/Word parsers so server boot never pays for them. */
export async function extractTextFromUpload(input: {
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}): Promise<ExtractedUpload> {
  if (input.bytes.byteLength === 0) {
    throw new Error(`“${input.filename}” is empty — there’s nothing to add to the library.`);
  }
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `“${input.filename}” is larger than ${String(MAX_UPLOAD_BYTES / 1024 / 1024)} MB, which is the current limit for one knowledge file.`,
    );
  }
  const kind = detectUploadKind({
    filename: input.filename,
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
  });
  switch (kind) {
    case 'pdf':
      return { kind, ...(await extractPdfText(input.bytes)) };
    case 'docx':
      return { kind, text: await extractDocxText(input.bytes) };
    case 'txt':
    case 'md':
      return { kind, text: decodeText(input.bytes, input.filename) };
  }
}

async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; note?: string }> {
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const doc = await loadingTask.promise;
  try {
    const totalPages = doc.numPages;
    const pageCap = Math.min(totalPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCap; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const line = content.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (line.length > 0) {
        pages.push(line);
      }
    }
    const text = pages.join('\n\n').trim();
    if (text.length === 0) {
      throw new Error(
        'No readable text was found in this PDF. Scanned pages (photos of text) can’t be read yet — an OCR step is planned for a later release.',
      );
    }
    return {
      text,
      ...(totalPages > MAX_PDF_PAGES
        ? { note: `Only the first ${String(MAX_PDF_PAGES)} of ${String(totalPages)} pages were indexed.` }
        : {}),
    };
  } finally {
    await doc.destroy();
  }
}

/**
 * Real uncompressed size of the zip, capped: each entry is inflated with an
 * output bound, because a bomb can understate its size in both the local and
 * central headers. The declared sizes are summed too, so a lying zip64 record
 * is refused before anything inflates. Zip64 is parsed for real, not skipped.
 * Returns null when the structure can't be walked; the caller refuses the file
 * rather than handing it to the zip reader unchecked.
 */
function docxInflatedBytes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIG = 0x0605_4b50;
  const CDH_SIG = 0x0201_4b50;
  const LOCAL_SIG = 0x0403_4b50;
  const ZIP64_LOCATOR_SIG = 0x0706_4b50;
  const ZIP64_EOCD_SIG = 0x0606_4b50;
  const SENTINEL = 0xffff_ffff;
  // The end-of-central-directory record is at least 22 bytes; a comment can
  // push it back, so scan the tail.
  let eocdOffset = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65_558); i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    return null;
  }
  const readU64 = (offset: number): bigint | null => {
    if (offset < 0 || offset + 8 > bytes.byteLength) {
      return null;
    }
    return view.getBigUint64(offset, true);
  };
  let cdEntries = BigInt(view.getUint16(eocdOffset + 10, true));
  let cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdEntries === BigInt(0xffff) || cdOffset === SENTINEL) {
    // Zip64: real values live in the zip64 EOCD, found via the 20-byte
    // locator immediately before the EOCD.
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0 || view.getUint32(locatorOffset, true) !== ZIP64_LOCATOR_SIG) {
      return null;
    }
    const zip64Eocd = readU64(locatorOffset + 8);
    if (zip64Eocd === null || zip64Eocd > BigInt(bytes.byteLength - 56)) {
      return null;
    }
    const zoff = Number(zip64Eocd);
    if (view.getUint32(zoff, true) !== ZIP64_EOCD_SIG) {
      return null;
    }
    const entries64 = readU64(zoff + 32);
    const offset64 = readU64(zoff + 48);
    if (entries64 === null || offset64 === null || offset64 > BigInt(bytes.byteLength)) {
      return null;
    }
    cdEntries = entries64;
    cdOffset = Number(offset64);
  }
  if (cdOffset >= bytes.byteLength) {
    return null;
  }
  let declared = 0;
  let total = 0;
  let offset = cdOffset;
  for (let n = BigInt(0); n < cdEntries; n += BigInt(1)) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CDH_SIG) {
      return null;
    }
    const method = view.getUint16(offset + 10, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const zip64 = readZip64Extra(view, bytes.byteLength, offset + 46 + nameLen, extraLen);
    if (zip64 === null) {
      return null;
    }
    // The zip64 record holds, in order, each of these fields whose 32-bit value is the sentinel.
    let widenedIndex = 0;
    const widen = (raw: number): bigint | undefined => {
      if (raw !== SENTINEL) {
        return BigInt(raw);
      }
      widenedIndex += 1;
      return zip64[widenedIndex - 1];
    };
    const declaredSize = widen(view.getUint32(offset + 24, true));
    const compressedSize = widen(view.getUint32(offset + 20, true));
    const localOffset = widen(view.getUint32(offset + 42, true));
    if (declaredSize === undefined || compressedSize === undefined || localOffset === undefined) {
      return null;
    }
    if (declaredSize > BigInt(MAX_DOCX_UNCOMPRESSED_BYTES - declared)) {
      return MAX_DOCX_UNCOMPRESSED_BYTES + 1;
    }
    declared += Number(declaredSize);
    if (localOffset + BigInt(30) > BigInt(bytes.byteLength)) {
      return null;
    }
    const local = Number(localOffset);
    if (view.getUint32(local, true) !== LOCAL_SIG) {
      return null;
    }
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (BigInt(dataStart) + compressedSize > BigInt(bytes.byteLength)) {
      return null;
    }
    const data = bytes.subarray(dataStart, dataStart + Number(compressedSize));
    if (method === 0) {
      total += data.byteLength;
    } else if (method === 8) {
      try {
        total += inflateRawSync(data, { maxOutputLength: MAX_DOCX_UNCOMPRESSED_BYTES - total + 1 }).byteLength;
      } catch (error) {
        // Inflating past the bound throws ERR_BUFFER_TOO_LARGE; anything else is corrupt data.
        const tooLarge =
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE';
        return tooLarge ? MAX_DOCX_UNCOMPRESSED_BYTES + 1 : null;
      }
    } else {
      return null;
    }
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
      return total;
    }
    offset += 46 + nameLen + extraLen + view.getUint16(offset + 32, true);
  }
  return Math.max(declared, total);
}

/**
 * The 64-bit values of the zip64 extra field (id 0x0001), in record order.
 * Empty when the entry has no such field; null when the extra block is malformed.
 */
function readZip64Extra(view: DataView, byteLength: number, extraOffset: number, extraLen: number): bigint[] | null {
  const ZIP64_EXTRA_ID = 0x0001;
  const end = extraOffset + extraLen;
  if (end > byteLength) {
    return null;
  }
  let cursor = extraOffset;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (cursor + 4 + size > end) {
      return null;
    }
    if (id === ZIP64_EXTRA_ID) {
      const values: bigint[] = [];
      for (let at = cursor + 4; at + 8 <= cursor + 4 + size; at += 8) {
        values.push(view.getBigUint64(at, true));
      }
      return values;
    }
    cursor += 4 + size;
  }
  return [];
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const uncompressed = docxInflatedBytes(bytes);
  if (uncompressed === null) {
    throw new Error('This file could not be opened as a Word document. Try saving it again as .docx.');
  }
  if (uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw new Error(
      'This Word document expands to an enormous size when opened, so it can’t be indexed safely. Try a smaller file.',
    );
  }
  const result = await extractRawText({ buffer: Buffer.from(bytes) });
  const text = result.value.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0) {
    throw new Error('No readable text was found in this Word document.');
  }
  return text;
}

function decodeText(bytes: Uint8Array, filename: string): string {
  const text = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/, '')
    .trim();
  if (text.length === 0) {
    throw new Error(`“${filename}” has no readable text.`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// URL snapshots
// ---------------------------------------------------------------------------

export interface UrlSnapshot {
  /** URL after following redirects. */
  finalUrl: string;
  title: string;
  text: string;
  /** Plain-English truncation note (e.g. PDF page cap). */
  note?: string;
}

export interface FetchSnapshotOptions {
  /**
   * Fetch implementation override (tests). Defaults to undici's fetch — the
   * same engine behind the global — so the `dispatcher` option carrying the
   * DNS-rebinding pin is always honored.
   */
  fetchImpl?: typeof undiciFetch;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * DNS resolver seam. Defaults to the system resolver; tests inject a fake
   * so URL tests never touch public DNS.
   */
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}

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

function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`“${raw}” isn’t a valid web address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Knowledge links must start with http:// or https://.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('Links with a username or password in them can’t be saved to the library.');
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new Error('Only standard web ports (80 and 443) can be saved to the library.');
  }
  return url;
}

async function assertPublicHost(
  hostname: string,
  resolveAddresses: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  // An IP literal is its own address: validate it directly instead of trusting
  // a resolver to echo the literal back.
  if (isIP(hostname) !== 0) {
    if (!isPublicIpLiteral(hostname)) {
      throw privateHostError(hostname);
    }
    return [hostname];
  }
  let addresses: string[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch (error) {
    throw new Error(`Couldn’t look up “${hostname}” — check the address and try again.`, {
      cause: error,
    });
  }
  if (addresses.length === 0 || addresses.some(address => !isPublicIpLiteral(address))) {
    throw privateHostError(hostname);
  }
  return addresses;
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

function privateHostError(hostname: string): Error {
  return new Error(
    `“${hostname}” points at a private or internal address, so it can’t be saved to the library. Public web pages only.`,
  );
}

/**
 * Fetches a URL and snapshots its readable text. SSRF-guarded: every
 * redirect hop is re-resolved, every resolved address must be public
 * (fail-closed), and the connection is pinned to a validated address so DNS
 * rebinding between the check and the connect cannot redirect the fetch.
 * Redirects are capped and the body is byte-capped. HTML becomes text; a PDF
 * link is parsed as a PDF.
 */
export async function fetchUrlSnapshot(rawUrl: string, options?: FetchSnapshotOptions): Promise<UrlSnapshot> {
  const fetchImpl = options?.fetchImpl ?? undiciFetch;
  const timeoutMs = options?.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  const maxBytes = options?.maxBytes ?? MAX_URL_BYTES;
  const resolveAddresses = options?.resolveAddresses ?? defaultResolveAddresses;

  let current = assertFetchableUrl(rawUrl).toString();
  let response: Response | undefined;
  let responseDispatcher: Dispatcher | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = assertFetchableUrl(current);
    const validated = await assertPublicHost(url.hostname, resolveAddresses);
    const address = validated[0];
    if (address === undefined) {
      throw new Error(`Couldn’t resolve “${url.hostname}” to a usable address. Try again.`);
    }
    // Pin the connection to the validated address: the hostname still drives
    // TLS SNI and the Host header, but the TCP destination cannot move.
    const dispatcher = pinnedDispatcher(address);
    let fetched: Response;
    try {
      fetched = await fetchImpl(current, {
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: { 'user-agent': 'AmanuensisPersonaKnowledge/1.0 (+https://amanuensis.local)' },
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
    response = fetched;
    responseDispatcher = dispatcher;
    break;
  }
  if (response === undefined) {
    throw new Error(`“${rawUrl}” redirected too many times. Try the final page’s address instead.`);
  }
  try {
    if (!response.ok) {
      throw new Error(`The page returned “${String(response.status)}”. Only pages that load normally can be saved.`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const bytes = await readCappedBody(response, maxBytes);
    if (contentType === 'application/pdf') {
      const { text, note } = await extractPdfText(new Uint8Array(bytes));
      return { finalUrl: current, title: titleFromUrl(current), text, ...(note === undefined ? {} : { note }) };
    }
    if (contentType !== '' && !contentType.startsWith('text/')) {
      throw new Error(
        'Only web pages and PDFs can be saved from a link. Downloads like videos or archives aren’t supported.',
      );
    }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const snapshot = htmlToText(html);
    if (snapshot.text.length === 0) {
      throw new Error('No readable text was found on that page.');
    }
    return { finalUrl: current, title: snapshot.title || titleFromUrl(current), text: snapshot.text };
  } finally {
    // The body is fully consumed above; closing the pinned dispatcher releases
    // its sockets instead of leaving them for GC.
    await responseDispatcher?.close().catch(() => undefined);
    await response.arrayBuffer().catch(() => undefined);
  }
}

async function readCappedBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const body = response.body;
  if (body === null) {
    return new ArrayBuffer(0);
  }
  // Typed reader: the platform types leave ReadableStream unparameterized, so the
  // annotation pins the chunk type the way embeddingModel.ts does.
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(
        `That page is larger than ${String(maxBytes / 1024 / 1024)} MB, which is the current limit for one saved link.`,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last !== undefined && last !== '' ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// HTML → text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

const BLOCK_TAGS =
  'p|div|h1|h2|h3|h4|h5|h6|li|tr|td|th|section|article|header|footer|blockquote|pre|br|hr|table|ul|ol|dl|dt|dd|figure|figcaption|main|nav|aside';

/** Extracts the readable text of an HTML page: title plus body copy. Exported for tests. */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1] !== undefined ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  let body = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)[\s\S]*?<\/\1>/gi, ' ');
  body = body.replace(new RegExp(`<(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  body = body.replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
