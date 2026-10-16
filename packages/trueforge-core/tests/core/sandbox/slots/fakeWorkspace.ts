import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attestation, FakeAgent, type FakeHandler } from './fakeAgent';

const FsWriteBody = z.object({ path: z.string(), content_base64: z.string() });
const FsReadBody = z.object({ path: z.string() });
const ExecBody = z.object({ argv: z.array(z.string()) });

/** What a stand-in shell answers: the output, or the output of a command that failed. */
export type ShellAnswer = string | { exitCode: number; output: string };

function execReply(answer: ShellAnswer): ReturnType<FakeHandler> {
  const { exitCode, output } = typeof answer === 'string' ? { exitCode: 0, output: answer } : answer;
  return {
    status: 200,
    body: { exit_code: exitCode, output, terminated_by: 'completed', internal_error: '', duration_ms: 1 },
  };
}

/** The slot agent reads at most this much from an ordinary file; only the transfer directory may hold more. */
const AGENT_READ_CAP_BYTES = 10 * 1024 * 1024;
const TRANSFER_DIR = '/workspace/.aman/transfer/';

/**
 * A slot agent stand-in with an in-memory workspace: `fs_write` and `fs_read` keep bytes by path, and the few
 * shell commands the document pipeline sends are answered the way the guest's tools would. It proves the
 * protocol path (bytes travel to the slot, text comes back), not what poppler or tesseract would print.
 */
export function fakeWorkspaceAgent(
  pdfPages: readonly string[],
  answerShell: (command: string) => ShellAnswer | undefined = () => undefined,
  /** Makes every read return other bytes than were written. */
  corruptReads = false,
): { agent: FakeAgent; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();

  function runShell(command: string): ShellAnswer {
    const answered = answerShell(command);
    if (answered !== undefined) {
      return answered;
    }
    const realpath = /^realpath -e -- '([^']+)'$/.exec(command)?.[1];
    if (realpath !== undefined) {
      return `${realpath}\n`;
    }
    const snapshotMarker = /AMAN_DOCUMENT_SNAPSHOT_[0-9a-f]+/.exec(command)?.[0];
    if (snapshotMarker !== undefined) {
      const source = /exec 3<'([^']+)'/.exec(command)?.[1] ?? '';
      const target = /> '([^']+)'; source_hash_after/.exec(command)?.[1] ?? '';
      const bytes = files.get(source);
      if (bytes === undefined) {
        return `${snapshotMarker}:UNSAFE_PATH\n`;
      }
      files.set(target, bytes);
      return `${snapshotMarker}:OK:${String(bytes.length)}:${createHash('sha256').update(bytes).digest('hex')}\n`;
    }
    const textMarker = /AMAN_PDF_TEXT_[0-9a-f]+/.exec(command)?.[0];
    if (textMarker !== undefined) {
      const range = `1-${String(pdfPages.length)}`;
      return `${textMarker}:TOTAL:${String(pdfPages.length)}\n${textMarker}:RANGE:${range}\n${pdfPages.join('\x0C')}`;
    }
    return '';
  }

  const handler: FakeHandler = request => {
    if (request.path === '/v1/health') {
      return { status: 200, body: { busy: false, sessions: 0, attestation: attestation() } };
    }
    if (request.path === '/v1/fs_write') {
      const body = FsWriteBody.parse(request.body);
      files.set(body.path, Buffer.from(body.content_base64, 'base64'));
      return { status: 204, body: undefined };
    }
    if (request.path === '/v1/fs_read') {
      const readPath = FsReadBody.parse(request.body).path;
      const stored = files.get(readPath);
      if (stored !== undefined && stored.length > AGENT_READ_CAP_BYTES && !readPath.startsWith(TRANSFER_DIR)) {
        return {
          status: 400,
          body: { error: { code: 'invalid_request', message: 'tree: file is larger than the read cap' } },
        };
      }
      return stored === undefined
        ? { status: 404, body: { error: { code: 'not_found', message: 'no such file' } } }
        : {
            status: 200,
            body: {
              content_base64: (corruptReads ? Buffer.concat([stored, Buffer.from('x')]) : stored).toString('base64'),
              size_bytes: stored.length,
            },
          };
    }
    if (request.path === '/v1/destroy_session') {
      return { status: 204, body: undefined };
    }
    if (request.path === '/v1/exec') {
      return execReply(runShell(ExecBody.parse(request.body).argv[2] ?? ''));
    }
    return { status: 404, body: { error: { code: 'not_found', message: request.path } } };
  };

  return { agent: new FakeAgent(handler), files };
}
