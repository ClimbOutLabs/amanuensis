import { callSpeaking } from '../../../../src/runtime/calls/callSpeaking';
import { speechLimiter, speechPersonKey } from '../../../../src/voice/speechRateLimit';

describe('how a call speaks', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('waits for a place in the person’s share of the shared voice limiter', async () => {
    const owner = { tenant_id: 'tenant-a', created_by: 'person-a' };
    const acquire = jest.spyOn(speechLimiter, 'acquireInFlightWaiting').mockResolvedValue(() => undefined);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(0)));
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    for await (const chunk of callSpeaking(owner).stream({
      text: 'Hello.',
      format: 'pcm16',
      signal: controller.signal,
    })) {
      chunks.push(chunk);
    }
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({ key: speechPersonKey({ tenantId: 'tenant-a', personId: 'person-a' }) }),
    );
  });
});
