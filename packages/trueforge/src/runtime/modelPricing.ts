import { z } from 'zod';

/** Price of one model in USD per million tokens, with an optional name for display. */
export const ModelPriceSchema = z
  .object({
    input_per_million: z.number().nonnegative(),
    output_per_million: z.number().nonnegative(),
    display_name: z.string().trim().min(1).optional(),
  })
  .strict();

/** Prices keyed by the upstream model id the provider is called with. */
export const ModelPricesSchema = z.record(z.string().min(1), ModelPriceSchema);

export type ModelPrice = z.infer<typeof ModelPriceSchema>;
export type ModelPrices = z.infer<typeof ModelPricesSchema>;

/**
 * Default Token Factory list prices, USD per million tokens. EDITABLE: a snapshot of 2026-10-15, not a
 * contract. When Nebius changes a price, override or extend the table with `TOKEN_FACTORY_PRICES`
 * (JSON, same shape) instead of editing it here.
 *
 * Sources, both read 2026-10-15 and in agreement: https://tokenfactory.nebius.com/model-catalog.md and the
 * `pricing` object of each model on `GET https://api.tokenfactory.nebius.com/v1/models?verbose=true`
 * (per-token USD times one million). The keys are the model ids that endpoint lists. Only
 * `nvidia/nemotron-3-super-120b-a12b` is also in catalog/model-catalog.yaml; the other ids are not
 * in the catalog file, so they are reachable by setting `TOKEN_FACTORY_MODEL` or
 * `TOKEN_FACTORY_CHEAPER_MODEL` to them.
 */
export const TOKEN_FACTORY_DEFAULT_PRICES: ModelPrices = {
  'nvidia/nemotron-3-super-120b-a12b': {
    input_per_million: 0.3,
    output_per_million: 0.9,
    display_name: 'Nemotron 3 Super',
  },
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B': {
    input_per_million: 0.06,
    output_per_million: 0.24,
    display_name: 'Nemotron 3 Nano',
  },
  'nvidia/Nemotron-3-Ultra-550b-a55b': {
    input_per_million: 1,
    output_per_million: 3,
    display_name: 'Nemotron 3 Ultra',
  },
  'nvidia/Nemotron-3_5-Lightning': {
    input_per_million: 0.06,
    output_per_million: 0.24,
    display_name: 'Nemotron 3.5 Lightning',
  },
  'nvidia/Nemotron-3.5-Super-VL': {
    input_per_million: 0.3,
    output_per_million: 0.9,
    display_name: 'Nemotron 3.5 Super VL',
  },
  'openai/gpt-oss-120b': { input_per_million: 0.15, output_per_million: 0.6, display_name: 'gpt-oss-120b' },
};

/** The provider type whose models the default table prices. */
const TOKEN_FACTORY_PROVIDER_TYPE = 'tokenfactory';

/**
 * Parses `TOKEN_FACTORY_PRICES`: unset or blank means no overrides. Overrides apply to the named
 * model id on any provider, which is how a non-Token-Factory model gets a cost at all.
 */
export function parseModelPrices({ envKey, raw }: { envKey: string; raw: string | undefined }): ModelPrices {
  if (raw === undefined || raw.trim() === '') {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${envKey} must be valid JSON`, { cause: error });
  }
  const parsed = ModelPricesSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `${envKey} must map a model id to {"input_per_million": number, "output_per_million": number}: ${issues}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/**
 * The price for a model, or undefined when none is known. A configured entry wins over the
 * Token Factory default and keeps the default's display name when it sets none.
 */
export function lookupModelPrice({
  providerType,
  modelId,
  configured,
}: {
  providerType: string;
  modelId: string;
  configured: ModelPrices;
}): ModelPrice | undefined {
  const fromDefaults = providerType === TOKEN_FACTORY_PROVIDER_TYPE ? TOKEN_FACTORY_DEFAULT_PRICES[modelId] : undefined;
  const override = configured[modelId];
  if (override === undefined) {
    return fromDefaults;
  }
  const displayName = override.display_name ?? fromDefaults?.display_name;
  return displayName === undefined ? override : { ...override, display_name: displayName };
}

/** USD for the given token counts at a model's price. */
export function priceTokens({
  price,
  inputTokens,
  outputTokens,
}: {
  price: ModelPrice;
  inputTokens: number;
  outputTokens: number;
}): number {
  return (inputTokens * price.input_per_million + outputTokens * price.output_per_million) / 1_000_000;
}

/** What a model is called in the UI: its configured display name, else the id after the last slash. */
export function modelDisplayName({
  providerType,
  modelId,
  configured,
}: {
  providerType: string;
  modelId: string;
  configured: ModelPrices;
}): string {
  return (
    lookupModelPrice({ providerType, modelId, configured })?.display_name ?? modelId.slice(modelId.lastIndexOf('/') + 1)
  );
}
