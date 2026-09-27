import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getMemorySummarizeRoute, putMemorySummarizeRoute } from '../routes/memorySummarizeRoutes';
import {
  MEMORY_SUMMARIZE_SETTING_KEY,
  isMemorySummarizeEffective,
  readMemorySummarizeSetting,
  type MemorySummarizeSetting,
} from '../runtime/memorySummarizeSettings';
import type { MemorySummarize } from '../schemas/memorySummarize';

export interface MemorySummarizeRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

function toMemorySummarize(setting: MemorySummarizeSetting): MemorySummarize {
  return {
    enabled: setting.enabled,
    overridden: setting.overridden,
    default_enabled: setting.defaultEnabled,
    effective_enabled: setting.effectiveEnabled,
  };
}

/**
 * Admin/settings turn-summarization surface (mounted at
 * /api/v1/settings/memory-summarize). `enabled` is the stored setting —
 * the persisted override when one is stored, else the env default;
 * `overridden` reports whether a persisted override is stored;
 * `effective_enabled` is what the server will actually do (markdown-only gate
 * applied) — the truth the Settings toggle shows.
 */
export function createMemorySummarizeRouter<TTransaction>(deps: MemorySummarizeRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();
  const readSetting = () =>
    readMemorySummarizeSetting({ globalSettingsStore: deps.globalSettingsStore, logger: deps.logger });

  const getHandler: RouteHandler<typeof getMemorySummarizeRoute> = async c => {
    const setting = await readSetting();
    return c.json({ data: toMemorySummarize(setting) }, 200);
  };

  const putHandler: RouteHandler<typeof putMemorySummarizeRoute> = async c => {
    const body = c.req.valid('json');
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_SUMMARIZE_SETTING_KEY });
    } else {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_SUMMARIZE_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    // The write above committed, so the intended state is the stored state. The 200
    // confirmation must not re-read through the env-default fallback: on a transient store
    // read failure that fallback would fabricate a response contradicting the override just
    // stored (e.g. report off while summarization is actually on).
    const defaultEnabled = configuration.MEMORY_SUMMARIZE;
    const enabled = body.enabled ?? defaultEnabled;
    const confirmed: MemorySummarizeSetting = {
      enabled,
      overridden: body.enabled !== null,
      defaultEnabled,
      effectiveEnabled: isMemorySummarizeEffective(enabled),
    };
    return c.json({ data: toMemorySummarize(confirmed) }, 200);
  };

  router.openapi(getMemorySummarizeRoute, getHandler);
  router.openapi(putMemorySummarizeRoute, putHandler);
  return router;
}
