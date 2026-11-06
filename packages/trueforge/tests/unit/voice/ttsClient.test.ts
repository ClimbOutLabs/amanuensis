import { SpeechRateLimiter } from '../../../src/voice/speechRateLimit';
import { SidecarSpeechSynthesizer, WholeSamples } from '../../../src/voice/ttsClient';

function streamOf(...pieces: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        pieces.forEach(piece => {
          controller.enqueue(piece);
        });
        controller.close();
      },
    }),
  );
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const piece of stream) {
    out.push(piece);
  }
  return out;
}

const never = new AbortController().signal;

describe('SidecarSpeechSynthesizer', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hands on only whole 16-bit samples when the stream is cut at an odd byte', async () => {
    const audio = Uint8Array.from({ length: 12 }, (_, index) => index);
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamOf(audio.slice(0, 3), audio.slice(3, 4), audio.slice(4)));
    const pieces = await collect(
      new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never }),
    );
    expect(pieces.every(piece => piece.length % 2 === 0)).toBe(true);
    expect(Array.from(Buffer.concat(pieces))).toEqual(Array.from(audio));
  });

  it('skips a sentence the service says has nothing to say aloud', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(
          { detail: 'text has nothing to say aloud' },
          { status: 400, headers: { 'x-aman-reason': 'nothing_to_say' } },
        ),
      );
    expect(await collect(new SidecarSpeechSynthesizer().stream({ text: '*', format: 'pcm16', signal: never }))).toEqual(
      [],
    );
  });

  it('reports any other refusal, such as a voice that does not exist', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ detail: 'Unknown voice' }, { status: 400 }));
    await expect(
      collect(new SidecarSpeechSynthesizer({ voice: 'nope' }).stream({ text: 'Hi.', format: 'pcm16', signal: never })),
    ).rejects.toThrow('text to speech answered 400');
  });
});

describe('a voice conversation sharing the voice service with read-aloud requests', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('waits for the person to have a free place, and gives it back when the sentence is done', async () => {
    const limiter = new SpeechRateLimiter({ maxInFlight: 1 });
    const readAloud = limiter.acquire('t:alice');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamOf(Uint8Array.of(1, 2)));
    const synth = new SidecarSpeechSynthesizer({ share: { limiter, person: 't:alice' } });
    const pieces = collect(synth.stream({ text: 'Hi.', format: 'pcm16', signal: never }));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(globalThis.fetch).not.toHaveBeenCalled();
    if (readAloud.allowed) readAloud.release();
    expect((await pieces).length).toBe(1);
    expect(limiter.acquire('t:alice').allowed).toBe(true);
  });
});

describe('WholeSamples', () => {
  it('carries a held byte into the next piece', () => {
    const whole = new WholeSamples();
    expect(Array.from(whole.push(Uint8Array.of(1, 2, 3)))).toEqual([1, 2]);
    expect(Array.from(whole.push(Uint8Array.of(4)))).toEqual([3, 4]);
  });
});
