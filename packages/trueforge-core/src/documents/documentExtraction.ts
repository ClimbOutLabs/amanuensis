import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { extensionMatchesImage, inspectImageHeader, looksLikePdf, MAX_OCR_PIXELS } from './fileSniff';

const OCR_IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);

/** True for the PDF and raster-image extensions this module can extract text from. */
export function isSupportedDocumentExtension(filename: string): boolean {
  const extension = extname(filename).toLowerCase();
  return extension === '.pdf' || OCR_IMAGE_EXTENSIONS.has(extension);
}

/** Single source of truth for the unsupported-type issue text used within this module. */
function unsupportedDocumentTypeIssue(filename: string): string {
  const extension = extname(filename).toLowerCase();
  // F2: office documents fail loudly with a way forward, not a dead end.
  if (OFFICE_DOCUMENT_EXTENSIONS.has(extension)) {
    return (
      `I can't read ${filename} yet: ${extension} files are not supported. ` +
      `Convert it to PDF and I'll read all of it.`
    );
  }
  return `Unsupported document type for ${filename}; expected PDF or a raster image.`;
}

const OFFICE_DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf']);

export const MAX_DOCUMENT_FILES = 32;
export const MAX_BYTES_PER_DOCUMENT = 25 * 1024 * 1024;
export const MAX_TOTAL_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_PAGES_PER_DOCUMENT = 100;
export const MAX_TOTAL_DOCUMENT_PAGES = 300;
export const MAX_CHARS_PER_DOCUMENT = 200_000;
/** Scanned pages read per call; a long scan continues from the page the result names, so one call cannot hold a sandbox for minutes. */
export const MAX_OCR_PAGES_PER_CALL = 20;
/** Languages Tesseract reads when none are configured; the sandbox image ships exactly these. */
export const DEFAULT_OCR_LANGUAGES = 'eng hin mar';
export const MAX_TOTAL_DOCUMENT_CHARS = 1_000_000;

export type DocumentExtractionMode = 'text' | 'ocr' | 'mixed';

export interface DocumentTextLine {
  line_number: number;
  text: string;
}

export interface ExtractedDocumentPage {
  page_number: number;
  extraction_mode: 'text' | 'ocr';
  lines: DocumentTextLine[];
}

export interface DocumentSource {
  filename: string;
  path: string;
  sha256: string;
  page: number;
  line: number;
  start: number;
  end: number;
  span_text: string;
  extraction_mode: DocumentExtractionMode;
}

export interface ExtractedDocument {
  filename: string;
  path: string;
  sha256: string;
  extraction_mode: DocumentExtractionMode | null;
  pages: ExtractedDocumentPage[];
  issue: string | null;
}

export interface DocumentExtraction {
  documents: ExtractedDocument[];
}

/**
 * Per-file lifecycle notification from {@link extractDocumentText}'s sequential loop, so a caller
 * (upload-time ingestion; see `ingestUploadedDocuments` in UserInputMessage.ts) can surface progress
 * while a large batch is still running instead of only after it completes. `started` fires as each
 * file's own extraction begins (download-from-sandbox through OCR); `finished` or `failed` fires once
 * its result is known, based on whether any page text was recovered. A signal abort mid-batch is
 * folded into `failed` here (the thrown AbortError is caught per file, same as any other extraction
 * error); the caller distinguishes a genuine cancellation (files never reached, no `started` emitted)
 * on its own.
 */
export type DocumentFileProgress =
  | { phase: 'started'; filename: string; path: string }
  | { phase: 'finished' | 'failed'; filename: string; path: string; elapsedMs: number; document: ExtractedDocument };

export interface DocumentInputFile {
  filename: string;
  path: string;
}

export interface DocumentOcrPage {
  page_number: number;
  text: string;
}

/** Why an image must not go to OCR, judged from its header bytes alone; undefined when it may. */
function imageProblem(bytes: Buffer, extension: string): string | undefined {
  const header = inspectImageHeader(bytes);
  if (header === null || !extensionMatchesImage({ extension, format: header.format })) {
    return 'is not a valid image of the type its name says, so it cannot be read.';
  }
  if (header.width * header.height > MAX_OCR_PIXELS) {
    return `is too large to read (${String(header.width)} by ${String(header.height)} pixels). Shrink it and try again.`;
  }
  return undefined;
}

