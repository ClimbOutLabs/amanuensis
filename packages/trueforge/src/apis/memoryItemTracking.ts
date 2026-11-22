import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMemoryItemTrackingRoute, putMemoryItemTrackingRoute } from '../routes/memoryItemTrackingRoutes';
import {
  MEMORY_ITEM_TRACKING_SETTING_KEY,
  readMemoryItemTrackingSetting,
  type MemoryItemTrackingSetting,
} from '../runtime/memoryItemTrackingSettings';
import type { MemoryItemTracking } from '../schemas/memoryItemTracking';

export interface MemoryItemTrackingRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

function toMemoryItemTracking(setting: MemoryItemTrackingSetting): MemoryItemTracking {
  return {
    enabled: setting.enabled,
    overridden: setting.overridden,
    default_enabled: setting.defaultEnabled,
  };
}

/**
 * Admin/settings item-tracking surface (mounted at
 * /api/v1/settings/memory-item-tracking). `enabled` is the stored setting —
 * the persisted override when one is stored, else the default, which is on;
 * `overridden` reports whether a persisted override is stored.
 */
export function createMemoryItemTrackingRouter<TTransaction>(deps: MemoryItemTrackingRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  const readSetting = () =>
    readMemoryItemTrackingSetting({ globalSettingsStore: deps.globalSettingsStore, logger: deps.logger });

  const getHandler: RouteHandler<typeof getMemoryItemTrackingRoute> = async c => {
    const setting = await readSetting();
    return c.json({ data: toMemoryItemTracking(setting) }, 200);
  };

  const putHandler: RouteHandler<typeof putMemoryItemTrackingRoute> = async c => {
    const body = c.req.valid('json');
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_ITEM_TRACKING_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_ITEM_TRACKING_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    // The write above committed, so the intended state is the stored state. The 200
    // confirmation must not re-read through the default fallback: on a transient store
    // read failure that fallback would fabricate a response contradicting the override just
    // stored (e.g. report on while tracking is actually off).
    const confirmed: MemoryItemTrackingSetting = {
      enabled: body.enabled ?? true,
      overridden: body.enabled !== null,
      defaultEnabled: true,
    };
    return c.json({ data: toMemoryItemTracking(confirmed) }, 200);
  };

  router.openapi(getMemoryItemTrackingRoute, getHandler);
  router.openapi(putMemoryItemTrackingRoute, putHandler);
  return router;
}
