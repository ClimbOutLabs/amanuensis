import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import {
  recordPrivateContextText,
  type WebSearchTurnState,
} from '@truefoundry/trueforge-core/core/permissions/webSearch';
import type { PersonalizationContext } from '../personalization/profile';

/** Root-only capability: subagent definitions deliberately receive no personal profile. */
export function personalizationContextCapability(input: {
  context: PersonalizationContext;
  /** The turn's search state: the profile is the person's own data, so a search that carries its details asks. */
  webSearch: WebSearchTurnState;
}): AgentCapability {
  const { context, webSearch } = input;
  let recorded = false;
  return {
    instructionBuilders: [
      builder => {
        builder.addSection('personalization-context', context.injected_context, true);
      },
    ],
    preLLMProcessors: [
      {
        // Kept at the turn's first model call, after the turn has loaded the chat's saved fingerprints.
        // eslint-disable-next-line @typescript-eslint/require-await -- records only; it adds nothing to the context
        processPreLLM: async function* () {
          if (!recorded) {
            recorded = true;
            recordPrivateContextText({ state: webSearch, text: context.injected_context, source: 'each_turn' });
          }
          yield* [];
        },
      },
    ],
  };
}
