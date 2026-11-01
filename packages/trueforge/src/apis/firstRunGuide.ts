import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import { extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import { getFirstRunGuideRoute, putFirstRunGuideRoute } from '../routes/firstRunGuideRoutes';

/**
 * Global-settings key for the first-run checklist. One account per instance, so the
 * instance-wide row is the owner's. Stored value is the string `'true'`; anything else,
 * or no row, reads as not dismissed.
 */
export const FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY = 'first_run_guide_dismissed';

export interface FirstRunGuideRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  logger: Logger;
}

/**
 * Reads the dismissal. Fails open to "not dismissed" when the store read throws: showing the
 * checklist once more is the harmless side of that failure.
 */
export async function readFirstRunGuideDismissed<TTransaction>(
  deps: FirstRunGuideRouterDeps<TTransaction>,
): Promise<boolean> {
  try {
    const record = await deps.globalSettingsStore.getSetting({ key: FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY });
    return record?.value === 'true';
  } catch (error) {
    deps.logger.warn('Global setting read failed; showing the first-run checklist', extractErrorLogFields(error));
    return false;
  }
}

/** Settings surface for the first-run checklist (mounted at /api/v1/settings/first-run-guide). */
export function createFirstRunGuideRouter<TTransaction>(deps: FirstRunGuideRouterDeps<TTransaction>) {
  const router = new OpenAPIHono();

  const getHandler: RouteHandler<typeof getFirstRunGuideRoute> = async c => {
    const dismissed = await readFirstRunGuideDismissed(deps);
    return c.json({ data: { dismissed } }, 200);
  };

  const putHandler: RouteHandler<typeof putFirstRunGuideRoute> = async c => {
    const body = c.req.valid('json');
    if (body.dismissed) {
      await deps.globalSettingsStore.setSetting({ key: FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY, value: 'true' });
    } else {
      await deps.globalSettingsStore.deleteSetting({ key: FIRST_RUN_GUIDE_DISMISSED_SETTING_KEY });
    }
    // The write committed, so the request is the stored state; no re-read through the fail-open path.
    return c.json({ data: { dismissed: body.dismissed } }, 200);
  };

  router.openapi(getFirstRunGuideRoute, getHandler);
  router.openapi(putFirstRunGuideRoute, putHandler);
  return router;
}
