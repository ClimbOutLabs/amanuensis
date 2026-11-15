import type { Logger } from 'winston';

import { requestContextFromCreatedBySubject, type RequestContext } from '../../auth/identity';
import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IModelProviderStore } from '../../db/modelProviderStore';
import type { PersonOwner } from '../../db/personOwner';
import type { IPersonalizationStore } from '../../db/personalizationStore';
import { resolveDefaultChatModel } from '../defaultChatModel';
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import { createNoticingJudge, type NoticingJudge } from './judge';

/** Said when no model is set up, so a watcher falls back to a plain note. */
class NoNoticingModelError extends Error {
  constructor() {
    super('No model is set up for the assistant to ask. Add one in Settings, Models.');
    this.name = 'NoNoticingModelError';
  }
}

/**
 * Opens the "does this matter" model for one person: the model a new chat starts on, and the name they gave their
 * assistant. The model is resolved when the first event needs it, so a pass with no event touches neither.
 */
export function createNoticingJudgeResolver({
  resolveModelProviderStore,
  personalizationStore,
  globalSettingsStore,
  tokenFactoryBudget,
  logger,
}: {
  resolveModelProviderStore: (context: RequestContext) => IModelProviderStore;
  personalizationStore: Pick<IPersonalizationStore, 'getProfile'>;
  globalSettingsStore: IGlobalSettingsStore;
  tokenFactoryBudget: TokenFactoryBudget;
  logger: Logger;
}): (owner: PersonOwner) => Promise<NoticingJudge> {
  return async owner => {
    const context = requestContextFromCreatedBySubject({
      tenant_id: owner.tenant_id,
      created_by_subject: {
        subject_id: owner.created_by,
        subject_type: 'user',
        subject_display_name: owner.created_by,
      },
    });
    const modelProviderStore = resolveModelProviderStore(context);
    const modelName = await resolveDefaultChatModel({
      tenantId: owner.tenant_id,
      modelProviderStore,
      globalSettingsStore,
      logger,
    });
    if (modelName === undefined) {
      throw new NoNoticingModelError();
    }
    const profile = await personalizationStore.getProfile({ tenant_id: owner.tenant_id, created_by: owner.created_by });
    return createNoticingJudge({
      tenantId: owner.tenant_id,
      modelName,
      assistantName: profile?.assistant_name ?? undefined,
      modelProviderStore,
      tokenFactoryBudget,
      logger,
    });
  };
}
