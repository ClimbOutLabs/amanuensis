import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';
import type { Logger } from 'winston';

import configuration from '../config';
import type { IGlobalSettingsStore } from '../db/globalSettingsStore';
import {
  getMemoryNightlyRoute,
  getMemoryNightlyRunRoute,
  putMemoryNightlyRoute,
  runMemoryNightlyRoute,
} from '../routes/memoryNightlyRoutes';
import type { NightlyMemoryJob, TidyState } from '../runtime/memory/nightlyService';
import {
  DEFAULT_MEMORY_HELPER_WAIT_MINUTES,
  MEMORY_HELPER_WAIT_SETTING_KEY,
  parseHelperWaitMinutes,
  readMemoryHelperWaitMinutes,
} from '../runtime/memoryHelperWaitSettings';
import {
  DEFAULT_MEMORY_NIGHTLY_HOUR,
  MEMORY_NIGHTLY_HOUR_SETTING_KEY,
  MEMORY_NIGHTLY_SETTING_KEY,
  parseNightlyHour,
  readMemoryNightlySetting,
  type MemoryNightlySetting,
} from '../runtime/memoryNightlySettings';
import type { MemoryNightly, MemoryTidyRun } from '../schemas/memoryNightly';

export interface MemoryNightlyRouterDeps<TTransaction> {
  globalSettingsStore: IGlobalSettingsStore<TTransaction>;
  /** Runs the tidy-up now, and tells where a tidy-up stands. */
  memoryTidy: NightlyMemoryJob;
  logger: Logger;
}

function toMemoryTidyRun(state: TidyState): MemoryTidyRun {
  const counts = state.status === 'ran' ? state.counts : undefined;
  return {
    status: state.status,
    moved_to_earlier: counts?.movedToEarlier ?? 0,
    notes_asked: counts?.notesAsked ?? 0,
    notes_sorted: counts?.notesSorted ?? 0,
    pairs_listed: counts?.pairsListed ?? 0,
    sorting: state.status === 'ran' ? state.sorting : 'off',
    model_missing: (counts?.vaultsWithoutModel ?? 0) > 0,
    unsorted_reasons: counts?.unsortedReasons ?? [],
  };
}

function toMemoryNightly({
  setting,
  modelWaitMinutes,
}: {
  setting: MemoryNightlySetting;
  modelWaitMinutes: number;
}): MemoryNightly {
  return {
    enabled: setting.enabled,
    overridden: setting.overridden,
    default_enabled: setting.defaultEnabled,
    hour: setting.hour,
    model_wait_minutes: modelWaitMinutes,
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
    const modelWaitMinutes = await readMemoryHelperWaitMinutes({
      globalSettingsStore: deps.globalSettingsStore,
      logger: deps.logger,
    });
    return c.json({ data: toMemoryNightly({ setting, modelWaitMinutes }) }, 200);
  };

  const putHandler: RouteHandler<typeof putMemoryNightlyRoute> = async c => {
    const body = c.req.valid('json');
    if (body.enabled === null) {
      await deps.globalSettingsStore.deleteSetting({ key: MEMORY_NIGHTLY_SETTING_KEY });
    } else if (body.enabled !== undefined) {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_NIGHTLY_SETTING_KEY,
        value: body.enabled ? 'true' : 'false',
      });
    }
    if (body.hour !== undefined) {
      await deps.globalSettingsStore.setSetting({ key: MEMORY_NIGHTLY_HOUR_SETTING_KEY, value: String(body.hour) });
    }
    if (body.model_wait_minutes !== undefined) {
      await deps.globalSettingsStore.setSetting({
        key: MEMORY_HELPER_WAIT_SETTING_KEY,
        value: String(body.model_wait_minutes),
      });
    }
    // Confirm from what was just written, not a re-read: a failed read would fall back to the env default
    // and contradict the change the person just made. Only a field the request left out is read.
    const defaultEnabled = configuration.MEMORY_NIGHTLY_JOB;
    const left = async (key: string): Promise<string | undefined> => {
      try {
        return (await deps.globalSettingsStore.getSetting({ key }))?.value;
      } catch {
        return undefined;
      }
    };
    const storedEnabled = body.enabled === undefined ? await left(MEMORY_NIGHTLY_SETTING_KEY) : undefined;
    const override =
      body.enabled === undefined
        ? storedEnabled === 'true'
          ? true
          : storedEnabled === 'false'
            ? false
            : null
        : body.enabled;
    const storedHour = body.hour === undefined ? await left(MEMORY_NIGHTLY_HOUR_SETTING_KEY) : undefined;
    const storedWait = body.model_wait_minutes === undefined ? await left(MEMORY_HELPER_WAIT_SETTING_KEY) : undefined;
    return c.json(
      {
        data: toMemoryNightly({
          setting: {
            enabled: override ?? defaultEnabled,
            overridden: override !== null,
            defaultEnabled,
            hour:
              body.hour ??
              (storedHour === undefined ? undefined : parseNightlyHour(storedHour)) ??
              DEFAULT_MEMORY_NIGHTLY_HOUR,
          },
          modelWaitMinutes:
            body.model_wait_minutes ??
            (storedWait === undefined ? undefined : parseHelperWaitMinutes(storedWait)) ??
            DEFAULT_MEMORY_HELPER_WAIT_MINUTES,
        }),
      },
      200,
    );
  };

  const runHandler: RouteHandler<typeof runMemoryNightlyRoute> = async c =>
    c.json({ data: toMemoryTidyRun(await deps.memoryTidy.tidyNow()) }, 200);

  const getRunHandler: RouteHandler<typeof getMemoryNightlyRunRoute> = c =>
    c.json({ data: toMemoryTidyRun(deps.memoryTidy.tidyState()) }, 200);

  router.openapi(getMemoryNightlyRoute, getHandler);
  router.openapi(putMemoryNightlyRoute, putHandler);
  router.openapi(runMemoryNightlyRoute, runHandler);
  router.openapi(getMemoryNightlyRunRoute, getRunHandler);
  return router;
}