function linesFromText(text: string): DocumentTextLine[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line, index) => ({ line_number: index + 1, text: line.trimEnd() }))
    .filter(line => line.text.trim().length > 0);
}

function issueMessage(error: unknown, filename: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/not found|enoent|cannot find/i.test(detail)) {
    return `No extractable text in ${filename}; local OCR requires pinned pdftoppm and tesseract in the sandbox image.`;
  }
  return `Could not extract ${filename}: ${detail}`;
}

function sourceHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function appendIssue(current: string | null, addition: string): string {
  return current === null ? addition : `${current} ${addition}`;
}

/**
 * Why page bounding stopped. `per_document_limit` (the per-call page/char
 * caps) is continuable with a fresh page_start; `aggregate_exhausted` (the
 * shared batch/session budgets) is a dead end: re-running cannot show more.
 */
type BoundStopReason = 'complete' | 'per_document_limit' | 'aggregate_exhausted';

function pageCharacterCount(page: ExtractedDocumentPage): number {
  return page.lines.reduce((sum, line) => sum + line.text.length, 0);
}

function boundDocument(
  document: ExtractedDocument,
  remainingPages: number,
  remainingCharacters: number,
): { document: ExtractedDocument; pages: number; characters: number; stopReason: BoundStopReason } {
  // Pages are emitted atomically: a page is shown whole or not at all, so a
  // page_start continuation can never skip unseen text mid-page.
  const pageCap = Math.min(MAX_PAGES_PER_DOCUMENT, remainingPages);
  const boundedPages: ExtractedDocumentPage[] = [];
  let characters = 0;
  let stopReason: BoundStopReason = 'complete';
  let midPageTruncated = false;
  for (const page of document.pages) {
    if (boundedPages.length >= pageCap) {
      stopReason = remainingPages < MAX_PAGES_PER_DOCUMENT ? 'aggregate_exhausted' : 'per_document_limit';
      break;
    }
    const pageChars = pageCharacterCount(page);
    const documentCharsLeft = MAX_CHARS_PER_DOCUMENT - characters;
    const aggregateCharsLeft = remainingCharacters - characters;
    if (pageChars <= documentCharsLeft && pageChars <= aggregateCharsLeft) {
      boundedPages.push(page);
      characters += pageChars;
      continue;
    }
    if (boundedPages.length === 0 && pageChars > documentCharsLeft && pageChars <= aggregateCharsLeft) {
      // Pathological single huge page: show its head, say so explicitly, and
      // let the caller continue after it. Re-reading the page would hit the
      // same per-document cap, so no continuation is named for its tail.
      const lines: DocumentTextLine[] = [];
      let shown = 0;
      for (const line of page.lines) {
        if (shown >= documentCharsLeft) {
          break;
        }
        const text = line.text.slice(0, documentCharsLeft - shown);
        shown += text.length;
        if (text.trim().length > 0) {
          lines.push({ ...line, text });
        }
      }
      boundedPages.push({ ...page, lines });
      characters += shown;
      midPageTruncated = true;
      stopReason = 'per_document_limit';
      break;
    }
    // Stop before the page that does not fit: the next page_start resumes
    // exactly here, with no unseen text skipped.
    stopReason = pageChars > aggregateCharsLeft ? 'aggregate_exhausted' : 'per_document_limit';
    break;
  }
  let issue = document.issue;
  if (stopReason === 'per_document_limit') {
    issue = appendIssue(
      issue,
      midPageTruncated
        ? 'One page exceeded the per-document character limit; only its head is shown.'
        : 'Extraction hit the per-document page/character limit.',
    );
  } else if (stopReason === 'aggregate_exhausted') {
    issue = appendIssue(issue, 'Extraction stopped: the aggregate page/character budget is exhausted.');
  }
  return {
    document: { ...document, pages: boundedPages, issue },
    pages: boundedPages.length,
    characters,
    stopReason,
  };
}

