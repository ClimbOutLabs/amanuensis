import { DocumentTools } from '../../../../src/core/capabilities/builtins/DocumentTools';
import type { CallToolResponse } from '../../../../src/core/mcp/IMCPServer';
import { stageAttachment } from '../../../../src/core/runtime/attachmentStaging';
import { Sandbox, type BoundRepository } from '../../../../src/core/sandbox/Sandbox';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { MAX_BYTES_PER_DOCUMENT, type DocumentExtraction } from '../../../../src/documents/documentExtraction';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../../src/documents/toolContract';
import { syntheticPdf } from '../../documents/syntheticFiles';
import { makeSilentLogger } from '../../harnessMocks';
import type { FakeAgent } from '../../sandbox/slots/fakeAgent';
import { fakeWorkspaceAgent } from '../../sandbox/slots/fakeWorkspace';

const BOUND_REPOSITORY: BoundRepository = {
  repository_id: 'repo-1',
  revision: 1,
  workspace_cwd: '/workspace',
  commands: [],
};

const PAGE_TEXT = 'Workspace total: 4,200';

function resultText(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected a tool result, got an approval request');
  }
  return response.result.content.map(block => (block.type === 'text' ? block.text : '')).join('');
}

function resultError(response: CallToolResponse): boolean {
  if (!('result' in response)) {
    throw new Error('expected a tool result, got an approval request');
  }
  return response.result.isError ?? false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The extraction shape the bridge tests read: each document's name, path, issue and page line text. */
function isDocumentExtraction(value: unknown): value is DocumentExtraction {
  if (!isRecord(value)) {
    return false;
  }
  const documents: unknown = value['documents'];
  if (!Array.isArray(documents)) {
    return false;
  }
  return documents.every((document: unknown) => {
    if (!isRecord(document)) {
      return false;
    }
    const issue: unknown = document['issue'];
    const pages: unknown = document['pages'];
    if (typeof document['filename'] !== 'string' || typeof document['path'] !== 'string') {
      return false;
    }
    if (issue !== null && typeof issue !== 'string') {
      return false;
    }
    if (!Array.isArray(pages)) {
      return false;
    }
    return pages.every((page: unknown) => {
      if (!isRecord(page)) {
        return false;
      }
      const lines: unknown = page['lines'];
      if (!Array.isArray(lines)) {
        return false;
      }
      return lines.every((line: unknown) => isRecord(line) && typeof line['text'] === 'string');
    });
  });
}

function extractionOf(response: CallToolResponse): DocumentExtraction {
  const parsed: unknown = JSON.parse(resultText(response));
  if (!isDocumentExtraction(parsed)) {
    throw new Error('expected a document extraction result');
  }
  return parsed;
}

describe('the document staging bridge', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function makeTools(): Promise<{ tools: DocumentTools; sandbox: Sandbox; files: Map<string, Buffer> }> {
    const workspace = fakeWorkspaceAgent([PAGE_TEXT]);
    agent = workspace.agent;
    const sandbox = new Sandbox({
      provider: new SlotSandboxProvider({
        socketPaths: [await agent.start()],
        defaultExecTimeoutSeconds: 30,
        treeDiskMb: 100,
        fileMaxBytesForDownload: MAX_BYTES_PER_DOCUMENT,
        logger: makeSilentLogger(),
        sleepMs: undefined,
        gitBridge: undefined,
      }),
      boundRepository: BOUND_REPOSITORY,
      workspaceVerificationCoordinator: undefined,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    return {
      tools: new DocumentTools({
        sandbox,
        tracing: NOOP_AGENT_TRACING,
        logger: makeSilentLogger(),
        boundRepository: BOUND_REPOSITORY,
      }),
      sandbox,
      files: workspace.files,
    };
  }

  function stagedCopies(files: Map<string, Buffer>): string[] {
    return [...files.keys()].filter(path => path.startsWith('/workspace/.aman/uploads/attachment-'));
  }

  it('extracts a workspace PDF end to end through a staged copy, leaving the original untouched', async () => {
    const { tools, files } = await makeTools();
    const pdf = syntheticPdf();
    files.set('/workspace/report.pdf', pdf);

    const info = await tools.toolCallInfo({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/report.pdf'] },
    });
    expect(info.document_scope).toEqual({
      staged_uploads_dir: '/workspace/.aman/uploads',
      workspace_cwd: '/workspace',
      path_resolution: 'remote',
    });
    expect(info.path_resolution).toBe('remote');

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/report.pdf'] },
    });
    expect(resultError(response)).toBe(false);
    const document = extractionOf(response).documents[0];
    expect(document?.filename).toBe('report.pdf');
    expect(document?.path).toBe('/workspace/report.pdf');
    expect(document?.issue).toBeNull();
    expect(document?.pages[0]?.lines[0]?.text).toBe(PAGE_TEXT);

    const copies = stagedCopies(files);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain('-report.pdf');
    expect(files.get(copies[0] ?? '')?.equals(pdf)).toBe(true);
    expect(files.get('/workspace/report.pdf')?.equals(pdf)).toBe(true);
  });

  it('stages nothing and reads nothing for an outside path with no approval', async () => {
    const { tools, files } = await makeTools();
    files.set('/outside/secret.pdf', syntheticPdf());

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/outside/secret.pdf'] },
    });
    expect(resultError(response)).toBe(true);
    const payload: unknown = JSON.parse(resultText(response));
    const errorText: unknown = isRecord(payload) ? payload['error'] : null;
    if (typeof errorText !== 'string') {
      throw new Error('expected an error result');
    }
    expect(errorText).toContain('outside the project folder');
    expect(errorText).toContain('approval first');
    expect(stagedCopies(files)).toHaveLength(0);
  });

  it('stages nothing for an outside path when the approval is refused', async () => {
    const { tools, files } = await makeTools();
    files.set('/outside/secret.pdf', syntheticPdf());

    await tools.callTool(
      { name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME, arguments: { file_paths: ['/outside/secret.pdf'] } },
      { status: 'deny', reason: 'Not now' },
    );
    expect(stagedCopies(files)).toHaveLength(0);
  });

  it('extracts an outside path once the exact call is approved', async () => {
    const { tools, files } = await makeTools();
    files.set('/outside/secret.pdf', syntheticPdf());

    const response = await tools.callTool(
      { name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME, arguments: { file_paths: ['/outside/secret.pdf'] } },
      { status: 'allow', scope: 'once' },
    );
    expect(resultError(response)).toBe(false);
    const document = extractionOf(response).documents[0];
    expect(document?.path).toBe('/outside/secret.pdf');
    expect(document?.pages[0]?.lines[0]?.text).toBe(PAGE_TEXT);
    expect(stagedCopies(files)).toHaveLength(1);
  });

  it('refuses an unsupported type in plain words, without reading or staging it', async () => {
    const { tools, files } = await makeTools();
    files.set('/workspace/deck.ppt', Buffer.from('not a real document'));

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/deck.ppt'] },
    });
    const document = extractionOf(response).documents[0];
    expect(document?.issue).toContain('.ppt is an old format');
    expect(document?.issue).toContain('Save it as .pptx or as a PDF');
    expect(stagedCopies(files)).toHaveLength(0);
  });

  it('names a missing file as not found, not as a staged-upload problem', async () => {
    const { tools, files } = await makeTools();

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/missing.pdf'] },
    });
    const document = extractionOf(response).documents[0];
    expect(document?.issue).toContain('the file could not be found');
    expect(stagedCopies(files)).toHaveLength(0);
  });

  it('does not call a provider failure that says not found a missing file, and never shows it', async () => {
    const { tools, sandbox, files } = await makeTools();
    files.set('/workspace/report.pdf', syntheticPdf());
    jest.spyOn(sandbox, 'downloadDocumentSourceFile').mockRejectedValue(new Error('slot 3 not found: /srv/slots/3'));

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/report.pdf'] },
    });
    const issue = extractionOf(response).documents[0]?.issue ?? '';
    expect(issue).toBe(
      'Could not read report.pdf. Try again; if it keeps failing, check that the sandbox is ready under Settings, Sandbox.',
    );
    expect(issue).not.toContain('/srv');
  });

  it('shows a fixed sentence, never the raw error, when a project file cannot be staged', async () => {
    const { tools, sandbox, files } = await makeTools();
    files.set('/workspace/report.pdf', syntheticPdf());
    jest.spyOn(sandbox, 'uploadUserFile').mockRejectedValue(new Error('disk full at /srv/slots/3/uploads'));

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/report.pdf'] },
    });
    const issue = extractionOf(response).documents[0]?.issue ?? '';
    expect(issue).toBe(
      'Could not read report.pdf. Try again; if it keeps failing, check that the sandbox is ready under Settings, Sandbox.',
    );
    expect(issue).not.toContain('/srv');
  });

  it('names an empty project file as empty', async () => {
    const { tools, files } = await makeTools();
    files.set('/workspace/blank.pdf', Buffer.alloc(0));

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/blank.pdf'] },
    });
    expect(extractionOf(response).documents[0]?.issue).toBe(
      'Could not read blank.pdf: the file is empty. Check that it is the right file.',
    );
    expect(stagedCopies(files)).toHaveLength(0);
  });

  it('shows a fixed sentence, never the raw error, when the whole read fails', async () => {
    const { tools, sandbox, files } = await makeTools();
    files.set('/workspace/report.pdf', syntheticPdf());
    jest.spyOn(sandbox, 'documentReadScope').mockImplementation(() => {
      throw new Error('provider lost: /srv/slots/3');
    });

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: ['/workspace/report.pdf'] },
    });
    expect(resultError(response)).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error:
        'Nothing was read. Try again; if it keeps failing, check that the sandbox is ready under Settings, Sandbox.',
    });
  });

  it('still reads a staged upload by its staged path, unchanged', async () => {
    const { tools, sandbox, files } = await makeTools();
    const staged = await stageAttachment({
      sandbox,
      filename: 'upload.pdf',
      bytes: syntheticPdf(),
      mime: 'application/pdf',
      ordinal: 1,
    });

    const response = await tools.callTool({
      name: EXTRACT_DOCUMENT_TEXT_TOOL_NAME,
      arguments: { file_paths: [staged.path] },
    });
    expect(resultError(response)).toBe(false);
    const document = extractionOf(response).documents[0];
    expect(document?.path).toBe(staged.path);
    expect(document?.pages[0]?.lines[0]?.text).toBe(PAGE_TEXT);
    expect(stagedCopies(files)).toHaveLength(1);
  });

  it('carries no document scope on the report tools', async () => {
    const { tools } = await makeTools();
    const report = await tools.toolCallInfo({ name: 'create_document_report', arguments: {} });
    expect(report.document_scope).toBeUndefined();
    expect(report.is_approval_required).toBe(true);
    const netWorth = await tools.toolCallInfo({ name: 'summarize_net_worth', arguments: {} });
    expect(netWorth.document_scope).toBeUndefined();
    expect(netWorth.is_approval_required).toBe(true);
  });
});
