import { extractDocumentsFromSandbox } from '../../../../src/core/capabilities/builtins/DocumentTools';
import type { AttachmentStager } from '../../../../src/core/email/gmail/GmailToolSet';
import { InvalidFileInputError } from '../../../../src/core/errors';
import { stageAttachment } from '../../../../src/core/runtime/attachmentStaging';
import { Sandbox, SandboxFileUploadError, type SandboxInfo } from '../../../../src/core/sandbox/Sandbox';
import { SlotSandboxProvider } from '../../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';
import { MAX_DOCUMENT_FILES } from '../../../../src/documents/documentExtraction';
import { makeSilentLogger } from '../../harnessMocks';
import type { FakeAgent } from '../../sandbox/slots/fakeAgent';
import { fakeWorkspaceAgent } from '../../sandbox/slots/fakeWorkspace';
import { b64url, message } from './fixtures';
import { build, route, text } from './harness';

const UPLOADS_DIR = '/workspace/.aman/uploads';
const PDF_BYTES = Buffer.from('%PDF-1.4 synthetic');
const CREATED: SandboxInfo = { sandbox_id: 'sb-1', sandbox_provider: 'slots' };

/** One line per script the document reader is installed for, as a PDF extractor returns them. */
const MULTILINGUAL_PAGES = [
  'Fatura número 4200: pagamento até amanhã, São João',
  'फ़ाइल कुल राशि चार हजार दो सौ रुपये क्‍ष',
  'فاتورة الدفع غدا',
  '請求書の合計は四千二百円です 发票总额为四千二百元 청구서 합계는 사천이백 원입니다',
];

