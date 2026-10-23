import { VercelAILLM, type ILLM } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import type { IModelProviderStore } from '../db/modelProviderStore';
import { modelIdentity, type TurnModelUsage } from './modelUsage';
import { getModelDetails } from './sessionResources';
import { meterHelperLlm, type TokenFactoryBudget } from './tokenFactoryBudget';

/** Text of a model reply; tool-call and refusal parts carry no text. */
export function flattenLlmContent(
  content: string | { type: string; text?: string; refusal?: string }[] | null,
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content === null) {
    return '';
  }
  return content.map(part => (part.type === 'text' ? (part.text ?? '') : '')).join('');
}

/**
 * The metered LLM for a helper job (turn summary, chat title) on the given model. Every helper
 * call goes through here, so the call is budgeted, metered and time-limited the same way.
 */
export async function resolveHelperLlm(params: {
  tenantId: string;
  modelProviderStore: IModelProviderStore;
  modelFqn: string;
  tokenFactoryBudget: TokenFactoryBudget;
  modelUsage: TurnModelUsage;
  logger: Logger;
  timeoutMs: number;
}): Promise<ILLM> {
  const { tenantId, modelProviderStore, modelFqn, logger } = params;
  const { providerConfig, streamTimeout } = await getModelDetails({
    tenant_id: tenantId,
    name: modelFqn,
    store: modelProviderStore,
  });
  return meterHelperLlm({
    llm: new VercelAILLM({
      providerConfig,
      logger,
      signal: AbortSignal.timeout(params.timeoutMs),
      streamTimeout,
    }),
    identity: modelIdentity({ name: modelFqn, providerConfig }),
    role: 'summarization',
    budget: params.tokenFactoryBudget,
    usage: params.modelUsage,
    logger,
  });
}
