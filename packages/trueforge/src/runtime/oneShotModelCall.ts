import { VercelAILLM, type LLMCreateParams } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { IModelProviderStore } from '../db/modelProviderStore';
import type { ModelProperties } from '../schemas/modelProvider';
import type { ModelUsageRole } from '../schemas/modelUsageEvents';
import { lightReasoningRequestFields, withRequestFields } from './memory/memorySummarize';
import { modelIdentity, type TurnModelUsage } from './modelUsage';
import { getModelDetails } from './sessionResources';
import { meterHelperLlm, type TokenFactoryBudget } from './tokenFactoryBudget';

function answerText(content: string | { type: string; text?: string; refusal?: string }[] | null): string {
  if (typeof content === 'string') {
    return content;
  }
  return content === null ? '' : content.map(part => part.text ?? part.refusal ?? '').join('');
}

/** Room for a model that thinks before it answers, so a short cap is not spent on thinking alone. */
const THINKING_ROOM_TOKENS = 1_024;

/**
 * The output cap and reasoning fields for a short helper call. Thinking is turned off when the
 * model says it can be. Otherwise the model is asked for the least thinking it lists and the cap
 * gets room for it; `maxTokens` stays the size of the answer that is wanted.
 */
export function shortCallRequestFields({
  modelProperties,
  maxTokens,
}: {
  modelProperties: ModelProperties;
  maxTokens: number;
}): { max_completion_tokens: number; reasoning: Record<string, string | boolean> } {
  const reasoning = lightReasoningRequestFields(modelProperties);
  if (reasoning['enable_thinking'] === false) {
    return { max_completion_tokens: maxTokens, reasoning };
  }
  const withRoom = maxTokens + THINKING_ROOM_TOKENS;
  return {
    max_completion_tokens: Math.min(withRoom, modelProperties.max_output_tokens ?? withRoom),
    reasoning,
  };
}

/**
 * One short helper call with no tools and no streaming, metered under `role`, that resolves to the answer's text.
 * Throws when the model cannot be reached or answer in
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
  signal,
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
  /** Stops the call early, such as when the person spoke again. */
  signal?: AbortSignal;
}): Promise<string> {
  const { providerConfig, modelProperties, streamTimeout } = await getModelDetails({
    tenant_id: tenantId,
    name: modelName,
    store: modelProviderStore,
  });
  const fields = shortCallRequestFields({ modelProperties, maxTokens });
  const request: LLMCreateParams = {
    messages,
    max_completion_tokens: fields.max_completion_tokens,
    temperature: 0,
    top_p: 1,
  };
  const metered = meterHelperLlm({
    llm: new VercelAILLM({
      providerConfig,
      logger,
      signal:
        signal === undefined
          ? AbortSignal.timeout(timeoutMs)
          : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
      streamTimeout,
    }),
    identity: modelIdentity({ name: modelName, providerConfig }),
    role,
    budget: tokenFactoryBudget,
    usage,
    logger,
  });
  const llm = withRequestFields({
    llm: metered,
    fields: fields.reasoning,
    modelKey: `${tenantId}/${modelName}`,
    logger,
  });
  const result = await llm.createNonStream(request);
  return answerText(result.output.content ?? null);
}
