import { callVoiceReady, createCallReadiness } from '../../../../src/runtime/calls/callVoiceReady';

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

describe('one answer to whether calls can work', () => {
  it('is not ready until checked, then holds the last check for everything that asks', async () => {
    let ready = true;
    const readiness = createCallReadiness(() => Promise.resolve(ready));
    expect(readiness.current()).toBe(false);
    await expect(readiness.check()).resolves.toBe(true);
    expect(readiness.current()).toBe(true);
    ready = false;
    expect(readiness.current()).toBe(true);
    await expect(readiness.check()).resolves.toBe(false);
    expect(readiness.current()).toBe(false);
  });

  it('counts a check that fails as not ready', async () => {
    const readiness = createCallReadiness(() => Promise.reject(new Error('down')));
    await expect(readiness.check()).resolves.toBe(false);
    expect(readiness.current()).toBe(false);
  });

  it('runs one check at a time, and callers that ask meanwhile share it', async () => {
    let checks = 0;
    const readiness = createCallReadiness(() => {
      checks += 1;
      return Promise.resolve(true);
    });
    await Promise.all([readiness.check(), readiness.check(), readiness.check()]);
    expect(checks).toBe(1);
  });
});
