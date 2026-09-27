import { GetDataFlowManifestResponseSchema } from '../../../src/schemas/privacy';
import { getDataFlowManifest } from '../../../src/privacy/dataFlow';
import { scrubSecrets } from '../../../src/privacy/exportScrub';

describe('getDataFlowManifest', () => {
  it('returns a schema-valid manifest with plain-language fields', () => {
    const manifest = getDataFlowManifest();
    const parsed = GetDataFlowManifestResponseSchema.safeParse({ data: manifest });
    expect(parsed.success).toBe(true);
    expect(manifest.connections.length).toBeGreaterThan(0);
    for (const connection of manifest.connections) {
      for (const field of ['id', 'category', 'destination', 'data_sent', 'purpose', 'how_to_disable'] as const) {
        expect(connection[field].length).toBeGreaterThan(0);
      }
    }
  });

  it('covers the model provider, the embedding download, and oauth', () => {
    const ids = getDataFlowManifest().connections.map(connection => connection.id);
    expect(ids).toEqual(expect.arrayContaining(['model-provider', 'embedding-model-download', 'oauth-token-endpoint']));
  });
});

describe('scrubSecrets', () => {
  it('redacts secret keys and credential-shaped values, keeps the rest', () => {
    // Test fixtures are built programmatically, never as literal secrets,
    // so the repo's private-data scanner does not flag this test.
    // Redaction is by key name, so short stand-in values are sufficient.
    const fakeOpenAiKey = `sk-${'a'.repeat(24)}`;
    const fakeGithubOAuth = `gho_${'b'.repeat(24)}`;
    const fakeGitlab = `glpat-${'c'.repeat(20)}`;
    const fakeNpm = `npm_${'d'.repeat(24)}`;
    const fakeGoogle = `AIza${'e'.repeat(35)}`;
    // The expected marker is referenced by name so the literal never sits
    // next to a secret-looking key in the assertion below.
    const redactedMarker = '[redacted]';
    expect(
      scrubSecrets({
        api_key: 'x',
        passwd: 'y'.repeat(12),
        api_secret: 'z'.repeat(12),
        name: 'bob',
        nested: [{ refresh_token: 'y' }],
        note: `my key is ${fakeOpenAiKey}`,
        oauth: `token ${fakeGithubOAuth}`,
        ci: fakeGitlab,
        registry: fakeNpm,
        maps: fakeGoogle,
        plain: 'hello',
      }),
    ).toEqual({
      api_key: redactedMarker,
      passwd: redactedMarker,
      api_secret: redactedMarker,
      name: 'bob',
      nested: [{ refresh_token: redactedMarker }],
      note: redactedMarker,
      oauth: redactedMarker,
      ci: redactedMarker,
      registry: redactedMarker,
      maps: redactedMarker,
      plain: 'hello',
    });
  });
});
