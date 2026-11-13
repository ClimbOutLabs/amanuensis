/**
 * Starts the nightly memory job with the server. The summary model is found without a chat turn: the persona's own
 * model for a persona's vault, otherwise the model new chats start on, behind the same switch and the same token
 * budget that turns use.
 */
import { execFileRunner, extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../../config';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IModelProviderStore } from '../../db/modelProviderStore';
import type { IPersonaStore } from '../../db/personaStore';
import { TENANT_ID } from '../../tenancy';
import { resolveDefaultChatModel } from '../defaultChatModel';
import { readMemoryHelperModel } from '../memoryHelperModelSettings';
import { readMemoryNightlySetting } from '../memoryNightlySettings';
import { readMemoryPageSortingSetting } from '../memoryPageSortingSettings';
import { readMemorySummarizeSetting } from '../memorySummarizeSettings';
import type { TurnModelUsage } from '../modelUsage';
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import { createMemoryClient } from './createMemoryClient';
import { personaVaultNamespace, sanitizeNamespace, vaultFilesystemNamespace } from './markdownMemoryFiles';
import type { SummarizeTurnContext } from './memoryRetain';
import { inQuietHours, runNightlyJob, type NightlyCounts, type NightlyDeps, type NightlyVault } from './nightlyJob';
import type { PageSortMode } from './pageSortMode';
import { similarPagesFinder } from './pageSortRun';

/** How often the server looks at the clock; the job itself runs at most once a day per vault. */
const LOOK_INTERVAL_MS = 10 * 60 * 1000;

/** The job's own calls belong to no turn, so there is no turn to show them on. They still count against the token budget. */
const unrecordedModelUsage: TurnModelUsage = { record: () => undefined };

type PersonaLister = Pick<IPersonaStore<unknown>, 'listPersonaOwners' | 'listPersonas'>;

async function personaVaults(personaStore: PersonaLister): Promise<NightlyVault[]> {
  const vaults: NightlyVault[] = [];
  for (const owner of await personaStore.listPersonaOwners({ tenant_id: TENANT_ID })) {
    for (const persona of await personaStore.listPersonas({ tenant_id: TENANT_ID, created_by: owner })) {
      vaults.push({
        namespace: sanitizeNamespace(vaultFilesystemNamespace(TENANT_ID, personaVaultNamespace(persona.display_name))),
        persona: { id: persona.id, name: persona.display_name, modelName: persona.model_name },
      });
    }
  }
  return vaults;
}

/** How a tidy-up the person asked for ended: what it did, or `failed` when it stopped on an error. */
export type TidyResult = { status: 'ran'; counts: NightlyCounts; sorting: PageSortMode } | { status: 'failed' };

/** Where a tidy-up the person asked for stands: running (`busy`), ended a short while ago, or neither (`idle`). */
export type TidyState = TidyResult | { status: 'busy' } | { status: 'idle' };

/** How long the result of a finished tidy-up is still told to a page that asks. */
const LAST_TIDY_KEPT_MS = 60 * 60 * 1000;

export interface NightlyMemoryJob {
  /**
   * Starts tidying every vault, whatever the hour and whether or not the daily tidy-up is switched on. It does not
   * wait for the end, because a slow model can take longer than a web request lasts. With one running, it starts nothing.
   */
  tidyNow: () => void;
  /** Lets a page find out that a tidy-up is running, or how the last one ended. */
  tidyState: () => TidyState;
}

/**
 * Starts the once-a-day timer on a Markdown server. The tidy-up setting and the sorting setting are read each time
 * the timer looks at the clock, so a change in Settings applies without a restart.
 */
export function startNightlyMemoryJob({
  personaStore,
  modelProviderStore,
  globalSettingsStore,
  tokenFactoryBudget,
  logger,
}: {
  personaStore: PersonaLister;
  modelProviderStore: IModelProviderStore;
  globalSettingsStore: IGlobalSettingsStore;
  tokenFactoryBudget: TokenFactoryBudget;
  logger: Logger;
}): NightlyMemoryJob {
  const deps: Omit<NightlyDeps, 'mode' | 'hour'> = {
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    now: () => new Date(),
    vaults: async () => [{ namespace: sanitizeNamespace(TENANT_ID) }, ...(await personaVaults(personaStore))],
    summarizeFor: async (vault): Promise<SummarizeTurnContext | undefined> => {
      const setting = await readMemorySummarizeSetting({ globalSettingsStore, logger });
      if (!setting.enabled) {
        return undefined;
      }
      const summarizationModelFqn =
        (await readMemoryHelperModel({ tenantId: TENANT_ID, globalSettingsStore, modelProviderStore, logger })) ??
        vault.persona?.modelName ??
        (await resolveDefaultChatModel({ tenantId: TENANT_ID, modelProviderStore, globalSettingsStore, logger }));
      return {
        tenantId: TENANT_ID,
        modelProviderStore,
        globalSettingsStore,
        summarizationModelFqn,
        tokenFactoryBudget,
        modelUsage: unrecordedModelUsage,
      };
    },
    similarPagesFor: vault => {
      const client = createMemoryClient({
        markdownDir: configuration.MEMORY_MARKDOWN_DIR,
        namespace: TENANT_ID,
        vaultScope:
          vault.persona === undefined ? undefined : { personaName: vault.persona.name, personaId: vault.persona.id },
        embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
          ? {
              modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
              batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
              log: (message: string) => logger.info(message),
            }
          : undefined,
      });
      return similarPagesFinder(client);
    },
    runner: execFileRunner,
    logger,
  };

  let running = false;
  let lastTidy: { result: TidyResult; finishedAt: number } | undefined;
  // True when a page asked for a tidy-up while the daily one ran: that page waits on it, so its outcome is kept.
  let awaited = false;
  const startTidy = (): void => {
    running = true;
    void (async (): Promise<TidyResult> => {
      const nightly = await readMemoryNightlySetting({ globalSettingsStore, logger });
      const sorting = await readMemoryPageSortingSetting({ globalSettingsStore, logger });
      const counts = await runNightlyJob({
        deps: { ...deps, mode: sorting.mode, hour: nightly.hour },
        onRequest: true,
      });
      return { status: 'ran', counts, sorting: sorting.mode };
    })()
      .catch((error: unknown): TidyResult => {
        logger.warn('A tidy-up asked for now stopped on an error.', extractErrorLogFields(error));
        return { status: 'failed' };
      })
      .then(result => {
        lastTidy = { result, finishedAt: deps.now().getTime() };
        awaited = false;
        running = false;
      });
  };
  const look = (): void => {
    if (running) {
      return;
    }
    running = true;
    void (async (): Promise<TidyResult | undefined> => {
      const nightly = await readMemoryNightlySetting({ globalSettingsStore, logger });
      if (!nightly.enabled || !inQuietHours({ now: deps.now(), hour: nightly.hour })) {
        return undefined;
      }
      const sorting = await readMemoryPageSortingSetting({ globalSettingsStore, logger });
      const counts = await runNightlyJob({ deps: { ...deps, mode: sorting.mode, hour: nightly.hour } });
      return { status: 'ran', counts, sorting: sorting.mode };
    })()
      .catch((error: unknown): TidyResult => {
        logger.warn('The nightly memory job stopped on an error.', extractErrorLogFields(error));
        return { status: 'failed' };
      })
      .then(result => {
        const wanted = awaited;
        awaited = false;
        running = false;
        if (!wanted) {
          return;
        }
        if (result === undefined) {
          // The look had nothing to do, so the tidy-up the page asked for meanwhile still has to run.
          startTidy();
          return;
        }
        lastTidy = { result, finishedAt: deps.now().getTime() };
      });
  };
  setInterval(look, LOOK_INTERVAL_MS).unref();

  return {
    tidyNow: () => {
      lastTidy = undefined;
      if (running) {
        awaited = true;
        return;
      }
      startTidy();
    },
    tidyState: () => {
      if (running) {
        return { status: 'busy' };
      }
      return lastTidy !== undefined && deps.now().getTime() - lastTidy.finishedAt < LAST_TIDY_KEPT_MS
        ? lastTidy.result
        : { status: 'idle' };
    },
  };
}
