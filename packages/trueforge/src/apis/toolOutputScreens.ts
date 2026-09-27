import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getToolOutputScreenRoute, putToolOutputScreenRoute } from '../routes/toolOutputScreenRoutes';
import {
  TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY,
  readToolOutputScreenSetting,
  type ToolOutputScreenSetting,
} from '../runtime/toolOutputScreenSettings';
import type { ToolOutputScreen } from '../schemas/toolOutputScreen';

export interface ToolOutputScreensRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

function toToolOutputScreen(setting: ToolOutputScreenSetting): ToolOutputScreen {
  return {
    enabled: setting.enabled,
    overridden: setting.overridden,
    default_enabled: setting.defaultEnabled,
  };
}

/**
 * Admin/settings live tool-output screen surface (mounted at
 * /api/v1/settings/tool-output-screens). `enabled` is the stored setting —
 * the persisted override when one is stored, else the env default —
 * NOT the effective runtime state (screening is effectively off when no
 * screening service is configured); `overridden` reports whether a persisted
 * override is stored.
 */
export function createToolOutputScreensRouter<TTransaction>(deps: ToolOutputScreensRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  const readSetting = () =>
    readToolOutputScreenSetting({ globalSettingsStore: deps.globalSettingsStore, logger: deps.logger });

  const getHandler: RouteHandler<typeof getToolOutputScreenRoute> = async c => {
    const setting = await readSetting();
    return c.json({ data: toToolOutputScreen(setting) }, 200);
  };

  const putHandler: RouteHandler<typeof putToolOutputScreenRoute> = async c => {
    const body = c.req.valid('json');
    // Turning screening on requires a classifier to call: a stored ON override with
    // no screening service configured would silently withhold every open-world tool
    // result (the classifier URL is empty, so every classification fails closed).
    // Clearing the override stays allowed so a stale override is always removable.
    if (body.enabled !== null && configuration.MEMORY_SCREEN_URL === '') {
      return c.json(
        {
          error: {
            message:
              'Cannot change the live tool-output screen setting: no screening service is configured (`MEMORY_SCREEN_URL` is unset).',
            code: 'tool_output_screen_not_configured',
          },
        },
        409,
      );
    }
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: TOOL_OUTPUT_SCREEN_ENABLED_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    // The write above committed, so the intended state is the stored state. The 200
    // confirmation must not re-read through the env-default fallback: on a transient store
    // read failure that fallback would fabricate a response contradicting the override just
    // stored (e.g. report on while screening is actually off).
    const defaultEnabled = configuration.TOOL_OUTPUT_SCREEN_ENABLED;
    const confirmed: ToolOutputScreenSetting = {
      enabled: body.enabled ?? defaultEnabled,
      overridden: body.enabled !== null,
      defaultEnabled,
    };
    return c.json({ data: toToolOutputScreen(confirmed) }, 200);
  };

  router.openapi(getToolOutputScreenRoute, getHandler);
  router.openapi(putToolOutputScreenRoute, putHandler);
  return router;
}
