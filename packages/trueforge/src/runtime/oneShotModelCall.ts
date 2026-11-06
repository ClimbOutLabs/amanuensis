import { VercelAILLM, type LLMCreateParams } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ModelUsageRole } from '../schemas/modelUsageEvents';
import { modelIdentity, type TurnModelUsage } from './modelUsage';
import { getModelDetails } from './sessionResources';
import { meterHelperLlm, type TokenFactoryBudget } from './tokenFactoryBudget';

function answerText(content: string | { type: string; text?: string; refusal?: string }[] | null): string {
  if (typeof content === 'string') {
    return content;
  }
  return content === null ? '' : content.map(part => part.text ?? part.refusal ?? '').join('');
}

/**
 * One short helper call with no tools and no streaming, metered under `role`, that resolves to the answer's text.
 * Thinking is turned off only when the model says it can be. Throws when the model cannot be reached or answer in
 * time, so each caller chooses its own fallback.
 */
export async function askModelOnce({
  tenantId,
  modelName,
  modelProviderStore,
  tokenFactoryBudget,
  usage,
  logger,
  role,
  messages,
  maxTokens,
  timeoutMs,
}: {
  tenantId: string;
  modelName: string;
  modelProviderStore: IModelProviderStore;
  tokenFactoryBudget: TokenFactoryBudget;
  usage: TurnModelUsage;
  logger: Logger;
  role: ModelUsageRole;
  messages: LLMCreateParams['messages'];
  maxTokens: number;
  timeoutMs: number;
}): Promise<string> {
  const { providerConfig, modelProperties, streamTimeout } = await getModelDetails({
    tenant_id: tenantId,
    name: modelName,
    store: modelProviderStore,
  });
  const request: LLMCreateParams = { messages, max_completion_tokens: maxTokens, temperature: 0, top_p: 1 };
  if (modelProperties.reasoning_efforts?.includes('none') === true) {
    Object.assign(request, { enable_thinking: false, reasoning_effort: 'none' });
  }
  const llm = meterHelperLlm({
    llm: new VercelAILLM({ providerConfig, logger, signal: AbortSignal.timeout(timeoutMs), streamTimeout }),
    identity: modelIdentity({ name: modelName, providerConfig }),
    role,
    budget: tokenFactoryBudget,
    usage,
    logger,
  });
  const result = await llm.createNonStream(request);
  return answerText(result.output.content ?? null);
}
