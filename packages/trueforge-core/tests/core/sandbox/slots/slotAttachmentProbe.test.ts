import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeSlotAttachments } from '../../../../src/core/sandbox/slots/slotAttachmentProbe';
import { makeSilentLogger } from '../../harnessMocks';
import type { FakeAgent } from './fakeAgent';
import { fakeWorkspaceAgent } from './fakeWorkspace';

describe('probeSlotAttachments', () => {
  let agent: FakeAgent | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
  });

  async function probe(answerShell?: (command: string) => string | undefined) {
    const workspace = fakeWorkspaceAgent([], answerShell);
    agent = workspace.agent;
    const result = await probeSlotAttachments({
      socketPaths: [await agent.start()],
      logger: makeSilentLogger(),
      signal: AbortSignal.timeout(5_000),
    });
    return { result, requests: agent.requests, files: workspace.files };
  }

  it('is ready when a file goes in and comes back and the guest has the PDF and OCR tools', async () => {
    const { result, requests, files } = await probe();
    expect(result).toEqual({ ready: true });
    const written = [...files.keys()];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\/workspace\/\.aman\/uploads\/doctor-[0-9a-f]{16}\.txt$/);
    // The throwaway workspace is removed again.
    expect(requests.map(request => request.path)).toContain('/v1/destroy_session');
  });

  it('names the missing tools and the repair command when the image predates attachment reading', async () => {
    const { result } = await probe(command =>
      command.includes('command -v pdfinfo') ? 'pdftotext\ntesseract\n' : undefined,
    );
    expect(result).toMatchObject({ ready: false });
    expect(result.ready === false && result.error).toContain('missing pdftotext, tesseract');
    expect(result.ready === false && result.error).toContain('aman doctor sandbox --fix');
  });

  it('is not ready, with the repair command, when no slot is reachable', async () => {
    const result = await probeSlotAttachments({
      socketPaths: [join(tmpdir(), 'no-such-slot', 'agent.sock')],
      logger: makeSilentLogger(),
      signal: AbortSignal.timeout(5_000),
    });
    expect(result.ready).toBe(false);
    expect(result.ready === false && result.error).toContain('aman doctor sandbox --fix');
  });
});
