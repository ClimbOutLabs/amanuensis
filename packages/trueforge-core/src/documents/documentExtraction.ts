import { createHash } from 'node:crypto';
import { extname } from 'node:path';

const OCR_IMAGE_EXTENSIONS = new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp']);

/** True for the PDF and raster-image extensions this module can extract text from. */
export function isSupportedDocumentExtension(filename: string): boolean {
  const extension = extname(filename).toLowerCase();
  return extension === '.pdf' || OCR_IMAGE_EXTENSIONS.has(extension);
}

/** Single source of truth for the unsupported-type issue text used within this module. */
function unsupportedDocumentTypeIssue(filename: string): string {
  return `Unsupported document type for ${filename}; expected PDF or a raster image.`;
}

export const MAX_DOCUMENT_FILES = 32;
export const MAX_BYTES_PER_DOCUMENT = 25 * 1024 * 1024;
export const MAX_TOTAL_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_PAGES_PER_DOCUMENT = 100;
export const MAX_TOTAL_DOCUMENT_PAGES = 300;
export const MAX_CHARS_PER_DOCUMENT = 200_000;
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

function boundDocument(
  document: ExtractedDocument,
  remainingPages: number,
  remainingCharacters: number,
): { document: ExtractedDocument; pages: number; characters: number } {
  let pages = 0;
  let characters = 0;
  let truncated = false;
  const boundedPages = document.pages.slice(0, Math.min(MAX_PAGES_PER_DOCUMENT, remainingPages)).map(page => {
    pages += 1;
    const lines = page.lines
      .map(line => {
        const remaining = Math.min(MAX_CHARS_PER_DOCUMENT - characters, remainingCharacters - characters);
        if (remaining < line.text.length) {
          truncated = true;
        }
        const text = line.text.slice(0, Math.max(0, remaining));
        characters += text.length;
        return { ...line, text };
      })
      .filter(line => line.text.trim().length > 0);
    return { ...page, lines };
  });
  if (document.pages.length > boundedPages.length) {
    truncated = true;
  }
  return {
    document: {
      ...document,
      pages: boundedPages,
      issue: truncated
        ? appendIssue(document.issue, 'Extraction was truncated by the page/character limit.')
        : document.issue,
    },
    pages,
    characters,
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
 * Aggregate caps carried across a sequence of {@link extractDocumentText} calls so a per-file
 * driver (see `AgentThread.extractStagedDocuments`) can extract one file at a time — yielding a
 * live progress event around each call — while the same byte/page/character/file-count ceilings
 * that a single batched call enforces internally still hold across the whole batch. Passed in and
 * mutated in place; omit it (or call {@link createDocumentExtractionBudget} once per batch) for a
 * single all-files-at-once call, which is unaffected because it never persists the object.
 */
export interface DocumentExtractionBudget {
  totalBytes: number;
  pageBudgetRemaining: number;
  remainingPages: number;
  remainingCharacters: number;
  filesProcessed: number;
}

export function createDocumentExtractionBudget(): DocumentExtractionBudget {
  return {
    totalBytes: 0,
    pageBudgetRemaining: MAX_TOTAL_DOCUMENT_PAGES,
    remainingPages: MAX_TOTAL_DOCUMENT_PAGES,
    remainingCharacters: MAX_TOTAL_DOCUMENT_CHARS,
    filesProcessed: 0,
  };
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
  runNativePdfText: (input: { filePath: string; maxPages: number }) => Promise<{
    total_pages: number;
    pages: DocumentOcrPage[];
  }>;
  /** See {@link DocumentFileProgress}. Optional: existing callers (tool-path re-extraction) pass none. */
  onFileProgress?: (progress: DocumentFileProgress) => void;
  /** See {@link DocumentExtractionBudget}. Defaults to a fresh, single-call budget. */
  budget?: DocumentExtractionBudget;
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
  for (const file of input.files) {
    if (budget.filesProcessed >= MAX_DOCUMENT_FILES) {
      documents.push({
        ...file,
        sha256: '',
        extraction_mode: null,
        pages: [],
        issue: `Skipped ${file.filename}: maximum of ${String(MAX_DOCUMENT_FILES)} documents per operation.`,
      });
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
      continue;
    }

    const sha256 = sourceHash(buffer);
    if (buffer.length > MAX_BYTES_PER_DOCUMENT || totalBytes + buffer.length > MAX_TOTAL_DOCUMENT_BYTES) {
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
      continue;
    }
    totalBytes += buffer.length;
    const extension = extname(file.filename).toLowerCase();
    try {
      if (extension === '.pdf') {
        const nativeMaxPages = Math.min(MAX_PAGES_PER_DOCUMENT, pageBudgetRemaining);
        if (nativeMaxPages === 0) {
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
          continue;
        }
        const nativeResult = await input.runNativePdfText({ filePath: file.path, maxPages: nativeMaxPages });
        const pagesAllowed = reservePages(Math.min(nativeResult.total_pages, MAX_PAGES_PER_DOCUMENT));
        const nativeByPage = new Map(nativeResult.pages.map(page => [page.page_number, page]));
        const nativePages = Array.from({ length: pagesAllowed }, (_, index): ExtractedDocumentPage => {
          const page_number = index + 1;
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
              issue: pages.length < nativeResult.total_pages ? 'Extraction truncated at the page budget.' : null,
            },
            fileStartedAt,
          );
        } else {
          const emptyPages = nativePages
            .filter(page => page.lines.length === 0)
            .map(page => page.page_number)
            .slice(0, MAX_PAGES_PER_DOCUMENT);
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
                unresolved.length > 0 || pages.length < nativeResult.total_pages
                  ? `${unresolved.length > 0 ? `OCR did not resolve page(s): ${unresolved.join(', ')}.` : ''}${pages.length < nativeResult.total_pages ? ' Extraction truncated at the page budget.' : ''}`.trim()
                  : null,
            },
            fileStartedAt,
          );
        }
      } else if (OCR_IMAGE_EXTENSIONS.has(extension)) {
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
    }
  }
  let remainingPages = budget.remainingPages;
  let remainingCharacters = budget.remainingCharacters;
  const boundedDocuments = documents.map(document => {
    const bounded = boundDocument(document, remainingPages, remainingCharacters);
    remainingPages -= bounded.pages;
    remainingCharacters -= bounded.characters;
    return bounded.document;
  });
  budget.totalBytes = totalBytes;
  budget.pageBudgetRemaining = pageBudgetRemaining;
  budget.remainingPages = remainingPages;
  budget.remainingCharacters = remainingCharacters;
  return { documents: boundedDocuments };
}
