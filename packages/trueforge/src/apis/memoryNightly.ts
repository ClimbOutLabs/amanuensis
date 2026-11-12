import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMemoryNightlyRoute, putMemoryNightlyRoute } from '../routes/memoryNightlyRoutes';
import {
  MEMORY_NIGHTLY_SETTING_KEY,
  readMemoryNightlySetting,
  type MemoryNightlySetting,
} from '../runtime/memoryNightlySettings';
import type { MemoryNightly } from '../schemas/memoryNightly';

export interface MemoryNightlyRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

function toMemoryNightly(setting: MemoryNightlySetting): MemoryNightly {
  return {
    enabled: setting.enabled,
    overridden: setting.overridden,
    default_enabled: setting.defaultEnabled,
    effective_enabled: setting.effectiveEnabled,
  };
}

/** Admin/settings nightly tidy-up surface (mounted at /api/v1/settings/memory-nightly). */
export function createMemoryNightlyRouter<TTransaction>(deps: MemoryNightlyRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();

  const getHandler: RouteHandler<typeof getMemoryNightlyRoute> = async c => {
    const setting = await readMemoryNightlySetting({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    return c.json({ data: toMemoryNightly(setting) }, 200);
  };

  const putHandler: RouteHandler<typeof putMemoryNightlyRoute> = async c => {
    const body = c.req.valid('json');
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_NIGHTLY_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_NIGHTLY_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    // Confirm from what was just written, not a re-read: a failed read would fall back to the env default
    // and contradict the change the person just made.
    const defaultEnabled = configuration.MEMORY_NIGHTLY_JOB;
    const enabled = body.enabled ?? defaultEnabled;
    return c.json(
      {
        data: toMemoryNightly({
          enabled,
          overridden: body.enabled !== null,
          defaultEnabled,
          effectiveEnabled: enabled,
        }),
      },
      200,
    );
  };

  router.openapi(getMemoryNightlyRoute, getHandler);
  router.openapi(putMemoryNightlyRoute, putHandler);
  return router;
}
