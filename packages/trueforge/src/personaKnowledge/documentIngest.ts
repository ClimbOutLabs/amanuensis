import { extractRawText } from 'mammoth';
import { inflateRawSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { fetch as undiciFetch } from 'undici';

import { fetchPublicUrl, type PublicFetchProblem } from '../runtime/publicFetch';

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
 *
 * The checked layout must be the only one the zip reader can see: it finds
 * records by searching backwards for their signatures and re-bases every offset
 * when the central directory does not end at the end record. So the file must
 * be entries from byte 0, then the central directory, optional zip64 records,
 * the end record and its comment, with no entry ranges that overlap.
 * Returns null when the structure is anything else; the caller refuses the file
 * rather than handing it to the zip reader unchecked.
 */
function docxInflatedBytes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIG = 0x0605_4b50;
  const CDH_SIG = 0x0201_4b50;
  const LOCAL_SIG = 0x0403_4b50;
  const ZIP64_LOCATOR_SIG = 0x0706_4b50;
  const ZIP64_EOCD_SIG = 0x0606_4b50;
  const SENTINEL_16 = 0xffff;
  const SENTINEL = 0xffff_ffff;
  const ZIP64_EOCD_BYTES = 56;
  const ZIP64_LOCATOR_BYTES = 20;
  // Same search the zip reader runs: the last occurrence anywhere in the file.
  const lastIndexOf = (signature: number): number => {
    for (let i = bytes.byteLength - 4; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === signature) {
        return i;
      }
    }
    return -1;
  };
  const eocdOffset = lastIndexOf(EOCD_SIG);
  if (eocdOffset < 0 || eocdOffset + 22 > bytes.byteLength) {
    return null;
  }
  if (eocdOffset + 22 + view.getUint16(eocdOffset + 20, true) !== bytes.byteLength) {
    return null;
  }
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const directoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entries16 = view.getUint16(eocdOffset + 10, true);
  const size32 = view.getUint32(eocdOffset + 12, true);
  const offset32 = view.getUint32(eocdOffset + 16, true);
  // The zip reader switches to zip64 when any of these holds its sentinel.
  const isZip64 =
    [diskNumber, directoryDisk, entriesOnDisk, entries16].includes(SENTINEL_16) ||
    size32 === SENTINEL ||
    offset32 === SENTINEL;
  let cdEntries: bigint;
  let cdSize: bigint;
  let cdStart: bigint;
  let cdEnd: number;
  if (isZip64) {
    const locatorOffset = eocdOffset - ZIP64_LOCATOR_BYTES;
    const zoff = locatorOffset - ZIP64_EOCD_BYTES;
    if (zoff < 0 || lastIndexOf(ZIP64_LOCATOR_SIG) !== locatorOffset) {
      return null;
    }
    if (
      view.getUint32(locatorOffset + 4, true) !== 0 ||
      view.getBigUint64(locatorOffset + 8, true) !== BigInt(zoff) ||
      view.getUint32(locatorOffset + 16, true) > 1 ||
      view.getUint32(zoff, true) !== ZIP64_EOCD_SIG ||
      view.getBigUint64(zoff + 4, true) !== BigInt(ZIP64_EOCD_BYTES - 12) ||
      view.getUint32(zoff + 16, true) !== 0 ||
      view.getUint32(zoff + 20, true) !== 0 ||
      view.getBigUint64(zoff + 24, true) !== view.getBigUint64(zoff + 32, true)
    ) {
      return null;
    }
    cdEntries = view.getBigUint64(zoff + 32, true);
    cdSize = view.getBigUint64(zoff + 40, true);
    cdStart = view.getBigUint64(zoff + 48, true);
    cdEnd = zoff;
  } else {
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entries16) {
      return null;
    }
    cdEntries = BigInt(entries16);
    cdSize = BigInt(size32);
    cdStart = BigInt(offset32);
    cdEnd = eocdOffset;
  }
  if (cdStart + cdSize !== BigInt(cdEnd) || cdEntries === BigInt(0)) {
    return null;
  }
  const directoryStart = Number(cdStart);
  const checked: { method: number; start: number; dataStart: number; dataEnd: number }[] = [];
  let declared = 0;
  let offset = directoryStart;
  for (let n = BigInt(0); n < cdEntries; n += BigInt(1)) {
    if (offset + 46 > cdEnd || view.getUint32(offset, true) !== CDH_SIG) {
      return null;
    }
    const method = view.getUint16(offset + 10, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const entryEnd = offset + 46 + nameLen + extraLen + view.getUint16(offset + 32, true);
    if (entryEnd > cdEnd) {
      return null;
    }
    const zip64 = readZip64Extra({ view, offset: offset + 46 + nameLen, length: extraLen });
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
    if (localOffset + BigInt(30) > cdStart) {
      return null;
    }
    const local = Number(localOffset);
    if (view.getUint32(local, true) !== LOCAL_SIG) {
      return null;
    }
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (BigInt(dataStart) + compressedSize > cdStart) {
      return null;
    }
    checked.push({ method, start: local, dataStart, dataEnd: dataStart + Number(compressedSize) });
    offset = entryEnd;
  }
  if (offset !== cdEnd) {
    return null;
  }
  // Entries start at byte 0 and never share bytes: shared data would be
  // inflated once per entry, and leading bytes are what the reader re-bases over.
  const ordered = [...checked].sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const [index, entry] of ordered.entries()) {
    if (index === 0 ? entry.start !== 0 : entry.start < previousEnd) {
      return null;
    }
    previousEnd = entry.dataEnd;
  }
  let total = 0;
  for (const entry of checked) {
    const data = bytes.subarray(entry.dataStart, entry.dataEnd);
    if (entry.method === 0) {
      total += data.byteLength;
    } else if (entry.method === 8) {
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
  }
  return Math.max(declared, total);
}

