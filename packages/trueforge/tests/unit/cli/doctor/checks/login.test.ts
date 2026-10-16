import { checkLogin, probeLogin } from '../../../../../src/cli/doctor/checks/login';
import { fakeDeps, networkError, response } from '../fakeDeps';

const ISSUER = 'http://127.0.0.1:5556/dex';
const DISCOVERY = { issuer: ISSUER };

describe('login probe and check', () => {
  it('requests the discovery document under the issuer', async () => {
    const get = jest.fn().mockResolvedValue(response({ json: DISCOVERY }));
    const probe = await probeLogin({ deps: fakeDeps({ get, env: { OIDC_ISSUER_URL: `${ISSUER}/` } }), timeoutMs: 77 });
    expect(get).toHaveBeenCalledWith({
      url: 'http://127.0.0.1:5556/dex/.well-known/openid-configuration',
      timeoutMs: 77,
    });
    expect(checkLogin(probe)).toMatchObject({ id: 'login', state: 'ok' });
  });

  it('fails with a fix when no issuer is configured, without a request', async () => {
    const get = jest.fn();
    const probe = await probeLogin({ deps: fakeDeps({ get }), timeoutMs: 1 });
    const check = checkLogin(probe);
    expect(check.state).toBe('fail');
    expect(check.fix).not.toBe('');
    expect(get).not.toHaveBeenCalled();
  });

  it('fails with a fix when the issuer is not a URL, without echoing it', async () => {
    const probe = await probeLogin({ deps: fakeDeps({ env: { OIDC_ISSUER_URL: 'SENTINEL nonsense' } }), timeoutMs: 1 });
    const check = checkLogin(probe);
    expect(check.state).toBe('fail');
    expect(JSON.stringify(check)).not.toContain('SENTINEL');
  });

  it('fails with a fix when the provider is unreachable and keeps credentials out of the report', async () => {
    const env = { OIDC_ISSUER_URL: 'https://owner:SENTINEL@login.example.com/dex?k=SENTINEL' };
    const probe = await probeLogin({
      deps: fakeDeps({ env, get: () => Promise.reject(networkError('ENOTFOUND')) }),
      timeoutMs: 1,
    });
    const check = checkLogin(probe);
    expect(check.state).toBe('fail');
    expect(check.detail).toContain('login.example.com');
    expect(check.detail).toContain('ENOTFOUND');
    expect(check.fix).not.toBe('');
    expect(JSON.stringify(check)).not.toContain('SENTINEL');
  });

  it('fails when the address answers but is not a discovery document', async () => {
    for (const reply of [response({ status: 404 }), response({ json: { hello: 'world' } }), response({ json: 'x' })]) {
      const probe = await probeLogin({
        deps: fakeDeps({ env: { OIDC_ISSUER_URL: ISSUER }, get: () => Promise.resolve(reply) }),
        timeoutMs: 1,
      });
      const check = checkLogin(probe);
      expect(check.state).toBe('fail');
      expect(check.fix).not.toBe('');
    }
  });
});
