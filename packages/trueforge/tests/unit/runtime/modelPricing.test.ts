import {
  lookupModelPrice,
  modelDisplayName,
  parseModelPrices,
  priceTokens,
  TOKEN_FACTORY_DEFAULT_PRICES,
} from '../../../src/runtime/modelPricing';

const SUPER = 'nvidia/nemotron-3-super-120b-a12b';
const NANO = 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

describe('default Token Factory prices', () => {
  it('prices the Nemotron family and the default cheaper model', () => {
    expect(TOKEN_FACTORY_DEFAULT_PRICES[SUPER]).toEqual({
      input_per_million: 0.3,
      output_per_million: 0.9,
      display_name: 'Nemotron 3 Super',
    });
    expect(TOKEN_FACTORY_DEFAULT_PRICES[NANO]).toMatchObject({ input_per_million: 0.06, output_per_million: 0.24 });
    expect(TOKEN_FACTORY_DEFAULT_PRICES['openai/gpt-oss-120b']).toBeDefined();
  });
});

describe('priceTokens', () => {
  it('multiplies tokens by the per-million price on each side', () => {
    const price = { input_per_million: 0.3, output_per_million: 0.9 };

    expect(priceTokens({ price, inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(1.2, 10);
    expect(priceTokens({ price, inputTokens: 1800, outputTokens: 340 })).toBeCloseTo(0.000846, 10);
    expect(priceTokens({ price, inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe('lookupModelPrice', () => {
  it('uses the default table for Token Factory models only', () => {
    expect(lookupModelPrice({ providerType: 'tokenfactory', modelId: SUPER, configured: {} })).toBe(
      TOKEN_FACTORY_DEFAULT_PRICES[SUPER],
    );
    expect(lookupModelPrice({ providerType: 'custom', modelId: SUPER, configured: {} })).toBeUndefined();
    expect(lookupModelPrice({ providerType: 'tokenfactory', modelId: 'acme/unknown', configured: {} })).toBeUndefined();
  });

  it('lets a configured price win, keep the default display name, and price a model on any provider', () => {
    const configured = { [SUPER]: { input_per_million: 1, output_per_million: 2 } };

    expect(lookupModelPrice({ providerType: 'tokenfactory', modelId: SUPER, configured })).toEqual({
      input_per_million: 1,
      output_per_million: 2,
      display_name: 'Nemotron 3 Super',
    });
    expect(lookupModelPrice({ providerType: 'custom', modelId: SUPER, configured })).toEqual({
      input_per_million: 1,
      output_per_million: 2,
    });
  });
});

describe('modelDisplayName', () => {
  it('prefers the configured name, then the id after the last slash', () => {
    expect(modelDisplayName({ providerType: 'tokenfactory', modelId: NANO, configured: {} })).toBe('Nemotron 3 Nano');
    expect(modelDisplayName({ providerType: 'custom', modelId: 'org/some-model', configured: {} })).toBe('some-model');
    expect(modelDisplayName({ providerType: 'custom', modelId: 'plain', configured: {} })).toBe('plain');
    expect(
      modelDisplayName({
        providerType: 'custom',
        modelId: 'org/some-model',
        configured: { 'org/some-model': { input_per_million: 0, output_per_million: 0, display_name: 'Some Model' } },
      }),
    ).toBe('Some Model');
  });
});

describe('parseModelPrices', () => {
  const parse = (raw: string | undefined) => parseModelPrices({ envKey: 'TOKEN_FACTORY_PRICES', raw });

  it('reads no overrides from an unset or blank value', () => {
    expect(parse(undefined)).toEqual({});
    expect(parse('  ')).toEqual({});
  });

  it('parses a JSON map of model id to per-million prices', () => {
    expect(parse(`{"${SUPER}":{"input_per_million":0.25,"output_per_million":0.8,"display_name":"Super"}}`)).toEqual({
      [SUPER]: { input_per_million: 0.25, output_per_million: 0.8, display_name: 'Super' },
    });
  });

  it('rejects invalid JSON, keeping the cause', () => {
    expect(() => parse('{nope')).toThrow('TOKEN_FACTORY_PRICES must be valid JSON');
    try {
      parse('{nope');
    } catch (error) {
      expect(error).toHaveProperty('cause');
    }
  });

  it.each([
    ['a missing output price', '{"m":{"input_per_million":1}}'],
    ['a negative price', '{"m":{"input_per_million":-1,"output_per_million":1}}'],
    ['a string price', '{"m":{"input_per_million":"1","output_per_million":1}}'],
    ['an unknown field', '{"m":{"input_per_million":1,"output_per_million":1,"extra":true}}'],
    ['an array', '[]'],
  ])('rejects %s', (_label, raw) => {
    expect(() => parse(raw)).toThrow('TOKEN_FACTORY_PRICES must map a model id to');
  });
});