export function sourceForLine(input: {
  document: ExtractedDocument;
  page: number;
  line: number;
  start: number | undefined;
  end: number | undefined;
}): DocumentSource | null {
  const page = input.document.pages.find(candidate => candidate.page_number === input.page);
  const line = page?.lines.find(candidate => candidate.line_number === input.line);
  if (!page || !line) {
    return null;
  }
  const start = input.start ?? 0;
  const end = input.end ?? line.text.length;
  if (start < 0 || end < start || end > line.text.length) {
    return null;
  }
  return {
    filename: input.document.filename,
    path: input.document.path,
    sha256: input.document.sha256,
    page: input.page,
    line: input.line,
    start,
    end,
    span_text: line.text.slice(start, end),
    extraction_mode: linePageMode(input.document, input.page),
  };
}

function linePageMode(document: ExtractedDocument, pageNumber: number): 'text' | 'ocr' {
  return document.pages.find(page => page.page_number === pageNumber)?.extraction_mode ?? 'text';
}

/**
 * Aggregate caps carried across a sequence of extractDocumentText calls so a per-file
 * driver (see `AgentThread.extractStagedDocuments`) can extract one file at a time — yielding a
 * live progress event around each call — while the same byte/page/character/file-count ceilings
 * that a single batched call enforces internally still hold across the whole batch. Passed in and
 * mutated in place; omit it (or call createDocumentExtractionBudget once per batch) for a
 * single all-files-at-once call, which is unaffected because it never persists the object.
 */
export interface DocumentExtractionBudget {
  totalBytes: number;
  /** Snapshot/download ceiling this budget enforces (per-call or session scale). */
  maxTotalBytes: number;
  pageBudgetRemaining: number;
  remainingPages: number;
  remainingCharacters: number;
  /** File-count ceiling this budget enforces (per-call or session scale). */
  maxFiles: number;
  filesProcessed: number;
  /**
   * 'call': a fresh budget per extractDocumentText call, so a document cut by
   * the aggregate can be continued with a fresh call. 'session': shared across
   * tool calls, so an exhausted aggregate is a dead end.
   */
  scope: 'call' | 'session';
}

export function createDocumentExtractionBudget(): DocumentExtractionBudget {
  return {
    totalBytes: 0,
    maxTotalBytes: MAX_TOTAL_DOCUMENT_BYTES,
    pageBudgetRemaining: MAX_TOTAL_DOCUMENT_PAGES,
    remainingPages: MAX_TOTAL_DOCUMENT_PAGES,
    remainingCharacters: MAX_TOTAL_DOCUMENT_CHARS,
    maxFiles: MAX_DOCUMENT_FILES,
    filesProcessed: 0,
    scope: 'call',
  };
}

/**
 * Session-scale budget for the `extract_document_text` tool path: the same
 * aggregate caps, scaled up, carried across every tool call in the session.
 * Repeated page-range reads of one long document stay possible, while a
 * runaway loop still hits a ceiling. Not a cache: every call re-extracts.
 */
export const SESSION_BUDGET_SCALE = 10;

export function createSessionDocumentExtractionBudget(): DocumentExtractionBudget {
  const perCall = createDocumentExtractionBudget();
  return {
    ...perCall,
    maxTotalBytes: perCall.maxTotalBytes * SESSION_BUDGET_SCALE,
    pageBudgetRemaining: perCall.pageBudgetRemaining * SESSION_BUDGET_SCALE,
    remainingPages: perCall.remainingPages * SESSION_BUDGET_SCALE,
    remainingCharacters: perCall.remainingCharacters * SESSION_BUDGET_SCALE,
    maxFiles: perCall.maxFiles * SESSION_BUDGET_SCALE,
    scope: 'session',
  };
}

/**
 * Resolved page range for a PDF extraction. Both bounds are required here;
 * the tool schema resolves omitted ends before calling.
 */
export interface DocumentPageRange {
  page_start: number;
  page_end: number;
}

