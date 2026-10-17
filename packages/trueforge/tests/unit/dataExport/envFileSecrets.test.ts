import { envFileSecretValues } from '../../../src/dataExport/envFileSecrets';

describe('envFileSecretValues', () => {
  it('takes the values of credential settings and the passwords inside URLs, and nothing else', () => {
    const text = [
      '# a comment',
      'NEBIUS_API_KEY=invented-model-key-0000aaaa1111',
      'export OIDC_CLIENT_SECRET="invented-client-secret-2222bbbb"',
      "MEMORY_SCREEN_AUTH_TOKEN='invented-token-3333cccc'",
      'POSTGRES_PASSWORD=invented-db-pass',
      'DATABASE_URL=postgres://aman:invented%2Fpass-4444@postgres:5432/aman',
      'PUBLIC_BASE_URL=http://localhost:8791',
      'STANDALONE=false',
      'TRUEFORGE_API_KEY=',
      'not a setting line',
    ].join('\r\n');
    expect(envFileSecretValues(text).sort()).toEqual(
      [
        'invented-model-key-0000aaaa1111',
        'invented-client-secret-2222bbbb',
        'invented-token-3333cccc',
        'invented-db-pass',
        'postgres://aman:invented%2Fpass-4444@postgres:5432/aman',
        'invented/pass-4444',
      ].sort(),
    );
  });

  it('leaves model names, addresses and numbers alone even when their setting name mentions a token', () => {
    const text = [
      'TOKEN_FACTORY_MODEL=nvidia/nemotron-3-super-120b-a12b',
      'TOKEN_FACTORY_BASE_URL=https://api.tokenfactory.example.invalid/v1/',
      'TOKEN_FACTORY_DAILY_TOKEN_CAP=20000000',
      'TOKEN_FACTORY_PRICES={"nvidia/nemotron-3-super-120b-a12b":{"input_per_million":0.3,"output_per_million":0.9}}',
      'CONTEXT_COMPACTION_THRESHOLD_TOKENS=50000',
      'TRUEFOUNDRY_API_KEY=invented-platform-key-5555dddd',
    ].join('\n');
    expect(envFileSecretValues(text)).toEqual(['invented-platform-key-5555dddd']);
  });

  it('reads quoted values the way docker compose does, without inline comments and with escapes applied', () => {
    const text = [
      'NEBIUS_API_KEY="invented-model-key-6666" # the model key',
      "TRUEFORGE_API_KEY='invented-service-key-7777' # the service key",
      'OIDC_CLIENT_SECRET="invented-\\"quoted\\"-secret-8888"',
      'MEMORY_SCREEN_AUTH_TOKEN=invented-token-9999 # the screen token',
    ].join('\n');
    expect(envFileSecretValues(text).sort()).toEqual(
      [
        'invented-model-key-6666',
        'invented-service-key-7777',
        'invented-"quoted"-secret-8888',
        'invented-token-9999',
      ].sort(),
    );
  });
});