/**
 * The 64-bit values of the zip64 extra field (id 0x0001), in record order.
 * Empty when the entry has no such field; null when the extra block is
 * malformed or repeats the field, since readers disagree on which copy wins.
 */
function readZip64Extra({ view, offset, length }: { view: DataView; offset: number; length: number }): bigint[] | null {
  const ZIP64_EXTRA_ID = 0x0001;
  const end = offset + length;
  let values: bigint[] | undefined;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) {
      return null;
    }
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (cursor + 4 + size > end) {
      return null;
    }
    if (id === ZIP64_EXTRA_ID) {
      if (values !== undefined) {
        return null;
      }
      values = [];
      for (let at = cursor + 4; at + 8 <= cursor + 4 + size; at += 8) {
        values.push(view.getBigUint64(at, true));
      }
    }
    cursor += 4 + size;
  }
  return values ?? [];
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

/** Library wording for each reason a link cannot be fetched. */
function describeFetchProblem(problem: PublicFetchProblem): string {
  switch (problem.kind) {
    case 'invalid_url':
      return `“${problem.url}” isn’t a valid web address.`;
    case 'scheme':
      return 'Knowledge links must start with http:// or https://.';
    case 'credentials':
      return 'Links with a username or password in them can’t be saved to the library.';
    case 'port':
      return 'Only standard web ports (80 and 443) can be saved to the library.';
    case 'private_host':
      return `“${problem.hostname}” points at a private or internal address, so it can’t be saved to the library. Public web pages only.`;
    case 'lookup_failed':
      return `Couldn’t look up “${problem.hostname}” — check the address and try again.`;
    case 'unresolved':
      return `Couldn’t resolve “${problem.hostname}” to a usable address. Try again.`;
    case 'refused_hop':
    case 'too_many_redirects':
      return 'That link redirected too many times. Try the final page’s address instead.';
  }
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
  const maxBytes = options?.maxBytes ?? MAX_URL_BYTES;
  const { response, finalUrl, release } = await fetchPublicUrl(rawUrl, {
    fetchImpl: options?.fetchImpl,
    resolveAddresses: options?.resolveAddresses,
    timeoutMs: options?.timeoutMs ?? URL_FETCH_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    headers: { 'user-agent': 'AmanuensisPersonaKnowledge/1.0 (+https://amanuensis.local)' },
    allowHop: undefined,
    describe: describeFetchProblem,
  });
  try {
    if (!response.ok) {
      throw new Error(`The page returned “${String(response.status)}”. Only pages that load normally can be saved.`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const bytes = await readCappedBody(response, maxBytes);
    if (contentType === 'application/pdf') {
      const { text, note } = await extractPdfText(new Uint8Array(bytes));
      return { finalUrl, title: titleFromUrl(finalUrl), text, ...(note === undefined ? {} : { note }) };
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
    return { finalUrl, title: snapshot.title || titleFromUrl(finalUrl), text: snapshot.text };
  } finally {
    // Closing the pinned dispatcher releases its sockets instead of leaving them for GC.
    await release();
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
