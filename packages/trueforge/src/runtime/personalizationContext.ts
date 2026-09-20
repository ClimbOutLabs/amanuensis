import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import type { PersonalizationContext } from '../personalization/profile';

/** Root-only capability: subagent definitions deliberately receive no personal profile. */
export function personalizationContextCapability(context: PersonalizationContext): AgentCapability {
  return {
    instructionBuilders: [
      builder => {
        builder.addSection('personalization-context', context.injected_context, true);
      },
    ],
  };
}