export async function extractDocumentText(input: {
  files: readonly DocumentInputFile[];
  downloadFile: (path: string) => Promise<Buffer>;
  runOcr: (input: {
    filename: string;
    filePath: string;
    kind: 'pdf' | 'image';
    pages: readonly number[] | undefined;
    maxPages: number;
  }) => Promise<DocumentOcrPage[]>;
  runNativePdfText: (input: { filePath: string; firstPage: number; maxPages: number }) => Promise<{
    total_pages: number;
    pages: DocumentOcrPage[];
  }>;
  /** File-progress callback. Absent when the caller does not need progress events. */
  onFileProgress: ((progress: DocumentFileProgress) => void) | undefined;
  /**
   * Aggregate budget threaded across calls. Defaults to a fresh single-call
   * budget when absent.
   */
  budget: DocumentExtractionBudget | undefined;
  /**
   * Page range for PDF extraction (1-based, inclusive). Native PDF text starts
   * at page_start instead of re-scanning from page 1; the caller pages
   * forward with page_start set to the previous last page + 1. Absent means
   * the default first window.
   */
  pageRange: DocumentPageRange | undefined;
}): Promise<DocumentExtraction> {
  const budget = input.budget ?? createDocumentExtractionBudget();
  const documents: ExtractedDocument[] = [];
  let totalBytes = budget.totalBytes;
  let pageBudgetRemaining = budget.pageBudgetRemaining;
  const reservePages = (requested: number): number => {
    const reserved = Math.min(requested, pageBudgetRemaining);
    pageBudgetRemaining -= reserved;
    return reserved;
  };
  const pushDocument = (document: ExtractedDocument, startedAt: number): void => {
    documents.push(document);
    input.onFileProgress?.({
      phase: document.pages.length > 0 ? 'finished' : 'failed',
      filename: document.filename,
      path: document.path,
      elapsedMs: Date.now() - startedAt,
      document,
    });
  };
  const pendingRangeInfo: ({ start: number; total: number } | undefined)[] = [];
  for (const file of input.files) {
    if (budget.filesProcessed >= budget.maxFiles) {
      documents.push({
        ...file,
        sha256: '',
        extraction_mode: null,
        pages: [],
        issue: `Skipped ${file.filename}: maximum of ${String(budget.maxFiles)} documents per operation.`,
      });
      pendingRangeInfo.push(undefined);
      continue;
    }
    budget.filesProcessed += 1;
    const fileStartedAt = Date.now();
    input.onFileProgress?.({ phase: 'started', filename: file.filename, path: file.path });
    let buffer: Buffer;
    try {
      buffer = await input.downloadFile(file.path);
    } catch (error) {
      pushDocument(
        {
          filename: file.filename,
          path: file.path,
          sha256: '',
          extraction_mode: null,
          pages: [],
          issue: `Could not read ${file.filename}: ${error instanceof Error ? error.message : String(error)}`,
        },
        fileStartedAt,
      );
      pendingRangeInfo.push(undefined);
      continue;
    }

    const sha256 = sourceHash(buffer);
    if (buffer.length > MAX_BYTES_PER_DOCUMENT || totalBytes + buffer.length > budget.maxTotalBytes) {
      pushDocument(
        {
          ...file,
          sha256,
          extraction_mode: null,
          pages: [],
          issue: `Skipped ${file.filename}: document byte limit exceeded.`,
        },
        fileStartedAt,
      );
      pendingRangeInfo.push(undefined);
      continue;
    }
    totalBytes += buffer.length;
    const extension = extname(file.filename).toLowerCase();
    // Continuation metadata for the post-bounding pass: lets the final issue
    // name the exact next page range from the pages actually shown.
    let rangeInfo: { start: number; total: number } | undefined;
    try {
      if (extension === '.pdf' && !looksLikePdf(buffer)) {
        pushDocument(
          {
            ...file,
            sha256,
            extraction_mode: null,
            pages: [],
            issue: `${file.filename} is not a valid PDF, so it cannot be read.`,
          },
          fileStartedAt,
        );
      } else if (extension === '.pdf') {
        // The requested range, resolved: page_start defaults to 1, page_end
        // defaults to a full window past page_start. The schema caps the
        // width at MAX_PAGES_PER_DOCUMENT.
        const rangeStart = input.pageRange?.page_start ?? 1;
        const rangeEnd = input.pageRange?.page_end ?? rangeStart + MAX_PAGES_PER_DOCUMENT - 1;
        const rangeWidth = Math.max(0, rangeEnd - rangeStart + 1);
        const adapterMaxPages = Math.min(rangeWidth, pageBudgetRemaining);
        if (adapterMaxPages === 0) {
          pushDocument(
            {
              ...file,
              sha256,
              extraction_mode: null,
              pages: [],
              issue: 'Extraction skipped because the total page budget was exhausted.',
            },
            fileStartedAt,
          );
          // No continue: falls through to pendingRangeInfo.push below so every
          // pushed document gets exactly one range record.
        } else {
          const nativeResult = await input.runNativePdfText({
            filePath: file.path,
            firstPage: rangeStart,
            maxPages: adapterMaxPages,
          });
          if (rangeStart > nativeResult.total_pages) {
            pushDocument(
              {
                ...file,
                sha256,
                extraction_mode: null,
                pages: [],
                issue:
                  `page_start ${String(rangeStart)} is beyond the end of ${file.filename} ` +
                  `(${String(nativeResult.total_pages)} pages).`,
              },
              fileStartedAt,
            );
            // No continue: falls through to pendingRangeInfo.push below.
          } else {
            rangeInfo = { start: rangeStart, total: nativeResult.total_pages };
            const lastPageInRange = Math.min(rangeStart + adapterMaxPages - 1, rangeEnd, nativeResult.total_pages);
            const pagesInRange = Math.max(0, lastPageInRange - rangeStart + 1);
            const pagesAllowed = reservePages(pagesInRange);
            const nativeByPage = new Map(nativeResult.pages.map(page => [page.page_number, page]));
            // Page numbers are absolute: a range read never re-processes the
            // pages before it.
            const nativePages = Array.from({ length: pagesAllowed }, (_, index): ExtractedDocumentPage => {
              const page_number = rangeStart + index;
              const nativePage = nativeByPage.get(page_number);
              return {
                page_number,
                extraction_mode: 'text',
                lines: nativePage ? linesFromText(nativePage.text) : [],
              };
            });
            if (nativePages.every(page => page.lines.length > 0)) {
              const pages = nativePages;
              pushDocument(
                {
                  ...file,
                  sha256,
                  extraction_mode: 'text',
                  pages,
                  issue: null,
                },
                fileStartedAt,
              );
            } else {
              const scannedPages = nativePages.filter(page => page.lines.length === 0).map(page => page.page_number);
              const emptyPages = scannedPages.slice(0, MAX_OCR_PAGES_PER_CALL);
              const unreadScanned = scannedPages.slice(MAX_OCR_PAGES_PER_CALL);
              const ocrPages =
                emptyPages.length > 0
                  ? await input.runOcr({
                      filename: file.filename,
                      filePath: file.path,
                      kind: 'pdf',
                      pages: emptyPages,
                      maxPages: pagesAllowed,
                    })
                  : [];
              const ocrByPage = new Map(ocrPages.map(page => [page.page_number, page]));
              const pages = nativePages.map((page): ExtractedDocumentPage => {
                if (page.lines.length > 0) {
                  return page;
                }
                const ocrPage = ocrByPage.get(page.page_number);
                return ocrPage
                  ? { page_number: page.page_number, extraction_mode: 'ocr', lines: linesFromText(ocrPage.text) }
                  : page;
              });
              const unresolved = pages.filter(page => page.lines.length === 0).map(page => page.page_number);
              pushDocument(
                {
                  ...file,
                  sha256,
                  extraction_mode: 'mixed',
                  pages,
                  issue:
                    unreadScanned.length > 0
                      ? `OCR read the first ${String(MAX_OCR_PAGES_PER_CALL)} scanned pages; for the rest call extract_document_text with page_start=${String(unreadScanned[0])}.`
                      : unresolved.length > 0
                        ? `OCR did not resolve page(s): ${unresolved.join(', ')}.`
                        : null,
                },
                fileStartedAt,
              );
            }
          }
        }
      } else if (OCR_IMAGE_EXTENSIONS.has(extension)) {
        const problem = imageProblem(buffer, extension);
        if (input.pageRange !== undefined) {
          pushDocument(
            {
              ...file,
              sha256,
              extraction_mode: null,
              pages: [],
              issue: `page_start/page_end apply to PDF files only; ${file.filename} is not a PDF.`,
            },
            fileStartedAt,
          );
          rangeInfo = undefined;
          // No continue: falls through to pendingRangeInfo.push below.
        } else if (problem !== undefined) {
          pushDocument(
            {
              ...file,
              sha256,
              extraction_mode: null,
              pages: [],
              issue: `${file.filename} ${problem}`,
            },
            fileStartedAt,
          );
          rangeInfo = undefined;
        } else {
          const pagesAllowed = reservePages(1);
          const ocrPages =
            pagesAllowed > 0
              ? await input.runOcr({
                  filename: file.filename,
                  filePath: file.path,
                  kind: 'image',
                  pages: undefined,
                  maxPages: pagesAllowed,
                })
              : [];
          pushDocument(
            {
              ...file,
              sha256,
              extraction_mode: 'ocr',
              pages: ocrPages.slice(0, pagesAllowed).map(page => ({
                page_number: page.page_number,
                extraction_mode: 'ocr',
                lines: linesFromText(page.text),
              })),
              issue: pagesAllowed === 0 ? 'Extraction truncated at the total page budget.' : null,
            },
            fileStartedAt,
          );
          rangeInfo = undefined;
        }
      } else {
        pushDocument(
          {
            ...file,
            sha256,
            extraction_mode: null,
            pages: [],
            issue: unsupportedDocumentTypeIssue(file.filename),
          },
          fileStartedAt,
        );
        rangeInfo = undefined;
      }
    } catch (error) {
      pushDocument(
        {
          ...file,
          sha256,
          extraction_mode: isSupportedDocumentExtension(file.filename) ? 'ocr' : null,
          pages: [],
          issue: issueMessage(error, file.filename),
        },
        fileStartedAt,
      );
      rangeInfo = undefined;
    }
    pendingRangeInfo.push(rangeInfo);
  }
  let remainingPages = budget.remainingPages;
  let remainingCharacters = budget.remainingCharacters;
  const boundedDocuments = documents.map((document, index) => {
    const bounded = boundDocument(document, remainingPages, remainingCharacters);
    remainingPages -= bounded.pages;
    remainingCharacters -= bounded.characters;
    const info = pendingRangeInfo[index];
    if (info !== undefined) {
      const shown = bounded.document.pages;
      const lastShown = shown.length > 0 ? (shown[shown.length - 1]?.page_number ?? info.start) : info.start - 1;
      const hasMore = lastShown < info.total;
      // A session budget is shared across tool calls: once depleted, no
      // re-read can show more. A per-call budget renews every call, so a cut
      // document always has a valid page_start continuation.
      const aggregateDeadEnd =
        hasMore && budget.scope === 'session' && (remainingPages <= 0 || remainingCharacters <= 0);
      if (shown.length === 0) {
        // Budget messaging only when bounding actually cut pages: an empty
        // document from a failed extraction already carries its own issue.
        if (bounded.stopReason !== 'complete') {
          bounded.document.issue = appendIssue(
            bounded.document.issue,
            aggregateDeadEnd
              ? 'The aggregate page/character budget is exhausted; re-running cannot show more of this document.'
              : `No pages could be shown within this call's remaining budget. ` +
                  `Call extract_document_text again with page_start=${String(info.start)}.`,
          );
        }
      } else if (hasMore) {
        if (aggregateDeadEnd) {
          bounded.document.issue = appendIssue(
            bounded.document.issue,
            'The aggregate page/character budget is exhausted; re-running cannot show more of this document.',
          );
        } else {
          // F4: bounding is page-atomic, so every shown page is complete and
          // the next range starts exactly after the last shown page.
          const firstShown = shown[0]?.page_number ?? info.start;
          const limitNote =
            bounded.stopReason === 'per_document_limit'
              ? ' (this read hit the per-document limit)'
              : bounded.stopReason === 'aggregate_exhausted'
                ? ' (this read hit the aggregate budget; a fresh call continues with what remains)'
                : '';
          bounded.document.issue = appendIssue(
            bounded.document.issue,
            `Read pages ${String(firstShown)}-${String(lastShown)} of ${String(info.total)} total${limitNote}. ` +
              `For the next pages, call extract_document_text with page_start=${String(lastShown + 1)}.`,
          );
        }
      }
    }
    return bounded.document;
  });
  budget.totalBytes = totalBytes;
  budget.pageBudgetRemaining = pageBudgetRemaining;
  budget.remainingPages = remainingPages;
  budget.remainingCharacters = remainingCharacters;
  return { documents: boundedDocuments };
}
