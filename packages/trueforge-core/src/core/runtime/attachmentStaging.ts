import { createHash } from 'node:crypto';
import { MAX_BYTES_PER_DOCUMENT } from '../../documents/documentExtraction';
import { InvalidFileInputError } from '../errors';
import type { Sandbox, SandboxInfo } from '../sandbox/Sandbox';

const MAX_FILENAME_BYTES = 180;
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
 * Repairs a name the sender chose (an email attachment): keeps the last path segment, replaces control
 * characters, and shortens it to the limit while keeping a short extension. A name that is empty or only
 * dots becomes `attachment`.
 */
function sanitizeAttachmentName(raw: string): string {
  const lastSegment = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = Array.from(lastSegment, character => (containsControlCharacter(character) ? '_' : character)).join(
    '',
  );
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

/**
 * The one way a file the server holds (a chat upload, an email attachment) gets into the turn's sandbox
 * workspace: sanitized name, size cap, bytes written through the sandbox provider (the slot agent's
 * `fs_write` on slots, so the slot never fetches anything), and the file offered to `run_code` as /ingress.
 * Read it afterwards with `extractDocumentsFromSandbox` or `run_code`; rejects with the provider's message
 * when no sandbox is available.
 */
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
