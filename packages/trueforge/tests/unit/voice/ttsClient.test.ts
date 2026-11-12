import configuration from '../../../src/config';
import { SpeechRateLimiter } from '../../../src/voice/speechRateLimit';
import { UncheckedSpeechError, WouldChangeTextError } from '../../../src/voice/transport';
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

/** What an aman-tts that checked an exact speak answers with. */
const CHECKED_HEADERS = { 'x-aman-exact': 'checked', 'content-type': 'audio/L16' };

function checkedStream(...pieces: Uint8Array[]): Response {
  return new Response(streamOf(...pieces).body, { status: 200, headers: CHECKED_HEADERS });
}

describe('SidecarSpeechSynthesizer with exact', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the whole text once, marked exact, and streams what comes back', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(checkedStream(Uint8Array.of(1, 2)));
    const pieces = await collect(
      new SidecarSpeechSynthesizer().stream({
        text: 'Total is 100. + 500 fee.',
        format: 'pcm16',
        signal: never,
        exact: true,
      }),
    );
    expect(pieces.length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/v1\/speak$/);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      text: 'Total is 100. + 500 fee.',
      exact: true,
    });
  });

  it.each([
    ['a plain reading', false],
    ['an exact read-back', true],
  ])('presents the shared speech secret on %s', async (_name, exact) => {
    const original = configuration.SPEECH_SECRET;
    configuration.SPEECH_SECRET = 'synthetic-speech-secret-with-32-plus-chars';
    try {
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(exact ? checkedStream(Uint8Array.of(1, 2)) : streamOf(Uint8Array.of(1, 2)));
      await collect(new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never, exact }));
      expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
        'x-speech-secret': 'synthetic-speech-secret-with-32-plus-chars',
      });
    } finally {
      configuration.SPEECH_SECRET = original;
    }
  });

  it('does not ask for exact unless told to', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(streamOf(Uint8Array.of(1, 2)));
    await collect(new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never }));
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).not.toHaveProperty('exact');
  });

  it('says so, before any sound, when the voice would change the words', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ detail: 'no' }, { status: 400, headers: { 'x-aman-reason': 'would_change_text' } }),
      );
    await expect(
      collect(
        new SidecarSpeechSynthesizer().stream({ text: 'Pay $1,5.', format: 'pcm16', signal: never, exact: true }),
      ),
    ).rejects.toBeInstanceOf(WouldChangeTextError);
  });

  it.each([
    ['a refusal for another reason', () => Response.json({ detail: 'bad' }, { status: 400 })],
    ['a server error', () => Response.json({ detail: 'down' }, { status: 503 })],
  ])('reports %s as a failure, not as a refusal of the words', async (_name, answer) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer());
    const read = collect(
      new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never, exact: true }),
    );
    await expect(read).rejects.toThrow(/text to speech answered/);
    await expect(read).rejects.not.toBeInstanceOf(WouldChangeTextError);
  });

  it.each([
    ['an older voice service that ignores exact', () => streamOf(Uint8Array.of(1, 2))],
    ['a 200 that is not the voice service', () => new Response('<html>welcome</html>', { status: 200 })],
    [
      'an answer that is not audio',
      () =>
        new Response('<html>welcome</html>', {
          status: 200,
          headers: { 'x-aman-exact': 'checked', 'content-type': 'text/html' },
        }),
    ],
  ])('does not speak %s, since nothing checked the words', async (_name, answer) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer());
    const read = collect(
      new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never, exact: true }),
    );
    await expect(read).rejects.toBeInstanceOf(UncheckedSpeechError);
    await expect(read).rejects.not.toBeInstanceOf(WouldChangeTextError);
  });

  it('stops an unchecked answer at once, so an older service does not keep making the whole read-back', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
      },
      cancel() {
        cancelled = true;
      },
    });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const read = collect(
      new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never, exact: true }),
    );
    await expect(read).rejects.toBeInstanceOf(UncheckedSpeechError);
    expect(cancelled).toBe(true);
  });

  it('takes the audio type in any case', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Uint8Array.of(1, 2), {
        status: 200,
        headers: { 'x-aman-exact': 'checked', 'content-type': 'AUDIO/L16' },
      }),
    );
    const pieces = await collect(
      new SidecarSpeechSynthesizer().stream({ text: 'Hi.', format: 'pcm16', signal: never, exact: true }),
    );
    expect(pieces.length).toBe(1);
  });
});
