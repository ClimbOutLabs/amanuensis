import { extractRawText } from 'mammoth';
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
 * 500k chars, but mammoth inflates the whole archive first — so the
 * uncompressed size is checked up front via the zip central directory.
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
 * Sums the uncompressed size of every entry from the zip central directory.
 * Returns null when the archive isn't a parseable zip (mammoth reports that).
 *
 * Zip64 is parsed for real, not skipped: a zip64 end-of-central-directory
 * stores 0xFFFF/0xFFFFFFFF sentinels in the 32-bit fields, and treating those
 * as "unparseable" would fail open while the zip reader parses the archive
 * just fine. Any malformed structure still returns null — the zip reader
 * trips over the same bytes and rejects the file.
 */
function docxUncompressedBytes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD_SIG = 0x0605_4b50;
  const CDH_SIG = 0x0201_4b50;
  const ZIP64_LOCATOR_SIG = 0x0706_4b50;
  const ZIP64_EOCD_SIG = 0x0606_4b50;
  const ZIP64_EXTRA_ID = 0x0001;
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
  if (cdEntries === BigInt(0xffff) || cdOffset === 0xffff_ffff) {
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
  let total = 0;
  let offset = cdOffset;
  for (let n = BigInt(0); n < cdEntries; n += BigInt(1)) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CDH_SIG) {
      return null;
    }
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    let entrySize = view.getUint32(offset + 24, true);
    if (entrySize === 0xffff_ffff) {
      // Zip64 entry: the true 64-bit size is the first field of the zip64
      // extra record (it is only present when the 32-bit field is the
      // sentinel, and uncompressed size is first in the field order).
      const extraOffset = offset + 46 + nameLen;
      const size64 = readZip64ExtraSize(view, bytes.byteLength, extraOffset, extraLen, ZIP64_EXTRA_ID);
      if (size64 === null || size64 > BigInt(MAX_DOCX_UNCOMPRESSED_BYTES)) {
        return MAX_DOCX_UNCOMPRESSED_BYTES + 1;
      }
      entrySize = Number(size64);
    }
    total += entrySize;
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
      return total;
    }
    offset += 46 + nameLen + extraLen + view.getUint16(offset + 32, true);
  }
  return total;
}

/**
 * Reads the uncompressed size (first uint64) of the zip64 extra field with
 * the given id. Returns null when the extra block is absent or malformed.
 */
function readZip64ExtraSize(
  view: DataView,
  byteLength: number,
  extraOffset: number,
  extraLen: number,
  extraId: number,
): bigint | null {
  let cursor = extraOffset;
  const end = extraOffset + extraLen;
  if (end > byteLength || cursor < 0) {
    return null;
  }
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (id === extraId) {
      if (size < 8 || cursor + 4 + 8 > end || cursor + 4 + 8 > byteLength) {
        return null;
      }
      return view.getBigUint64(cursor + 4, true);
    }
    cursor += 4 + size;
  }
  return null;
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const uncompressed = docxUncompressedBytes(bytes);
  if (uncompressed !== null && uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
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