function slotSandbox(socketPath: string): Sandbox {
  return new Sandbox({
    provider: new SlotSandboxProvider({
      socketPaths: [socketPath],
      defaultExecTimeoutSeconds: 30,
      treeDiskMb: 100,
      fileMaxBytesForDownload: 30 * 1024 * 1024,
      logger: makeSilentLogger(),
      sleepMs: undefined,
      gitBridge: undefined,
    }),
    workspaceVerificationCoordinator: undefined,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

function attachmentMessage(files: { id: string; filename: string; size: number }[]) {
  return message({
    id: 'm1',
    body: 'see attached',
    attachments: files.map(file => ({ ...file, mimeType: 'application/pdf' })),
  });
}

function download(attachmentId: string) {
  return { name: 'download_attachment', arguments: { message_id: 'm1', attachment_id: attachmentId } };
}

describe('download_attachment through the real staging helper', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function stagedInto(pages: readonly string[]) {
    const workspace = fakeWorkspaceAgent(pages);
    agent = workspace.agent;
    const sandbox = slotSandbox(await agent.start());
    const stager: AttachmentStager = {
      stageAttachment: async input => {
        const staged = await stageAttachment({ sandbox, ...input });
        return { filename: staged.filename, path: staged.path, sandboxCreated: staged.sandboxCreated };
      },
    };
    return { sandbox, stager, files: workspace.files };
  }

  it('stages a PDF in the workspace and its text comes back intact in every script', async () => {
    const { sandbox, stager, files } = await stagedInto(MULTILINGUAL_PAGES);
    const { tools } = await build({
      stager,
      routes: [
        route(
          '/messages/m1',
          attachmentMessage([{ id: 'a1', filename: 'फ़ाइल-فاتورة-請求書.pdf', size: PDF_BYTES.length }]),
        ),
        route('/messages/m1/attachments/a1', { size: PDF_BYTES.length, data: b64url('%PDF-1.4 synthetic') }),
      ],
    });
    const result = JSON.parse(text(await tools.callTool(download('a1'))));
    expect(result.path).toMatch(new RegExp(`^${UPLOADS_DIR}/attachment-01-[0-9a-f]{32}-`));
    expect(result.filename).toBe('फ़ाइल-فاتورة-請求書.pdf');
    expect(files.get(result.path)).toEqual(PDF_BYTES);

    const extraction = await extractDocumentsFromSandbox(sandbox, [result.path]);
    expect(extraction.documents[0]?.issue).toBeNull();
    expect(extraction.documents[0]?.pages.flatMap(page => page.lines.map(line => line.text))).toEqual(
      MULTILINGUAL_PAGES,
    );
  });

  it('numbers each attachment of the turn so two files with one name stay apart', async () => {
    const { stager, files } = await stagedInto([]);
    const { tools } = await build({
      stager,
      routes: [
        route(
          '/messages/m1',
          attachmentMessage([
            { id: 'a1', filename: 'invoice.pdf', size: 3 },
            { id: 'a2', filename: 'invoice.pdf', size: 3 },
          ]),
        ),
        route('/messages/m1/attachments/a1', { size: 3, data: b64url('one') }),
        route('/messages/m1/attachments/a2', { size: 3, data: b64url('two') }),
      ],
    });
    const first = JSON.parse(text(await tools.callTool(download('a1'))));
    const second = JSON.parse(text(await tools.callTool(download('a2'))));
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain('attachment-01-');
    expect(second.path).toContain('attachment-02-');
    expect([...files.keys()].filter(path => path.startsWith(UPLOADS_DIR))).toHaveLength(2);
  });

  it('keeps a hostile file name inside the uploads directory and out of the result', async () => {
    const { stager, files } = await stagedInto([]);
    const { tools } = await build({
      stager,
      routes: [
        route('/messages/m1', attachmentMessage([{ id: 'a1', filename: '../../etc/evil‮fdp.pdf', size: 3 }])),
        route('/messages/m1/attachments/a1', { size: 3, data: b64url('abc') }),
      ],
    });
    const result = JSON.parse(text(await tools.callTool(download('a1'))));
    expect(result.path.startsWith(`${UPLOADS_DIR}/`)).toBe(true);
    expect(result.path.slice(UPLOADS_DIR.length + 1)).not.toMatch(/[/\\]/);
    expect(result.filename).not.toMatch(/‮|\//);
    expect([...files.keys()].every(path => path.startsWith(UPLOADS_DIR) || !path.includes('evil'))).toBe(true);
  });
});

describe('download_attachment refusals', () => {
  const tiny = (count: number) =>
    attachmentMessage(
      Array.from({ length: count }, (_, index) => ({
        id: `a${String(index)}`,
        filename: `f${String(index)}.pdf`,
        size: 1,
      })),
    );

  it('refuses an attachment over 25 MB by its declared size without fetching or staging it', async () => {
    const staged: string[] = [];
    const { tools, google } = await build({
      stager: {
        stageAttachment: input => {
          staged.push(input.filename);
          return Promise.resolve({ filename: input.filename, path: '/x', sandboxCreated: undefined });
        },
      },
      routes: [route('/messages/m1', attachmentMessage([{ id: 'a1', filename: 'big.pdf', size: 26 * 1024 * 1024 }]))],
    });
    const response = await tools.callTool(download('a1'));
    expect(text(response)).toContain('larger than 25 MB');
    expect(google.urls.some(entry => entry.includes('/attachments/'))).toBe(false);
    expect(staged).toEqual([]);
  });

  it('stops at the shared count limit for one turn and never fetches past it', async () => {
    const { tools, google } = await build({
      stager: {
        stageAttachment: input =>
          Promise.resolve({ filename: input.filename, path: `/w/${input.filename}`, sandboxCreated: undefined }),
      },
      routes: [
        route('/messages/m1', tiny(MAX_DOCUMENT_FILES + 1)),
        url =>
          /\/attachments\/a\d+$/.test(url.pathname)
            ? new Response(JSON.stringify({ size: 1, data: b64url('x') }), {
                headers: { 'Content-Type': 'application/json' },
              })
            : undefined,
      ],
    });
    for (let index = 0; index < MAX_DOCUMENT_FILES; index += 1) {
      expect(JSON.parse(text(await tools.callTool(download(`a${String(index)}`)))).path).toBe(
        `/w/f${String(index)}.pdf`,
      );
    }
    const fetchedBefore = google.urls.filter(entry => entry.includes('/attachments/')).length;
    const refused = await tools.callTool(download(`a${String(MAX_DOCUMENT_FILES)}`));
    expect(text(refused)).toContain(`${String(MAX_DOCUMENT_FILES)} attachment limit`);
    expect(google.urls.filter(entry => entry.includes('/attachments/')).length).toBe(fetchedBefore);
  });

  it('turns the staging helper refusals into a plain error instead of failing the turn', async () => {
    const { tools } = await build({
      stager: {
        stageAttachment: () => Promise.reject(new InvalidFileInputError('File exceeds the 26214400 byte upload limit')),
      },
      routes: [
        route('/messages/m1', attachmentMessage([{ id: 'a1', filename: 'lies.pdf', size: 3 }])),
        route('/messages/m1/attachments/a1', { size: 3, data: b64url('abc') }),
      ],
    });
    const response = await tools.callTool(download('a1'));
    expect(JSON.parse(text(response)).error).toBe(
      'The attachment was not saved: File exceeds the 26214400 byte upload limit.',
    );
  });

  it('says the sandbox could not take the file, and still reports a sandbox the failed upload created', async () => {
    const { tools } = await build({
      stager: { stageAttachment: () => Promise.reject(new SandboxFileUploadError('boom', CREATED)) },
      routes: [
        route('/messages/m1', attachmentMessage([{ id: 'a1', filename: 'a.pdf', size: 3 }])),
        route('/messages/m1/attachments/a1', { size: 3, data: b64url('abc') }),
      ],
    });
    const response = await tools.callTool(download('a1'));
    expect(JSON.parse(text(response)).error).toBe(
      'The sandbox could not take the attachment, so it was not saved. Try again.',
    );
    expect(response).toMatchObject({ sandboxCreated: true, sandboxInfo: CREATED });
  });

  it('passes on a sandbox that staging had to create, so the next turn finds the same one', async () => {
    const { tools } = await build({
      stager: {
        stageAttachment: input =>
          Promise.resolve({ filename: input.filename, path: '/w/a.pdf', sandboxCreated: CREATED }),
      },
      routes: [
        route('/messages/m1', attachmentMessage([{ id: 'a1', filename: 'a.pdf', size: 3 }])),
        route('/messages/m1/attachments/a1', { size: 3, data: b64url('abc') }),
      ],
    });
    expect(await tools.callTool(download('a1'))).toMatchObject({ sandboxCreated: true, sandboxInfo: CREATED });
  });

  it('is offered in a scheduled run too, which reads mail but never writes it', async () => {
    const { tools } = await build({
      unattended: true,
      features: ['gmail_read', 'gmail_compose'],
      stager: {
        stageAttachment: input =>
          Promise.resolve({ filename: input.filename, path: '/w/a.pdf', sandboxCreated: undefined }),
      },
      routes: [],
    });
    const names = (await tools.listTools()).result.tools.map(tool => tool.name);
    expect(names).toContain('download_attachment');
    expect(names).not.toContain('draft_email');
  });
});

describe('the reason attachments cannot be read', () => {
  const withFile = () => route('/messages/m1', attachmentMessage([{ id: 'a1', filename: 'lease.pdf', size: 5 }]));

  it('is stated plainly in the message when the chat has no sandbox', async () => {
    const { tools } = await build({ routes: [withFile()] });
    const result = JSON.parse(text(await tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } })));
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments_note).toBe(
      'Attachments cannot be opened in this chat because the sandbox is off. Tell the user that plainly; do not guess what they contain.',
    );
  });

  it('is absent when the chat can open them, and when the message has none', async () => {
    const stager: AttachmentStager = {
      stageAttachment: input =>
        Promise.resolve({ filename: input.filename, path: '/w/a.pdf', sandboxCreated: undefined }),
    };
    const open = await build({ stager, routes: [withFile()] });
    expect(
      JSON.parse(text(await open.tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } })))
        .attachments_note,
    ).toBeUndefined();
    const none = await build({ routes: [route('/messages/m1', message({ id: 'm1', body: 'hi' }))] });
    expect(
      JSON.parse(text(await none.tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } })))
        .attachments_note,
    ).toBeUndefined();
  });

  it('is given for a thread that lists attachments', async () => {
    const { tools } = await build({
      routes: [
        route('/threads/t-m1', {
          id: 't-m1',
          messages: [attachmentMessage([{ id: 'a1', filename: 'lease.pdf', size: 5 }])],
        }),
      ],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'get_thread', arguments: { thread_id: 't-m1' } })));
    expect(result.attachments_note).toContain('sandbox is off');
  });
});
