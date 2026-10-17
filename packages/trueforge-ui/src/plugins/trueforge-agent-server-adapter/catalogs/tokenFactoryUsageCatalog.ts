import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** Today's Token Factory counters per model, and the daily cap with what is left under it. */
export type TokenFactoryUsage = TrueForgeApi.TokenFactoryUsage;

export interface TokenFactoryUsageCatalog {
  getTokenFactoryUsage(): Promise<TokenFactoryUsage>;
}

/**
 * Reads `GET /api/v1/settings/token-factory-usage` through the SDK client. Admin-only on the
 * server; a caller without access gets the SDK's error, which the panel shows as unavailable.
 */
export function createTokenFactoryUsageCatalog(client: TrueForge): TokenFactoryUsageCatalog {
  return {
    getTokenFactoryUsage: async () => (await client.settings.tokenFactoryUsage.get()).data,
  };
}
