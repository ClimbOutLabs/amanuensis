import { TOKEN_BUDGET_SAFETY_MARGIN, VERCEL_AI_PROVIDER_NAMES } from '@truefoundry/trueforge-core/core';
import { ModelProviderManifestSchema, modelProviderName } from '../../../src/schemas/modelProvider';

const models = [{ model_id: 'a-model', name: 'a-model', properties: {} }];

function parse(body: Record<string, unknown>): { success: boolean; name?: string; base_url?: string } {
  const result = ModelProviderManifestSchema.safeParse({ auth: { api_key: 'k' }, models, ...body });
  if (!result.success) {
    return { success: false };
  }
  return {
    success: true,
    name: modelProviderName(result.data),
    ...('base_url' in result.data && result.data.base_url !== undefined ? { base_url: result.data.base_url } : {}),
  };
}

/** A custom endpoint is arbitrary, so there is nothing to default to, and nothing to name it after. */
const NAMED_TYPES = ['custom'];
/** Types whose adapter has no implicit host — the endpoint must be supplied (custom by the caller, truefoundry by the store). */
const REQUIRES_BASE_URL = ['custom', 'truefoundry'];

/** Only `custom` takes a name; the others reject one, so fixtures name just that type. */
function providerFor(type: string, body: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, ...(NAMED_TYPES.includes(type) ? { name: 'internal' } : {}), ...body };
}

describe('ModelProviderManifestSchema', () => {
  // A type with no schema of its own leaves its catalog entries unconfigurable.
  it('can configure every adapter the harness can build', () => {
    const rejected = VERCEL_AI_PROVIDER_NAMES.filter(
      type => !parse(providerFor(type, { base_url: 'https://example.com/v1' })).success,
    );
    expect(rejected).toEqual([]);
  });

  // A named endpoint keeps buildLanguageModel off its adapter's implicit default.
  it('defaults base_url for every type that has a known endpoint', () => {
    for (const type of VERCEL_AI_PROVIDER_NAMES) {
      const parsed = parse(providerFor(type));
      if (REQUIRES_BASE_URL.includes(type)) {
        expect([type, parsed.success]).toEqual([type, false]);
      } else {
        expect([type, parsed.base_url]).toEqual([type, expect.stringMatching(/^https:\/\//)]);
      }
    }
  });

  it('keeps a caller-supplied base_url over the default', () => {
    expect(parse({ type: 'openai', base_url: 'https://gateway.internal/v1' }).base_url).toBe(
      'https://gateway.internal/v1',
    );
  });

  // Deriving the name is what makes a second write replace the first, so the body cannot carry one.
  it('names every type but custom after itself, and takes no name from the caller', () => {
    expect(parse({ type: 'anthropic' }).name).toBe('anthropic');
    expect(parse({ type: 'anthropic', name: 'anthropic' }).success).toBe(false);
    expect(parse({ type: 'anthropic', name: 'anthropic-eu' }).success).toBe(false);
  });

  it('requires a caller-supplied name for custom providers', () => {
    const base = { type: 'custom', base_url: 'https://llm.internal/v1' };
    expect(parse({ ...base, name: 'internal' }).name).toBe('internal');
    expect(parse(base).success).toBe(false);
  });

  // An unmappable effort is dropped on the way out, so the session silently runs at the default.
  it('rejects a reasoning effort no adapter can honour', () => {
    const withEfforts = (efforts: string[]): boolean =>
      parse({
        type: 'anthropic',
        models: [{ model_id: 'a-model', name: 'a-model', properties: { reasoning_efforts: efforts } }],
      }).success;
    expect(withEfforts(['low', 'medium', 'high', 'max'])).toBe(true);
    expect(withEfforts(['ultra'])).toBe(false);
  });

  // Absent means false: a model with no `vision` key must not be treated as vision-capable.
  it('accepts an explicit vision flag and defaults it to absent', () => {
    const withVision = (vision: boolean | undefined): unknown => {
      const properties: Record<string, unknown> = {};
      if (vision !== undefined) properties['vision'] = vision;
      const result = ModelProviderManifestSchema.safeParse({
        auth: { api_key: 'k' },
        type: 'anthropic',
        models: [{ model_id: 'a-model', name: 'a-model', properties }],
      });
      return result.success ? result.data.models[0]?.properties['vision'] : undefined;
    };
    expect(withVision(true)).toBe(true);
    expect(withVision(false)).toBe(false);
    expect(withVision(undefined)).toBeUndefined();
  });

  it('rejects a non-boolean vision value', () => {
    const result = ModelProviderManifestSchema.safeParse({
      auth: { api_key: 'k' },
      type: 'anthropic',
      models: [{ model_id: 'a-model', name: 'a-model', properties: { vision: 'yes' } }],
    });
    expect(result.success).toBe(false);
  });

  // Reserving the whole context window for output leaves no room for input, so
  // every turn fails the token pre-flight guard. The schema rejects it up front.
  it('rejects max_output_tokens within the safety margin of context_length', () => {
    const withProperties = (properties: Record<string, unknown>): boolean => {
      const result = ModelProviderManifestSchema.safeParse({
        auth: { api_key: 'k' },
        type: 'anthropic',
        models: [{ model_id: 'a-model', name: 'a-model', properties }],
      });
      return result.success;
    };
    expect(withProperties({ context_length: 128000, max_output_tokens: 128000 })).toBe(false);
    expect(withProperties({ context_length: 128000, max_output_tokens: 200000 })).toBe(false);
    // The runtime guard also holds back a safety margin, so the boundary sits below the context length.
    expect(withProperties({ context_length: 128000, max_output_tokens: 128000 - TOKEN_BUDGET_SAFETY_MARGIN })).toBe(
      false,
    );
    expect(withProperties({ context_length: 128000, max_output_tokens: 128000 - TOKEN_BUDGET_SAFETY_MARGIN - 1 })).toBe(
      true,
    );
    expect(withProperties({ context_length: 128000, max_output_tokens: 4096 })).toBe(true);
    // Either limit alone is fine; the guard only applies to the combination.
    expect(withProperties({ context_length: 128000 })).toBe(true);
    expect(withProperties({ max_output_tokens: 4096 })).toBe(true);
    expect(withProperties({})).toBe(true);
  });

  it('reports a clear message when max output covers the context window', () => {
    const result = ModelProviderManifestSchema.safeParse({
      auth: { api_key: 'k' },
      type: 'anthropic',
      models: [
        {
          model_id: 'a-model',
          name: 'a-model',
          properties: { context_length: 8000, max_output_tokens: 8000 },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(issue => issue.message);
      expect(messages).toContain(
        'Max output tokens must be less than the context length (8,000) minus a small reserve.',
      );
    }
  });
});
