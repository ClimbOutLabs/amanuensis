import { randomBytes } from 'node:crypto';
import type { Logger } from 'winston';
import { SLOT_FIX_COMMAND } from './SlotDriver';
import { SlotSandboxProvider } from './SlotSandboxProvider';

/** What the document pipeline runs in the guest; a slot image built before attachments were supported lacks them. */
const GUEST_DOCUMENT_TOOLS = ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] as const;

export type SlotAttachmentProbeResult = { ready: true } | { ready: false; error: string };

/**
 * Sends a few bytes into a throwaway workspace on an attested slot, reads them back, and asks the guest for
 * the PDF and OCR tools: the path every attachment takes into the sandbox, without touching a user's files.
 */
export async function probeSlotAttachments({
  socketPaths,
  logger,
  signal,
}: {
  socketPaths: readonly string[];
  logger: Logger;
  signal: AbortSignal;
}): Promise<SlotAttachmentProbeResult> {
  const provider = new SlotSandboxProvider({
    socketPaths,
    defaultExecTimeoutSeconds: 30,
    treeDiskMb: 64,
    fileMaxBytesForDownload: 1024,
    logger,
    sleepMs: undefined,
    gitBridge: undefined,
  });
  let sandboxId: string;
  try {
    ({ sandboxId } = await provider.createSandbox({ signal }));
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const path = `${provider.getFileUploadsDir()}/doctor-${randomBytes(8).toString('hex')}.txt`;
    const bytes = randomBytes(16);
    await provider.uploadFile({ sandboxId, remotePath: path, content: bytes, signal });
    const echoed = await provider.downloadFile({ sandboxId, path, signal });
    if (!echoed.equals(bytes)) {
      return { ready: false, error: 'A file sent into the sandbox did not come back the same.' };
    }
    const tools = await provider.exec({
      sandboxId,
      command: GUEST_DOCUMENT_TOOLS.map(tool => `command -v ${tool} >/dev/null || echo ${tool}`).join('; '),
      signal,
    });
    if (!tools.success) {
      return { ready: false, error: tools.error };
    }
    const missing = tools.response.result.split('\n').filter(line => line.trim() !== '');
    if (missing.length > 0) {
      return {
        ready: false,
        error: `The sandbox image cannot read PDFs and images yet (missing ${missing.join(', ')}). Run \`${SLOT_FIX_COMMAND}\` to rebuild it.`,
      };
    }
    return { ready: true };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await provider.destroySandbox({ sandboxId });
    } catch (error) {
      logger.warn('Could not remove the attachment probe workspace', { error: String(error) });
    }
  }
}
