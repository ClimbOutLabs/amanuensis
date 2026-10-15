import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attestation, FakeAgent, type FakeHandler } from './fakeAgent';

const FsWriteBody = z.object({ path: z.string(), content_base64: z.string() });
const FsReadBody = z.object({ path: z.string() });
const ExecBody = z.object({ argv: z.array(z.string()) });

function execReply(output: string): ReturnType<FakeHandler> {
  return {
    status: 200,
    body: { exit_code: 0, output, terminated_by: 'completed', internal_error: '', duration_ms: 1 },
  };
}

/**
 * A slot agent stand-in with an in-memory workspace: `fs_write` and `fs_read` keep bytes by path, and the few
 * shell commands the document pipeline sends are answered the way the guest's tools would. It proves the
 * protocol path (bytes travel to the slot, text comes back), not what poppler or tesseract would print.
 */
export function fakeWorkspaceAgent(
  pdfPages: readonly string[],
  answerShell: (command: string) => string | undefined = () => undefined,
): { agent: FakeAgent; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();

  function runShell(command: string): string {
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
      const stored = files.get(FsReadBody.parse(request.body).path);
      return stored === undefined
        ? { status: 404, body: { error: { code: 'not_found', message: 'no such file' } } }
        : { status: 200, body: { content_base64: stored.toString('base64'), size_bytes: stored.length } };
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
