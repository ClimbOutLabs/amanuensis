import type { DriverReadiness } from '@truefoundry/trueforge-core/core';
import { createRunCodeRouter } from '../../../src/apis/runCode';

function statusRequest({ readiness }: { readiness: DriverReadiness | Error | undefined }) {
  const ensureReady = jest.fn((_signal: AbortSignal) =>
    readiness === undefined
      ? undefined
      : readiness instanceof Error
        ? Promise.reject(readiness)
        : Promise.resolve(readiness),
  );
  const router = createRunCodeRouter({ ensureReady });
  router.onError((_error, c) => c.json({ error: { message: 'Internal server error' } }, 500));
  return { ensureReady, response: router.request('/status') };
}

describe('GET /status', () => {
  it('reports not_configured while the sandbox slots are off', async () => {
    const res = await statusRequest({ readiness: undefined }).response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { state: 'not_configured' } });
  });

  it('reports a ready sandbox', async () => {
    const res = await statusRequest({ readiness: { ready: true } }).response;
    expect(await res.json()).toEqual({ data: { state: 'ready' } });
  });

  it('reports the slots being down with the driver text', async () => {
    const res = await statusRequest({
      readiness: { ready: false, error_code: 'slots_unavailable', error: 'The sandbox slots are not running.' },
    }).response;
    expect(await res.json()).toEqual({
      data: { state: 'slots_unavailable', detail: 'The sandbox slots are not running.' },
    });
  });

  it('fails the request when the probe itself throws, so the UI can offer a retry', async () => {
    const res = await statusRequest({ readiness: new Error('probe crashed') }).response;
    expect(res.status).toBe(500);
  });
});
