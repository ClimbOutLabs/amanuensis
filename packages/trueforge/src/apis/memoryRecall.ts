import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMemoryRecallRoute, putMemoryRecallRoute } from '../routes/memoryRecallRoutes';
import { MEMORY_RECALL_ENABLED_SETTING_KEY, readMemoryRecallSetting } from '../runtime/memoryRecallSettings';

export interface MemoryRecallRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

/** Settings surface for the person-level memory recall switch (mounted at /api/v1/settings/memory-recalls). */
export function createMemoryRecallRouter<TTransaction>(deps: MemoryRecallRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();

  const getHandler: RouteHandler<typeof getMemoryRecallRoute> = async c => {
    const enabled = await readMemoryRecallSetting({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    return c.json({ data: { enabled: enabled ?? null } }, 200);
  };

  const putHandler: RouteHandler<typeof putMemoryRecallRoute> = async c => {
    const body = c.req.valid('json');
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_RECALL_ENABLED_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_RECALL_ENABLED_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    // Echo what was written: a re-read could fail and report a state that was never stored.
    return c.json({ data: { enabled: body.enabled } }, 200);
  };

  router.openapi(getMemoryRecallRoute, getHandler);
  router.openapi(putMemoryRecallRoute, putHandler);
  return router;
}
