import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { sumKnownCostUsd } from '@truefoundry/trueforge-core/core/util/usageCost';

import configuration from '../config';
import { getTokenFactoryUsageRoute } from '../routes/tokenFactoryUsageRoutes';
import { lookupModelPrice, modelDisplayName, priceTokens, type ModelPrices } from '../runtime/modelPricing';
import type { TokenFactoryBudget, TokenFactoryDay } from '../runtime/tokenFactoryBudget';
import type { TokenFactoryUsage } from '../schemas/tokenFactoryUsage';

// The counters only ever hold Token Factory traffic, so its default prices apply.
const PROVIDER_TYPE = 'tokenfactory';

/** One day's counters as the settings view shows them: per-model cost, and what is left under the cap. */
export function describeTokenFactoryDay({
  day,
  prices,
}: {
  day: TokenFactoryDay;
  prices: ModelPrices;
}): TokenFactoryUsage {
  const models = day.models.map(model => {
    const price = lookupModelPrice({ providerType: PROVIDER_TYPE, modelId: model.model_id, configured: prices });
    return {
      model_id: model.model_id,
      display_name: modelDisplayName({ providerType: PROVIDER_TYPE, modelId: model.model_id, configured: prices }),
      input_tokens: model.input_tokens,
      output_tokens: model.output_tokens,
      calls: model.calls,
      cost_usd:
        price === undefined
          ? null
          : priceTokens({ price, inputTokens: model.input_tokens, outputTokens: model.output_tokens }),
    };
  });
  const costs = models.map(model => model.cost_usd);
  return {
    usage_date: day.usage_date,
    cap_tokens: day.cap_tokens ?? null,
    used_tokens: day.used_tokens,
    remaining_tokens: day.cap_tokens === undefined ? null : Math.max(day.cap_tokens - day.used_tokens, 0),
    cost_usd: sumKnownCostUsd(costs),
    models,
  };
}

/**
 * Admin/settings daily Token Factory usage surface (mounted at /api/v1/settings/token-factory-usage):
 * the per-model counters the budget keeps for the day, priced from the configured table.
 */
export function createTokenFactoryUsageRouter({ budget }: { budget: TokenFactoryBudget }) {
  const router = new OpenAPIHono();
  const getHandler: RouteHandler<typeof getTokenFactoryUsageRoute> = async c => {
    const day = await budget.today();
    return c.json({ data: describeTokenFactoryDay({ day, prices: configuration.TOKEN_FACTORY_PRICES }) }, 200);
  };
  router.openapi(getTokenFactoryUsageRoute, getHandler);
  return router;
}
