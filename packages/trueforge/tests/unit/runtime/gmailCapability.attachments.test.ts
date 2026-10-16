import type { SandboxInfo } from '@truefoundry/trueforge-core/core';
import { sandboxAttachmentStager } from '../../../src/runtime/gmailCapability';

const PDF_BYTES = Buffer.from('%PDF-1.4 synthetic');
const CREATED: SandboxInfo = { sandbox_id: 'sb-1' };

function recordingSandbox(options: { created?: SandboxInfo } = {}) {
  const uploads: { fileName: string; content: Buffer; mime: string }[] = [];
  const sandbox = {
    uploadUserFile: (input: { fileName: string; content: Buffer; mime: string }) => {
      uploads.push(input);
      return Promise.resolve({
        filePath: `/workspace/.aman/uploads/${input.fileName}`,
        sandboxCreated: options.created,
      });
    },
  };
  return { sandbox, uploads };
}

describe('sandboxAttachmentStager', () => {
  it('is absent without a sandbox, so the attachment tool is not offered', () => {
    expect(sandboxAttachmentStager(undefined)).toBeUndefined();
  });

  it('places the bytes in the turn sandbox under a sanitized, numbered name and returns the path', async () => {
    const { sandbox, uploads } = recordingSandbox();
    const stager = sandboxAttachmentStager(sandbox);
    const staged = await stager?.stageAttachment({
      filename: '../../etc/invoice‮fdp.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      ordinal: 3,
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.content).toEqual(PDF_BYTES);
    expect(uploads[0]?.fileName).toMatch(/^attachment-03-[0-9a-f]{32}-invoice_fdp\.pdf$/);
    expect(staged).toEqual({
      filename: 'invoice_fdp.pdf',
      path: `/workspace/.aman/uploads/${uploads[0]?.fileName ?? ''}`,
      sandboxCreated: undefined,
    });
  });

  it('reports a sandbox that staging created', async () => {
    const stager = sandboxAttachmentStager(recordingSandbox({ created: CREATED }).sandbox);
    const staged = await stager?.stageAttachment({
      filename: 'a.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      ordinal: 1,
    });
    expect(staged?.sandboxCreated).toEqual(CREATED);
  });

  it('keeps the size cap of the shared helper: an oversized or empty file writes nothing', async () => {
    const { sandbox, uploads } = recordingSandbox();
    const stager = sandboxAttachmentStager(sandbox);
    await expect(
      stager?.stageAttachment({
        filename: 'big.pdf',
        bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
        mime: 'application/pdf',
        ordinal: 1,
      }),
    ).rejects.toThrow('upload limit');
    await expect(
      stager?.stageAttachment({ filename: 'empty.pdf', bytes: Buffer.alloc(0), mime: 'application/pdf', ordinal: 2 }),
    ).rejects.toThrow('The file is empty');
    expect(uploads).toEqual([]);
  });
});
