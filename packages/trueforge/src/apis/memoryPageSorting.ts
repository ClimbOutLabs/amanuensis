import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMemoryPageSortingRoute, putMemoryPageSortingRoute } from '../routes/memoryPageSortingRoutes';
import {
  MEMORY_PAGE_SORTING_SETTING_KEY,
  readMemoryPageSortingSetting,
  type MemoryPageSortingSetting,
} from '../runtime/memoryPageSortingSettings';
import type { MemoryPageSorting } from '../schemas/memoryPageSorting';

export interface MemoryPageSortingRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

function toMemoryPageSorting(setting: MemoryPageSortingSetting): MemoryPageSorting {
  return {
    mode: setting.mode,
    overridden: setting.overridden,
    default_mode: setting.defaultMode,
  };
}

/** Admin/settings page-sorting surface (mounted at /api/v1/settings/memory-page-sorting). */
export function createMemoryPageSortingRouter<TTransaction>(deps: MemoryPageSortingRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();

  const getHandler: RouteHandler<typeof getMemoryPageSortingRoute> = async c => {
    const setting = await readMemoryPageSortingSetting({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    return c.json({ data: toMemoryPageSorting(setting) }, 200);
  };

  const putHandler: RouteHandler<typeof putMemoryPageSortingRoute> = async c => {
    const body = c.req.valid('json');
    if (body.mode === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({ key: MEMORY_PAGE_SORTING_SETTING_KEY, value: body.mode });
    }
    // Confirm from what was just written, not a re-read: a failed read would fall back to the env default
    // and contradict the change the person just made.
    const defaultMode = configuration.MEMORY_PAGE_SORTING;
    const mode = body.mode ?? defaultMode;
    return c.json(
      {
        data: toMemoryPageSorting({
          mode,
          overridden: body.mode !== null,
          defaultMode,
        }),
      },
      200,
    );
  };

  router.openapi(getMemoryPageSortingRoute, getHandler);
  router.openapi(putMemoryPageSortingRoute, putHandler);
  return router;
}
