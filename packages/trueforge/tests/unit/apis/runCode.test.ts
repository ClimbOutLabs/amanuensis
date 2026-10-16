import type { DriverReadiness } from '@truefoundry/trueforge-core/core';
import { createRunCodeRouter } from '../../../src/apis/runCode';

function statusRequest({
  imageConfigured,
  readiness,
}: {
  imageConfigured: boolean;
  readiness: DriverReadiness | Error;
}) {
  const ensureReady = jest.fn((_signal: AbortSignal) =>
    readiness instanceof Error ? Promise.reject(readiness) : Promise.resolve(readiness),
  );
  const router = createRunCodeRouter({ imageConfigured: () => imageConfigured, ensureReady });
  router.onError((_error, c) => c.json({ error: { message: 'Internal server error' } }, 500));
  return { ensureReady, response: router.request('/status') };
}

describe('GET /status', () => {
  it('reports not_configured without probing Docker while no image is pinned', async () => {
    const { ensureReady, response } = statusRequest({ imageConfigured: false, readiness: { ready: true } });
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { state: 'not_configured' } });
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it('reports a ready sandbox', async () => {
    const res = await statusRequest({ imageConfigured: true, readiness: { ready: true } }).response;
    expect(await res.json()).toEqual({ data: { state: 'ready' } });
  });

  it('reports Docker as unavailable on a server without Docker access', async () => {
    const res = await statusRequest({
      imageConfigured: true,
      readiness: { ready: false, error_code: 'docker_unavailable', error: 'Docker was not detected' },
    }).response;
    expect(await res.json()).toEqual({ data: { state: 'docker_unavailable' } });
  });

  it('keeps the signature failure text for the admin', async () => {
    const res = await statusRequest({
      imageConfigured: true,
      readiness: {
        ready: false,
        error_code: 'image_unavailable',
        error: 'cosign signature verification failed',
        reason: 'signature_unverified',
      },
    }).response;
    expect(await res.json()).toEqual({
      data: { state: 'signature_unverified', detail: 'cosign signature verification failed' },
    });
  });

  it('fails the request when the probe itself throws, so the UI can offer a retry', async () => {
    const res = await statusRequest({ imageConfigured: true, readiness: new Error('probe crashed') }).response;
    expect(res.status).toBe(500);
  });
});
