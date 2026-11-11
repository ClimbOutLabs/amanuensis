/**
 * Starts the nightly memory job with the server. The summary model is found without a chat turn: the persona's own
 * model for a persona's vault, otherwise the model new chats start on, behind the same switch and the same token
 * budget that turns use.
 */
import { execFileRunner } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import configuration from '../../config';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IModelProviderStore } from '../../db/modelProviderStore';
import type { IPersonaStore } from '../../db/personaStore';
import { TENANT_ID } from '../../tenancy';
import { resolveDefaultChatModel } from '../defaultChatModel';
import { readMemorySummarizeSetting } from '../memorySummarizeSettings';
import type { TurnModelUsage } from '../modelUsage';
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import { createMemoryClient } from './createMemoryClient';
import { personaVaultNamespace, sanitizeNamespace, vaultFilesystemNamespace } from './markdownMemoryFiles';
import type { SummarizeTurnContext } from './memoryRetain';
import { inQuietHours, runNightlyJob, type NightlyDeps, type NightlyVault } from './nightlyJob';
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

/** Starts the once-a-day job. Does nothing unless this server keeps Markdown memory and the job is on. */
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
}): void {
  if (configuration.MEMORY_BACKEND !== 'markdown' || !configuration.MEMORY_NIGHTLY_JOB) {
    return;
  }
  const deps: NightlyDeps = {
    baseDir: configuration.MEMORY_MARKDOWN_DIR,
    mode: configuration.MEMORY_PAGE_SORTING,
    now: () => new Date(),
    vaults: async () => [{ namespace: sanitizeNamespace(TENANT_ID) }, ...(await personaVaults(personaStore))],
    summarizeFor: async (vault): Promise<SummarizeTurnContext | undefined> => {
      const setting = await readMemorySummarizeSetting({ globalSettingsStore, logger });
      if (!setting.effectiveEnabled) {
        return undefined;
      }
      const summarizationModelFqn =
        vault.persona?.modelName ??
        (await resolveDefaultChatModel({ tenantId: TENANT_ID, modelProviderStore, globalSettingsStore, logger }));
      return {
        tenantId: TENANT_ID,
        modelProviderStore,
        summarizationModelFqn,
        tokenFactoryBudget,
        modelUsage: unrecordedModelUsage,
      };
    },
    similarPagesFor: vault => {
      const client = createMemoryClient({
        backend: 'markdown',
        markdownDir: configuration.MEMORY_MARKDOWN_DIR,
        namespace: TENANT_ID,
        vaultScope:
          vault.persona === undefined ? undefined : { personaName: vault.persona.name, personaId: vault.persona.id },
        hindsight: undefined,
        embeddings: configuration.MEMORY_EMBEDDINGS_ENABLED
          ? {
              modelDir: configuration.MEMORY_EMBEDDINGS_MODEL_DIR,
              batchSize: configuration.MEMORY_EMBEDDINGS_BACKFILL_BATCH_SIZE,
              log: (message: string) => logger.info(message),
            }
          : undefined,
      });
      return client === undefined ? undefined : similarPagesFinder(client);
    },
    runner: execFileRunner,
    logger,
  };

  let running = false;
  const look = (): void => {
    if (running || !inQuietHours(deps.now())) {
      return;
    }
    running = true;
    void runNightlyJob(deps).finally(() => {
      running = false;
    });
  };
  setInterval(look, LOOK_INTERVAL_MS).unref();
}
