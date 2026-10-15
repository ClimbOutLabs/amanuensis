import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractDocumentsFromSandbox } from '../../../src/core/capabilities/builtins/DocumentTools';
import { InvalidFileInputError } from '../../../src/core/errors';
import { EventType } from '../../../src/core/events/schema';
import { stageAttachment } from '../../../src/core/runtime/attachmentStaging';
import { processAgentUserInput } from '../../../src/core/runtime/UserInputMessage';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { SlotSandboxProvider } from '../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { makeSilentLogger } from '../harnessMocks';
import type { FakeAgent } from '../sandbox/slots/fakeAgent';
import { fakeWorkspaceAgent } from '../sandbox/slots/fakeWorkspace';

const UPLOADS_DIR = '/workspace/.aman/uploads';
const PDF_BYTES = Buffer.from('%PDF-1.4 synthetic');

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

describe('stageAttachment on sandbox slots', () => {
  let agent: FakeAgent | undefined;
  let files: Map<string, Buffer>;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function stubbedSandbox(pages: readonly string[]): Promise<Sandbox> {
    const workspace = fakeWorkspaceAgent(pages);
    agent = workspace.agent;
    files = workspace.files;
    return slotSandbox(await agent.start());
  }

  function writtenPaths(): string[] {
    return [...files.keys()].filter(path => path.startsWith(UPLOADS_DIR));
  }

  test('writes the bytes into the uploads directory of the workspace and returns the in-sandbox path', async () => {
    const sandbox = await stubbedSandbox([]);
    const staged = await stageAttachment({
      sandbox,
      filename: 'invoice.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      ordinal: 1,
    });
    expect(staged.path).toMatch(new RegExp(`^${UPLOADS_DIR}/attachment-01-[0-9a-f]{32}-invoice\\.pdf$`));
    expect(staged.filename).toBe('invoice.pdf');
    expect(staged.size).toBe(PDF_BYTES.length);
    expect(files.get(staged.path)).toEqual(PDF_BYTES);
  });

  test('keeps a hostile name inside the uploads directory', async () => {
    const sandbox = await stubbedSandbox([]);
    const staged = await stageAttachment({
      sandbox,
      filename: '../../etc/cron.d/evil\u0000.pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      ordinal: 1,
    });
    expect(staged.filename).toBe('evil_.pdf');
    expect(staged.path.startsWith(`${UPLOADS_DIR}/`)).toBe(true);
    expect(staged.path.slice(UPLOADS_DIR.length + 1)).not.toMatch(/[/\\]/);
    expect(writtenPaths()).toEqual([staged.path]);
  });

  test.each([
    ['', 'attachment'],
    ['..', 'attachment'],
    ['...', 'attachment'],
    ['dir\\sub\\report.pdf', 'report.pdf'],
    ['line\nbreak.pdf', 'line_break.pdf'],
  ])('sanitizes the name %j to %j', async (raw, expected) => {
    const sandbox = await stubbedSandbox([]);
    const staged = await stageAttachment({ sandbox, filename: raw, bytes: PDF_BYTES, mime: 'text/plain', ordinal: 2 });
    expect(staged.filename).toBe(expected);
    expect(staged.stagedName.startsWith('attachment-02-')).toBe(true);
  });

  test('shortens a very long name but keeps the extension', async () => {
    const sandbox = await stubbedSandbox([]);
    const staged = await stageAttachment({
      sandbox,
      filename: `${'é'.repeat(300)}.pdf`,
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      ordinal: 1,
    });
    expect(Buffer.byteLength(staged.filename, 'utf8')).toBeLessThanOrEqual(180);
    expect(staged.filename.endsWith('.pdf')).toBe(true);
  });

  test('refuses a file over the size cap and an empty file without writing anything', async () => {
    const sandbox = await stubbedSandbox([]);
    await expect(
      stageAttachment({
        sandbox,
        filename: 'big.pdf',
        bytes: Buffer.alloc(25 * 1024 * 1024 + 1),
        mime: 'application/pdf',
        ordinal: 1,
      }),
    ).rejects.toThrow(InvalidFileInputError);
    await expect(
      stageAttachment({ sandbox, filename: 'empty.pdf', bytes: Buffer.alloc(0), mime: 'application/pdf', ordinal: 1 }),
    ).rejects.toThrow(InvalidFileInputError);
    expect(files.size).toBe(0);
  });

  test('accepts a file exactly at the size cap', async () => {
    const sandbox = await stubbedSandbox([]);
    const staged = await stageAttachment({
      sandbox,
      filename: 'edge.pdf',
      bytes: Buffer.alloc(25 * 1024 * 1024),
      mime: 'application/pdf',
      ordinal: 1,
    });
    expect((await sandbox.downloadUserFile(staged.path)).length).toBe(25 * 1024 * 1024);
  });

  test('tells the person how to repair the sandbox when no slot is reachable', async () => {
    const sandbox = slotSandbox(join(tmpdir(), 'no-such-slot', 'agent.sock'));
    await expect(
      stageAttachment({ sandbox, filename: 'a.pdf', bytes: PDF_BYTES, mime: 'application/pdf', ordinal: 1 }),
    ).rejects.toThrow('aman doctor sandbox --fix');
  });

  test('a PDF uploaded in chat is staged on the slot and its text reaches the model in one extraction', async () => {
    const sandbox = await stubbedSandbox(['Total due: $4,200.00', 'Pay by 2026-11-01']);
    const result = await processAgentUserInput(
      {
        type: EventType.USER_MESSAGE,
        content: [
          { type: 'text', text: 'What is due?' },
          { type: 'file', name: 'invoice.pdf', data: `data:application/pdf;base64,${PDF_BYTES.toString('base64')}` },
        ],
      },
      sandbox,
    );
    const staged = result.stagedDocuments?.[0];
    expect(staged?.path).toMatch(new RegExp(`^${UPLOADS_DIR}/attachment-01-[0-9a-f]{32}-invoice\\.pdf$`));
    expect(files.get(staged?.path ?? '')).toEqual(PDF_BYTES);

    const extraction = await extractDocumentsFromSandbox(sandbox, [staged?.path ?? '']);
    const document = extraction.documents[0];
    expect(document?.issue).toBeNull();
    expect(document?.pages.flatMap(page => page.lines.map(line => line.text))).toEqual([
      'Total due: $4,200.00',
      'Pay by 2026-11-01',
    ]);
  });

  test('an email attachment staged through the same helper is readable the same way', async () => {
    const sandbox = await stubbedSandbox(['Flight LH 401 departs 09:15']);
    const staged = await stageAttachment({
      sandbox,
      filename: 'Itinerary (final).pdf',
      bytes: PDF_BYTES,
      mime: 'application/pdf',
      ordinal: 1,
    });
    const extraction = await extractDocumentsFromSandbox(sandbox, [staged.path]);
    expect(extraction.documents[0]?.pages[0]?.lines[0]?.text).toBe('Flight LH 401 departs 09:15');
    expect(await sandbox.downloadUserFile(staged.path)).toEqual(PDF_BYTES);
  });
});
