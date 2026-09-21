import { TurnResourceResolver } from '@truefoundry/trueforge-core/agent-session';
import type { AgentCapability } from '@truefoundry/trueforge-core/core';
import type { TurnCustom } from '../db/sessionCustom';
import type { PersonalizationContext } from '../personalization/profile';
import { personalizationContextCapability } from './personalizationContext';

export function personalizationCapabilitiesForTurn(
  context: PersonalizationContext | undefined,
  isSubAgent: boolean,
): AgentCapability[] {
  if (!context || isSubAgent) {
    return [];
  }
  return [personalizationContextCapability(context)];
}

/** Adds one immutable per-turn profile context to root agents only. */
export class PersonalizationTurnResourceResolver extends TurnResourceResolver<TurnCustom> {
  readonly #context: PersonalizationContext | undefined;

  constructor(
    deps: ConstructorParameters<typeof TurnResourceResolver<TurnCustom>>[0],
    context: PersonalizationContext | undefined,
  ) {
    super(deps);
    this.#context = context;
  }

  override async resolveAgentDefinition(input: Parameters<TurnResourceResolver['resolveAgentDefinition']>[0]) {
    const resolved = await super.resolveAgentDefinition(input);
    const personalizationCapabilities = personalizationCapabilitiesForTurn(this.#context, Boolean(input.agent_info));
    if (personalizationCapabilities.length === 0) {
      return resolved;
    }
    return {
      ...resolved,
      extraCapabilities: [...(resolved.extraCapabilities ?? []), ...personalizationCapabilities],
    };
  }
}
