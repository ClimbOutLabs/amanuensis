import { recordPersonText, type AgentCapability, type WebSearchTurnState } from '@truefoundry/trueforge-core/core';
import type { PersonalizationContext } from '../personalization/profile';

/** Root-only capability: subagent definitions deliberately receive no personal profile. */
export function personalizationContextCapability(input: {
  context: PersonalizationContext;
  /** The turn's lookup state: the profile is the person's own, so a link or address in it is theirs to use. */
  webSearch: WebSearchTurnState;
}): AgentCapability {
  const { context, webSearch } = input;
  recordPersonText({ provenance: webSearch.provenance, text: context.injected_context });
  return {
    instructionBuilders: [
      builder => {
        builder.addSection('personalization-context', context.injected_context, true);
      },
    ],
  };
}
