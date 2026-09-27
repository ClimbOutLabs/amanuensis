import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMemoryScreenRoute, putMemoryScreenRoute } from '../routes/memoryScreenRoutes';
import {
  MEMORY_SCREEN_ENABLED_SETTING_KEY,
  readMemoryScreenSetting,
  type MemoryScreenSetting,
} from '../runtime/memoryScreenSettings';
import type { MemoryScreen } from '../schemas/memoryScreen';

export interface MemoryScreensRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

function toMemoryScreen(setting: MemoryScreenSetting): MemoryScreen {
  return {
    enabled: setting.enabled,
    overridden: setting.overridden,
    default_enabled: setting.defaultEnabled,
  };
}

/**
 * Admin/settings recall screen surface (mounted at /api/v1/settings/memory-screens).
 * `enabled` is the stored setting — the persisted override when one is stored, else
 * the env default — NOT the effective runtime state (recall screening is effectively
 * off when no screening service is configured); `overridden` reports whether a
 * persisted override is stored.
 */
export function createMemoryScreensRouter<TTransaction>(deps: MemoryScreensRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  const readSetting = () =>
    readMemoryScreenSetting({ globalSettingsStore: deps.globalSettingsStore, logger: deps.logger });

  const getHandler: RouteHandler<typeof getMemoryScreenRoute> = async c => {
    const setting = await readSetting();
    return c.json({ data: toMemoryScreen(setting) }, 200);
  };

  const putHandler: RouteHandler<typeof putMemoryScreenRoute> = async c => {
    const body = c.req.valid('json');
    // Turning recall screening ON requires a classifier to call: a stored ON override with
    // no screening service configured would promise screening the server cannot perform.
    // Explicitly turning it OFF (or clearing the override) stays allowed: the user may
    // want to record "off" even when there is no service to call.
    if (body.enabled === true && configuration.MEMORY_SCREEN_URL === '') {
      return c.json(
        {
          error: {
            message:
              'Cannot change the recall screen setting: no screening service is configured (`MEMORY_SCREEN_URL` is unset).',
            code: 'memory_screen_not_configured',
          },
        },
        409,
      );
    }
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_SCREEN_ENABLED_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_SCREEN_ENABLED_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    // The write above committed, so the intended state is the stored state. The 200
    // confirmation must not re-read through the env-default fallback: on a transient store
    // read failure that fallback would fabricate a response contradicting the override just
    // stored (e.g. report on while screening is actually off).
    const defaultEnabled = configuration.MEMORY_SCREEN_ENABLED;
    const confirmed: MemoryScreenSetting = {
      enabled: body.enabled ?? defaultEnabled,
      overridden: body.enabled !== null,
      defaultEnabled,
    };
    return c.json({ data: toMemoryScreen(confirmed) }, 200);
  };

  router.openapi(getMemoryScreenRoute, getHandler);
  router.openapi(putMemoryScreenRoute, putHandler);
  return router;
}
