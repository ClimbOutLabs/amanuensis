import { checkModel } from '../../../../../src/cli/doctor/checks/model';
import { DEFAULT_TOKEN_FACTORY_MODEL } from '../../../../../src/runtime/tokenFactoryDefaults';
import type { SmokeCheck } from '../../../../../src/runtime/tokenFactorySmoke';
import { fakeDeps } from '../fakeDeps';

const KEY = 'SENTINEL-token-factory-key';
const MODEL = 'vendor/some-model';
const PASSING: SmokeCheck[] = [
  { ok: true, label: 'GET /models', detail: '12 models' },
  { ok: true, label: `model listed ${MODEL}`, detail: 'present in /models' },
  { ok: true, label: `tool call ${MODEL}`, detail: 'returned get_weather({})' },
];

describe('model check', () => {
  it('is off without a key and makes no request', async () => {
    const tokenFactoryChecks = jest.fn();
    const check = await checkModel({ deps: fakeDeps({ tokenFactoryChecks }), timeoutMs: 1 });
    expect(check).toMatchObject({ id: 'model', state: 'off' });
    expect(tokenFactoryChecks).not.toHaveBeenCalled();
  });

  describe('without a hosted model key, the model comes from a provider added in the app', () => {
    const env = { SQLITE_PATH: '/data/db/db.sqlite' };

    it('warns, pointing at Settings and nothing else, when no provider is set up', async () => {
      const countModelProviders = jest.fn().mockReturnValue(0);
      const check = await checkModel({ deps: fakeDeps({ env, countModelProviders }), timeoutMs: 1 });
      expect(countModelProviders).toHaveBeenCalledWith({ path: '/data/db/db.sqlite' });
      expect(check).toMatchObject({ id: 'model', state: 'warn' });
      expect(check.fix).toBe('Open Aman and add a model in Settings › Models.');
      expect(`${check.detail} ${check.fix}`).not.toMatch(/\.env|docker|aman doctor|NEBIUS|command/);
    });

    it('is ok once a provider is set up', async () => {
      const one = await checkModel({ deps: fakeDeps({ env, countModelProviders: () => 1 }), timeoutMs: 1 });
      expect(one).toMatchObject({ state: 'ok', detail: 'A model provider is set up.' });
      const two = await checkModel({ deps: fakeDeps({ env, countModelProviders: () => 2 }), timeoutMs: 1 });
      expect(two).toMatchObject({ state: 'ok', detail: '2 model providers are set up.' });
    });

    it('is off, never a failure, when the providers cannot be read or the database is not the built-in one', async () => {
      const unreadable = await checkModel({
        deps: fakeDeps({
          env,
          countModelProviders: () => {
            throw new Error('SQLITE_CANTOPEN');
          },
        }),
        timeoutMs: 1,
      });
      expect(unreadable.state).toBe('off');
      const shared = await checkModel({ deps: fakeDeps({ env: { ...env, STANDALONE: 'false' } }), timeoutMs: 1 });
      expect(shared.state).toBe('off');
    });

    it('makes no Token Factory request', async () => {
      const tokenFactoryChecks = jest.fn();
      await checkModel({ deps: fakeDeps({ env, tokenFactoryChecks }), timeoutMs: 1 });
      expect(tokenFactoryChecks).not.toHaveBeenCalled();
    });
  });

  it('asks the shared Token Factory checks for the configured model and passes on success', async () => {
    const tokenFactoryChecks = jest.fn().mockResolvedValue(PASSING);
    const env = {
      NEBIUS_API_KEY: KEY,
      TOKEN_FACTORY_MODEL: MODEL,
      TOKEN_FACTORY_BASE_URL: 'https://tf.example.com/v1',
    };
    const check = await checkModel({ deps: fakeDeps({ env, tokenFactoryChecks }), timeoutMs: 4321 });
    expect(check).toMatchObject({ id: 'model', state: 'ok' });
    expect(check.detail).toContain(MODEL);
    expect(tokenFactoryChecks).toHaveBeenCalledWith({
      apiKey: KEY,
      baseUrl: 'https://tf.example.com/v1',
      model: MODEL,
      timeoutMs: 4321,
    });
  });

  it('falls back to the server defaults for the model and the endpoint', async () => {
    const tokenFactoryChecks = jest.fn().mockResolvedValue(PASSING);
    await checkModel({
      deps: fakeDeps({ env: { NEBIUS_API_KEY: KEY, TOKEN_FACTORY_MODEL: '  ' }, tokenFactoryChecks }),
      timeoutMs: 1,
    });
    expect(tokenFactoryChecks).toHaveBeenCalledWith({
      apiKey: KEY,
      baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      model: DEFAULT_TOKEN_FACTORY_MODEL,
      timeoutMs: 1,
    });
  });

  it.each([
    ['a refused key', { ok: false, label: 'GET /models', detail: 'HTTP 401 unauthorized' }, 'NEBIUS_API_KEY'],
    [
      'an unlisted model',
      { ok: false, label: `model listed ${MODEL}`, detail: 'not in /models' },
      'TOKEN_FACTORY_MODEL',
    ],
    ['a model without tool calls', { ok: false, label: `tool call ${MODEL}`, detail: 'no tool_calls' }, 'tool calls'],
    ['no network', { ok: false, label: 'GET /models', detail: 'fetch failed (ENOTFOUND)' }, 'port 443'],
  ])('fails with a matching fix for %s', async (_name, failed, hint) => {
    const check = await checkModel({
      deps: fakeDeps({ env: { NEBIUS_API_KEY: KEY }, tokenFactoryChecks: () => Promise.resolve([failed]) }),
      timeoutMs: 1,
    });
    expect(check.state).toBe('fail');
    expect(check.fix).toContain(hint);
    expect(JSON.stringify(check)).not.toContain(KEY);
  });
});
