import { InputDecoder, decodeMulaw, upsampleTo16k } from '../../../src/voice/audio';
import { PhoneVoiceTransport, readPhoneFrame } from '../../../src/voice/phoneTransport';
import { mulawBytes } from '../../fixtures/voice/fakes';

/** Just the parts of a socket the transport uses, recording what it sent. */
function fakeSocket() {
  const sent: unknown[] = [];
  let closed: number | undefined;
  const socket: {
    OPEN: 1;
    readyState: 0 | 1 | 2 | 3;
    send: (data: string) => void;
    close: (code: number) => void;
  } = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => {
      sent.push(JSON.parse(data));
    },
    close: (code: number) => {
      closed = code;
      socket.readyState = 3;
    },
  };
  return { socket, sent, closed: () => closed };
}

const tone = (count: number): Int16Array =>
  Int16Array.from({ length: count }, (_, n) => Math.round(Math.sin((2 * Math.PI * 440 * n) / 8000) * 12_000));

describe('Twilio media frames', () => {
  it('reads start, media, mark and stop, and ignores anything else', () => {
    const start = readPhoneFrame(
      Buffer.from(
        JSON.stringify({
          event: 'start',
          start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { token: 't' } },
        }),
      ),
    );
    expect(start).toEqual({ kind: 'start', streamSid: 'MZ1', callSid: 'CA1', parameters: { token: 't' } });
    const media = readPhoneFrame(Buffer.from(JSON.stringify({ event: 'media', media: { payload: 'AAEC' } })));
    expect(media).toEqual({ kind: 'audio', bytes: new Uint8Array([0, 1, 2]) });
    expect(readPhoneFrame(Buffer.from(JSON.stringify({ event: 'mark', mark: { name: 'x' } })))).toEqual({
      kind: 'mark',
      name: 'x',
    });
    expect(readPhoneFrame(Buffer.from(JSON.stringify({ event: 'stop' })))).toEqual({ kind: 'stop' });
    expect(readPhoneFrame(Buffer.from('not json'))).toEqual({ kind: 'ignore' });
    expect(readPhoneFrame(Buffer.from(JSON.stringify({ event: 'dtmf' })))).toEqual({ kind: 'ignore' });
    expect(
      readPhoneFrame(Buffer.from(JSON.stringify({ event: 'media', media: { payload: 'AA', track: 'outbound' } }))),
    ).toEqual({ kind: 'ignore' });
  });

  it('carries 8 kHz mu-law through a frame and back to 16 kHz samples close to the original', () => {
    const original = tone(160);
    const payload = Buffer.from(mulawBytes(original)).toString('base64');
    const frame = readPhoneFrame(Buffer.from(JSON.stringify({ event: 'media', media: { payload } })));
    if (frame.kind !== 'audio') {
      throw new Error('expected audio');
    }
    const decoded = decodeMulaw(frame.bytes);
    // Mu-law keeps about 2 percent of the loudness of each sample.
    decoded.forEach((sample, n) => {
      expect(Math.abs(sample - (original[n] ?? 0))).toBeLessThanOrEqual(Math.abs(original[n] ?? 0) * 0.04 + 40);
    });
    const at16k = new InputDecoder('mulaw8k').push(frame.bytes);
    expect(at16k).toEqual(upsampleTo16k({ samples: decoded, previous: 0 }));
    expect(at16k.length).toBe(320);
  });
});

describe('the phone line', () => {
  it('says it is a phone line: mu-law both ways, and no approvals by voice', () => {
    const line = new PhoneVoiceTransport({ socket: fakeSocket().socket, streamSid: 'MZ1' });
    expect(line.inputFormat).toBe('mulaw8k');
    expect(line.outputFormat).toBe('mulaw8k');
    expect(line.voiceApprovals).toBe(false);
  });

  it('sends audio, clears it at once, and knows when Twilio has played what was sent', async () => {
    const fake = fakeSocket();
    const line = new PhoneVoiceTransport({ socket: fake.socket, streamSid: 'MZ1' });
    line.sendAudio(new Uint8Array([1, 2, 3]));
    line.clearAudio();
    const played = line.whenPlayed();
    expect(fake.sent).toEqual([
      { event: 'media', streamSid: 'MZ1', media: { payload: 'AQID' } },
      { event: 'clear', streamSid: 'MZ1' },
      { event: 'mark', streamSid: 'MZ1', mark: { name: 'played-1' } },
    ]);
    line.onMark('played-1');
    await played;
    line.close();
    expect(fake.closed()).toBe(1000);
  });
});
