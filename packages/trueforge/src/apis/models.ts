import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import type { ResolveRequestContext } from '../auth/identity';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { WithTransaction } from '../db/transaction';
import { listAvailableModelsRoute } from '../routes/modelRoutes';
import { putDefaultModelFirst, readDefaultChatModel } from '../runtime/tokenFactoryProvider';

/** Chat slim list (mounted at /api/v1/models) — mirrors GET /api/v1/skills. */
export function createModelsRouter<TTransaction>(deps: {
  resolveModelProviderStore: (c: Context) => IModelProviderStore<TTransaction>;
  withTransaction: WithTransaction<TTransaction>;
  resolveRequestContext: ResolveRequestContext;
  /** Holds the default chat model, which the list puts first so pickers start on it. */
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}) {
  const router = new OpenAPIHono();
  router.openapi(listAvailableModelsRoute, async c => {
    const store = deps.resolveModelProviderStore(c);
    const requestContext = deps.resolveRequestContext(c);
    const models = await store.listModels({ tenant_id: requestContext.tenant_id });
    const defaultModel = await readDefaultChatModel({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    return c.json({ data: putDefaultModelFirst(models, defaultModel) }, 200);
  });
  return router;
}
