import { VercelAILLM, classifyProviderCallError, extractErrorLogFields } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';
import type { IModelProviderStore, ModelProviderRecord } from '../db/modelProviderStore';
import { MODEL_PROBE_TIMEOUT_MS } from '../help/healthProbes';
import type { ModelProviderCheck, ModelProviderCheckKind } from '../schemas/modelProvider';
import { getModelDetails } from './sessionResources';

/**
 * Runs the one test call made when a model provider is saved and reports how it came out.
 * The save itself never waits on this outcome: the caller stores whatever comes back here
 * and shows it on the saved provider. Resolves for every provider failure; it rejects only
 * when the check itself could not be set up.
 */
export type CheckSavedModelProvider = (input: {
  tenant_id: string;
  store: IModelProviderStore;
  record: ModelProviderRecord;
}) => Promise<ModelProviderCheck>;

const CHECK_MESSAGES: Record<ModelProviderCheckKind, string> = {
  answered: 'The model server answered the test call.',
  key_refused: 'The model server refused the API key. Check the key for this provider and save again.',
  unreachable:
    'The model server did not answer. Check the server is running and the address is right, then save again.',
  server_error: 'The model server answered with an error. Check the provider settings and save again.',
};

/**
 * Builds the save-time check. The test call goes through the same model setup and guarded
 * outbound fetch as a real chat call, so a provider that passes here is set up the way a
 * chat turn will use it, and one that fails here fails for the reason a chat turn would hit.
 */
export function createModelProviderChecker({ logger }: { logger: Logger }): CheckSavedModelProvider {
  return async ({ tenant_id, store, record }) => {
    const checkedAt = new Date().toISOString();
    const firstModel = record.manifest.models[0];
    if (firstModel === undefined) {
      return { kind: 'server_error', message: CHECK_MESSAGES.server_error, checked_at: checkedAt };
    }
    try {
      const details = await getModelDetails({ tenant_id, name: `${record.name}/${firstModel.name}`, store });
      const llm = new VercelAILLM({
        providerConfig: details.providerConfig,
        logger,
        signal: AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
        streamTimeout: details.streamTimeout,
      });
      await llm.createNonStream({
        messages: [{ role: 'user', content: 'Reply with the word ok.' }],
        max_completion_tokens: 8,
        temperature: 0,
        top_p: 1,
      });
      return { kind: 'answered', message: CHECK_MESSAGES.answered, checked_at: checkedAt };
    } catch (error) {
      const kind = classifyProviderCallError(error);
      logger.warn('Model provider check did not pass', {
        provider: record.name,
        kind,
        ...extractErrorLogFields(error),
      });
      return { kind, message: CHECK_MESSAGES[kind], checked_at: checkedAt };
    }
  };
}
