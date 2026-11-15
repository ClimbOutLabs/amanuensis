import { callVoiceReady, createCallReadiness, type CallVoice } from '../../../../src/runtime/calls/callVoiceReady';
import type { TtsHealth } from '../../../../src/voice/ttsClient';

const ready = {
  sttReady: () => true,
  tts: () => Promise.resolve<TtsHealth>('ready'),
  vadModel: () => Promise.resolve(new Uint8Array(1)),
};

describe('whether a call can talk', () => {
  it('is ready only when it can listen, speak and find its listening model', async () => {
    await expect(callVoiceReady(ready)).resolves.toBe('ready');
  });

  it('is not ready when speech to text is down', async () => {
    await expect(callVoiceReady({ ...ready, sttReady: () => false })).resolves.toBe('not_running');
  });

  it('is not ready when the voice cannot speak, so the phone never rings in silence', async () => {
    await expect(callVoiceReady({ ...ready, tts: () => Promise.resolve<TtsHealth>('down') })).resolves.toBe(
      'not_running',
    );
  });

  it('says out of date when the voice runs but cannot check exact speech', async () => {
    await expect(callVoiceReady({ ...ready, tts: () => Promise.resolve<TtsHealth>('no_exact') })).resolves.toBe(
      'out_of_date',
    );
  });

  it('is not ready when the listening model is missing', async () => {
    await expect(callVoiceReady({ ...ready, vadModel: () => Promise.reject(new Error('missing')) })).resolves.toBe(
      'not_running',
    );
  });
});

describe('one answer to whether calls can work', () => {
  it('is not ready until checked, then holds the last check for everything that asks', async () => {
    let ready: CallVoice = 'ready';
    const readiness = createCallReadiness(() => Promise.resolve(ready));
    expect(readiness.current()).toBe('not_running');
    await expect(readiness.check()).resolves.toBe('ready');
    expect(readiness.current()).toBe('ready');
    ready = 'out_of_date';
    expect(readiness.current()).toBe('ready');
    await expect(readiness.check()).resolves.toBe('out_of_date');
    expect(readiness.current()).toBe('out_of_date');
  });

  it('counts a check that fails as not ready', async () => {
    const readiness = createCallReadiness(() => Promise.reject(new Error('down')));
    await expect(readiness.check()).resolves.toBe('not_running');
    expect(readiness.current()).toBe('not_running');
  });

  it('runs one check at a time, and callers that ask meanwhile share it', async () => {
    let checks = 0;
    const readiness = createCallReadiness(() => {
      checks += 1;
      return Promise.resolve<CallVoice>('ready');
    });
    await Promise.all([readiness.check(), readiness.check(), readiness.check()]);
    expect(checks).toBe(1);
  });
});
