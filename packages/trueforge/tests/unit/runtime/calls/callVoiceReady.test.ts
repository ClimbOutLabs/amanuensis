import { callVoiceReady } from '../../../../src/runtime/calls/callVoiceReady';

const ready = {
  sttReady: () => true,
  ttsReady: () => Promise.resolve(true),
  vadModel: () => Promise.resolve(new Uint8Array(1)),
};

describe('whether a call can talk', () => {
  it('is ready only when it can listen, speak and find its listening model', async () => {
    await expect(callVoiceReady(ready)).resolves.toBe(true);
  });

  it('is not ready when speech to text is down', async () => {
    await expect(callVoiceReady({ ...ready, sttReady: () => false })).resolves.toBe(false);
  });

  it('is not ready when the voice cannot speak, so the phone never rings in silence', async () => {
    await expect(callVoiceReady({ ...ready, ttsReady: () => Promise.resolve(false) })).resolves.toBe(false);
  });

  it('is not ready when the listening model is missing', async () => {
    await expect(callVoiceReady({ ...ready, vadModel: () => Promise.reject(new Error('missing')) })).resolves.toBe(
      false,
    );
  });
});
