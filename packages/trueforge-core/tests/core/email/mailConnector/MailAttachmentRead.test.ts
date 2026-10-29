import { MailAttachmentProcessor } from '../../../../src/core/email/mailConnector/MailAttachmentProcessor';
import type { DocumentScope } from '../../../../src/core/llm/LLMTypes';
import type { ToolCallResult } from '../../../../src/core/mcp/executeToolCalls';
import { classifyTier, type SentinelAction } from '../../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../../src/core/permissions/context';
import { createWebSearchTurnState } from '../../../../src/core/permissions/webSearch';
import { getEmptyCurrentContextUsage } from '../../../../src/core/runtime/contextUsage';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../../src/documents/toolContract';
import { makeMockIMCPServer, makeStubPublicSandbox } from '../../harnessMocks';

const UPLOADS_DIR = '/workspace/.aman/uploads';
const SCOPE: DocumentScope = {
  staged_uploads_dir: UPLOADS_DIR,
  workspace_cwd: null,
  path_resolution: 'remote',
};
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Runs the processor on one get_attachment_content result and returns the path the model is told to read. */
async function stagedPathFor(filename: string): Promise<string> {
  const sandbox = makeStubPublicSandbox();
  jest
    .spyOn(sandbox, 'uploadUserFile')
    .mockImplementation(input => Promise.resolve({ filePath: `${UPLOADS_DIR}/${input.fileName}` }));
  const raw = JSON.stringify([
    {
      type: 'resource',
      resource: {
        uri: 'email-attachment://content/x',
        mimeType: DOCX_MIME,
        blob: Buffer.from('docx bytes').toString('base64'),
      },
      _meta: { filename },
    },
  ]);
  const result: ToolCallResult = {
    message: { role: 'tool', tool_call_id: 'call-1', content: raw },
    images: [],
    rawContent: raw,
    toolCallInfo: undefined,
    screen: undefined,
    info: {
      toolSet: makeMockIMCPServer({ name: 'Email', preload: true }),
      originalToolName: 'get_attachment_content',
    },
    failure: false,
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
  await new MailAttachmentProcessor().process([result], {
    threadId: 'main',
    signal: undefined,
    sandbox,
    currentContextUsage: getEmptyCurrentContextUsage(),
    context: [],
  });
  const content = result.message.content;
  const parsed: unknown = JSON.parse(typeof content === 'string' ? content : '');
  if (typeof parsed !== 'object' || parsed === null || !('path' in parsed) || typeof parsed.path !== 'string') {
    throw new Error('The processor did not return a path');
  }
  return parsed.path;
}

function readAction(filePaths: string[]): SentinelAction {
  return {
    tool_name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
    canonical_params: { file_paths: filePaths },
    tool_type: 'truefoundry-system',
    mcp_server_name: 'documents',
    mcp_hints: { read_only_hint: true, destructive_hint: false, open_world_hint: false },
    document_scope: SCOPE,
  };
}

function classify(filePaths: string[]) {
  return classifyTier(readAction(filePaths), {
    services: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    tenant_id: 't1',
    created_by: 'u1',
    conversation_id: 'c1',
    repository_id: null,
    workspace_cwd: null,
    agent_intent: null,
    web_search: createWebSearchTurnState(),
    path_resolution: 'remote',
  });
}

describe('reading a staged Email attachment', () => {
  it('reads a staged attachment without a card', async () => {
    const path = await stagedPathFor('Old Lisbon photo walks - draft itinerary.docx');
    expect(path.startsWith(`${UPLOADS_DIR}/`)).toBe(true);
    const decision = await classify([path]);
    expect(decision).toMatchObject({ tier: 1, reason: 'document_read', card: null, approval_token_id: null });
  });

  it('still asks before reading a file outside the workspace that was not staged', async () => {
    const decision = await classify(['/home/someone/aviso-de-reparacao.docx']);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('document_outside_workspace');
    expect(decision.card?.plain_what).toContain('outside the project folder');
  });

  it('still asks when the model passes only the attachment file name', async () => {
    const decision = await classify(['invite.ics']);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('document_outside_workspace');
  });

  it('keeps a path-traversal attachment name inside the staging folder', async () => {
    const path = await stagedPathFor('../../etc/passwd.docx');
    expect(path.startsWith(`${UPLOADS_DIR}/attachment-01-`)).toBe(true);
    expect(path).not.toContain('..');
    expect(path.slice(UPLOADS_DIR.length + 1)).not.toContain('/');
    const decision = await classify([path]);
    expect(decision).toMatchObject({ tier: 1, reason: 'document_read' });
  });

  it('does not let a traversal path through the staging folder count as staged', async () => {
    const decision = await classify([`${UPLOADS_DIR}/../../../etc/passwd.docx`]);
    expect(decision.tier).toBe(3);
    expect(decision.reason).toBe('document_outside_workspace');
  });
});
