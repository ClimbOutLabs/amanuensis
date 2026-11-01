import { MailAttachmentProcessor } from '../../../../src/core/email/mailConnector/MailAttachmentProcessor';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { makeMockIMCPServer, makeStubPublicSandbox } from '../../harnessMocks';

const BASE64_BYTES = Buffer.from('%PDF-1.4 scanned lease').toString('base64');

/** The sidecar's embedded file block, as the MCP result is stringified before the processor sees it. */
function attachmentRaw(blob: string): string {
  return JSON.stringify([
    {
      type: 'resource',
      resource: { uri: 'email-attachment://content/x', mimeType: 'application/pdf', blob },
      _meta: { filename: 'lease.pdf', size: 24 },
    },
  ]);
}

function makeResult(input: {
  serverName: string;
  toolName: string;
  rawContent: string;
  failure?: boolean;
}): ToolCallResult {
  const toolSet = makeMockIMCPServer({ name: input.serverName, preload: true });
  return {
    message: { role: 'tool', tool_call_id: 'call-1', content: input.rawContent },
    images: [],
    rawContent: input.rawContent,
    toolCallInfo: undefined,
    screen: undefined,
    info: { toolSet, originalToolName: input.toolName },
    failure: input.failure ?? false,
    isStructuredContent: false,
    completedAt: '2026-10-21T00:00:00.000Z',
    memoized: false,
    repeatCount: 1,
    blockedPrivateFallback: false,
    repeatedSideEffect: false,
    verificationReceiptCandidate: undefined,
    disposition: 'executed_ok',
    remediation: undefined,
    admissionProvenance: { source: 'automatic' },
  };
}

const SANDBOX_OFF = {
  threadId: 'main',
  signal: undefined,
  sandbox: undefined,
  currentContextUsage: getEmptyCurrentContextUsage(),
  context: [],
};

describe('MailAttachmentProcessor', () => {
  it('with no sandbox, the base64 bytes never reach the model text', async () => {
    const result = makeResult({
      serverName: 'Email',
      toolName: 'get_attachment_content',
      rawContent: attachmentRaw(BASE64_BYTES),
    });
    const outcome = await new MailAttachmentProcessor().process([result], SANDBOX_OFF);
    expect(outcome).toEqual({});
    expect(result.message.content).toBe('Attachments cannot be opened in this chat because the sandbox is off.');
    expect(result.message.content).not.toContain(BASE64_BYTES);
    expect(result.outputTransform).toBe('replaced');
  });

  it('with a sandbox, the bytes are staged as a file and the model reads only its path and the untrusted notice', async () => {
    const sandbox = makeStubPublicSandbox();
    const upload = jest
      .spyOn(sandbox, 'uploadUserFile')
      .mockImplementation(input => Promise.resolve({ filePath: `/tmp/uploads/${input.fileName}` }));
    const result = makeResult({
      serverName: 'Email',
      toolName: 'get_attachment_content',
      rawContent: attachmentRaw(BASE64_BYTES),
    });
    await new MailAttachmentProcessor().process([result], { ...SANDBOX_OFF, sandbox });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0].content).toEqual(Buffer.from('%PDF-1.4 scanned lease'));
    expect(result.message.content).toContain('/tmp/uploads/');
    expect(result.message.content).toContain('untrusted data');
    expect(result.message.content).not.toContain(BASE64_BYTES);
    expect(result.message.content).toContain(
      'The file is in the sandbox workspace at this path. To read it, call extract_document_text with this path.',
    );
    expect(result.message.content).not.toContain('read it with the document tools');
  });

  it('leaves the raw provider output intact for output screening', async () => {
    const raw = attachmentRaw(BASE64_BYTES);
    const result = makeResult({ serverName: 'Email', toolName: 'get_attachment_content', rawContent: raw });
    await new MailAttachmentProcessor().process([result], SANDBOX_OFF);
    expect(result.rawContent).toBe(raw);
  });

  it('ignores the same tool on another connector', async () => {
    const raw = attachmentRaw(BASE64_BYTES);
    const result = makeResult({ serverName: 'other', toolName: 'get_attachment_content', rawContent: raw });
    await new MailAttachmentProcessor().process([result], SANDBOX_OFF);
    expect(result.message.content).toBe(raw);
    expect(result.outputTransform).toBeUndefined();
  });

  it('ignores other Email tools and failed calls', async () => {
    const raw = attachmentRaw(BASE64_BYTES);
    const other = makeResult({ serverName: 'Email', toolName: 'get_emails_content', rawContent: raw });
    const failed = makeResult({
      serverName: 'Email',
      toolName: 'get_attachment_content',
      rawContent: raw,
      failure: true,
    });
    await new MailAttachmentProcessor().process([other, failed], SANDBOX_OFF);
    expect(other.message.content).toBe(raw);
    expect(failed.message.content).toBe(raw);
  });

  it('ignores a result that carries no attachment block', async () => {
    const result = makeResult({ serverName: 'Email', toolName: 'get_attachment_content', rawContent: 'not json' });
    await new MailAttachmentProcessor().process([result], SANDBOX_OFF);
    expect(result.message.content).toBe('not json');
  });
});
