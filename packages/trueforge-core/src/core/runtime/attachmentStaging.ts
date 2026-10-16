import { createHash } from 'node:crypto';
import {
  MAX_BYTES_PER_DOCUMENT,
  MAX_DOCUMENT_FILES,
  MAX_TOTAL_DOCUMENT_BYTES,
} from '../../documents/documentExtraction';
import { InvalidFileInputError } from '../errors';
import type { Sandbox, SandboxInfo } from '../sandbox/Sandbox';

const MAX_FILENAME_BYTES = 180;
/** Controls (C0, DEL, C1), line and paragraph separators, bidi marks and overrides, and angle brackets: none belong in a name the model or a person reads. */
const UNSAFE_NAME_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]/gu;
const MAX_EXTENSION_BYTES = 16;
const FALLBACK_FILENAME = 'attachment';

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

/** Rejects, rather than repairs, a file name a person or client sent as-is. */
export function validatePublicFilename(filename: string): void {
  if (!filename.length) {
    throw new InvalidFileInputError('File name must not be empty');
  }
  if (Buffer.byteLength(filename, 'utf8') > MAX_FILENAME_BYTES) {
    throw new InvalidFileInputError(`File name must be ${String(MAX_FILENAME_BYTES)} UTF-8 bytes or fewer`);
  }
  if (containsControlCharacter(filename)) {
    throw new InvalidFileInputError('File name contains control characters');
  }
  if (filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    throw new InvalidFileInputError(`File name contains path traversal: ${filename}`);
  }
}

function truncateToBytes(value: string, maxBytes: number): string {
  let bytes = 0;
  let kept = '';
  for (const character of value) {
    bytes += Buffer.byteLength(character, 'utf8');
    if (bytes > maxBytes) {
      break;
    }
    kept += character;
  }
  return kept;
}

/**
 * Repairs a name the sender chose (an email attachment): keeps the last path segment, replaces unsafe
 * characters, and shortens it to the limit while keeping a short extension. A name that is empty or only
 * dots becomes `attachment`.
 */
function sanitizeAttachmentName(raw: string): string {
  const lastSegment = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = lastSegment.replace(UNSAFE_NAME_CHARACTERS, '_');
  if (cleaned.trim() === '' || /^\.+$/.test(cleaned)) {
    return FALLBACK_FILENAME;
  }
  if (Buffer.byteLength(cleaned, 'utf8') <= MAX_FILENAME_BYTES) {
    return cleaned;
  }
  const dot = cleaned.lastIndexOf('.');
  const extension =
    dot > 0 && Buffer.byteLength(cleaned.slice(dot), 'utf8') <= MAX_EXTENSION_BYTES ? cleaned.slice(dot) : '';
  const stem = truncateToBytes(
    cleaned.slice(0, cleaned.length - extension.length),
    MAX_FILENAME_BYTES - Buffer.byteLength(extension, 'utf8'),
  );
  return `${stem}${extension}`;
}

/** The workspace name of a staged file: ordinal and content digest keep two files with one name apart. */
function stagedFilename(filename: string, content: Buffer, ordinal: number): string {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 32);
  return `attachment-${String(ordinal).padStart(2, '0')}-${digest}-${filename}`;
}

/** The caps every source of attachments shares: how many files one message may carry, and their total size. */
export function assertAttachmentBatch(sizes: readonly number[]): void {
  if (sizes.length > MAX_DOCUMENT_FILES) {
    throw new InvalidFileInputError(`Message exceeds the ${String(MAX_DOCUMENT_FILES)} attachment limit`);
  }
  if (sizes.reduce((total, size) => total + size, 0) > MAX_TOTAL_DOCUMENT_BYTES) {
    throw new InvalidFileInputError(
      `Attachments exceed the ${String(MAX_TOTAL_DOCUMENT_BYTES)} byte cumulative upload limit`,
    );
  }
}

export interface StagedAttachment {
  /** The sanitized name the person and the model see. */
  filename: string;
  /** The name in the workspace and under /ingress. */
  stagedName: string;
  /** Absolute in-sandbox path, readable with the file tools and `extract_document_text`. */
  path: string;
  mime: string;
  size: number;
  /** Set when staging had to create the turn's sandbox. */
  sandboxCreated: SandboxInfo | undefined;
}

// Consumed by chat uploads and, from their own branches, the email connector and the demo inbox.
/** Places a file's bytes in the turn's sandbox workspace under a sanitized name and returns its in-sandbox path. */
export async function stageAttachment({
  sandbox,
  filename,
  bytes,
  mime,
  ordinal,
}: {
  sandbox: Pick<Sandbox, 'uploadUserFile'>;
  filename: string;
  bytes: Buffer;
  mime: string;
  ordinal: number;
}): Promise<StagedAttachment> {
  if (bytes.length === 0) {
    throw new InvalidFileInputError('The file is empty');
  }
  if (bytes.length > MAX_BYTES_PER_DOCUMENT) {
    throw new InvalidFileInputError(`File exceeds the ${String(MAX_BYTES_PER_DOCUMENT)} byte upload limit`);
  }
  const safeName = sanitizeAttachmentName(filename);
  const stagedName = stagedFilename(safeName, bytes, ordinal);
  const stored = await sandbox.uploadUserFile({ fileName: stagedName, content: bytes, mime });
  return {
    filename: safeName,
    stagedName,
    path: stored.filePath,
    mime,
    size: bytes.length,
    sandboxCreated: stored.sandboxCreated,
  };
}
