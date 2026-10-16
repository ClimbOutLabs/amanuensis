import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSlotAttachments } from '../../../../src/core/sandbox/slots/slotAttachmentProbe';
import { makeSilentLogger } from '../../harnessMocks';
import type { FakeAgent } from './fakeAgent';
import { fakeWorkspaceAgent } from './fakeWorkspace';

const LANGUAGES = ['eng', 'hin', 'mar'];

describe('probeSlotAttachments', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function probe({
    answerShell,
    corruptReads = false,
    timeoutMs = 5_000,
  }: {
    answerShell?: (command: string) => string | undefined;
    corruptReads?: boolean;
    timeoutMs?: number;
  } = {}) {
    const workspace = fakeWorkspaceAgent([], answerShell, corruptReads);
    agent = workspace.agent;
    const result = await probeSlotAttachments({
      socketPaths: [await agent.start()],
      logger: makeSilentLogger(),
      signal: AbortSignal.timeout(timeoutMs),
      treeDiskMb: 2048,
      ocrLanguages: LANGUAGES,
    });
    return { result, requests: agent.requests, files: workspace.files };
  }

  it('is ready when a file goes in and comes back and the guest has the PDF tools and OCR languages', async () => {
    const { result, requests, files } = await probe();
    expect(result).toEqual({ state: 'ready' });
    const written = [...files.keys()];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\/workspace\/\.aman\/uploads\/doctor-[0-9a-f]{16}\.txt$/);
    // The throwaway workspace is removed again.
    expect(requests.map(request => request.path)).toContain('/v1/destroy_session');
  });

  it('asks the guest for the tools and for every configured OCR language', async () => {
    let command = '';
    await probe({
      answerShell: asked => {
        command = asked.includes('command -v') ? asked : command;
        return undefined;
      },
    });
    for (const tool of ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract']) {
      expect(command).toContain(`command -v ${tool}`);
    }
    expect(command).toContain('tesseract --list-langs');
    for (const language of LANGUAGES) {
      expect(command).toContain(`grep -qx -- '${language}'`);
    }
  });

  it('is not ready when the image lacks a tool or a configured OCR language', async () => {
    const { result } = await probe({
      answerShell: command =>
        command.includes('command -v pdfinfo') ? 'AMAN_MISSING:pdftotext\nAMAN_MISSING:tesseract-hin\n' : undefined,
    });
    expect(result).toEqual({ state: 'not_ready', problem: 'tools_missing' });
  });

  it('reads only the lines that name something missing, not notices from the sandbox', async () => {
    const { result } = await probe({
      answerShell: command =>
        command.includes('command -v pdfinfo')
          ? '[sandbox] The workspace reached 90% of its limit; the missing pdftotext below is not a tool.\n'
          : undefined,
    });
    expect(result).toEqual({ state: 'ready' });
  });

  it('is not ready when the bytes that come back differ from the bytes sent', async () => {
    const { result } = await probe({ corruptReads: true });
    expect(result).toEqual({ state: 'not_ready', problem: 'file_changed' });
  });

  it('is busy, not broken, when the probe runs out of time', async () => {
    const { result } = await probe({ timeoutMs: 1 });
    expect(result).toEqual({ state: 'busy' });
  });

  it('is not ready when no slot is reachable', async () => {
    const result = await probeSlotAttachments({
      socketPaths: [join(tmpdir(), 'no-such-slot', 'agent.sock')],
      logger: makeSilentLogger(),
      signal: AbortSignal.timeout(5_000),
      treeDiskMb: 2048,
      ocrLanguages: LANGUAGES,
    });
    expect(result).toEqual({ state: 'not_ready', problem: 'sandbox_unavailable' });
  });
});
