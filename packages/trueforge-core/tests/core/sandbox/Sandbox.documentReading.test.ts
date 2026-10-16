import { extractDocumentsFromSandbox } from '../../../src/core/capabilities/builtins/DocumentTools';
import { stageAttachment } from '../../../src/core/runtime/attachmentStaging';
import { Sandbox } from '../../../src/core/sandbox/Sandbox';
import { SlotSandboxProvider } from '../../../src/core/sandbox/slots/SlotSandboxProvider';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { MAX_BYTES_PER_DOCUMENT } from '../../../src/documents/documentExtraction';
import { syntheticPdf, syntheticPng, unicodeTextPdfPages } from '../documents/syntheticFiles';
import { makeSilentLogger } from '../harnessMocks';
import type { FakeAgent } from './slots/fakeAgent';
import { fakeWorkspaceAgent, type ShellAnswer } from './slots/fakeWorkspace';

describe('reading a staged document on sandbox slots', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function slotSandbox({
    pages = ['Total: 4,200'],
    answerShell,
  }: {
    pages?: readonly string[];
    answerShell?: (command: string) => ShellAnswer | undefined;
  } = {}): Promise<{ sandbox: Sandbox; commands: string[] }> {
    const commands: string[] = [];
    const workspace = fakeWorkspaceAgent(pages, command => {
      commands.push(command);
      return answerShell?.(command);
    });
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
      workspaceVerificationCoordinator: undefined,
      blockDestructiveToolsInCodeMode: true,
      mcpRequestTimeoutMs: 60_000,
      mcpConnectTimeoutMs: 5_000,
      logger: makeSilentLogger(),
      tracing: NOOP_AGENT_TRACING,
    });
    return { sandbox, commands };
  }

  it('reads back a file larger than the agent ordinary read cap, by snapshotting under the transfer directory', async () => {
    const { sandbox } = await slotSandbox({ pages: ['Large file, first page'] });
    const bigPdf = unicodeTextPdfPages([['Large file, first page']], { paddingBytes: 12 * 1024 * 1024 });
    const staged = await stageAttachment({
      sandbox,
      filename: 'big.pdf',
      bytes: bigPdf,
      mime: 'application/pdf',
      ordinal: 1,
    });

    const snapshot = await sandbox.createDocumentSnapshot({ filePath: staged.path, maxBytes: undefined });
    expect(snapshot.filePath).toMatch(/^\/workspace\/\.aman\/transfer\/\.amanuensis-document-[0-9a-f]+$/);
    expect(snapshot.content.equals(bigPdf)).toBe(true);
    await snapshot.cleanup();

    const extraction = await extractDocumentsFromSandbox(sandbox, [staged.path]);
    expect(extraction.documents[0]?.issue).toBeNull();
    expect(extraction.documents[0]?.pages[0]?.lines[0]?.text).toBe('Large file, first page');
  });

  it('reads a scanned PDF one page per call, with one OCR thread, and keeps the pages read when a later page fails', async () => {
    const ocrCommands: string[] = [];
    const { sandbox } = await slotSandbox({
      answerShell: command => {
        const marker = /AMAN_OCR_PAGE_[0-9a-f]+/.exec(command)?.[0];
        if (marker === undefined) {
          return undefined;
        }
        ocrCommands.push(command);
        const page = /pdftoppm -f '(\d+)'/.exec(command)?.[1] ?? '0';
        return page === '4'
          ? { exitCode: 1, output: 'Page 4: could not be rendered' }
          : `${marker}:${page}\ntext of page ${page}\n`;
      },
    });
    const staged = await stageAttachment({
      sandbox,
      filename: 'scan.pdf',
      bytes: syntheticPdf(),
      mime: 'application/pdf',
      ordinal: 1,
    });

    const pages = await sandbox.runDocumentOcr({
      filePath: staged.path,
      kind: 'pdf',
      pages: [2, 3, 4, 5],
      maxPages: 4,
    });

    expect(pages).toEqual([
      { page_number: 2, text: 'text of page 2' },
      { page_number: 3, text: 'text of page 3' },
    ]);
    // One call per page, stopping at the failure.
    expect(ocrCommands).toHaveLength(3);
    for (const command of ocrCommands) {
      expect(command).toContain('export OMP_THREAD_LIMIT=1');
      expect(command).toContain('ulimit -v');
    }
  });

  it('fails, rather than returning nothing, when the first page cannot be read', async () => {
    const { sandbox } = await slotSandbox({
      answerShell: command =>
        command.includes('AMAN_OCR_PAGE_') ? { exitCode: 1, output: 'tesseract failed' } : undefined,
    });
    const staged = await stageAttachment({
      sandbox,
      filename: 'photo.png',
      bytes: syntheticPng(),
      mime: 'image/png',
      ordinal: 1,
    });
    await expect(
      sandbox.runDocumentOcr({ filePath: staged.path, kind: 'image', pages: undefined, maxPages: 1 }),
    ).rejects.toThrow('tesseract failed');
  });
});
