import { checkService } from '../../../../../src/cli/doctor/checks/service';
import { fakeDeps, networkError, response } from '../fakeDeps';

describe('service check', () => {
  it('is ok when /healthz answers 200 on the default port', async () => {
    const get = jest.fn().mockResolvedValue(response());
    const check = await checkService({ deps: fakeDeps({ get }), timeoutMs: 1234 });
    expect(check).toMatchObject({ id: 'service', state: 'ok' });
    expect(get).toHaveBeenCalledWith({ url: 'http://127.0.0.1:8790/healthz', timeoutMs: 1234 });
  });

  it('probes the configured PORT', async () => {
    const get = jest.fn().mockResolvedValue(response());
    await checkService({ deps: fakeDeps({ get, env: { PORT: '9001' } }), timeoutMs: 1 });
    expect(get).toHaveBeenCalledWith({ url: 'http://127.0.0.1:9001/healthz', timeoutMs: 1 });
  });

  it('fails with a fix when the app answers with an error status', async () => {
    const check = await checkService({
      deps: fakeDeps({ get: () => Promise.resolve(response({ status: 503 })) }),
      timeoutMs: 1,
    });
    expect(check.state).toBe('fail');
    expect(check.detail).toContain('503');
    expect(check.fix).not.toBe('');
  });

  it('fails with a fix when nothing answers', async () => {
    const check = await checkService({
      deps: fakeDeps({ get: () => Promise.reject(networkError('ECONNREFUSED')) }),
      timeoutMs: 1,
    });
    expect(check.state).toBe('fail');
    expect(check.detail).toContain('ECONNREFUSED');
    expect(check.fix).not.toBe('');
  });

  it('fails on a PORT that is not a number without making a request', async () => {
    const get = jest.fn();
    const check = await checkService({ deps: fakeDeps({ get, env: { PORT: 'abc' } }), timeoutMs: 1 });
    expect(check.state).toBe('fail');
    expect(get).not.toHaveBeenCalled();
  });
});
