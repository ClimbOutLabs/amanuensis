import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { ModelUsageApi } from '@truefoundry/trueforge-ui';
import { listModelUsageTurnContext } from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';

/**
 * Backs `ModelUsageProvider` with the same SDK client the rest of the app boots with
 * (`bootClient` in App.tsx) — reads `aman.model.usage` events for the model and cost line under
 * each answer.
 */
export function createModelUsageApi(client: TrueForge): ModelUsageApi {
  return {
    listModelUsage: sessionId => listModelUsageTurnContext(client, { sessionId }),
  };
}
