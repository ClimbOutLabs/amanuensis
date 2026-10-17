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
      'EMPTY_TOKEN=',
      'not a setting line',
    ].join('\r\n');
    expect(envFileSecretValues(text)).toEqual([
      'invented-model-key-0000aaaa1111',
      'invented-client-secret-2222bbbb',
      'invented-token-3333cccc',
      'invented-db-pass',
      'invented/pass-4444',
    ]);
  });
});
