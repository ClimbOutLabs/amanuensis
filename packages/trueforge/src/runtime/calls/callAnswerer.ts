import type { Logger } from 'winston';

import type { IGlobalSettingsStore } from '../../db/globalSettingsStore';
import type { IModelProviderStore } from '../../db/modelProviderStore';
import { resolveDefaultChatModel } from '../defaultChatModel';
import { NO_TURN_USAGE } from '../modelUsage';
import { askModelOnce } from '../oneShotModelCall';
import type { TokenFactoryBudget } from '../tokenFactoryBudget';
import type { CallAsk } from './callChats';

/** A spoken reply is a few sentences. */
const CALL_REPLY_MAX_TOKENS = 300;
/** The person is waiting on the line. */
const CALL_REPLY_TIMEOUT_MS = 20_000;

/**
 * Answers on a call with the model a new chat starts on, one call per reply, with no tools. Undefined when the server
 * has no model.
 */
export async function createCallAnswerer({
  tenantId,
  modelProviderStore,
  globalSettingsStore,
  tokenFactoryBudget,
  logger,
}: {
  tenantId: string;
  modelProviderStore: IModelProviderStore;
  globalSettingsStore: IGlobalSettingsStore;
  tokenFactoryBudget: TokenFactoryBudget;
  logger: Logger;
}): Promise<CallAsk | undefined> {
  const modelName = await resolveDefaultChatModel({ tenantId, modelProviderStore, globalSettingsStore, logger });
  if (modelName === undefined) {
    return undefined;
  }
  return ({ messages, signal }) =>
    askModelOnce({
      tenantId,
      modelName,
      modelProviderStore,
      tokenFactoryBudget,
      usage: NO_TURN_USAGE,
      logger,
      role: 'chat',
      messages,
      maxTokens: CALL_REPLY_MAX_TOKENS,
      timeoutMs: CALL_REPLY_TIMEOUT_MS,
      signal,
    });
}
