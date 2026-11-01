import { randomBytes } from 'node:crypto';
import type { Logger } from 'winston';
import { shellEscape } from '../provider/Provider';
import { SlotSandboxProvider } from './SlotSandboxProvider';

/** What the document pipeline runs in the guest; a slot image built before attachments were supported lacks them. */
const GUEST_DOCUMENT_TOOLS = ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] as const;
/** Marks the lines of the probe command's output that name something missing; every other line is ignored. */
const MISSING_MARKER = 'AMAN_MISSING:';
/** Cleanup gets its own short allowance so a probe that timed out can still remove its throwaway workspace. */
const CLEANUP_TIMEOUT_MS = 5_000;

export type SlotAttachmentProbeResult =
  /** A file went in and came back, and the guest has the PDF, Word and OCR tools. */
  | { state: 'ready' }
  /** The probe ran out of time, for example because every slot was busy; nothing is known to be wrong. */
  | { state: 'busy' }
  | { state: 'not_ready'; problem: 'sandbox_unavailable' | 'file_not_sent' | 'file_changed' | 'tools_missing' };

function missingToolsCommand(ocrLanguages: readonly string[]): string {
  const tools = GUEST_DOCUMENT_TOOLS.map(
    tool => `command -v ${tool} >/dev/null || echo ${shellEscape(`${MISSING_MARKER}${tool}`)}`,
  );
  const languages = ocrLanguages.map(
    language =>
      `printf '%s\\n' "$languages" | grep -qx -- ${shellEscape(language)} || echo ${shellEscape(`${MISSING_MARKER}tesseract-${language}`)}`,
  );
  const wordReader = `python3 -I -c 'import docx, lxml' >/dev/null 2>&1 || echo ${shellEscape(`${MISSING_MARKER}python-docx`)}`;
  return [...tools, wordReader, 'languages=$(tesseract --list-langs 2>/dev/null || true)', ...languages].join('; ');
}

/**
 * Sends a few bytes into a throwaway workspace on an attested slot, reads them back, and asks the guest for
 * the PDF tools and the OCR languages: the path every attachment takes into the sandbox, without touching a
 * user's files.
 */
export async function probeSlotAttachments({
  socketPaths,
  logger,
  signal,
  treeDiskMb,
  ocrLanguages,
}: {
  socketPaths: readonly string[];
  logger: Logger;
  signal: AbortSignal;
  /** The server's real per-chat quota, which decides whether a slot counts as full. */
  treeDiskMb: number;
  ocrLanguages: readonly string[];
}): Promise<SlotAttachmentProbeResult> {
  const provider = new SlotSandboxProvider({
    socketPaths,
    defaultExecTimeoutSeconds: 30,
    treeDiskMb,
    fileMaxBytesForDownload: 1024,
    logger,
    sleepMs: undefined,
    gitBridge: undefined,
  });
  // A call cut short by the probe's own time limit says nothing about the sandbox's health.
  const unavailable = (): SlotAttachmentProbeResult =>
    signal.aborted ? { state: 'busy' } : { state: 'not_ready', problem: 'sandbox_unavailable' };
  let sandboxId: string;
  try {
    ({ sandboxId } = await provider.createSandbox({ signal }));
  } catch {
    return unavailable();
  }
  try {
    const path = `${provider.getFileUploadsDir()}/doctor-${randomBytes(8).toString('hex')}.txt`;
    const bytes = randomBytes(16);
    try {
      await provider.uploadFile({ sandboxId, remotePath: path, content: bytes, signal });
    } catch {
      return signal.aborted ? { state: 'busy' } : { state: 'not_ready', problem: 'file_not_sent' };
    }
    let echoed: Buffer;
    try {
      echoed = await provider.downloadFile({ sandboxId, path, signal });
    } catch {
      return signal.aborted ? { state: 'busy' } : { state: 'not_ready', problem: 'file_not_sent' };
    }
    if (!echoed.equals(bytes)) {
      return { state: 'not_ready', problem: 'file_changed' };
    }
    const tools = await provider.exec({ sandboxId, command: missingToolsCommand(ocrLanguages), signal });
    if (!tools.success) {
      return unavailable();
    }
    const missing = tools.response.result.split('\n').filter(line => line.startsWith(MISSING_MARKER));
    return missing.length > 0 ? { state: 'not_ready', problem: 'tools_missing' } : { state: 'ready' };
  } catch {
    return unavailable();
  } finally {
    try {
      await provider.destroySandbox({ sandboxId, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) });
    } catch (error) {
      logger.warn('Could not remove the attachment probe workspace', { error: String(error) });
    }
  }
}
