import { getConfiguredSecretValues } from '../../../src/config';

const synthetic = {
  TRUEFORGE_API_KEY: 'synthetic-service-key-0001',
  NEBIUS_API_KEY: 'synthetic-nebius-key-0002',
  MEMORY_SCREEN_AUTH_TOKEN: 'synthetic-screen-token-0003',
};

describe('getConfiguredSecretValues', () => {
  it('lists the credentials a standalone process holds and skips unset or empty ones', () => {
    expect(
      getConfiguredSecretValues({
        STANDALONE: true,
        ...synthetic,
        MEMORY_SCREEN_AUTH_TOKEN: '',
        NEBIUS_API_KEY: undefined,
      }),
    ).toEqual(['synthetic-service-key-0001']);
  });

  it('adds the distributed credentials, including the passwords inside connection URLs', () => {
    const distributed = {
      STANDALONE: false as const,
      ...synthetic,
      OIDC: undefined,
      TRUEFOUNDRY_API_KEY: 'synthetic-platform-key-0004',
      TRUEFOUNDRY_SANDBOX_API_KEY: undefined,
      DATABASE_URL: 'postgres://app:p%40ss%2Fword-0005@db.internal:5432/app',
      REDIS_URL: 'redis://:redis-pass-0006@cache.internal:6379',
    };
    expect(getConfiguredSecretValues(distributed)).toEqual([
      'synthetic-service-key-0001',
      'synthetic-nebius-key-0002',
      'synthetic-screen-token-0003',
      'synthetic-platform-key-0004',
      'postgres://app:p%40ss%2Fword-0005@db.internal:5432/app',
      'p@ss/word-0005',
      'redis://:redis-pass-0006@cache.internal:6379',
      'redis-pass-0006',
    ]);
  });
});
