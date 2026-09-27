import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { MemoryRecallApi } from '@truefoundry/trueforge-ui';
import { listMemoryTurnContext } from '@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter';

/**
 * Backs `MemoryRecallProvider` with the same SDK client the rest of the app boots with
 * (`bootClient` in App.tsx) — reads `aman.memory.recall` / `aman.profile.learned` events with
 * full fidelity for the durable "Recalled memory" card (SPEC.md I5).
 */
export function createMemoryRecallApi(client: TrueForge): MemoryRecallApi {
  return {
    listMemoryTurnContext: sessionId => listMemoryTurnContext(client, { sessionId }),
  };
}
